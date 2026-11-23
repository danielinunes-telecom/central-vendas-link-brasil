begin;

create table if not exists comercial.monthly_justifications(
  seller_key text not null references comercial.sellers,
  month date not null check(extract(day from month)=1),
  justification text not null default '',
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key(seller_key,month)
);
alter table comercial.monthly_justifications enable row level security;
drop policy if exists monthly_justifications_read on comercial.monthly_justifications;
create policy monthly_justifications_read on comercial.monthly_justifications for select to lb_dashboard using(
  exists(select from comercial.profile() p where p.role in ('admin','manager') or p.seller_key=monthly_justifications.seller_key));
drop policy if exists monthly_justifications_write on comercial.monthly_justifications;
create policy monthly_justifications_write on comercial.monthly_justifications for all to lb_dashboard using(
  exists(select from comercial.profile() p where p.role in ('admin','manager') or p.seller_key=monthly_justifications.seller_key)) with check(
  exists(select from comercial.profile() p where p.role in ('admin','manager') or p.seller_key=monthly_justifications.seller_key));
grant select,insert,update on comercial.monthly_justifications to lb_dashboard;

create or replace function comercial.goal_classification(description text) returns jsonb
language plpgsql immutable parallel safe set search_path=pg_catalog,comercial as $$
declare n text:=comercial.normalize(description); category text; rate numeric; hits integer:=0;
begin
  -- LINK has explicit precedence: LINK CDNTV E FIBRA is LINK, never CDNTV.
  if n ~ '(^| )LINK( |$)' then category:='LINK'; rate:=0.25;
  else
    if n ~ '(^| )OBRA( |$)' then category:='OBRA';rate:=0.03;hits:=hits+1;end if;
    if n ~ '(^| )CDNTV( |$)' then category:='CDNTV';rate:=1;hits:=hits+1;end if;
    if n ~ '(^| )MITIGACAO( |$)' then category:='MITIGAÇÃO';rate:=1;hits:=hits+1;end if;
    if n ~ '(^| )TRANSPORTE( |$)' then category:='TRANSPORTE';rate:=0.25;hits:=hits+1;end if;
    if n ~ '(^| )PNI( |$)' then category:='PNI';rate:=0.25;hits:=hits+1;end if;
    if n ~ '(^| )GLOBAL +CROSS( |$)' then category:='GLOBAL CROSS';rate:=0.25;hits:=hits+1;end if;
    if hits>1 then return jsonb_build_object('status','ambiguous','normalized',n);end if;
  end if;
  if category is null then return jsonb_build_object('status','unmatched','normalized',n);end if;
  return jsonb_build_object('status','classified','normalized',n,'category',category,'rate',rate);
end $$;

do $$begin
  if to_regprocedure('comercial.refresh_base_month_before_product_rules(date,date,text)') is null then
    alter function comercial.refresh_base_month(date,date,text) rename to refresh_base_month_before_product_rules;
  end if;
end$$;
create or replace function comercial.refresh_base_month(period date,cutoff date,selected_base text) returns void
language plpgsql set search_path=pg_catalog,comercial,pg_temp as $$
declare until_day date:=least(cutoff,(period+interval '1 month - 1 day')::date);
begin
  perform comercial.refresh_base_month_before_product_rules(period,cutoff,selected_base);

  -- Reclassify every activation item; unknown and ambiguous descriptions become review items.
  with classified as (
    select ctid,comercial.goal_classification(coalesce(details->>'product',product)) value
    from metric_rows where base_code=selected_base and month=period and kind='goal_sale'
  )
  update metric_rows m set
    kind=case when c.value->>'status'='classified' then 'goal_sale' else 'goal_pending' end,
    amount=case when c.value->>'status'='classified' then (m.details->>'gross')::numeric*(c.value->>'rate')::numeric else null end,
    details=m.details||jsonb_build_object('original_description',coalesce(m.details->>'product',m.product),'category',c.value->>'category',
      'rate',case when c.value?'rate' then (c.value->>'rate')::numeric else null end,'classification_status',c.value->>'status',
      'calculation','product_value_x_goal_rate','reason',case c.value->>'status' when 'unmatched' then 'Descrição sem correspondência; revisar' when 'ambiguous' then 'Descrição ambígua; revisar' end)
  from classified c where m.ctid=c.ctid;

  -- Renewal state uses contract expiry, never invoice due date. Expired wins over pending.
  delete from metric_rows where base_code=selected_base and month=period and kind in ('expired','renewal_pending');
  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
  select selected_base,period,case when (r.payload->>'expires')::date<until_day then 'expired' else 'renewal_pending' end,
    a.row_key,a.seller_key,(r.payload->>'expires')::date,a.label,1,a.city,a.branch,a.product,
    a.details||jsonb_build_object('expires',r.payload->>'expires','days_since_expiry',greatest(until_day-(r.payload->>'expires')::date,0),
      'renewal_status',case when (r.payload->>'expires')::date<until_day then 'Vencido' else 'Pendente de renovação' end)
  from metric_rows a join lateral(
    select payload from records r where r.base_code=selected_base and r.source='contracts' and r.external_key=a.row_key
      and r.valid_from<=until_day and (r.valid_until is null or r.valid_until>until_day) order by r.valid_from desc limit 1
  ) r on true
  where a.base_code=selected_base and a.month=period and a.kind='active_contract' and r.payload->>'expires' is not null
    and (r.payload->>'expires')::date<=until_day+60;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
  select selected_base,period,case r.payload->>'classification' when 'request' then 'cancellation_request'
      when 'effective' then 'cancellation_effective' when 'reversed' then 'cancellation_reversed' else 'cancellation_pending' end,
    r.external_key,coalesce(a.seller_key,comercial.seller_for(r.payload->>'portfolio_seller')),r.event_day,
    coalesce(r.payload->>'client',a.label,'Atendimento '||r.external_key),(r.payload->>'value')::numeric,a.city,a.branch,a.product,
    jsonb_build_object('service_order',r.external_key,'contract',r.payload->>'contract_key','client',r.payload->>'client_key',
      'attendant',r.payload->>'attendant','reason',r.payload->>'reason','status',r.payload->>'status','subject',r.payload->>'subject',
      'original_text',r.payload->>'original_text','evidence',r.payload->>'evidence','classification',r.payload->>'classification',
      'needs_review',coalesce((r.payload->>'needs_review')::boolean,true))
  from comercial.base_rows_on(cutoff,selected_base) r left join metric_rows a on a.base_code=selected_base and a.month=period
    and a.kind='active_contract' and a.row_key=r.payload->>'contract_key'
  where r.source='cancellation_orders' and r.event_day between period and until_day
  on conflict(base_code,month,kind,row_key) do update set details=excluded.details,amount=excluded.amount,seller_key=excluded.seller_key;

  update metric_state set data=data||jsonb_build_object('cancellation_orders',exists(
    select from source_observations s where s.base_code=selected_base and s.source='cancellation_orders' and s.observed_on<=cutoff))
  where base_code=selected_base and month=period;
end $$;

do $$ declare cutoff date;begin
  select max(observed_on) into cutoff from comercial.source_loads;
  if cutoff is not null then perform comercial.refresh_all(cutoff);end if;
end $$;
commit;
