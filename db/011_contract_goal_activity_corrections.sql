begin;

create table if not exists comercial.cancellation_review(
  base_code text not null check(base_code in ('old','new','legacy')),
  service_order text not null,
  classification text not null check(classification in ('request','effective','reversed','pending')),
  note text not null,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key(base_code,service_order)
);

do $$begin
  if to_regprocedure('comercial.refresh_base_month_before_contract_goal_activity(date,date,text)') is null then
    alter function comercial.refresh_base_month(date,date,text) rename to refresh_base_month_before_contract_goal_activity;
  end if;
end$$;

create or replace function comercial.refresh_base_month(period date,cutoff date,selected_base text) returns void
language plpgsql set search_path=pg_catalog,comercial,pg_temp as $$
declare until_day date:=least(cutoff,(period+interval '1 month - 1 day')::date);
begin
  perform comercial.refresh_base_month_before_contract_goal_activity(period,cutoff,selected_base);

  -- A meta usa o valor total do contrato mais recente de cada cliente.
  delete from metric_rows where base_code=selected_base and month=period and kind in ('goal_sale','goal_pending');
  with raw_contracts as (
    select c.external_key contract_id,
      coalesce(d.payload->>'client_key',l.payload->>'client_key',c.payload->>'client_key') client_id,
      coalesce((d.payload->>'activated')::date,(l.payload->>'activated')::date,(c.payload->>'activated')::date) activated,
      coalesce((d.payload->>'total')::numeric,(l.payload->>'total')::numeric) contract_total,
      c.payload,coalesce(c.payload->>'description','Contrato '||c.external_key) description
    from comercial.base_rows_on(cutoff,selected_base) c
    left join lateral(select payload from comercial.base_rows_on(cutoff,selected_base) x
      where x.source='contract_details' and x.external_key=c.external_key limit 1)d on true
    left join lateral(select payload from comercial.base_rows_on(cutoff,selected_base) x
      where x.source='contract_links' and x.external_key=c.external_key limit 1)l on true
    where c.source='contracts'
  ), ranked as (
    select *,row_number() over(partition by client_id order by activated desc nulls last,contract_id desc) latest
    from raw_contracts
  ), prepared as (
    select r.*,a.seller_key,a.label,a.city,a.branch,a.product,
      comercial.goal_classification(r.description) class,
      v.seller_key reviewed_seller,v.items reviewed_items
    from ranked r left join metric_rows a on a.base_code=selected_base and a.month=period and a.kind='activation' and a.row_key=r.contract_id
    left join sales_review v on v.contract_id=case when selected_base='legacy' then r.contract_id else selected_base||':'||r.contract_id end
    where r.latest=1 and r.activated between period and until_day
  ), valued as (
    select p.*,coalesce((select sum((item->>'total')::numeric) from jsonb_array_elements(p.reviewed_items)item),p.contract_total) total,
      coalesce((select item->>'product' from jsonb_array_elements(p.reviewed_items)item limit 1),p.description) goal_description
    from prepared p
  ), classified as (
    select v.*,comercial.goal_classification(v.goal_description) goal_class from valued v
  )
  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
  select selected_base,period,
    case when coalesce(reviewed_seller,seller_key) is not null and total is not null and goal_class->>'status'='classified' then 'goal_sale' else 'goal_pending' end,
    contract_id,coalesce(reviewed_seller,seller_key),activated,coalesce(label,'Contrato '||contract_id),
    case when goal_class->>'status'='classified' then total*(goal_class->>'rate')::numeric end,city,branch,product,
    jsonb_build_object('contract',contract_id,'client',client_id,'contract_total',total,'gross',total,'original_description',goal_description,
      'category',goal_class->>'category','rate',case when goal_class?'rate' then (goal_class->>'rate')::numeric end,
      'calculation','latest_client_contract_value_x_goal_rate','reason',case
        when client_id is null then 'Cliente não vinculado ao contrato'
        when coalesce(reviewed_seller,seller_key) is null then 'Vendedor não confirmado'
        when total is null then 'Valor total do contrato não localizado'
        when goal_class->>'status'<>'classified' then 'Descrição do contrato sem classificação automática' end)
  from classified;

  -- Toda atividade registrada conta como visita, sem filtro de assunto ou status.
  delete from metric_rows where base_code=selected_base and month=period and kind in ('visit_coverage','visit_task','prospect_visit');
  if selected_base in ('new','legacy') then
    insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,details)
    select selected_base,period,'visit_task',r.external_key,comercial.seller_for(r.payload->>'seller'),
      coalesce((r.payload->>'planned')::date,r.event_day),coalesce(r.payload->>'subject','Atividade '||r.external_key),1,
      jsonb_build_object('task',r.external_key,'client',r.payload->>'client_key','subject',r.payload->>'subject',
        'status',r.payload->>'status','method','Toda atividade registrada conta como visita')
    from comercial.base_rows_on(cutoff,selected_base)r where r.source='activities'
      and coalesce((r.payload->>'planned')::date,r.event_day) between period and until_day;
  end if;

  update metric_rows m set kind=case v.classification when 'request' then 'cancellation_request'
      when 'effective' then 'cancellation_effective' when 'reversed' then 'cancellation_reversed' else 'cancellation_pending' end,
    details=m.details||jsonb_build_object('classification',v.classification,'manual_review',true,'review_note',v.note)
  from cancellation_review v where m.base_code=v.base_code and m.row_key=v.service_order and m.month=period
    and m.kind in ('cancellation_request','cancellation_effective','cancellation_reversed','cancellation_pending');
