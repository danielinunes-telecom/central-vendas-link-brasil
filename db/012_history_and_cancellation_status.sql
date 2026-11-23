begin;

-- The first complete customer/contract position makes the 2026 history
-- reconstructable.  Earlier imports remain preserved, but filters now start in January.
insert into comercial.targets(seller_key,effective_month,amount)
select distinct on(seller_key) seller_key,date '2026-01-01',amount
from comercial.targets order by seller_key,effective_month
on conflict do nothing;

alter table comercial.cancellation_review add column if not exists contract_id text;

do $$begin
  if to_regprocedure('comercial.refresh_before_history_2026(date)') is null then
    alter function comercial.refresh_all(date) rename to refresh_before_history_2026;
  end if;
end$$;

create or replace function comercial.refresh_all(cutoff date) returns void
language plpgsql set search_path=pg_catalog,comercial,pg_temp as $$
declare period date; selected_base text; until_day date;
begin
  perform comercial.refresh_before_history_2026(cutoff);
  perform pg_advisory_xact_lock(211687);

  for selected_base in select distinct base_code from source_loads order by base_code loop
    for period in select d::date from generate_series(date '2026-01-01',date_trunc('month',cutoff)::date,interval '1 month')d loop
      until_day:=least(cutoff,(period+interval '1 month - 1 day')::date);

      -- Re-read every contract change from its actual event month.  The amount
      -- remains the IXC difference (downgrades are negative).
      if period<date '2026-10-01' then
      delete from metric_rows where base_code=selected_base and month=period and kind in ('upgrade','downgrade');
      insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,details)
      select selected_base,period,case when normalize(r.payload->>'type') like '%UPGRADE%' then 'upgrade' else 'downgrade' end,
        r.external_key,coalesce(seller_for(r.payload->>'seller'),seller_for(c.payload->>'seller')),r.event_day,
        coalesce(c.payload->>'client','Contrato '||(r.payload->>'contract_key')),(r.payload->>'difference')::numeric,
        jsonb_build_object('contract',r.payload->>'contract_key','type',r.payload->>'type',
          'old_plan',r.payload->>'old_plan','new_plan',r.payload->>'new_plan','old_value',r.payload->>'old_value','new_value',r.payload->>'new_value')
      from base_rows_on(cutoff,selected_base)r
      left join base_rows_on(cutoff,selected_base)c on c.source='contracts' and c.external_key=r.payload->>'contract_key'
      where r.source='changes' and r.event_day between period and until_day
        and (normalize(r.payload->>'type') like '%UPGRADE%' or normalize(r.payload->>'type') like '%DOWNGRADE%');
      end if;

      -- One commercial activation per customer: always the most recent
      -- contract, using the full contract value and the product rule.
      if exists(select from base_rows_on(cutoff,selected_base) where source='contracts' and payload->>'total' is not null) then
      delete from metric_rows where base_code=selected_base and month=period and kind in ('goal_sale','goal_pending');
      with ranked as (
        select r.*,row_number()over(partition by r.payload->>'client_key'
          order by (r.payload->>'activated')::date desc nulls last,r.external_key desc) latest
        from base_rows_on(cutoff,selected_base)r where r.source='contracts'
      ), prepared as (
        select r.*,seller_for(r.payload->>'seller') seller,goal_classification(r.payload->>'description') class
        from ranked r where latest=1 and (r.payload->>'activated')::date between period and until_day
      )
      insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,product,details)
      select selected_base,period,case when seller is not null and payload->>'total' is not null and class->>'status'='classified'
          then 'goal_sale' else 'goal_pending' end,
        external_key,seller,(payload->>'activated')::date,coalesce(payload->>'client','Contrato '||external_key),
        case when class->>'status'='classified' then (payload->>'total')::numeric*(class->>'rate')::numeric end,
        payload->>'city',payload->>'description',jsonb_build_object('contract',external_key,'client',payload->>'client_key',
          'contract_total',payload->>'total','gross',payload->>'total','original_description',payload->>'description',
          'category',class->>'category','rate',case when class?'rate' then (class->>'rate')::numeric end,
          'calculation','latest_client_contract_value_x_goal_rate','reason',case
            when payload->>'client_key' is null then 'Cliente não vinculado ao contrato'
            when seller is null then 'Vendedor do contrato não confirmado'
            when payload->>'total' is null then 'Valor total do contrato não localizado'
            when class->>'status'<>'classified' then 'Descrição do contrato sem classificação automática' end)
      from prepared;
      end if;

      -- CRM is sourced only from the New Base.  Every activity counts, and a
      -- negotiation explicitly typed RELACIONAMENTO also counts as a visit.
      if selected_base in ('new','legacy') then
        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,details)
        select selected_base,period,'visit_task','negotiation:'||r.external_key,seller_for(r.payload->>'seller'),r.event_day,
          coalesce(r.payload->>'client','Relacionamento '||r.external_key),1,
          jsonb_build_object('deal',r.external_key,'client',r.payload->>'client_key','type',r.payload->>'type',
            'status',r.payload->>'status','method','Negociação do tipo RELACIONAMENTO conta como visita')
        from base_rows_on(cutoff,selected_base)r where r.source='negotiations' and r.event_day between period and until_day
          and normalize(r.payload->>'type')='RELACIONAMENTO'
        on conflict(base_code,month,kind,row_key)do update set seller_key=excluded.seller_key,occurred_on=excluded.occurred_on,
          label=excluded.label,amount=excluded.amount,details=excluded.details;
        if selected_base='new' then
          with mapping as(select m.ctid id,c.external_key,c.payload from metric_rows m
            left join lateral(select x.external_key,x.payload from base_rows_on(cutoff,'old')x
              where x.source='contracts' and x.payload->>'client_key'=m.details->>'client'
              order by (x.payload->>'activated')::date desc nulls last,x.external_key desc limit 1)c on true
            where m.base_code='new' and m.month=period and m.kind='visit_task')
          update metric_rows m set label=coalesce(mapping.payload->>'client',m.label),
            details=m.details||jsonb_build_object('matched_old_contract',mapping.external_key)
          from mapping where m.ctid=mapping.id and mapping.external_key is not null;
        end if;
      end if;

      -- Before November there were no trustworthy monthly positions.  The full
      -- history allows a clearly identified lifecycle reconstruction.
      if period<date '2026-11-01' then
        delete from metric_rows where base_code=selected_base and month=period and kind in
          ('active_contract','active_client','mrr','opening_contract','opening_mrr','target');
        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,product,details)
        select selected_base,period,'active_contract',r.external_key,seller_for(r.payload->>'seller'),until_day,
          coalesce(r.payload->>'client','Contrato '||r.external_key),1,r.payload->>'city',r.payload->>'description',
          jsonb_build_object('contract',r.external_key,'client',r.payload->>'client_key','description',r.payload->>'description',
            'status',r.payload->>'status','activated',r.payload->>'activated','cancelled',r.payload->>'cancelled',
            'contract_total',r.payload->>'total','position_method','reconstructed_from_contract_lifecycle')
        from base_rows_on(cutoff,selected_base)r where r.source='contracts' and (r.payload->>'activated')::date<=until_day
          and (r.payload->>'cancelled' is null or (r.payload->>'cancelled')::date>until_day);
        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,details)
        select selected_base,period,'active_client',coalesce(payload->>'client_key',external_key),seller_for(payload->>'seller'),until_day,
          max(coalesce(payload->>'client','Cliente '||(payload->>'client_key'))),1,max(payload->>'city'),
          jsonb_build_object('client',payload->>'client_key','position_method','reconstructed_from_contract_lifecycle')
        from base_rows_on(cutoff,selected_base)r where source='contracts' and (payload->>'activated')::date<=until_day
          and (payload->>'cancelled' is null or (payload->>'cancelled')::date>until_day)
        group by coalesce(payload->>'client_key',external_key),seller_for(payload->>'seller'),payload->>'client_key';
        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,product,details)
        select selected_base,period,'mrr',external_key,seller_for(payload->>'seller'),until_day,
          coalesce(payload->>'client','Contrato '||external_key),(payload->>'total')::numeric,payload->>'city',payload->>'description',
          jsonb_build_object('contract',external_key,'client',payload->>'client_key','position_method','reconstructed_from_contract_lifecycle')
        from base_rows_on(cutoff,selected_base)r where source='contracts' and payload->>'total' is not null
          and (payload->>'activated')::date<=until_day and (payload->>'cancelled' is null or (payload->>'cancelled')::date>until_day);
        insert into metric_rows(base_code,month,kind,row_key,seller_key,label,amount,details)
        select selected_base,period,'target',s.seller_key,s.seller_key,s.name,t.amount,jsonb_build_object('team',s.team)
        from sellers s join lateral(select amount from targets t where t.seller_key=s.seller_key and t.effective_month<=period
          order by effective_month desc limit 1)t on true where s.active;
        insert into metric_state(base_code,month,observed_on,data)values(selected_base,period,until_day,
          jsonb_build_object('closing',true,'goal',exists(select from source_observations where base_code=selected_base and source='contracts'),
            'historical_position','reconstructed_from_contract_lifecycle','contracts',true))
        on conflict(base_code,month)do update set observed_on=excluded.observed_on,data=metric_state.data||excluded.data,refreshed_at=now();
      end if;
    end loop;

    -- A cancellation report row is always a request.  Its outcome is derived
    -- only from the matched contract after the request date.  The OS opener is
    -- retained as evidence and is never used as the portfolio seller.
    delete from metric_rows where base_code=selected_base and kind in
      ('cancellation_request','cancellation_effective','cancellation_reversed','cancellation_pending');
    with orders as (
      select r.*,v.classification manual_class,v.contract_id manual_contract,v.note manual_note
      from base_rows_on(cutoff,selected_base)r left join cancellation_review v
        on v.base_code=selected_base and v.service_order=r.external_key
      where r.source='cancellation_orders' and r.event_day>=date '2026-01-01'
    ), stats as (
      select o.*,
        count(c.*) candidates,
        count(c.*)filter(where (c.payload->>'cancelled')::date>=o.event_day) cancelled_after,
        count(c.*)filter(where normalize(c.payload->>'status')='ATIVO' and c.payload->>'cancelled' is null) active_now,
        min(c.external_key)filter(where (c.payload->>'cancelled')::date>=o.event_day) cancelled_contract,
        min(c.external_key)filter(where normalize(c.payload->>'status')='ATIVO' and c.payload->>'cancelled' is null) active_contract,
        min(c.external_key) only_contract,jsonb_agg(jsonb_build_object('contract',c.external_key,'status',c.payload->>'status',
          'seller',c.payload->>'seller','cancelled',c.payload->>'cancelled','value',c.payload->>'total'))filter(where c.external_key is not null) candidate_list
      from orders o left join base_rows_on(cutoff,selected_base)c on c.source='contracts'
        and normalize(c.payload->>'client')=normalize(o.payload->>'client')
      group by o.base_code,o.source,o.external_key,o.valid_from,o.valid_until,o.event_day,o.payload,o.file_id,o.row_number,
        o.manual_class,o.manual_contract,o.manual_note
    ), matched as (
      select s.*,coalesce(manual_contract,case when cancelled_after=1 then cancelled_contract when candidates=1 then only_contract
        when cancelled_after=0 and active_now=1 then active_contract end) matched_contract
      from stats s
    ), decided as (
      select m.*,c.payload contract_payload,case
        when manual_class is not null then manual_class
        when matched_contract is null then 'pending'
        when (c.payload->>'cancelled')::date>=m.event_day then 'effective'
        when normalize(c.payload->>'status')='ATIVO' and c.payload->>'cancelled' is null then 'reversed'
        else 'pending' end outcome
      from matched m left join base_rows_on(cutoff,selected_base)c on c.source='contracts' and c.external_key=m.matched_contract
    ), rows as (
      select 'cancellation_request' kind,* from decided
      union all select case outcome when 'effective' then 'cancellation_effective' when 'reversed' then 'cancellation_reversed'
        else 'cancellation_pending' end kind,* from decided
    )
    insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,product,details)
    select selected_base,date_trunc('month',event_day)::date,kind,external_key,seller_for(contract_payload->>'seller'),event_day,
      coalesce(payload->>'client','Atendimento '||external_key),case when kind='cancellation_request' then null else (contract_payload->>'total')::numeric end,
      contract_payload->>'city',contract_payload->>'description',jsonb_build_object('service_order',external_key,'contract',matched_contract,
        'client',payload->>'client','seller_source',contract_payload->>'seller','attendant',payload->>'attendant',
        'opening_responsible',payload->>'opening_responsible','status',payload->>'status','subject',payload->>'subject',
        'original_text',payload->>'original_text','classification',case when kind='cancellation_request' then 'request' else outcome end,
        'needs_review',outcome='pending','manual_review',manual_class is not null,'review_note',manual_note,
        'match_rule',case when manual_contract is not null then 'manual_contract' when cancelled_after=1 then 'single_cancellation_after_request'
          when candidates=1 then 'single_client_contract' when cancelled_after=0 and active_now=1 then 'single_active_contract' else 'ambiguous_client_contracts' end,
        'candidate_contracts',coalesce(candidate_list,'[]'::jsonb)) from rows;

    update metric_state set data=data||jsonb_build_object('cancellation_orders',exists(
      select from source_observations where base_code=selected_base and source='cancellation_orders' and observed_on<=cutoff))
    where base_code=selected_base and month between date '2026-01-01' and date_trunc('month',cutoff)::date;
  end loop;
