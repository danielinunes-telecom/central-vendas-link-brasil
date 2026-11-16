begin;

create or replace function comercial.contract_details_for(period date, row_ids text[])
returns table(row_key text, renewal date, total numeric, observed_on date)
language sql stable security definer set search_path = pg_catalog, comercial
as $$
  select m.row_key, (detail.payload->>'renewal')::date,
    (detail.payload->>'total')::numeric, detail.valid_from
  from metric_rows m
  join metric_state state on state.month=m.month
  join records detail on detail.source='contract_details'
    and detail.external_key=m.details->>'contract'
    and detail.valid_from<=state.observed_on
    and (detail.valid_until is null or detail.valid_until>state.observed_on)
    and (m.details->>'client' is null or detail.payload->>'client_key'=m.details->>'client')
  where m.month=period and m.kind='active_contract' and m.row_key=any(row_ids)
    and exists(select from profile() p where p.role in ('admin','manager')
      or (p.role='seller' and p.seller_key=m.seller_key))
$$;
revoke all on function comercial.contract_details_for(date,text[]) from public;
grant execute on function comercial.contract_details_for(date,text[]) to lb_dashboard;

commit;
