begin;

-- Final consolidation:
-- * active customers come from the customer status, independently of contracts;
-- * goals keep only contracts whose latest status is ACTIVE;
-- * cancellation requests and reversals work independently for each base;
-- * operational cancellation reasons remain auditable but do not enter KPIs.

create or replace function comercial.excluded_cancellation_reason(reason text) returns boolean
language sql immutable parallel safe set search_path=pg_catalog,comercial as $$
  select comercial.normalize(reason) in
      ('ACERTO DE SISTEMA','INSTALACAO NAO CONCLUIDA','TROCA DE TITULARIDADE')
    or comercial.normalize(reason) like '%ACERTO DE SISTEMA%'
    or comercial.normalize(reason) like '%INSTALACAO NAO CONCLUIDA%'
    or comercial.normalize(reason) like '%TROCA DE TITULARIDADE%'
$$;

do $$begin
  if to_regprocedure('comercial.refresh_before_final_consolidation(date)') is null then
    alter function comercial.refresh_all(date) rename to refresh_before_final_consolidation;
  end if;
end;$$;

create or replace function comercial.refresh_all(cutoff date) returns void
language plpgsql set search_path=pg_catalog,comercial,pg_temp as $$
declare period date; selected_base text; until_day date; opening_day date;
begin
  perform comercial.refresh_before_final_consolidation(cutoff);
  perform pg_advisory_xact_lock(211689);

  for selected_base in
    select distinct base_code from source_loads where observed_on<=cutoff order by base_code
  loop
    for period in
      select d::date from generate_series(date '2026-01-01',date_trunc('month',cutoff)::date,interval '1 month')d
    loop
      until_day:=least(cutoff,(period+interval '1 month - 1 day')::date);
      opening_day:=period-1;

      -- Customer position is based on the customer report's own active flag.
      -- It is intentionally independent of the number of active contracts.
      if exists(select from source_observations where base_code=selected_base and source='customers' and observed_on<=until_day) then
        delete from metric_rows where base_code=selected_base and month=period and kind='active_client';
        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
        select selected_base,period,'active_client',r.external_key,seller_for(r.payload->>'seller'),until_day,
          coalesce(r.payload->>'name',r.payload->>'trading_name','Cliente '||r.external_key),1,
          r.payload->>'city',r.payload->>'branch',jsonb_build_object(
            'client',r.external_key,'identity',client_identity(r.payload->>'document'),
            'active',true,'position_method','customer_status')
        from base_portfolio_on(until_day,cutoff,selected_base,'customers')r
        where normalize(r.payload->>'active') in ('TRUE','SIM','S','ATIVO','1');
      end if;

      if exists(select from source_observations where base_code=selected_base and source='customers' and observed_on<=opening_day) then
        delete from metric_rows where base_code=selected_base and month=period and kind='opening_active_client';
        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
        select selected_base,period,'opening_active_client',r.external_key,seller_for(r.payload->>'seller'),opening_day,
          coalesce(r.payload->>'name',r.payload->>'trading_name','Cliente '||r.external_key),1,
          r.payload->>'city',r.payload->>'branch',jsonb_build_object(
            'client',r.external_key,'identity',client_identity(r.payload->>'document'),
            'active',true,'position_method','customer_status')
        from base_portfolio_on(opening_day,cutoff,selected_base,'customers')r
        where normalize(r.payload->>'active') in ('TRUE','SIM','S','ATIVO','1');
      end if;
    end loop;

    -- No inactive or cancelled contract contributes to commercial goals.
    delete from metric_rows m
    where m.base_code=selected_base and m.kind in ('goal_sale','goal_pending')
      and not exists(
        select from base_rows_on(cutoff,selected_base)c
        where c.source='contracts'
          and c.external_key=coalesce(m.details->>'contract',m.row_key)
          and normalize(c.payload->>'status')='ATIVO');

    -- Refresh the evidence attached to every cancellation outcome. The service
    -- order opener never replaces the seller responsible for the contract.
    update metric_rows set details=details-'excluded_from_kpi'-'exclusion_reason'
    where base_code=selected_base and kind in
      ('cancellation_request','cancellation_effective','cancellation_reversed','cancellation_pending','cancellation');

    with evidence as(
      select m.ctid id,
        coalesce(nullif(c.payload->>'cancellation_reason',''),nullif(o.payload->>'reason',''),
          nullif(o.payload->>'subject','')) reason,
        concat_ws(' ',c.payload->>'cancellation_reason',o.payload->>'reason',o.payload->>'subject',o.payload->>'original_text') exclusion_text,
        c.payload->>'status' contract_status,c.payload->>'activated' contract_activated,
        c.payload->>'cancelled' contract_cancelled
      from metric_rows m
      left join base_rows_on(cutoff,selected_base)o
        on o.source='cancellation_orders' and o.external_key=m.row_key
      left join base_rows_on(cutoff,selected_base)c
        on c.source='contracts' and c.external_key=coalesce(m.details->>'contract',o.payload->>'contract_key')
      where m.base_code=selected_base and m.kind in
        ('cancellation_request','cancellation_effective','cancellation_reversed','cancellation_pending','cancellation')
    )
    update metric_rows m set details=m.details||jsonb_build_object(
      'reason',e.reason,'contract_status',e.contract_status,'contract_activated',e.contract_activated,
      'contract_cancelled',e.contract_cancelled,'excluded_from_kpi',excluded_cancellation_reason(e.exclusion_text),
      'exclusion_reason',case when excluded_cancellation_reason(e.exclusion_text)
        then 'Motivo operacional desconsiderado' end)
    from evidence e where m.ctid=e.id;

    -- A reversal requires proof that the same contract already existed on the
    -- request date and is still active in the latest imported position.
    with moved as(
      delete from metric_rows
      where base_code=selected_base and kind='cancellation_reversed'
        and (details->>'contract_activated' is null or (details->>'contract_activated')::date>occurred_on
          or normalize(details->>'contract_status')<>'ATIVO')
      returning base_code,month,row_key,seller_key,occurred_on,label,amount,city,branch,product,details
    )
    insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select base_code,month,'cancellation_pending',row_key,seller_key,occurred_on,label,amount,city,branch,product,
      details||jsonb_build_object('classification','pending','needs_review',true,
        'reason',coalesce(details->>'reason','Não foi possível provar que o contrato permaneceu ativo após a solicitação'))
    from moved
    on conflict(base_code,month,kind,row_key)do update set seller_key=excluded.seller_key,
      occurred_on=excluded.occurred_on,label=excluded.label,amount=excluded.amount,city=excluded.city,
      branch=excluded.branch,product=excluded.product,details=excluded.details;
  end loop;
end;$$;

do $$declare cutoff date;begin
  select max(observed_on)into cutoff from comercial.source_loads;
  if cutoff is not null then perform comercial.refresh_all(cutoff);end if;
end;$$;

commit;
