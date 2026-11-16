begin;

-- Historical uploads have no trustworthy origin label. Preserve them separately.
alter table comercial.import_batches add column base_code text not null default 'legacy'
  check (base_code in ('legacy','old','new'));
alter table comercial.source_loads add column base_code text not null default 'legacy'
  check (base_code in ('legacy','old','new'));
alter table comercial.source_observations add column base_code text not null default 'legacy'
  check (base_code in ('legacy','old','new'));
alter table comercial.records add column base_code text not null default 'legacy'
  check (base_code in ('legacy','old','new'));
alter table comercial.metric_rows add column base_code text not null default 'legacy'
  check (base_code in ('legacy','old','new'));
alter table comercial.metric_state add column base_code text not null default 'legacy'
  check (base_code in ('legacy','old','new'));
alter table comercial.source_loads drop constraint source_loads_pkey, add primary key(base_code,source);
alter table comercial.source_observations drop constraint source_observations_pkey, add primary key(base_code,source,observed_on);
alter table comercial.records drop constraint records_pkey, add primary key(base_code,source,external_key,valid_from);
alter table comercial.metric_rows drop constraint metric_rows_pkey, add primary key(base_code,month,kind,row_key);
alter table comercial.metric_state drop constraint metric_state_pkey, add primary key(base_code,month);

drop index comercial.records_current;
create unique index records_current on comercial.records(base_code,source,external_key) where valid_until is null;

create function comercial.client_identity(document text) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare
  digits text := regexp_replace(coalesce(document,''),'[^0-9]','','g');
  size int := length(digits);
  i int; j int; weight int; total int; expected int;
begin
  if size not in (11,14) or digits=repeat(left(digits,1),size) then return null; end if;
  for i in size-1..size loop
    total := 0;
    for j in 1..i-1 loop
      weight := case when size=11 then i+1-j else ((i-1-j)%8)+2 end;
      total := total+substr(digits,j,1)::int*weight;
    end loop;
    expected := case when total%11<2 then 0 else 11-total%11 end;
    if substr(digits,i,1)::int<>expected then return null; end if;
  end loop;
  return md5('link-brasil:carteira:'||digits);
end $$;

create function comercial.base_rows_on(cutoff date, selected_base text)
returns setof comercial.records language sql stable
as $$ select r.* from comercial.records r where r.base_code=selected_base
  and r.valid_from<=cutoff and (r.valid_until is null or r.valid_until>cutoff) $$;

create function comercial.base_mapping(key text, selected_base text) returns jsonb
language sql stable set search_path = pg_catalog, comercial as $$
  select case when selected_base='legacy' then setting_value(key) else
    coalesce((select jsonb_object_agg(substr(m.key,length(selected_base)+2),m.value)
      from jsonb_each(setting_value(key)) m where starts_with(m.key,selected_base||':')),'{}') end
$$;

create function comercial.refresh_base_month(period date, cutoff date, selected_base text) returns void
language plpgsql set search_path = pg_catalog, comercial, pg_temp as $$
declare
  until_day date := least(cutoff, (period + interval '1 month - 1 day')::date);
  window_start date := (period - 1);
  initial_known boolean;
  final_known boolean;
  visit_history_known boolean;
  visit_terms jsonb := setting_value('visit_rules')->'visit';
  prospect_terms jsonb := setting_value('visit_rules')->'prospect';
  lodging_limit numeric := (setting_value('expense_limits')->>'lodging')::numeric;
  meal_limit numeric := (setting_value('expense_limits')->>'meal')::numeric;