end$$;

create or replace function comercial.correction_queue() returns jsonb
language sql stable security definer set search_path=pg_catalog,comercial as $$
  with issues as (
    select 'goal:'||base_code||':'||month||':'||row_key key,'goal' kind,base_code,month,row_key,label,
      coalesce(details->>'reason','Ativação não validada') reason,details from metric_rows where kind='goal_pending'
    union all
    select 'contract:'||base_code||':'||month||':'||row_key,'contract_link',base_code,month,row_key,label,
      'Contrato ativo sem vínculo confirmado com cliente',details from metric_rows where kind='active_contract' and details->>'client' is null
    union all
    select 'cancel:'||base_code||':'||month||':'||row_key,'cancellation',base_code,month,row_key,label,
      'Atendimento de cancelamento requer classificação manual',details from metric_rows where kind='cancellation_pending'
    union all
    select 'file:'||f.id,'import',b.base_code,null::date,f.id::text,f.name,
      coalesce(f.error,'Importação com avisos'),jsonb_build_object('status',f.status,'issues',f.issues)
    from import_files f join import_batches b on b.id=f.batch_id where f.status='failed' or jsonb_array_length(f.issues)>0
  ) select case when comercial.is_admin() then coalesce(jsonb_agg(to_jsonb(i) order by month desc nulls last,kind,label),'[]') else '[]' end
  from (select * from issues order by month desc nulls last limit 500)i
$$;

create or replace function comercial.save_correction(issue_kind text,selected_base text,row_id text,new_value jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,comercial as $$
declare cutoff date; current_map jsonb;
begin
  if not comercial.is_admin() then raise exception 'Acesso restrito' using errcode='42501';end if;
  if issue_kind='goal' then
    if not exists(select from sellers where seller_key=new_value->>'seller') then raise exception 'Vendedor inválido';end if;
    insert into sales_review(contract_id,seller_key,items,note) values(
      case when selected_base='legacy' then row_id else selected_base||':'||row_id end,new_value->>'seller',
      jsonb_build_array(jsonb_build_object('product',new_value->>'product','total',(new_value->>'total')::numeric)),new_value->>'note')
    on conflict(contract_id)do update set seller_key=excluded.seller_key,items=excluded.items,note=excluded.note,updated_at=now();
  elsif issue_kind='contract_link' then
    select value into current_map from settings where setting='contract_clients';
    current_map:=coalesce(current_map,'{}')||jsonb_build_object(selected_base||':'||row_id,new_value->>'client');
    insert into settings(setting,value)values('contract_clients',current_map)on conflict(setting)do update set value=excluded.value;
  elsif issue_kind='cancellation' then
    insert into cancellation_review(base_code,service_order,classification,note,updated_by)
      values(selected_base,row_id,new_value->>'classification',new_value->>'note',comercial.email())
    on conflict(base_code,service_order)do update set classification=excluded.classification,note=excluded.note,updated_by=excluded.updated_by,updated_at=now();
  else raise exception 'Tipo de correção inválido';end if;
  select max(observed_on)into cutoff from source_loads;if cutoff is not null then perform refresh_all(cutoff);end if;
end$$;

revoke execute on function comercial.correction_queue(),comercial.save_correction(text,text,text,jsonb) from public;
grant execute on function comercial.correction_queue(),comercial.save_correction(text,text,text,jsonb) to lb_dashboard;

do $$declare cutoff date;begin select max(observed_on)into cutoff from comercial.source_loads;
  if cutoff is not null then perform comercial.refresh_all(cutoff);end if;end$$;
commit;
