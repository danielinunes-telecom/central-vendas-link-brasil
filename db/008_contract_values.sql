begin;

alter function comercial.refresh_all(date) rename to refresh_before_contract_values;

create function comercial.refresh_all(cutoff date) returns void
language plpgsql set search_path = pg_catalog, comercial, pg_temp as $$
begin
  perform comercial.refresh_before_contract_values(cutoff);
  delete from metric_rows where kind='contract_values';
  insert into metric_rows(base_code,month,kind,row_key,seller_key,occurred_on,label,amount,city,branch,details)
  select state.base_code,state.month,'contract_values',r.external_key,
    comercial.seller_for(r.payload->>'seller'),r.valid_from,r.payload->>'client',
    (r.payload->>'monthly')::numeric,c.city,c.branch,
    jsonb_build_object('client',r.payload->>'client_key','contract',matched.contract,
      'plan',r.payload->>'plan','seller_source',r.payload->>'seller',
      'renewal',r.payload->>'renewal','monthly_report',r.payload->>'monthly',
      'installation',r.payload->>'installation','report_date',r.valid_from,
      'reason',case when matched.contract is null then 'Vínculo com contrato pendente de confirmação' end)
  from metric_state state
  join records r on r.base_code=state.base_code and r.source='contract_values'
    and r.valid_from<=state.observed_on and (r.valid_until is null or r.valid_until>state.observed_on)
  left join lateral (
    select case when count(*)=1 then min(m.details->>'contract') end contract
    from metric_rows m
    where m.base_code=state.base_code and m.month=state.month and m.kind='active_contract'
      and m.details->>'client'=r.payload->>'client_key'
      and length(coalesce(r.payload->>'plan',''))>0
      and starts_with(normalize(m.details->>'description'),normalize(r.payload->>'plan'))
      and (r.payload->>'activated' is null or exists (
        select from base_rows_on(state.observed_on,state.base_code) contract
        where contract.source='contracts' and contract.external_key=m.details->>'contract'
          and contract.payload->>'activated'=r.payload->>'activated'))
  ) matched on true
  left join metric_rows c on c.base_code=state.base_code and c.month=state.month
    and c.kind='active_contract' and c.details->>'contract'=matched.contract;

  -- Several ambiguous source rows cannot overwrite the same contract value.
  update metric_rows m set details=m.details||jsonb_build_object(
    'monthly_report',v.amount,'monthly_report_date',v.occurred_on,'renewal_report',v.details->>'renewal')
  from metric_rows v
  where m.kind='active_contract' and v.kind='contract_values'
    and m.base_code=v.base_code and m.month=v.month and m.details->>'contract'=v.details->>'contract'
    and (select count(*) from metric_rows other where other.kind='contract_values'
      and other.base_code=v.base_code and other.month=v.month
      and other.details->>'contract'=v.details->>'contract')=1;
end $$;

do $$
declare cutoff date;
begin
  select max(observed_on) into cutoff from comercial.source_loads;
  if cutoff is not null then perform comercial.refresh_all(cutoff); end if;
end $$;

commit;
