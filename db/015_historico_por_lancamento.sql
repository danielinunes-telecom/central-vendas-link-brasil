-- Atualiza as rotinas instaladas pelas migrações 007–014 e reapura as cargas existentes.
begin;
select pg_advisory_xact_lock(211687);
do $$begin
  if to_regprocedure('comercial.refresh_before_final_consolidation(date)') is null then
    raise exception 'Aplique a migração 014 antes da 015';
  end if;
end$$;

create or replace function comercial.refresh_base_month_before_product_rules(period date, cutoff date, selected_base text) returns void
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
  if period < date '2026-01-01' or until_day < period then return; end if;
  select exists(select from source_observations where base_code=selected_base and source='contracts' and observed_on <= window_start)
    into initial_known;
  select exists(select from source_observations where base_code=selected_base and source='contracts' and observed_on <= until_day)
    into final_known;
  select coalesce(range_agg(daterange(scope_start,scope_end,'[]')) @> daterange(until_day-60,until_day,'[]'),false)
    into visit_history_known
    from source_observations where base_code=case selected_base when 'old' then 'new' else selected_base end and source='activities' and observed_on<=cutoff and scope_start is not null and scope_end is not null;

  delete from metric_rows where month=period and base_code=selected_base;
  drop table if exists pg_temp.lb_data, pg_temp.lb_customers, pg_temp.lb_contracts,
    pg_temp.lb_opening, pg_temp.lb_acts, pg_temp.lb_first_visit, pg_temp.lb_coverage, pg_temp.lb_titles,
    pg_temp.lb_titles_opening, pg_temp.lb_opening_customers, pg_temp.lb_visit_events;
  create temp table lb_data on commit drop as
    select * from base_rows_on(cutoff,selected_base);
  create index on lb_data(source,external_key);
  create index on lb_data(source,(payload->>'contract_key'));
  create temp table lb_customers on commit drop as
    select external_key as id, payload as p, seller_for(payload->>'seller') as seller
    from base_portfolio_on(until_day,cutoff,selected_base,'customers');
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
    select r.external_key id, r.payload || jsonb_build_object('document',c.p->>'document') p, c.id client_id, coalesce(seller_for(r.payload->>'seller'),c.seller) seller,
      coalesce(c.p->>'name',r.payload->>'client','Contrato '||r.external_key) label,
      coalesce(c.p->>'city',r.payload->>'city') city,
      coalesce(c.p->>'branch',r.payload->>'branch') branch,
      product_for(case when selected_base='legacy' then r.payload->>'plan_key' else selected_base||':'||(r.payload->>'plan_key') end,r.payload->>'description') product
    from base_portfolio_on(until_day,cutoff,selected_base,'contracts') r
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
    from lb_contracts where final_known and comercial.normalize(p->>'status')='ATIVO'
    union all
    select selected_base,period,'opening_contract',id,seller,window_start,label,1,city,branch,product,
      jsonb_build_object('contract',id,'client',client_id,'identity',client_identity(p->>'document'))
    from lb_opening;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,v.kind,r.external_key,coalesce(seller_for(r.payload->>'seller'),c.seller),v.day,
      coalesce(r.payload->>'client',c.label,'Contrato '||r.external_key),1,
      coalesce(c.city,r.payload->>'city'),coalesce(c.branch,r.payload->>'branch'),coalesce(c.product,r.payload->>'description'),
      jsonb_build_object('contract',r.external_key,'client',coalesce(r.payload->>'client_key',c.client_id),'reason',r.payload->>'cancellation_reason')
    from lb_data r left join lb_contracts c on c.id=r.external_key
    cross join lateral (values ('activation',(r.payload->>'activated')::date),('cancellation',(r.payload->>'cancelled')::date)) v(kind,day)
    where r.source='contracts' and v.day between period and until_day;

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
        when v.unique_sale and v.total is not null
          then jsonb_build_array(jsonb_build_object('product',coalesce(c.product,'Venda'),'total',v.total))
      end items
    from eligible c
    left join lateral (
      select count(*)=1 unique_sale, min(seller_for(payload->>'seller')) seller,
        min((payload->>'total')::numeric) total
      from lb_data r where r.source='sales' and r.payload->>'contract_key'=c.id
        and comercial.normalize(r.payload->>'status')='FINALIZADO'
        and r.event_day<=cutoff
        -- Every finalized sale is eligible, independently of document or plan code.
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
  ), valued as (
    select c.*, items_data.rows, items_data.known
    from matched c cross join lateral (
      select count(*) rows, count(i->>'total') known
      from jsonb_array_elements(coalesce(c.items,'[]')) i
    ) items_data
  )
  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,product,details)
    select selected_base,period,'goal_pending',id,seller,activation_day,label,null,city,branch,product,
      jsonb_build_object('contract',id,'reason',case when safe_seller is null then 'Vendedor da venda não confirmado' else 'Valor da venda pendente de confirmação' end)
    from valued where safe_seller is null or rows=0 or known<>rows
    union all
    select selected_base,period,'goal_sale',c.id||':'||i.seq,c.seller,c.activation_day,c.label,
      (i.item->>'total')::numeric,c.city,c.branch,coalesce(i.item->>'product',c.product,'Venda'),
      jsonb_build_object('contract',c.id,'product',coalesce(i.item->>'product',c.product,'Venda'),
        'gross',i.item->>'total','rate',1,'calculation','full_sale_value')
    from valued c
    cross join lateral jsonb_array_elements(c.items) with ordinality as i(item,seq)
    where c.safe_seller is not null and c.rows>0 and c.known=c.rows;

  insert into metric_rows(base_code,month,kind,row_key,seller_key,label,amount,details)
    select selected_base,period,'target',s.seller_key,s.seller_key,s.name,t.amount,jsonb_build_object('team',s.team)
    from sellers s join lateral (
      select amount from targets t where t.seller_key=s.seller_key and t.effective_month<=period
      order by t.effective_month desc limit 1
    ) t on true where s.active;

  create temp table lb_visit_events on commit drop as
    select * from visit_events(cutoff,selected_base);
  create temp table lb_acts on commit drop as
    select r.id,r.day,r.p,c.id client_id,
      coalesce(c.p->>'name','Cliente '||coalesce(r.client_id,'sem vínculo')) label,
      c.p->>'city' city,c.p->>'branch' branch,
      seller_for(r.p->>'seller') actor,
      coalesce(seller_for(history.payload->>'seller'),c.seller,seller_for(r.p->>'seller')) owner,
      true visit,false prospect
    from lb_visit_events r
    left join lb_customers c on c.id=r.client_id
    left join lateral (
      select payload from records h where h.base_code=selected_base and h.source='customers'
        and h.external_key=c.id and h.valid_from<=r.day and (h.valid_until is null or h.valid_until>r.day)
      order by h.valid_from desc limit 1
    ) history on true
    where r.day between period and until_day;
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
      jsonb_build_object('client',coalesce(c.client_id,v.client_id),'identity',client_identity((select p->>'document' from lb_customers where id=coalesce(c.client_id,v.client_id))),'task',case when v.p->>'visit_source'='activities' then v.p->>'visit_id' end,
        'deal',case when v.p->>'visit_source'='negotiations' then v.p->>'visit_id' end,'subject',v.p->>'subject',
        'status',case when v.id is null then 'Pendente' else 'Visitado' end)
    from lb_coverage c full join lb_first_visit v using(client_id)
    where c.client_id is not null or exists (select from lb_opening b where b.client_id=v.client_id)
      or exists (select from lb_contracts b where b.client_id=v.client_id and
        (b.p->>'cancelled')::date between v.day and until_day);

  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
    select selected_base,period,case when prospect then 'prospect_visit' else 'visit_task' end,id,
      case when prospect then actor else owner end,day,label,1,city,branch,
      jsonb_build_object('client',client_id,'task',case when p->>'visit_source'='activities' then p->>'visit_id' end,
        'deal',case when p->>'visit_source'='negotiations' then p->>'visit_id' end,'subject',p->>'subject',
        'status',p->>'status','source_base',p->>'source_base')
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
      from (select distinct on (external_key) external_key id,payload p
            from base_rows_on(until_day,selected_base) where source in ('titles','open_titles','payments')
            order by external_key, valid_from desc, case source when 'titles' then 0 when 'payments' then 1 else 2 end) t
      left join lb_contracts c on c.id=t.p->>'contract_key'
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
    left join lateral (select max(r.day) as day from lb_visit_events r
      where r.client_id=c.client_id and r.day<=until_day) last_visit on true
    left join lateral (select min((p->>'activated')::date) as day from lb_contracts x where x.client_id=c.client_id
      and comercial.normalize(x.p->>'status')='ATIVO') entry on true
    where coalesce(last_visit.day,entry.day)<=until_day-60 and visit_history_known;

  insert into metric_state(base_code,month,observed_on,data) values(selected_base,period,until_day,
    jsonb_build_object('opening',initial_known,'activation_history',exists(select from lb_data where source='contracts' and (payload->>'activated') is not null),
      'reversal_history',exists(select from source_observations where base_code=selected_base and source='cancellation_orders'
          and scope_start<=until_day and scope_end>=period and observed_on<=cutoff),
      'closing',final_known,
      'changes',exists(select from source_observations s where base_code=selected_base and s.source='changes' and s.observed_on<=cutoff
        and s.scope_start<=until_day and s.scope_end>=period),
      'reversal',jsonb_array_length(setting_value('reversal_types'))>0 and exists(select from source_observations s
        where s.base_code=selected_base and s.source='changes' and s.observed_on<=cutoff and s.scope_start<=until_day and s.scope_end>=period),
      'band',exists(select from lb_data where source='band' and event_day between period and until_day),
      'visits',exists(select from source_observations s where base_code=case selected_base when 'old' then 'new' else selected_base end and (selected_base<>'new') and s.source in ('activities','negotiations') and s.observed_on<=cutoff
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

create or replace function comercial.refresh_before_contract_values(cutoff date) returns void
language plpgsql set search_path = pg_catalog, comercial, pg_temp as $$
declare period date; position record;
begin
  perform pg_advisory_xact_lock(211687);
  for period in select d::date from generate_series(date '2026-01-01',date_trunc('month',cutoff)::date,interval '1 month') d loop
    for position in select base_code,max(observed_on) as cutoff_day from source_loads where observed_on<=cutoff group by base_code order by base_code loop
      perform refresh_base_month(period,cutoff,position.base_code);
    end loop;
  end loop;
end $$;

create or replace function comercial.refresh_before_monthly_annual(cutoff date) returns void
language plpgsql set search_path=pg_catalog,comercial,pg_temp as $$
declare period date; selected_base text; until_day date;
begin
  perform comercial.refresh_before_history_2026(cutoff);
  perform pg_advisory_xact_lock(211687);

  for selected_base in select distinct base_code from source_loads order by base_code loop
    for period in select d::date from generate_series(date '2026-01-01',date_trunc('month',cutoff)::date,interval '1 month')d loop
      until_day:=least(cutoff,(period+interval '1 month - 1 day')::date);

      -- Each month already receives changes through refresh_base_month.
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
      if not exists(select from source_observations where source='contracts' and base_code=selected_base and observed_on<=until_day)
        and exists(select from base_rows_on(cutoff,selected_base) where source='contracts' and payload->>'activated' is not null) then
        delete from metric_rows where base_code=selected_base and month=period and kind in
          ('active_contract','active_client','opening_contract','opening_mrr','target');
        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,product,details)
        select selected_base,period,'active_contract',r.external_key,seller_for(r.payload->>'seller'),until_day,
          coalesce(r.payload->>'client','Contrato '||r.external_key),1,r.payload->>'city',r.payload->>'description',
          jsonb_build_object('contract',r.external_key,'client',r.payload->>'client_key','description',r.payload->>'description',
            'status',r.payload->>'status','activated',r.payload->>'activated','cancelled',r.payload->>'cancelled',
            'contract_total',r.payload->>'total','position_method','reconstructed_from_contract_lifecycle')
        from base_rows_on(cutoff,selected_base)r where r.source='contracts' and (r.payload->>'activated')::date<=until_day
          and ((r.payload->>'cancelled')::date>until_day or (r.payload->>'cancelled' is null and normalize(r.payload->>'status')='ATIVO'));
        insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,details)
        select distinct on (payload->>'client_key') selected_base,period,'active_client',payload->>'client_key',seller_for(payload->>'seller'),until_day,
          coalesce(payload->>'client','Cliente '||(payload->>'client_key')),1,payload->>'city',
          jsonb_build_object('client',payload->>'client_key','position_method','reconstructed_from_contract_lifecycle')
        from base_rows_on(cutoff,selected_base) where source='contracts' and payload->>'client_key' is not null
          and (payload->>'activated')::date<=until_day
          and ((payload->>'cancelled')::date>until_day or (payload->>'cancelled' is null and normalize(payload->>'status')='ATIVO'))
        order by payload->>'client_key',(payload->>'activated')::date desc,external_key desc;
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
    select selected_base,date_trunc('month',event_date)::date,kind,external_key,seller_for(contract_payload->>'seller'),event_date,
      coalesce(payload->>'client','Atendimento '||external_key),case when kind='cancellation_request' then null else (contract_payload->>'total')::numeric end,
      contract_payload->>'city',contract_payload->>'description',jsonb_build_object('service_order',external_key,'contract',matched_contract,
        'client',payload->>'client','seller_source',contract_payload->>'seller','attendant',payload->>'attendant',
        'opening_responsible',payload->>'opening_responsible','status',payload->>'status','subject',payload->>'subject',
        'original_text',payload->>'original_text','classification',case when kind='cancellation_request' then 'request' else outcome end,
        'needs_review',outcome='pending','manual_review',manual_class is not null,'review_note',manual_note,
        'match_rule',case when manual_contract is not null then 'manual_contract' when cancelled_after=1 then 'single_cancellation_after_request'
          when candidates=1 then 'single_client_contract' when cancelled_after=0 and active_now=1 then 'single_active_contract' else 'ambiguous_client_contracts' end,
        'candidate_contracts',coalesce(candidate_list,'[]'::jsonb)) from rows
    cross join lateral (select case when kind='cancellation_effective' then coalesce((contract_payload->>'cancelled')::date,event_day)
      else event_day end as event_date) d
    where event_date between date '2026-01-01' and cutoff;

    update metric_state set data=data||jsonb_build_object('cancellation_orders',exists(
      select from source_observations where base_code=selected_base and source='cancellation_orders' and observed_on<=cutoff))
    where base_code=selected_base and month between date '2026-01-01' and date_trunc('month',cutoff)::date;
  end loop;
end$$;

do $$declare cutoff date; begin
  select max(observed_on) into cutoff from comercial.source_loads;
  if cutoff is not null then perform comercial.refresh_all(cutoff); end if;
end$$;
commit;

