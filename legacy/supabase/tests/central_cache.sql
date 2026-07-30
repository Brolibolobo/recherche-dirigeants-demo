begin;

insert into public.workspaces (id, name)
values
  ('10000000-0000-0000-0000-000000000001', 'Test A'),
  ('10000000-0000-0000-0000-000000000002', 'Test B');

insert into public.scans (id, workspace_id, query_hash, filters, target_count)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', repeat('1', 64), '{}'::jsonb, 2),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', repeat('1', 64), '{}'::jsonb, 2),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', repeat('1', 64), '{}'::jsonb, 1),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', repeat('1', 64), '{}'::jsonb, 1),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', repeat('1', 64), '{}'::jsonb, 1),
  ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000002', repeat('1', 64), '{}'::jsonb, 1),
  ('20000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000002', repeat('1', 64), '{}'::jsonb, 2);

create temporary table first_reservation as
select * from public.reserve_scan_leads(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  jsonb_build_array(
    jsonb_build_object('lead_key', repeat('a',64), 'director_fingerprint', repeat('a',64), 'person_name_fingerprint', repeat('1',64), 'birth_year', '1980', 'fingerprint_version', 2, 'identity_quality', 'strong', 'company_siren', '111111111', 'payload', '{"nom":"Alice"}'::jsonb),
    jsonb_build_object('lead_key', repeat('b',64), 'director_fingerprint', repeat('b',64), 'person_name_fingerprint', repeat('2',64), 'birth_year', '', 'fingerprint_version', 2, 'identity_quality', 'weak', 'company_siren', '222222222', 'payload', '{"nom":"Bob"}'::jsonb)
  ),
  1
);

create temporary table second_reservation as
select * from public.reserve_scan_leads(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000002',
  jsonb_build_array(
    jsonb_build_object('lead_key', repeat('a',64), 'director_fingerprint', repeat('a',64), 'person_name_fingerprint', repeat('1',64), 'birth_year', '1980', 'fingerprint_version', 2, 'identity_quality', 'strong', 'company_siren', '111111111', 'payload', '{"nom":"Alice"}'::jsonb),
    jsonb_build_object('lead_key', repeat('b',64), 'director_fingerprint', repeat('b',64), 'person_name_fingerprint', repeat('2',64), 'birth_year', '', 'fingerprint_version', 2, 'identity_quality', 'weak', 'company_siren', '222222222', 'payload', '{"nom":"Bob"}'::jsonb)
  ),
  2
);

create temporary table other_workspace_reservation as
select * from public.reserve_scan_leads(
  '10000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000003',
  jsonb_build_array(
    jsonb_build_object('lead_key', repeat('a',64), 'director_fingerprint', repeat('a',64), 'person_name_fingerprint', repeat('1',64), 'birth_year', '1980', 'fingerprint_version', 2, 'identity_quality', 'strong', 'company_siren', '111111111', 'payload', '{"nom":"Alice"}'::jsonb)
  ),
  1
);

create temporary table weak_after_strong as
select * from public.reserve_scan_leads(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000004',
  jsonb_build_array(
    jsonb_build_object('lead_key', repeat('c',64), 'director_fingerprint', repeat('c',64), 'person_name_fingerprint', repeat('1',64), 'birth_year', '', 'fingerprint_version', 2, 'identity_quality', 'weak', 'company_siren', '333333333', 'payload', '{"nom":"Alice faible"}'::jsonb)
  ),
  1
);

create temporary table strong_after_weak as
select * from public.reserve_scan_leads(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000005',
  jsonb_build_array(
    jsonb_build_object('lead_key', repeat('d',64), 'director_fingerprint', repeat('d',64), 'person_name_fingerprint', repeat('2',64), 'birth_year', '1975', 'fingerprint_version', 2, 'identity_quality', 'strong', 'company_siren', '444444444', 'payload', '{"nom":"Bob fort"}'::jsonb)
  ),
  1
);