begin
  if period < date '2026-11-01' or until_day < period then return; end if;
  select exists(select from source_observations where base_code=selected_base and source='contracts' and observed_on <= window_start)
    into initial_known;
  select exists(select from source_observations where base_code=selected_base and source='contracts' and observed_on <= until_day)
    into final_known;
  select coalesce(range_agg(daterange(scope_start,scope_end,'[]')) @> daterange(until_day-60,until_day,'[]'),false)
    into visit_history_known
    from source_observations where base_code=selected_base and source='activities' and observed_on<=cutoff and scope_start is not null and scope_end is not null;

  delete from metric_rows where month=period and base_code=selected_base;
  drop table if exists pg_temp.lb_data, pg_temp.lb_customers, pg_temp.lb_contracts,
    pg_temp.lb_opening, pg_temp.lb_acts, pg_temp.lb_first_visit, pg_temp.lb_coverage, pg_temp.lb_titles,
    pg_temp.lb_titles_opening, pg_temp.lb_opening_customers;
  create temp table lb_data on commit drop as
    select * from base_rows_on(cutoff,selected_base);
  create index on lb_data(source,external_key);
  create index on lb_data(source,(payload->>'contract_key'));
  create temp table lb_customers on commit drop as
    select external_key as id, payload as p, seller_for(payload->>'seller') as seller
    from base_rows_on(until_day,selected_base) where source='customers';
  create index on lb_customers(id);
  create index on lb_customers(comercial.normalize(p->>'name'));
  create index on lb_customers(comercial.normalize(p->>'trading_name'));
  create temp table lb_opening_customers on commit drop as
    select external_key id,payload p,seller_for(payload->>'seller') seller
    from base_rows_on(window_start,selected_base) where source='customers';
  create index on lb_opening_customers(id);
  create index on lb_opening_customers(comercial.normalize(p->>'name'));
  create index on lb_opening_customers(comercial.normalize(p->>'trading_name'));
  create temp table lb_contracts on commit drop as
    select r.external_key id, r.payload || jsonb_build_object('document',c.p->>'document') p, c.id client_id, c.seller,
      coalesce(c.p->>'name',r.payload->>'client','Contrato '||r.external_key) label,
      coalesce(c.p->>'city',r.payload->>'city') city,
      coalesce(c.p->>'branch',r.payload->>'branch') branch,
      product_for(case when selected_base='legacy' then r.payload->>'plan_key' else selected_base||':'||(r.payload->>'plan_key') end,r.payload->>'description') product
    from base_rows_on(until_day,selected_base) r
    left join lateral (
      select case when count(*)=1 then min(m.id) end id from lb_customers m
      where
        m.id = coalesce(r.payload->>'client_key', base_mapping('contract_clients',selected_base)->>r.external_key)
        or (coalesce(r.payload->>'client_key',base_mapping('contract_clients',selected_base)->>r.external_key) is null
          and comercial.normalize(r.payload->>'client') <> ''
          and comercial.normalize(r.payload->>'client') in (comercial.normalize(m.p->>'name'),comercial.normalize(m.p->>'trading_name')))
    ) link on true
    left join lb_customers c on c.id=link.id
    where r.source='contracts';
  create index on lb_contracts(id);
  create index on lb_contracts(client_id);
  create temp table lb_opening on commit drop as
    select r.external_key id,r.payload || jsonb_build_object('document',c.p->>'document') p,c.id client_id,c.seller,
      coalesce(c.p->>'name',r.payload->>'client','Contrato '||r.external_key) label,
      coalesce(c.p->>'city',r.payload->>'city') city,
      coalesce(c.p->>'branch',r.payload->>'branch') branch,
      product_for(case when selected_base='legacy' then r.payload->>'plan_key' else selected_base||':'||(r.payload->>'plan_key') end,r.payload->>'description') product
    from base_rows_on(window_start,selected_base) r
    left join lateral (
      select case when count(*)=1 then min(m.id) end id
      from lb_opening_customers m where (
        m.id=coalesce(r.payload->>'client_key',base_mapping('contract_clients',selected_base)->>r.external_key)
        or (coalesce(r.payload->>'client_key',base_mapping('contract_clients',selected_base)->>r.external_key) is null
          and comercial.normalize(r.payload->>'client') <> ''
          and comercial.normalize(r.payload->>'client') in (comercial.normalize(m.p->>'name'),comercial.normalize(m.p->>'trading_name')))
      )
    ) link on true
    left join lb_opening_customers c on c.id=link.id
    where r.source='contracts' and comercial.normalize(r.payload->>'status')='ATIVO';
  create index on lb_opening(id);
  create temp table lb_titles on commit drop as
    select distinct on (external_key) external_key id,payload p,file_id,row_number
    from lb_data where source in ('titles','open_titles','payments')
    order by external_key, valid_from desc,
      case source when 'titles' then 0 when 'payments' then 1 else 2 end;
  create temp table lb_titles_opening on commit drop as
    select distinct on (external_key) external_key id,payload p
    from base_rows_on(window_start,selected_base) where source in ('titles','open_titles','payments')
    order by external_key,valid_from desc,case source when 'titles' then 0 when 'payments' then 1 else 2 end;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,'active_contract',id,seller,until_day,label,1,city,branch,product,
      jsonb_build_object('contract',id,'client',client_id,'identity',client_identity(p->>'document'),'access',p->>'access','description',p->>'description')
    from lb_contracts where comercial.normalize(p->>'status')='ATIVO'
    union all
    select selected_base,period,'opening_contract',id,seller,window_start,label,1,city,branch,product,
      jsonb_build_object('contract',id,'client',client_id,'identity',client_identity(p->>'document'))
    from lb_opening;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,v.kind,c.id,coalesce(seller_for(history.payload->>'seller'),c.seller),v.day,c.label,1,c.city,c.branch,c.product,
      jsonb_build_object('contract',c.id,'client',c.client_id,'reason',c.p->>'cancellation_reason')
    from lb_contracts c cross join lateral (values
      ('activation',(c.p->>'activated')::date),('cancellation',(c.p->>'cancelled')::date)
    ) v(kind,day)
    left join lateral (select h.payload from records h where h.base_code=selected_base and h.source='customers' and h.external_key=c.client_id
      and h.valid_from<=v.day and (h.valid_until is null or h.valid_until>v.day) limit 1) history on true
    where v.day between period and until_day;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,v.kind,c.id,c.seller,v.reference_day,c.label,1,c.city,c.branch,c.product,
      jsonb_build_object('contract',c.id)
    from lb_contracts c cross join lateral (values
      ('expired',(c.p->>'expires')::date,(c.p->>'expires')::date<until_day),
      ('unsigned',null::date,comercial.normalize(c.p->>'signed_state') in ('NAO','PENDENTE','SEM ASSINATURA'))
    ) v(kind,reference_day,applies) where comercial.normalize(c.p->>'status')='ATIVO' and v.applies;

  -- Billing is an estimate. One non-proportional recurring title per contract and month is required.
  with candidates as (
    select p->>'recurring' id, min((p->>'nominal')::numeric) value, count(*) count
    from lb_titles where (p->>'due')::date between period and (period+interval '1 month - 1 day')::date
      and comercial.normalize(p->>'proportional') in ('N','NAO')
      and comercial.normalize(p->>'status') in ('A RECEBER','RECEBIDO','ABERTO')
      and p->>'recurring' is not null and p->>'one_time' is null and (p->>'nominal')::numeric > 0
    group by p->>'recurring'
  ), exact as (
    select payload->>'contract_key' id, sum((payload->>'total')::numeric) value
    from base_rows_on(until_day,selected_base) where source='items' and comercial.normalize(payload->>'billing') in ('MENSAL','RECORRENTE','MENSALIDADE')
    group by payload->>'contract_key'
  )
  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,'mrr',c.id,c.seller,until_day,c.label,coalesce(e.value,t.value),
      c.city,c.branch,c.product,jsonb_build_object('contract',c.id,'method',case when e.id is not null then 'Itens do contrato' else 'Título recorrente' end)
    from lb_contracts c left join candidates t on t.id=c.id and t.count=1
    left join exact e on e.id=c.id where comercial.normalize(c.p->>'status')='ATIVO' and coalesce(e.value,t.value) is not null;

  with candidates as (
    select p->>'recurring' id,min((p->>'nominal')::numeric) value,count(*) count
    from lb_titles_opening where (p->>'due')::date between date_trunc('month',window_start)::date and window_start
      and comercial.normalize(p->>'proportional') in ('N','NAO')
      and comercial.normalize(p->>'status') in ('A RECEBER','RECEBIDO','ABERTO')
      and p->>'recurring' is not null and p->>'one_time' is null and (p->>'nominal')::numeric>0
    group by p->>'recurring'
  ), exact as (
    select payload->>'contract_key' id,sum((payload->>'total')::numeric) value
    from base_rows_on(window_start,selected_base) where source='items' and comercial.normalize(payload->>'billing') in ('MENSAL','RECORRENTE','MENSALIDADE')
    group by payload->>'contract_key'
  )
  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,'opening_mrr',c.id,c.seller,window_start,c.label,coalesce(e.value,t.value),
      c.city,c.branch,c.product,jsonb_build_object('contract',c.id)
    from lb_opening c left join candidates t on t.id=c.id and t.count=1
    left join exact e on e.id=c.id where coalesce(e.value,t.value) is not null;

  with eligible as (
    select c.*, (c.p->>'activated')::date activation_day, review.seller_key reviewed_seller, review.items reviewed_items
    from lb_contracts c left join sales_review review on review.contract_id=case when selected_base='legacy' then c.id else selected_base||':'||c.id end
    where (c.p->>'activated')::date between period and until_day
  ), matched as (
    select c.id, c.activation_day, c.label, c.city, c.branch, c.product,
      coalesce(c.reviewed_seller,case when it.seller_count=1 and not it.unresolved then it.seller end,
        v.seller,case when possible.seller_count=1 and not possible.unresolved then possible.seller end) seller,
      coalesce(c.reviewed_seller,case when it.seller_count=1 and not it.unresolved then it.seller end,v.seller) safe_seller,
      case when c.reviewed_items is not null then c.reviewed_items
        when it.items is not null and it.seller_count=1 and not it.unresolved then it.items
        when v.unique_sale and v.total is not null and base_mapping('plan_products',selected_base) ? (c.p->>'plan_key')
          then jsonb_build_array(jsonb_build_object('product',base_mapping('plan_products',selected_base)->>(c.p->>'plan_key'),'total',v.total))
      end items
    from eligible c
    left join lateral (
      select count(*)=1 unique_sale, min(seller_for(payload->>'seller')) seller,
        min((payload->>'total')::numeric) total
      from lb_data r where r.source='sales' and r.payload->>'contract_key'=c.id
        and comercial.normalize(r.payload->>'status')='FINALIZADO'
        and r.event_day<=cutoff
        and coalesce(setting_value('sales_doc_types') -> selected_base, setting_value('sales_doc_types')) ? (r.payload->>'doc_type')
    ) v on true
    left join lateral (
      select count(distinct seller_for(r.payload->>'seller')) seller_count, min(seller_for(r.payload->>'seller')) seller,
        bool_or(seller_for(r.payload->>'seller') is null) unresolved
      from lb_data r where r.source='sales' and r.payload->>'contract_key'=c.id
        and comercial.normalize(r.payload->>'status')='FINALIZADO'
        and r.event_day<=cutoff
    ) possible on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('product',r.payload->>'product','total',r.payload->>'total')) items,
        count(distinct seller_for(s.payload->>'seller')) seller_count,
        min(seller_for(s.payload->>'seller')) seller, bool_or(seller_for(s.payload->>'seller') is null) unresolved
      from lb_data r join lb_data s on s.source='sales' and s.external_key=r.payload->>'sale_key'
        and s.payload->>'contract_key'=c.id and comercial.normalize(s.payload->>'status')='FINALIZADO'
        and s.event_day<=cutoff
      where r.source='items' and r.payload->>'contract_key'=c.id
    ) it on true
  ), weighted as (
    select c.*, items_data.rows, items_data.known, items_data.amount
    from matched c left join lateral (
      select count(*) rows,count(rate.rate) known,
        sum((i->>'total')::numeric * rate.rate) amount
      from jsonb_array_elements(coalesce(c.items,'[]')) i
      left join lateral (select r.rate from product_rates r
        where comercial.normalize(r.product)=comercial.normalize(i->>'product') and r.effective_month<=period
        order by r.effective_month desc limit 1) rate on true
    ) items_data on true
  )
  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,'goal_pending',id,seller,activation_day,label,null,city,branch,product,
      jsonb_build_object('contract',id,'reason',case when seller is null then 'Vendedor da venda não confirmado' else 'Produto ou valor elegível pendente' end)
    from weighted where safe_seller is null or rows=0 or known<>rows
    union all
    select selected_base,period,'goal_sale',c.id||':'||i.seq,c.seller,c.activation_day,c.label,
      (i.item->>'total')::numeric*r.rate,c.city,c.branch,r.product,
      jsonb_build_object('contract',c.id,'product',r.product,'gross',i.item->>'total','rate',r.rate)
    from weighted c
    cross join lateral jsonb_array_elements(c.items) with ordinality as i(item,seq)
    join lateral (select p.product,p.rate from product_rates p where comercial.normalize(p.product)=comercial.normalize(i.item->>'product')
      and p.effective_month<=period order by p.effective_month desc limit 1) r on true
    where c.safe_seller is not null and c.rows>0 and c.known=c.rows;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,label,amount,details)
    select selected_base,period,'target',s.seller_key,s.seller_key,s.name,t.amount,jsonb_build_object('team',s.team)
    from sellers s join lateral (
      select amount from targets t where t.seller_key=s.seller_key and t.effective_month<=period
      order by t.effective_month desc limit 1
    ) t on true where s.active;

  create temp table lb_acts on commit drop as
    select r.external_key id,r.event_day as day,r.payload p,c.id client_id,
      coalesce(c.p->>'name','Cliente '||coalesce(r.payload->>'client_key','sem vínculo')) label,
      c.p->>'city' city,c.p->>'branch' branch,
      seller_for(r.payload->>'seller') actor,
      coalesce(case when history.payload is not null then seller_for(history.payload->>'seller') end,
        seller_for(r.payload->>'seller'),c.seller) owner,
      exists(select from jsonb_array_elements_text(visit_terms) term where
        comercial.normalize(term) = any(regexp_split_to_array(comercial.normalize(r.payload->>'subject'),'[^A-Z0-9]+'))) visit,
      exists(select from jsonb_array_elements_text(prospect_terms) term where
        comercial.normalize(term) = any(regexp_split_to_array(comercial.normalize(r.payload->>'subject'),'[^A-Z0-9]+'))) prospect
    from lb_data r
    left join lb_customers c on c.id=r.payload->>'client_key'
    left join lateral (
      select payload from records h where h.base_code=selected_base and h.source='customers' and h.external_key=c.id
        and h.valid_from<=r.event_day and (h.valid_until is null or h.valid_until>r.event_day)
      order by h.valid_from desc limit 1
    ) history on true
    where r.source='activities' and r.event_day between period and until_day
      and comercial.normalize(r.payload->>'type')='TAREFA' and comercial.normalize(r.payload->>'status')='CONCLUIDA';
  create temp table lb_first_visit on commit drop as
    select distinct on (client_id) * from lb_acts where visit and not prospect and client_id is not null
    and exists(select from lb_contracts history where history.client_id=lb_acts.client_id
      and (history.p->>'activated')::date <= lb_acts.day and
      ((history.p->>'cancelled')::date >= lb_acts.day or comercial.normalize(history.p->>'status')='ATIVO'))
    order by client_id,day,id;
  create temp table lb_coverage on commit drop as
    select client_id, min(seller) seller, min(label) label,min(city) city,min(branch) branch
    from lb_contracts where client_id is not null and comercial.normalize(p->>'status')='ATIVO'
    group by client_id;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
    select selected_base,period,'visit_coverage',coalesce(c.client_id,v.client_id),coalesce(v.owner,c.seller),v.day,
      coalesce(c.label,v.label),case when v.id is null then 0 else 1 end,coalesce(c.city,v.city),coalesce(c.branch,v.branch),
      jsonb_build_object('client',coalesce(c.client_id,v.client_id),'identity',client_identity((select p->>'document' from lb_customers where id=coalesce(c.client_id,v.client_id))),'task',v.id,'subject',v.p->>'subject',
        'status',case when v.id is null then 'Pendente' else 'Visitado' end)
    from lb_coverage c full join lb_first_visit v using(client_id)
    where c.client_id is not null or exists (select from lb_opening b where b.client_id=v.client_id)
      or exists (select from lb_contracts b where b.client_id=v.client_id and
        (b.p->>'cancelled')::date between v.day and until_day);

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
    select selected_base,period,case when prospect then 'prospect_visit' else 'visit_task' end,id,
      case when prospect then actor else owner end,day,label,1,city,branch,
      jsonb_build_object('client',client_id,'task',id,'subject',p->>'subject')
    from lb_acts where visit or prospect;

  with leads as (
    select l.external_key id,l.payload p,l.event_day registered,
      seller_for(l.payload->>'seller') seller,c.p->>'branch' branch,
      coalesce(c.p->>'city',l.payload->>'city') city,min((t.p->>'activated')::date) activation
    from lb_data l left join lb_customers c on c.id=l.payload->>'client_key'
    left join lb_contracts t on t.client_id=c.id and (t.p->>'activated')::date>=l.event_day
      and (t.p->>'activated')::date<=until_day
    where l.source='leads' and l.event_day<=until_day
    group by l.external_key,l.payload,l.event_day,c.p
  )
  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
    select selected_base,period,v.kind,l.id,l.seller,v.day,coalesce(l.p->>'name','Lead '||l.id),1,l.city,l.branch,
      jsonb_build_object('lead',l.id,'client',l.p->>'client_key')
    from leads l cross join lateral (values ('lead_new',l.registered),('lead_won',l.activation)) v(kind,day)
    where v.day between period and until_day;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
    select selected_base,period,'negotiation',r.external_key,seller_for(r.payload->>'seller'),r.event_day,
      coalesce(r.payload->>'client',r.payload->>'contact','Negociação '||r.external_key),1,null,null,
      jsonb_build_object('status',r.payload->>'status','stage',r.payload->>'stage','deal',r.external_key)
    from lb_data r where r.source='negotiations' and r.event_day between period and until_day;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,details)
    select selected_base,period,'expense',r.external_key,seller_for(r.payload->>'seller'),r.event_day,
      coalesce(r.payload->>'category','Sem categoria'),(r.payload->>'total')::numeric,
      jsonb_build_object('category',case
        when comercial.normalize(r.payload->>'category')='COMBUSTIVEL' then 'Combustível'
        when comercial.normalize(r.payload->>'category') in ('ALMOCO','JANTAR','ALMOCO COM CLIENTE','JANTAR COM CLIENTE','CAFE DA MANHA','CAFE COM CLIENTE') then 'Alimentação'
        when comercial.normalize(r.payload->>'category')='HOSPEDAGEM' then 'Hospedagem'
        else 'Extras' end,
        'seller',r.payload->>'seller','vehicle',r.payload->>'equipment','trip',r.payload->>'trip',
        'excess',case when comercial.normalize(r.payload->>'category') in ('ALMOCO','JANTAR')
          then greatest(0,(r.payload->>'total')::numeric-meal_limit)
          when comercial.normalize(r.payload->>'category')='HOSPEDAGEM' and
            (r.payload->>'people')::numeric>0 and (r.payload->>'nights')::numeric>0
          then greatest(0,(r.payload->>'total')::numeric-lodging_limit*(r.payload->>'people')::numeric*(r.payload->>'nights')::numeric)
          else null end,
        'pending_limit',comercial.normalize(r.payload->>'category')='HOSPEDAGEM' and (
          coalesce((r.payload->>'people')::numeric,0)<=0 or coalesce((r.payload->>'nights')::numeric,0)<=0))
    from lb_data r where r.source='expenses' and r.event_day between period and until_day;

  with changes as (
    select r.*,case
      when exists (select from jsonb_array_elements_text(setting_value('reversal_types')) s where comercial.normalize(s)=comercial.normalize(r.payload->>'type'))
        then 'reversal'
      when comercial.normalize(r.payload->>'type') ~ '\mUPGRADE\M' then 'upgrade'
      when comercial.normalize(r.payload->>'type') ~ '\mDOWNGRADE\M' then 'downgrade'
    end kind
    from lb_data r where source='changes' and event_day between period and until_day
  )
  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,r.kind,r.external_key,coalesce(seller_for(r.payload->>'seller'),c.seller),r.event_day,
      coalesce(c.label,'Contrato '||(r.payload->>'contract_key')),(r.payload->>'difference')::numeric,
      c.city,c.branch,c.product,jsonb_build_object('contract',r.payload->>'contract_key','type',r.payload->>'type')
    from changes r left join lb_contracts c on c.id=r.payload->>'contract_key'
    where r.kind is not null;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,'receipt',t.id,c.seller,(t.p->>'paid')::date,coalesce(c.label,t.p->>'client','Título '||t.id),
      (t.p->>'received')::numeric,coalesce(c.city,t.p->>'city'),coalesce(c.branch,t.p->>'branch'),c.product,
      jsonb_build_object('contract',c.id,'title',t.id)
    from lb_titles t left join lb_contracts c on c.id=t.p->>'contract_key'
    where comercial.normalize(t.p->>'status')='RECEBIDO' and (t.p->>'paid')::date between period and until_day
      and (t.p->>'received')::numeric>0;

  if exists(select from base_rows_on(until_day,selected_base) where source='debts')
     or exists(select from source_observations where base_code=selected_base and source='debts' and observed_on<=until_day) then
    insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
      select selected_base,period,'debt',r.external_key,c.seller,(r.payload->>'due')::date,
        coalesce(c.p->>'name',r.payload->>'client','Título em aberto'),(r.payload->>'balance')::numeric,
        coalesce(c.p->>'city',r.payload->>'city'),c.p->>'branch',
        jsonb_build_object('client',c.id,'title',r.payload->>'title_key','days',until_day-(r.payload->>'due')::date)
      from base_rows_on(until_day,selected_base) r left join lb_customers c on c.id=r.payload->>'client_key'
      where r.source='debts' and (r.payload->>'due')::date <= until_day - 60
        and (r.payload->>'balance')::numeric>0;
  else
    insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
      select selected_base,period,'debt',t.id,c.seller,(t.p->>'due')::date,coalesce(c.label,t.p->>'client','Título '||t.id),
        (t.p->>'balance')::numeric,coalesce(c.city,t.p->>'city'),coalesce(c.branch,t.p->>'branch'),
        jsonb_build_object('client',c.client_id,'title',t.id,'days',until_day-(t.p->>'due')::date)
      from lb_titles t left join lb_contracts c on c.id=t.p->>'contract_key'
      where comercial.normalize(t.p->>'status') in ('ABERTO','A RECEBER') and (t.p->>'due')::date<=until_day-60
        and (t.p->>'balance')::numeric>0;
  end if;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,'band',r.external_key,c.seller,r.event_day,coalesce(c.label,r.payload->>'circuit',r.payload->>'login','Circuito'),
      (r.payload->>'used')::numeric/nullif((r.payload->>'capacity')::numeric,0)*100,c.city,c.branch,c.product,
      jsonb_build_object('contract',c.id,'circuit',coalesce(r.payload->>'circuit',r.payload->>'login',c.id),
        'used',r.payload->>'used','capacity',r.payload->>'capacity')
    from lb_data r left join lb_contracts c on c.id=coalesce(r.payload->>'contract_key',
      base_mapping('band_links',selected_base)->>coalesce(r.payload->>'circuit',r.payload->>'login'))
    where r.source='band' and r.event_day between period and until_day;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
    select selected_base,period,'visit_overdue',c.client_id,c.seller,last_visit.day,c.label,1,c.city,c.branch,
      jsonb_build_object('client',c.client_id,'days',until_day-coalesce(last_visit.day,entry.day),
        'reason','60 dias ou mais sem visita registrada')
    from lb_coverage c
    left join lateral (select max(r.event_day) as day from lb_data r where source='activities'
      and r.payload->>'client_key'=c.client_id and r.event_day<=until_day
      and comercial.normalize(r.payload->>'type')='TAREFA' and comercial.normalize(r.payload->>'status')='CONCLUIDA'
      and exists(select from jsonb_array_elements_text(visit_terms) term where
        comercial.normalize(term)=any(regexp_split_to_array(comercial.normalize(r.payload->>'subject'),'[^A-Z0-9]+')))
      and not exists(select from jsonb_array_elements_text(prospect_terms) term where
        comercial.normalize(term)=any(regexp_split_to_array(comercial.normalize(r.payload->>'subject'),'[^A-Z0-9]+')))) last_visit on true
    left join lateral (select min((p->>'activated')::date) as day from lb_contracts x where x.client_id=c.client_id
      and comercial.normalize(x.p->>'status')='ATIVO') entry on true
    where coalesce(last_visit.day,entry.day)<=until_day-60 and visit_history_known;

  insert into metric_state(base_code,month,observed_on,data) values(selected_base,period,until_day,
    jsonb_build_object('opening',initial_known,'closing',final_known,
      'changes',exists(select from source_observations s where base_code=selected_base and s.source='changes' and s.observed_on<=cutoff
        and s.scope_start<=until_day and s.scope_end>=period),
      'reversal',jsonb_array_length(setting_value('reversal_types'))>0 and exists(select from source_observations s
        where s.base_code=selected_base and s.source='changes' and s.observed_on<=cutoff and s.scope_start<=until_day and s.scope_end>=period),
      'band',exists(select from lb_data where source='band' and event_day between period and until_day),
      'visits',exists(select from source_observations s where base_code=selected_base and s.source='activities' and s.observed_on<=cutoff
        and (s.scope_start is null or (s.scope_start<=until_day and s.scope_end>=period))),
      'expenses',exists(select from source_observations s where base_code=selected_base and s.source='expenses' and s.observed_on<=cutoff
        and (s.scope_start is null or (s.scope_start<=until_day and s.scope_end>=period))),
      'debts',exists(select from source_observations s where base_code=selected_base and s.source in ('debts','open_titles','titles') and s.observed_on<=until_day),
      'debt_as_of',(select max(s.observed_on) from source_observations s
        where s.base_code=selected_base and s.source=case when exists(select from source_observations a where base_code=selected_base and a.source='debts' and a.observed_on<=until_day)
          then 'debts' else 'open_titles' end and s.observed_on<=until_day),
      'contract_as_of',(select max(s.observed_on) from source_observations s where base_code=selected_base and s.source='contracts' and s.observed_on<=until_day),
      'receipts',exists(select from source_observations s where base_code=selected_base and s.source in ('payments','titles') and s.observed_on<=cutoff),
      'leads',exists(select from source_observations s where base_code=selected_base and s.source='leads' and s.observed_on<=cutoff),
      'signatures',exists(select from lb_contracts where p->>'signed_state' is not null),
      'goal',exists(select from source_observations s where base_code=selected_base and s.source in ('sales','items') and s.observed_on<=cutoff),
      'overdue',visit_history_known,
      'meal',meal_limit,'lodging',lodging_limit,
      'threshold',(setting_value('band_threshold') #>> '{}')::numeric
    )) on conflict(base_code,month) do update set observed_on=excluded.observed_on,data=excluded.data,refreshed_at=now();
end $$;


create or replace function comercial.refresh_all(cutoff date) returns void
language plpgsql set search_path = pg_catalog, comercial, pg_temp as $$
declare period date; position record;
begin
  perform pg_advisory_xact_lock(211687);
  for period in select d::date from generate_series(date '2026-11-01',date_trunc('month',cutoff)::date,interval '1 month') d loop
    for position in select base_code,max(observed_on) as cutoff_day from source_loads where observed_on<=cutoff group by base_code order by base_code loop
      perform refresh_base_month(period,position.cutoff_day,position.base_code);
    end loop;
  end loop;
end $$;

create function comercial.submit_base_import(observed date, files jsonb, enqueue boolean, selected_base text) returns uuid
language plpgsql security definer set search_path = pg_catalog, comercial
as $$
declare batch uuid; file jsonb;
begin
  if not comercial.is_admin() then raise exception 'Acesso restrito' using errcode='42501'; end if;
  if selected_base not in ('old','new') then raise exception 'Selecione a base da importação'; end if;
  if jsonb_array_length(files) not between 1 and 25 then raise exception 'Quantidade de arquivos inválida'; end if;
  if observed < date '2026-10-01' or observed > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'Data da extração inválida';
  end if;
  insert into comercial.import_batches(submitted_by,observed_on,base_code)
  values(comercial.email(),observed,selected_base) returning id into batch;
  for file in select * from jsonb_array_elements(files) loop
    insert into comercial.import_files(batch_id,name,object_key,bytes,sha256)
    values(batch,file->>'name',file->>'key',(file->>'bytes')::integer,file->>'sha256');
  end loop;
  if enqueue then
    execute 'select pgmq.send($1,$2)' using 'lb_imports'::text,jsonb_build_object('batch',batch);
  end if;
  return batch;
end $$;


grant execute on function comercial.submit_base_import(date,jsonb,boolean,text) to lb_dashboard;

create function comercial.base_source_status()
returns table(source text,base_code text,observed_on date,loaded_at timestamptz,rows_loaded integer)
language sql stable security definer set search_path = pg_catalog, comercial as $$
  select s.source,s.base_code,s.observed_on,s.loaded_at,s.rows_loaded from comercial.source_loads s
  where exists(select from comercial.profile()) order by s.base_code,s.source
$$;
grant execute on function comercial.base_source_status() to lb_dashboard;

create function comercial.base_contract_details_for(period date, selected_base text, row_ids text[])
returns table(row_key text, renewal date, total numeric, observed_on date)
language sql stable security definer set search_path = pg_catalog, comercial as $$
  select m.row_key,(detail.payload->>'renewal')::date,(detail.payload->>'total')::numeric,detail.valid_from
  from metric_rows m
  join metric_state state on state.base_code=m.base_code and state.month=m.month
  join records detail on detail.base_code=m.base_code and detail.source='contract_details'
    and detail.external_key=m.details->>'contract'
    and detail.valid_from<=state.observed_on
    and (detail.valid_until is null or detail.valid_until>state.observed_on)
    and (m.details->>'client' is null or detail.payload->>'client_key'=m.details->>'client')
  where m.base_code=selected_base and m.month=period and m.kind='active_contract' and m.row_key=any(row_ids)
    and exists(select from profile() p where p.role in ('admin','manager')
      or (p.role='seller' and p.seller_key=m.seller_key))
$$;
grant execute on function comercial.base_contract_details_for(date,text,text[]) to lb_dashboard;
create or replace function comercial.contract_details_for(period date, row_ids text[])
returns table(row_key text, renewal date, total numeric, observed_on date)
language sql stable set search_path = pg_catalog, comercial
as $$ select * from comercial.base_contract_details_for(period,'legacy',row_ids) $$;

create or replace function comercial.save_setting(key text, new_value jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, comercial
as $$
declare previous jsonb; cutoff date; acct comercial.accounts%rowtype;
begin
  if not comercial.is_admin() then raise exception 'Acesso restrito' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(211687);
  if key='target' then
    select to_jsonb(t) into previous from comercial.targets t
    where seller_key=new_value->>'seller' and effective_month=(new_value->>'month')::date;
    insert into comercial.targets(seller_key,effective_month,amount)
      values(new_value->>'seller',(new_value->>'month')::date,(new_value->>'amount')::numeric)
    on conflict(seller_key,effective_month) do update set amount=excluded.amount;
  elsif key='rate' then
    select to_jsonb(p) into previous from comercial.product_rates p
    where product=new_value->>'product' and effective_month=(new_value->>'month')::date;
    insert into comercial.product_rates(product,effective_month,rate)
      values(new_value->>'product',(new_value->>'month')::date,(new_value->>'rate')::numeric)
    on conflict(product,effective_month) do update set rate=excluded.rate;
  elsif key='sale_review' then
    if not exists(select from comercial.records where source='contracts' and valid_until is null and
      (case when base_code='legacy' then external_key else base_code||':'||external_key end)=new_value->>'contract') then
      raise exception 'Contrato não localizado';
    end if;
    select to_jsonb(r) into previous from comercial.sales_review r where contract_id=new_value->>'contract';
    insert into comercial.sales_review(contract_id,seller_key,items,note)
      values(new_value->>'contract',new_value->>'seller',new_value->'items',new_value->>'note')
    on conflict(contract_id) do update set seller_key=excluded.seller_key,items=excluded.items,note=excluded.note,updated_at=now();
  elsif key='clear_sale_review' then
    delete from comercial.sales_review r where contract_id=new_value->>'contract' returning to_jsonb(r) into previous;
  elsif key='account' then
    if lower(new_value->>'email')=comercial.email() and (
      new_value->>'role'<>'admin' or not (new_value->>'active')::boolean) then
      raise exception 'O próprio administrador precisa permanecer ativo';
    end if;
    select * into acct from comercial.accounts a where a.email=lower(new_value->>'email');
    previous := to_jsonb(acct);
    insert into comercial.accounts(email,name,role,seller_key,active)
      values(lower(new_value->>'email'),new_value->>'name',new_value->>'role',new_value->>'seller',(new_value->>'active')::boolean)
    on conflict(email) do update set name=excluded.name,role=excluded.role,seller_key=excluded.seller_key,active=excluded.active;
  elsif key in ('aliases','visit_rules','reversal_types','sales_doc_types','expense_limits','band_threshold','plan_products','contract_clients','band_links') then
    select value into previous from comercial.settings where setting=key;
    insert into comercial.settings(setting,value) values(key,new_value)
    on conflict(setting) do update set value=excluded.value;
  else
    raise exception 'Configuração não reconhecida';
  end if;
  insert into comercial.settings_history(setting,old_value,new_value,changed_by)
    values(key,previous,new_value,comercial.email());
  if key <> 'account' then
    select max(observed_on) into cutoff from comercial.source_loads;
    if cutoff is not null then perform comercial.refresh_all(cutoff); end if;
  end if;
end $$;

revoke execute on all functions in schema comercial from public;
create or replace function comercial.refresh_month(period date, cutoff date) returns void
language sql set search_path = pg_catalog, comercial
as $$ select comercial.refresh_base_month(period,cutoff,'legacy') $$;

commit;
