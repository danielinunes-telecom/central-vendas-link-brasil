begin;
create function comercial.last_day() returns date
language sql stable security definer set search_path = pg_catalog, comercial
return case when exists (select from comercial.profile()) then
  (select max(observed_on) from comercial.source_loads) end;

create function comercial.source_status()
returns table(source text,observed_on date,loaded_at timestamptz,rows_loaded integer)
language sql stable security definer set search_path = pg_catalog, comercial
as $$ select s.source,s.observed_on,s.loaded_at,s.rows_loaded from comercial.source_loads s
  where exists(select from comercial.profile()) order by s.source $$;

create function comercial.import_status() returns jsonb
language sql stable security definer set search_path = pg_catalog, comercial
as $$
  select coalesce(jsonb_agg((to_jsonb(b) - 'submission_order' - 'lease_until' - 'available_at')||jsonb_build_object('files',
    coalesce((select jsonb_agg(to_jsonb(f) - 'object_key' - 'sha256' - 'batch_id' order by f.name)
      from comercial.import_files f where f.batch_id=b.id),'[]')) order by b.submitted_at desc),'[]')
  from (select * from comercial.import_batches where comercial.is_admin() order by submitted_at desc limit 20) b
$$;

create function comercial.submit_import(observed date, files jsonb, enqueue boolean) returns uuid
language plpgsql security definer set search_path = pg_catalog, comercial
as $$
declare batch uuid; file jsonb;
begin
  if not comercial.is_admin() then raise exception 'Acesso restrito' using errcode='42501'; end if;
  if jsonb_array_length(files) not between 1 and 25 then raise exception 'Quantidade de arquivos inválida'; end if;
  if observed < date '2026-10-01' or observed > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'Data da extração inválida';
  end if;
  insert into comercial.import_batches(submitted_by,observed_on)
  values(comercial.email(),observed) returning id into batch;
  for file in select * from jsonb_array_elements(files) loop
    insert into comercial.import_files(batch_id,name,object_key,bytes,sha256)
    values(batch,file->>'name',file->>'key',(file->>'bytes')::integer,file->>'sha256');
  end loop;
  if enqueue then
    execute 'select pgmq.send($1,$2)' using 'lb_imports'::text,jsonb_build_object('batch',batch);
  end if;
  return batch;
end $$;

create function comercial.admin_settings() returns jsonb
language sql stable security definer set search_path = pg_catalog, comercial
as $$ select case when comercial.is_admin() then jsonb_build_object(
  'rules',(select jsonb_object_agg(setting,value) from comercial.settings),
  'targets', (select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('name',s.name) order by s.name,t.effective_month desc),'[]')
              from comercial.targets t join comercial.sellers s using(seller_key)),
  'rates',(select coalesce(jsonb_agg(to_jsonb(p) order by p.product,p.effective_month desc),'[]') from comercial.product_rates p),
  'accounts',(select coalesce(jsonb_agg(to_jsonb(a) order by a.name),'[]') from comercial.accounts a),
  'sellers',(select coalesce(jsonb_agg(to_jsonb(s) order by s.name),'[]') from comercial.sellers s),
  'changes',(select coalesce(jsonb_agg(to_jsonb(h) order by h.changed_at desc),'[]')
             from (select setting,changed_by,changed_at from comercial.settings_history order by changed_at desc limit 20) h)
) end $$;

create function comercial.save_setting(key text, new_value jsonb) returns void
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
    if not exists(select from comercial.records where source='contracts' and external_key=new_value->>'contract') then
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
grant execute on function comercial.last_day(), comercial.source_status(), comercial.import_status(),
  comercial.submit_import(date,jsonb,boolean),comercial.admin_settings(),comercial.save_setting(text,jsonb) to lb_dashboard;
commit;

