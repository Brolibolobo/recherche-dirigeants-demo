create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.api_cache_pages (
  query_hash text not null check (query_hash ~ '^[0-9a-f]{64}$'),
  page integer not null check (page > 0),
  request jsonb not null,
  response jsonb not null,
  source_status integer not null default 200,
  schema_version smallint not null default 1,
  fetched_at timestamptz not null default now(),
  primary key (query_hash, page)
);

create table public.cache_page_locks (
  query_hash text not null,
  page integer not null check (page > 0),
  owner uuid not null,
  locked_until timestamptz not null,
  primary key (query_hash, page)
);

create table public.leads (
  lead_key text primary key check (lead_key ~ '^[0-9a-f]{64}$'),
  director_fingerprint text not null,
  person_name_fingerprint text not null check (person_name_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_version smallint not null check (fingerprint_version > 0),
  identity_quality text not null check (identity_quality in ('strong', 'medium', 'weak')),
  birth_year text not null default '' check (birth_year = '' or birth_year ~ '^\d{4}$'),
  company_siren text not null default '',
  payload jsonb not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table public.scans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  query_hash text not null,
  filters jsonb not null,
  target_count integer not null check (target_count between 1 and 100),
  result_count integer not null default 0 check (result_count >= 0),
  status text not null default 'running' check (status in ('running', 'completed', 'partial', 'failed')),
  warning text not null default '',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index scans_workspace_created_idx on public.scans (workspace_id, created_at desc);

create table public.workspace_lead_deliveries (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_key text not null references public.leads(lead_key) on delete restrict,
  person_name_fingerprint text not null check (person_name_fingerprint ~ '^[0-9a-f]{64}$'),
  birth_year text not null default '' check (birth_year = '' or birth_year ~ '^\d{4}$'),
  first_scan_id uuid not null references public.scans(id) on delete restrict,
  delivered_at timestamptz not null default now(),
  payload_snapshot jsonb not null,
  primary key (workspace_id, lead_key)
);

create index workspace_lead_identity_idx
on public.workspace_lead_deliveries (workspace_id, person_name_fingerprint, birth_year);

create table public.scan_results (
  scan_id uuid not null references public.scans(id) on delete cascade,
  lead_key text not null references public.leads(lead_key) on delete restrict,
  ordinal integer not null check (ordinal > 0),
  payload_snapshot jsonb not null,
  primary key (scan_id, lead_key),
  unique (scan_id, ordinal)
);

create table public.upstream_rate_limits (
  limiter_key text primary key,
  next_allowed_at timestamptz not null default now()
);

create table public.scan_rate_limits (
  identifier_hash text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (identifier_hash, window_start)
);

create index scan_rate_limits_window_idx on public.scan_rate_limits (window_start);

insert into public.workspaces (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Workspace public MVP')
on conflict (id) do nothing;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.api_cache_pages enable row level security;
alter table public.cache_page_locks enable row level security;
alter table public.leads enable row level security;
alter table public.scans enable row level security;
alter table public.workspace_lead_deliveries enable row level security;
alter table public.scan_results enable row level security;
alter table public.upstream_rate_limits enable row level security;
alter table public.scan_rate_limits enable row level security;

revoke all on table public.workspaces from anon, authenticated;
revoke all on table public.workspace_members from anon, authenticated;
revoke all on table public.api_cache_pages from anon, authenticated;
revoke all on table public.cache_page_locks from anon, authenticated;
revoke all on table public.leads from anon, authenticated;
revoke all on table public.scans from anon, authenticated;
revoke all on table public.workspace_lead_deliveries from anon, authenticated;
revoke all on table public.scan_results from anon, authenticated;
revoke all on table public.upstream_rate_limits from anon, authenticated;
revoke all on table public.scan_rate_limits from anon, authenticated;

grant select, insert, update, delete on table public.workspaces to service_role;
grant select, insert, update, delete on table public.workspace_members to service_role;
grant select, insert, update, delete on table public.api_cache_pages to service_role;
grant select, insert, update, delete on table public.cache_page_locks to service_role;
grant select, insert, update, delete on table public.leads to service_role;
grant select, insert, update, delete on table public.scans to service_role;
grant select, insert, update, delete on table public.workspace_lead_deliveries to service_role;
grant select, insert, update, delete on table public.scan_results to service_role;
grant select, insert, update, delete on table public.upstream_rate_limits to service_role;
grant select, insert, update, delete on table public.scan_rate_limits to service_role;

create or replace function public.reserve_scan_leads(
  p_workspace_id uuid,
  p_scan_id uuid,
  p_candidates jsonb,
  p_limit integer
)
returns table (lead_key text, ordinal integer, payload jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing integer;
  v_added integer;
begin
  if jsonb_typeof(p_candidates) <> 'array' then
    raise exception 'candidates_must_be_array';
  end if;
  if p_limit < 1 then
    return;
  end if;
  if not exists (
    select 1 from public.scans
    where id = p_scan_id and workspace_id = p_workspace_id and status = 'running'
  ) then
    raise exception 'scan_not_running_for_workspace';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  perform 1 from public.scans where id = p_scan_id for update;
  select count(*)::integer into v_existing from public.scan_results where scan_id = p_scan_id;

  with parsed as (
    select distinct on (item.value->>'lead_key')
      item.value->>'lead_key' as lead_key,
      item.value->>'director_fingerprint' as director_fingerprint,
      item.value->>'person_name_fingerprint' as person_name_fingerprint,
      (item.value->>'fingerprint_version')::smallint as fingerprint_version,
      item.value->>'identity_quality' as identity_quality,
      coalesce(item.value->>'birth_year', '') as birth_year,
      coalesce(item.value->>'company_siren', '') as company_siren,
      item.value->'payload' as payload,
      item.ordinality::integer as input_ordinal
    from jsonb_array_elements(p_candidates) with ordinality as item(value, ordinality)
    where item.value->>'lead_key' ~ '^[0-9a-f]{64}$'
      and coalesce(item.value->>'director_fingerprint', '') <> ''
      and item.value->>'person_name_fingerprint' ~ '^[0-9a-f]{64}$'
      and coalesce((item.value->>'fingerprint_version')::integer, 0) > 0
      and item.value->>'identity_quality' in ('strong', 'medium', 'weak')
      and (coalesce(item.value->>'birth_year', '') = '' or item.value->>'birth_year' ~ '^\d{4}$')
      and jsonb_typeof(item.value->'payload') = 'object'
    order by item.value->>'lead_key', item.ordinality
  )
  insert into public.leads (
    lead_key, director_fingerprint, person_name_fingerprint,
    fingerprint_version, identity_quality, birth_year, company_siren, payload
  )
  select
    parsed.lead_key, parsed.director_fingerprint, parsed.person_name_fingerprint,
    parsed.fingerprint_version, parsed.identity_quality, parsed.birth_year,
    parsed.company_siren, parsed.payload
  from parsed
  on conflict on constraint leads_pkey do update set
    director_fingerprint = excluded.director_fingerprint,
    person_name_fingerprint = excluded.person_name_fingerprint,
    fingerprint_version = excluded.fingerprint_version,
    identity_quality = excluded.identity_quality,
    birth_year = excluded.birth_year,
    company_siren = excluded.company_siren,
    payload = excluded.payload,
    last_seen_at = now();

  with parsed as (
    select distinct on (item.value->>'lead_key')
      item.value->>'lead_key' as lead_key,
      item.value->>'person_name_fingerprint' as person_name_fingerprint,
      coalesce(item.value->>'birth_year', '') as birth_year,
      item.value->'payload' as payload,
      item.ordinality::integer as input_ordinal
    from jsonb_array_elements(p_candidates) with ordinality as item(value, ordinality)
    where item.value->>'lead_key' ~ '^[0-9a-f]{64}$'
      and item.value->>'person_name_fingerprint' ~ '^[0-9a-f]{64}$'
      and (coalesce(item.value->>'birth_year', '') = '' or item.value->>'birth_year' ~ '^\d{4}$')
      and jsonb_typeof(item.value->'payload') = 'object'
    order by item.value->>'lead_key', item.ordinality
  ), eligible as (
    select parsed.*
    from parsed
    where not exists (
      select 1 from public.workspace_lead_deliveries delivered
      where delivered.workspace_id = p_workspace_id
        and (
          delivered.lead_key = parsed.lead_key
          or delivered.person_name_fingerprint = parsed.person_name_fingerprint
          and (
            parsed.birth_year = ''
            or delivered.birth_year = ''
            or delivered.birth_year = parsed.birth_year
          )
        )
    )
      and not (
        parsed.birth_year = '' and exists (
          select 1 from parsed specific
          where specific.person_name_fingerprint = parsed.person_name_fingerprint
            and specific.birth_year <> ''
        )
      )
  ), identity_ranked as (
    select eligible.*,
      row_number() over (
        partition by eligible.person_name_fingerprint, eligible.birth_year
        order by eligible.input_ordinal
      ) as identity_ordinal
    from eligible
  ), selected as materialized (
    select identity_ranked.*
    from identity_ranked
    where identity_ranked.identity_ordinal = 1
    order by identity_ranked.input_ordinal
    limit least(p_limit, 100)
  ), delivered as (
    insert into public.workspace_lead_deliveries (
      workspace_id, lead_key, person_name_fingerprint, birth_year, first_scan_id, payload_snapshot
    )
    select
      p_workspace_id, selected.lead_key, selected.person_name_fingerprint,
      selected.birth_year, p_scan_id, selected.payload
    from selected
    order by selected.input_ordinal
    on conflict on constraint workspace_lead_deliveries_pkey do nothing
    returning workspace_lead_deliveries.lead_key, workspace_lead_deliveries.payload_snapshot
  )
  insert into public.scan_results (scan_id, lead_key, ordinal, payload_snapshot)
  select
    p_scan_id,
    delivered.lead_key,
    v_existing + row_number() over (order by selected.input_ordinal),
    delivered.payload_snapshot
  from delivered
  join selected on selected.lead_key = delivered.lead_key
  order by selected.input_ordinal
  on conflict do nothing;

  get diagnostics v_added = row_count;
  update public.scans
  set result_count = v_existing + v_added
  where id = p_scan_id;

  return query
  select result.lead_key, result.ordinal, result.payload_snapshot
  from public.scan_results result
  where result.scan_id = p_scan_id
    and result.ordinal > v_existing
  order by result.ordinal;
end;
$$;

create or replace function public.reserve_upstream_slot(
  p_limiter_key text,
  p_interval_ms integer default 170
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_next timestamptz;
  v_wait_ms integer;
begin
  if p_interval_ms < 1 or p_interval_ms > 10000 then
    raise exception 'invalid_interval';
  end if;
  insert into public.upstream_rate_limits (limiter_key, next_allowed_at)
  values (p_limiter_key, v_now)
  on conflict (limiter_key) do nothing;

  select next_allowed_at into v_next
  from public.upstream_rate_limits
  where limiter_key = p_limiter_key
  for update;

  v_wait_ms := greatest(0, ceil(extract(epoch from (v_next - v_now)) * 1000)::integer);
  update public.upstream_rate_limits
  set next_allowed_at = greatest(v_next, v_now) + make_interval(secs => p_interval_ms / 1000.0)
  where limiter_key = p_limiter_key;
  return v_wait_ms;
end;
$$;

create or replace function public.consume_scan_rate_limit(
  p_identifier_hash text,
  p_max_requests integer default 5,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  if p_max_requests < 1 or p_window_seconds < 1 then
    raise exception 'invalid_rate_limit';
  end if;
  v_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  delete from public.scan_rate_limits
  where window_start < clock_timestamp() - interval '1 day';
  insert into public.scan_rate_limits (identifier_hash, window_start, request_count)
  values (p_identifier_hash, v_window, 1)
  on conflict (identifier_hash, window_start) do update
  set request_count = scan_rate_limits.request_count + 1
  returning request_count into v_count;
  return v_count <= p_max_requests;
end;
$$;

create or replace function public.claim_cache_page(
  p_query_hash text,
  p_page integer,
  p_owner uuid,
  p_lease_seconds integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner uuid;
begin
  if p_page < 1 or p_lease_seconds < 1 or p_lease_seconds > 300 then
    raise exception 'invalid_cache_claim';
  end if;
  insert into public.cache_page_locks (query_hash, page, owner, locked_until)
  values (p_query_hash, p_page, p_owner, clock_timestamp() + make_interval(secs => p_lease_seconds))
  on conflict (query_hash, page) do update set
    owner = excluded.owner,
    locked_until = excluded.locked_until
  where cache_page_locks.locked_until < clock_timestamp()
     or cache_page_locks.owner = excluded.owner
  returning owner into v_owner;
  return v_owner = p_owner;
end;
$$;

create or replace function public.release_cache_page(
  p_query_hash text,
  p_page integer,
  p_owner uuid
)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  delete from public.cache_page_locks
  where query_hash = p_query_hash and page = p_page and owner = p_owner;
$$;

revoke all on function public.reserve_scan_leads(uuid, uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.reserve_upstream_slot(text, integer) from public, anon, authenticated;
revoke all on function public.consume_scan_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_cache_page(text, integer, uuid, integer) from public, anon, authenticated;
revoke all on function public.release_cache_page(text, integer, uuid) from public, anon, authenticated;

grant execute on function public.reserve_scan_leads(uuid, uuid, jsonb, integer) to service_role;
grant execute on function public.reserve_upstream_slot(text, integer) to service_role;
grant execute on function public.consume_scan_rate_limit(text, integer, integer) to service_role;
grant execute on function public.claim_cache_page(text, integer, uuid, integer) to service_role;
grant execute on function public.release_cache_page(text, integer, uuid) to service_role;
