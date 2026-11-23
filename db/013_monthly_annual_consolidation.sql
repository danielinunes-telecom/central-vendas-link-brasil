begin;

-- Annual summary v2
-- 1. Rebuilds event indicators in their own month from all imported history.
-- 2. Goals only include contracts whose latest imported status is ACTIVE.
-- 3. System adjustments and unfinished installations remain auditable, but are
--    excluded from the cancellation KPI.

create or replace function comercial.excluded_cancellation_reason(reason text) returns boolean
language sql immutable parallel safe set search_path=pg_catalog,comercial as $$
  select comercial.normalize(reason) in ('INSTALACAO NAO CONCLUIDA','ACERTO DE SISTEMA')
$$;

do $$begin
  if to_regprocedure('comercial.refresh_before_monthly_annual(date)') is null then
    alter function comercial.refresh_all(date) rename to refresh_before_monthly_annual;
  end if;
end;$$;

create or replace function comercial.refresh_all(cutoff date) returns void
language plpgsql set search_path=pg_catalog,comercial,pg_temp as $$
declare period date; selected_base text; until_day date; crm_available boolean;
begin
  perform comercial.refresh_before_monthly_annual(cutoff);
  perform pg_advisory_xact_lock(211688);
  crm_available:=exists(select from source_loads where base_code='new' and observed_on<=cutoff);

  for selected_base in select distinct base_code from source_loads where observed_on<=cutoff order by base_code loop
    for period in select d::date from generate_series(date '2026-01-01',date_trunc('month',cutoff)::date,interval '1 month')d loop
      until_day:=least(cutoff,(period+interval '1 month - 1 day')::date);

      -- Expenses are events. Reimporting a file updates the month of the event,
      -- never the month in which the file happened to be uploaded.
      delete from metric_rows where base_code=selected_base and month=period and kind='expense';
      insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,details)
      select selected_base,period,'expense',r.external_key,seller_for(r.payload->>'seller'),r.event_day,
        coalesce(r.payload->>'category','Sem categoria'),(r.payload->>'total')::numeric,
        jsonb_build_object('category',case
          when normalize(r.payload->>'category')='COMBUSTIVEL' then 'Combustível'
          when normalize(r.payload->>'category') in ('ALMOCO','JANTAR','ALMOCO COM CLIENTE','JANTAR COM CLIENTE','CAFE DA MANHA','CAFE COM CLIENTE') then 'Alimentação'
          when normalize(r.payload->>'category')='HOSPEDAGEM' then 'Hospedagem'
          else 'Extras' end,'seller',r.payload->>'seller','vehicle',r.payload->>'equipment','trip',r.payload->>'trip',
          'excess',case when normalize(r.payload->>'category') in ('ALMOCO','JANTAR')
            then greatest(0,(r.payload->>'total')::numeric-(setting_value('expense_limits')->>'meal')::numeric)
            when normalize(r.payload->>'category')='HOSPEDAGEM' and coalesce((r.payload->>'people')::numeric,0)>0
              and coalesce((r.payload->>'nights')::numeric,0)>0
            then greatest(0,(r.payload->>'total')::numeric-(setting_value('expense_limits')->>'lodging')::numeric*
              (r.payload->>'people')::numeric*(r.payload->>'nights')::numeric) end)
      from base_rows_on(cutoff,selected_base)r
      where r.source='expenses' and r.event_day between period and until_day and r.payload->>'total' is not null;

      -- CRM exists only in New Base. If the installation still only has the old
      -- legacy import, legacy is used as a compatibility fallback.
      delete from metric_rows where base_code=selected_base and month=period and kind in ('visit_task','lead_new','lead_won');
      if selected_base='new' or (selected_base='legacy' and not crm_available) then
        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,details)
        select selected_base,period,'visit_task','activity:'||r.external_key,
          coalesce(owner.seller,seller_for(r.payload->>'seller')),
          coalesce((r.payload->>'planned')::date,r.event_day),
          coalesce(owner.client,r.payload->>'subject','Atividade '||r.external_key),1,
          jsonb_build_object('task',r.external_key,'client',r.payload->>'client_key','subject',r.payload->>'subject',
            'status',r.payload->>'status','method','Toda atividade registrada conta como visita')
        from base_rows_on(cutoff,selected_base)r
        left join lateral(
          select seller_for(c.payload->>'seller') seller,c.payload->>'client' client
          from base_rows_on(cutoff,case when selected_base='new' and exists(select from source_loads where base_code='old') then 'old' else selected_base end)c
          where c.source='contracts' and c.payload->>'client_key'=r.payload->>'client_key'
            and normalize(c.payload->>'status')='ATIVO'
          order by (c.payload->>'activated')::date desc nulls last,c.external_key desc limit 1
        )owner on true
        where r.source='activities' and coalesce((r.payload->>'planned')::date,r.event_day) between period and until_day;

        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,details)
        select selected_base,period,'visit_task','negotiation:'||r.external_key,seller_for(r.payload->>'seller'),r.event_day,
          coalesce(r.payload->>'client','Relacionamento '||r.external_key),1,
          jsonb_build_object('deal',r.external_key,'client',r.payload->>'client_key','type',r.payload->>'type',
            'status',r.payload->>'status','method','Negociação RELACIONAMENTO conta como visita')
        from base_rows_on(cutoff,selected_base)r where r.source='negotiations' and r.event_day between period and until_day
          and normalize(r.payload->>'type')='RELACIONAMENTO';

        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,details)
        select selected_base,period,'lead_new',r.external_key,seller_for(r.payload->>'seller'),r.event_day,
          coalesce(r.payload->>'name','Lead '||r.external_key),1,r.payload->>'city',
          jsonb_build_object('lead',r.external_key,'client',r.payload->>'client_key')
        from base_rows_on(cutoff,selected_base)r where r.source='leads' and r.event_day between period and until_day;

        with leads as(
          select l.*,won.activated from base_rows_on(cutoff,selected_base)l
          left join lateral(
            select min((c.payload->>'activated')::date) activated from base_rows_on(cutoff,selected_base)c
            where c.source='contracts' and c.payload->>'client_key'=l.payload->>'client_key'
              and (c.payload->>'activated')::date>=l.event_day
          )won on true where l.source='leads'
        )
        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,details)
        select selected_base,period,'lead_won',external_key,seller_for(payload->>'seller'),activated,
          coalesce(payload->>'name','Lead '||external_key),1,payload->>'city',
          jsonb_build_object('lead',external_key,'client',payload->>'client_key')
        from leads where activated between period and until_day;
      end if;

      insert into metric_state(base_code,month,observed_on,data) values(selected_base,period,until_day,
        jsonb_build_object(
          'expenses',exists(select from source_observations s where s.base_code=selected_base and s.source='expenses'
            and s.observed_on<=cutoff and (s.scope_start is null or (s.scope_start<=until_day and s.scope_end>=period))),
          'visits',(selected_base='new' or (selected_base='legacy' and not crm_available)) and exists(
            select from source_observations s where s.base_code=selected_base and s.source in ('activities','negotiations')
              and s.observed_on<=cutoff and (s.scope_start is null or (s.scope_start<=until_day and s.scope_end>=period))),
          'leads',(selected_base='new' or (selected_base='legacy' and not crm_available)) and exists(
            select from source_observations s where s.base_code=selected_base and s.source='leads'
              and s.observed_on<=cutoff and (s.scope_start is null or (s.scope_start<=until_day and s.scope_end>=period))))
      on conflict(base_code,month)do update set observed_on=greatest(metric_state.observed_on,excluded.observed_on),
        data=metric_state.data||excluded.data,refreshed_at=now();
    end loop;

    -- A sale contributes to the goal only while the selected latest contract is active.
    delete from metric_rows m where m.base_code=selected_base and m.kind in ('goal_sale','goal_pending')
      and not exists(select from base_rows_on(cutoff,selected_base)c where c.source='contracts'
        and c.external_key=coalesce(m.details->>'contract',m.row_key) and normalize(c.payload->>'status')='ATIVO');

    -- Keep the evidence, but do not include these operational reasons in any KPI.
    update metric_rows set details=details-'excluded_from_kpi'-'exclusion_reason'-'cancellation_reason'
    where base_code=selected_base and kind in ('cancellation','cancellation_effective');
    update metric_rows m set details=m.details||jsonb_build_object('excluded_from_kpi',true,
      'exclusion_reason','Motivo operacional desconsiderado','cancellation_reason',coalesce(c.payload->>'cancellation_reason',m.details->>'reason'))
    from base_rows_on(cutoff,selected_base)c
    where m.base_code=selected_base and m.kind in ('cancellation','cancellation_effective')
      and c.source='contracts' and c.external_key=coalesce(m.details->>'contract',m.row_key)
      and excluded_cancellation_reason(coalesce(c.payload->>'cancellation_reason',m.details->>'reason'));
  end loop;
end;$$;

do $$declare cutoff date;begin
  select max(observed_on)into cutoff from comercial.source_loads;
  if cutoff is not null then perform comercial.refresh_all(cutoff);end if;
end;$$;

commit;