create temporary table distinct_homonym_year as
select * from public.reserve_scan_leads(
  '10000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000006',
  jsonb_build_array(
    jsonb_build_object('lead_key', repeat('e',64), 'director_fingerprint', repeat('e',64), 'person_name_fingerprint', repeat('1',64), 'birth_year', '1981', 'fingerprint_version', 2, 'identity_quality', 'strong', 'company_siren', '555555555', 'payload', '{"nom":"Alice homonyme"}'::jsonb)
  ),
  1
);

create temporary table same_identity_in_one_batch as
select * from public.reserve_scan_leads(
  '10000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000007',
  jsonb_build_array(
    jsonb_build_object('lead_key', repeat('f',64), 'director_fingerprint', repeat('f',64), 'person_name_fingerprint', repeat('3',64), 'birth_year', '1990', 'fingerprint_version', 2, 'identity_quality', 'strong', 'company_siren', '666666666', 'payload', '{"nom":"Charlie société 1"}'::jsonb),
    jsonb_build_object('lead_key', repeat('9',64), 'director_fingerprint', repeat('9',64), 'person_name_fingerprint', repeat('3',64), 'birth_year', '1990', 'fingerprint_version', 2, 'identity_quality', 'strong', 'company_siren', '777777777', 'payload', '{"nom":"Charlie société 2"}'::jsonb)
  ),
  2
);

do $$
begin
  if (select count(*) from first_reservation) <> 1 then raise exception 'first scan must reserve one lead'; end if;
  if (select count(*) from second_reservation) <> 1 then raise exception 'second scan must skip Alice and reserve Bob'; end if;
  if exists (select 1 from first_reservation join second_reservation using (lead_key)) then raise exception 'same workspace received a duplicate'; end if;
  if (select count(*) from other_workspace_reservation) <> 1 then raise exception 'another workspace must be allowed to receive Alice'; end if;
  if (select count(*) from weak_after_strong) <> 0 then raise exception 'weak identity must not reappear after strong identity'; end if;
  if (select count(*) from strong_after_weak) <> 0 then raise exception 'strong identity must not reappear after weak identity'; end if;
  if (select count(*) from distinct_homonym_year) <> 1 then raise exception 'same name with another known year must stay eligible'; end if;
  if (select count(*) from same_identity_in_one_batch) <> 1 then raise exception 'same identity in one batch must be delivered only once'; end if;
  if (select count(*) from public.workspace_lead_deliveries where workspace_id = '10000000-0000-0000-0000-000000000001') <> 2 then raise exception 'workspace delivery ledger is incomplete'; end if;
end;
$$;

do $$
declare
  owner_a uuid := '30000000-0000-0000-0000-000000000001';
  owner_b uuid := '30000000-0000-0000-0000-000000000002';
begin
  if not public.claim_cache_page(repeat('c',64), 1, owner_a, 30) then raise exception 'first cache owner must win'; end if;
  if not public.claim_cache_page(repeat('c',64), 1, owner_a, 30) then raise exception 'same cache owner must renew its lease'; end if;
  if public.claim_cache_page(repeat('c',64), 1, owner_b, 30) then raise exception 'second cache owner must wait'; end if;
  perform public.release_cache_page(repeat('c',64), 1, owner_a);
  if not public.claim_cache_page(repeat('c',64), 1, owner_b, 30) then raise exception 'second cache owner must win after release'; end if;
end;
$$;

do $$
declare
  identifier text := repeat('d',64);
begin
  if not public.consume_scan_rate_limit(identifier, 2, 60) then raise exception 'first request refused'; end if;
  if not public.consume_scan_rate_limit(identifier, 2, 60) then raise exception 'second request refused'; end if;
  if public.consume_scan_rate_limit(identifier, 2, 60) then raise exception 'third request allowed'; end if;
end;
$$;

rollback;
