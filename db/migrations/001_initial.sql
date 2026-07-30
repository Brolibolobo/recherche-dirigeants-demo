begin;

create table api_cache_pages (
  query_hash text not null check (query_hash ~ '^[0-9a-f]{64}$'),
  page integer not null check (page > 0), request jsonb not null, response jsonb not null,
  source_status integer not null default 200, schema_version smallint not null default 1,
  fetched_at timestamptz not null default now(), primary key (query_hash, page)
);
create table cache_page_locks (
  query_hash text not null, page integer not null check (page > 0), owner uuid not null,
  locked_until timestamptz not null, primary key (query_hash, page)
);
create table leads (
  lead_key text primary key check (lead_key ~ '^[0-9a-f]{64}$'), director_fingerprint text not null,
  person_name_fingerprint text not null check (person_name_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_version smallint not null check (fingerprint_version > 0),
  identity_quality text not null check (identity_quality in ('strong','medium','weak')),
  birth_year text not null default '' check (birth_year = '' or birth_year ~ '^\d{4}$'),
  company_siren text not null default '', payload jsonb not null,
  first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now()
);
create index leads_first_seen_cursor_idx on leads(first_seen_at asc, lead_key asc);
create table scans (
  id uuid primary key default gen_random_uuid(), query_hash text not null, filters jsonb not null,
  target_count integer not null check (target_count between 1 and 100),
  result_count integer not null default 0 check (result_count >= 0),
  status text not null default 'running' check (status in ('running','completed','partial','failed')),
  warning text not null default '', created_at timestamptz not null default now(), completed_at timestamptz
);
create index scans_created_idx on scans(created_at desc);
create table lead_deliveries (
  lead_key text primary key references leads(lead_key), person_name_fingerprint text not null,
  birth_year text not null default '', first_scan_id uuid not null references scans(id),
  delivered_at timestamptz not null default now(), payload_snapshot jsonb not null
);
create index lead_deliveries_identity_idx on lead_deliveries(person_name_fingerprint, birth_year);
create index lead_deliveries_history_cursor_idx on lead_deliveries(delivered_at desc, lead_key desc);
create table scan_results (
  scan_id uuid not null references scans(id) on delete cascade, lead_key text not null references leads(lead_key),
  ordinal integer not null check (ordinal > 0), payload_snapshot jsonb not null,
  primary key (scan_id, lead_key), unique(scan_id, ordinal)
);
create table upstream_rate_limits (limiter_key text primary key, next_allowed_at timestamptz not null default now());
create table scan_rate_limits (
  identifier_hash text not null, window_start timestamptz not null, request_count integer not null default 0,
  primary key(identifier_hash, window_start)
);
create index scan_rate_limits_window_idx on scan_rate_limits(window_start);

create or replace function consume_scan_rate_limit(p_identifier_hash text, p_max_requests integer default 5, p_window_seconds integer default 60)
returns boolean language plpgsql as $$
declare v_window timestamptz; v_count integer;
begin
  if p_max_requests < 1 or p_window_seconds < 1 then raise exception 'invalid_rate_limit'; end if;
  v_window := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  delete from scan_rate_limits where window_start < clock_timestamp() - interval '1 day';
  insert into scan_rate_limits values (p_identifier_hash,v_window,1)
  on conflict(identifier_hash,window_start) do update set request_count=scan_rate_limits.request_count+1
  returning request_count into v_count;
  return v_count <= p_max_requests;
end $$;

create or replace function reserve_upstream_slot(p_limiter_key text, p_interval_ms integer default 170)
returns integer language plpgsql as $$
declare v_now timestamptz:=clock_timestamp(); v_next timestamptz; v_wait integer;
begin
  if p_interval_ms < 1 or p_interval_ms > 10000 then raise exception 'invalid_interval'; end if;
  insert into upstream_rate_limits values(p_limiter_key,v_now) on conflict do nothing;
  select next_allowed_at into v_next from upstream_rate_limits where limiter_key=p_limiter_key for update;
  v_wait:=greatest(0,ceil(extract(epoch from(v_next-v_now))*1000)::integer);
  update upstream_rate_limits set next_allowed_at=greatest(v_next,v_now)+make_interval(secs=>p_interval_ms/1000.0) where limiter_key=p_limiter_key;
  return v_wait;
end $$;

create or replace function claim_cache_page(p_query_hash text,p_page integer,p_owner uuid,p_lease_seconds integer default 30)
returns boolean language plpgsql as $$
declare v_owner uuid;
begin
  if p_page < 1 or p_lease_seconds < 1 or p_lease_seconds > 300 then raise exception 'invalid_cache_claim'; end if;
  insert into cache_page_locks values(p_query_hash,p_page,p_owner,clock_timestamp()+make_interval(secs=>p_lease_seconds))
  on conflict(query_hash,page) do update set owner=excluded.owner,locked_until=excluded.locked_until
  where cache_page_locks.locked_until<clock_timestamp() or cache_page_locks.owner=excluded.owner returning owner into v_owner;
  return v_owner=p_owner;
end $$;

create or replace function reserve_scan_leads(p_scan_id uuid,p_candidates jsonb,p_limit integer)
returns table(lead_key text,ordinal integer,payload jsonb) language plpgsql as $$
declare v_existing integer; v_total integer;
begin
  if jsonb_typeof(p_candidates)<>'array' then raise exception 'candidates_must_be_array'; end if;
  if p_limit < 1 then return; end if;
  if not exists(select 1 from scans where id=p_scan_id and status='running') then raise exception 'scan_not_running'; end if;
  perform pg_advisory_xact_lock(hashtextextended('global-lead-ledger',0));
  perform 1 from scans where id=p_scan_id and status='running' for update;
  if not found then raise exception 'scan_not_running'; end if;
  select count(*)::integer into v_existing from scan_results where scan_id=p_scan_id;
  with parsed as materialized (
    select distinct on (x.value->>'lead_key') x.value->>'lead_key' lead_key,x.value->>'director_fingerprint' director_fingerprint,
      x.value->>'person_name_fingerprint' person_name_fingerprint,(x.value->>'fingerprint_version')::smallint fingerprint_version,
      x.value->>'identity_quality' identity_quality,coalesce(x.value->>'birth_year','') birth_year,
      coalesce(x.value->>'company_siren','') company_siren,x.value->'payload' payload,x.ordinality::integer input_ordinal
    from jsonb_array_elements(p_candidates) with ordinality x(value,ordinality)
    where x.value->>'lead_key' ~ '^[0-9a-f]{64}$' and x.value->>'director_fingerprint' ~ '^[0-9a-f]{64}$'
      and x.value->>'person_name_fingerprint' ~ '^[0-9a-f]{64}$' and (x.value->>'fingerprint_version')::integer > 0
      and x.value->>'identity_quality' in ('strong','medium','weak')
      and (coalesce(x.value->>'birth_year','')='' or x.value->>'birth_year' ~ '^\d{4}$')
      and jsonb_typeof(x.value->'payload')='object'
    order by x.value->>'lead_key',case x.value->>'identity_quality' when 'strong' then 3 when 'medium' then 2 else 1 end desc,x.ordinality
  ), upserted as (
    insert into leads(lead_key,director_fingerprint,person_name_fingerprint,fingerprint_version,identity_quality,birth_year,company_siren,payload,first_seen_at,last_seen_at)
    select p.lead_key,p.director_fingerprint,p.person_name_fingerprint,p.fingerprint_version,p.identity_quality,p.birth_year,p.company_siren,p.payload,now(),now() from parsed p
    on conflict on constraint leads_pkey do update set
      director_fingerprint=case when case excluded.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end > case leads.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end then excluded.director_fingerprint else leads.director_fingerprint end,
      person_name_fingerprint=case when case excluded.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end > case leads.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end then excluded.person_name_fingerprint else leads.person_name_fingerprint end,
      fingerprint_version=case when case excluded.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end > case leads.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end then excluded.fingerprint_version else leads.fingerprint_version end,
      identity_quality=case when case excluded.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end > case leads.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end then excluded.identity_quality else leads.identity_quality end,
      birth_year=case when case excluded.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end > case leads.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end then excluded.birth_year else leads.birth_year end,
      company_siren=case when case excluded.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end > case leads.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end then excluded.company_siren else leads.company_siren end,
      payload=case when case excluded.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end > case leads.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end then excluded.payload else leads.payload end,
      last_seen_at=now()
    returning leads.lead_key
  ), eligible as (
    select p.* from parsed p where not exists(select 1 from lead_deliveries d where
      d.lead_key=p.lead_key or (d.person_name_fingerprint=p.person_name_fingerprint and (p.birth_year='' or d.birth_year='' or d.birth_year=p.birth_year)))
      and not (p.birth_year='' and exists (
        select 1 from parsed known
        where known.person_name_fingerprint=p.person_name_fingerprint and known.birth_year<>''
      ))
  ), identity_ranked as (
    select e.*,row_number() over(
      partition by e.person_name_fingerprint,e.birth_year
      order by case e.identity_quality when 'strong' then 3 when 'medium' then 2 else 1 end desc,e.input_ordinal
    ) identity_ordinal from eligible e
  ), selected as materialized (
    select ranked.* from identity_ranked ranked where ranked.identity_ordinal=1 order by ranked.input_ordinal limit least(p_limit,100)
  ), delivered as (
    insert into lead_deliveries(lead_key,person_name_fingerprint,birth_year,first_scan_id,payload_snapshot)
    select s.lead_key,s.person_name_fingerprint,s.birth_year,p_scan_id,s.payload from selected s order by s.input_ordinal
    on conflict do nothing returning lead_deliveries.lead_key,lead_deliveries.payload_snapshot
  ), results as (
    insert into scan_results(scan_id,lead_key,ordinal,payload_snapshot)
    select p_scan_id,d.lead_key,v_existing+row_number() over(order by s.input_ordinal),d.payload_snapshot from delivered d join selected s on s.lead_key=d.lead_key
    returning scan_results.lead_key,scan_results.ordinal,scan_results.payload_snapshot
  )
  select count(*)+v_existing into v_total from results;
  update scans set result_count=v_total where id=p_scan_id;
  return query select r.lead_key,r.ordinal,r.payload_snapshot from scan_results r where r.scan_id=p_scan_id and r.ordinal>v_existing order by r.ordinal;
end $$;

commit;
