begin;
create schema if not exists comercial;
revoke all on schema comercial from public;

do $$
begin
  if not exists (select from pg_roles where rolname = 'lb_dashboard') then
    create role lb_dashboard nologin;
  end if;
  execute format('grant lb_dashboard to %I', current_user);
end $$;

grant usage on schema comercial to lb_dashboard;
alter default privileges in schema comercial revoke execute on functions from public;

create table comercial.sellers (
  seller_key text primary key,
  name text not null unique,
  team text not null check (team in ('Hunter', 'Carteira', 'Internas')),
  active boolean not null default true
);
create table comercial.accounts (
  email text primary key check (email = lower(email)),
  name text not null,
  role text not null check (role in ('admin','manager','seller')),
  seller_key text references comercial.sellers,
  active boolean not null default true,
  check ((role = 'seller') = (seller_key is not null))
);
create table comercial.settings (
  setting text primary key,
  value jsonb not null
);
create table comercial.settings_history (
  id bigint generated always as identity primary key,
  setting text not null,
  old_value jsonb,
  new_value jsonb not null,
  changed_by text not null,
  changed_at timestamptz not null default now()
);
create table comercial.targets (
  seller_key text not null references comercial.sellers,
  effective_month date not null check (extract(day from effective_month) = 1),
  amount numeric(16,2) not null check (amount >= 0),
  primary key (seller_key, effective_month)
);
create table comercial.product_rates (
  product text not null,
  effective_month date not null check (extract(day from effective_month) = 1),
  rate numeric(8,5) not null check (rate between 0 and 1),
  primary key (product, effective_month)
);
create table comercial.sales_review (
  contract_id text primary key,
  seller_key text not null references comercial.sellers,
  items jsonb not null,
  note text not null,
  updated_at timestamptz not null default now()
);

create table comercial.import_batches (
  id uuid primary key default gen_random_uuid(),
  submitted_by text not null,
  submitted_at timestamptz not null default now(),
  submission_order bigint generated always as identity,
  observed_on date not null,
  status text not null default 'queued'
    check (status in ('queued','processing','complete','partial','failed')),
  attempt integer not null default 0,
  lease_until timestamptz,
  available_at timestamptz not null default now(),
  finished_at timestamptz,
  error text
);
create table comercial.import_files (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references comercial.import_batches,
  name text not null,
  object_key text not null unique,
  bytes integer not null,
  sha256 text not null check (length(sha256) = 64),
  source text,
  rows_read integer not null default 0,
  rows_applied integer not null default 0,
  issues jsonb not null default '[]',
  status text not null default 'queued'
    check (status in ('queued','applied','unchanged','failed')),
  error text
);
create index import_files_batch on comercial.import_files (batch_id);

create table comercial.source_loads (
  source text primary key,
  file_id uuid not null references comercial.import_files,
  sha256 text not null,
  observed_on date not null,
  rows_loaded integer not null,
  loaded_at timestamptz not null default now()
);
create table comercial.source_observations (
  source text not null,
  observed_on date not null,
  file_id uuid not null references comercial.import_files,
  scope_start date,
  scope_end date,
  primary key (source, observed_on)
);

create table comercial.records (
  source text not null,
  external_key text not null,
  valid_from date not null,
  valid_until date,
  event_day date,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  file_id uuid not null references comercial.import_files,
  row_number integer not null,
  primary key (source, external_key, valid_from),
  check (valid_until is null or valid_from < valid_until)
);
create unique index records_current on comercial.records (source, external_key) where valid_until is null;
create index records_source_day on comercial.records (source, event_day, valid_from);
create index records_contract_lookup on comercial.records (source, (payload->>'contract_key'));
create index records_customer_lookup on comercial.records (source, (payload->>'client_key'));

create table comercial.metric_rows (
  month date not null,
  kind text not null,
  row_key text not null,
  seller_key text references comercial.sellers,
  occurred_on date,
  label text not null,
  amount numeric(18,4),
  city text,
  branch text,
  product text,
  details jsonb not null default '{}',
  primary key (month, kind, row_key)
);
create index metric_scope on comercial.metric_rows (month, seller_key, kind);
create index metric_filters on comercial.metric_rows (month, kind, branch, city, product);
create table comercial.metric_state (
  month date primary key,
  observed_on date not null,
  data jsonb not null,
  refreshed_at timestamptz not null default now()
);

create function comercial.normalize(value text) returns text
language sql immutable parallel safe
return trim(regexp_replace(translate(upper(coalesce(value,'')),
  'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN'), '[[:space:]]+', ' ', 'g'));

create function comercial.email() returns text
language sql stable
return lower(coalesce(current_setting('app.user_email',true),''));

create function comercial.profile() returns table(email text,name text,role text,seller_key text)
language sql stable security definer set search_path = pg_catalog, comercial
as $$
  select a.email,a.name,a.role,a.seller_key
  from comercial.accounts a where a.email = comercial.email() and a.active
$$;

create function comercial.is_admin() returns boolean
language sql stable security definer set search_path = pg_catalog, comercial
return coalesce((select p.role = 'admin' from comercial.profile() p),false);

alter table comercial.metric_rows enable row level security;
create policy metric_read on comercial.metric_rows for select to lb_dashboard using (
  exists (select from comercial.profile() p
          where p.role in ('admin','manager') or (p.role = 'seller' and p.seller_key = metric_rows.seller_key))
);

alter table comercial.sellers enable row level security;
create policy seller_read on comercial.sellers for select to lb_dashboard using (
  exists (select from comercial.profile() p
          where p.role in ('admin','manager') or (p.role = 'seller' and p.seller_key = sellers.seller_key))
);
alter table comercial.metric_state enable row level security;
create policy state_read on comercial.metric_state for select to lb_dashboard using (
  exists (select from comercial.profile())
);
grant select on comercial.metric_rows, comercial.sellers, comercial.metric_state to lb_dashboard;
grant execute on function comercial.email(), comercial.profile(), comercial.is_admin() to lb_dashboard;
commit;