end$$;

create or replace function comercial.save_correction(issue_kind text,selected_base text,row_id text,new_value jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,comercial as $$
declare cutoff date; current_map jsonb;
begin
  if not comercial.is_admin() then raise exception 'Acesso restrito' using errcode='42501';end if;
  if issue_kind='goal' then
    if not exists(select from sellers where seller_key=new_value->>'seller') then raise exception 'Vendedor inválido';end if;
    insert into sales_review(contract_id,seller_key,items,note)values(case when selected_base='legacy' then row_id else selected_base||':'||row_id end,
      new_value->>'seller',jsonb_build_array(jsonb_build_object('product',new_value->>'product','total',(new_value->>'total')::numeric)),new_value->>'note')
    on conflict(contract_id)do update set seller_key=excluded.seller_key,items=excluded.items,note=excluded.note,updated_at=now();
  elsif issue_kind='contract_link' then
    select value into current_map from settings where setting='contract_clients';
    current_map:=coalesce(current_map,'{}')||jsonb_build_object(selected_base||':'||row_id,new_value->>'client');
    insert into settings(setting,value)values('contract_clients',current_map)on conflict(setting)do update set value=excluded.value;
  elsif issue_kind='cancellation' then
    insert into cancellation_review(base_code,service_order,classification,contract_id,note,updated_by)
      values(selected_base,row_id,new_value->>'classification',nullif(new_value->>'contract',''),new_value->>'note',comercial.email())
    on conflict(base_code,service_order)do update set classification=excluded.classification,contract_id=excluded.contract_id,
      note=excluded.note,updated_by=excluded.updated_by,updated_at=now();
  else raise exception 'Tipo de correção inválido';end if;
  select max(observed_on)into cutoff from source_loads;if cutoff is not null then perform refresh_all(cutoff);end if;
end$$;

do $$declare cutoff date;begin select max(observed_on)into cutoff from comercial.source_loads;
  if cutoff is not null then perform comercial.refresh_all(cutoff);end if;end$$;
commit;
