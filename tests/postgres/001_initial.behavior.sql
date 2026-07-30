\set ON_ERROR_STOP on
begin;

insert into scans(id,query_hash,filters,target_count) values
('90000000-0000-0000-0000-000000000001',repeat('1',64),'{}',2),
('90000000-0000-0000-0000-000000000002',repeat('1',64),'{}',2),
('90000000-0000-0000-0000-000000000003',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000004',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000005',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000006',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000007',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000008',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000009',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000010',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000011',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000012',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000013',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000014',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000015',repeat('1',64),'{}',1),
('90000000-0000-0000-0000-000000000016',repeat('1',64),'{}',1);

create temporary table weak_then_strong as select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000001',
jsonb_build_array(
 jsonb_build_object('lead_key',repeat('a',64),'director_fingerprint',repeat('a',64),'person_name_fingerprint',repeat('1',64),'fingerprint_version',2,'identity_quality','weak','birth_year','','company_siren','1','payload','{"choice":"weak"}'::jsonb),
 jsonb_build_object('lead_key',repeat('b',64),'director_fingerprint',repeat('b',64),'person_name_fingerprint',repeat('1',64),'fingerprint_version',2,'identity_quality','medium','birth_year','1980','company_siren','2','payload','{"choice":"strong"}'::jsonb)
),2);

create temporary table strong_then_weak as select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000002',
jsonb_build_array(
 jsonb_build_object('lead_key',repeat('c',64),'director_fingerprint',repeat('c',64),'person_name_fingerprint',repeat('2',64),'fingerprint_version',2,'identity_quality','medium','birth_year','1981','company_siren','3','payload','{"choice":"strong"}'::jsonb),
 jsonb_build_object('lead_key',repeat('d',64),'director_fingerprint',repeat('d',64),'person_name_fingerprint',repeat('2',64),'fingerprint_version',2,'identity_quality','weak','birth_year','','company_siren','4','payload','{"choice":"weak"}'::jsonb)
),2);

create temporary table weak_first_batch as select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000003',
jsonb_build_array(jsonb_build_object('lead_key',repeat('e',64),'director_fingerprint',repeat('e',64),'person_name_fingerprint',repeat('3',64),'fingerprint_version',2,'identity_quality','weak','birth_year','','company_siren','5','payload','{}'::jsonb)),1);
create temporary table strong_after_weak as select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000004',
jsonb_build_array(jsonb_build_object('lead_key',repeat('f',64),'director_fingerprint',repeat('f',64),'person_name_fingerprint',repeat('3',64),'fingerprint_version',2,'identity_quality','medium','birth_year','1982','company_siren','6','payload','{}'::jsonb)),1);

create temporary table strong_first_batch as select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000005',
jsonb_build_array(jsonb_build_object('lead_key',repeat('4',64),'director_fingerprint',repeat('4',64),'person_name_fingerprint',repeat('5',64),'fingerprint_version',2,'identity_quality','medium','birth_year','1983','company_siren','7','payload','{}'::jsonb)),1);
create temporary table weak_after_strong as select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000006',
jsonb_build_array(jsonb_build_object('lead_key',repeat('6',64),'director_fingerprint',repeat('6',64),'person_name_fingerprint',repeat('5',64),'fingerprint_version',2,'identity_quality','weak','birth_year','','company_siren','8','payload','{}'::jsonb)),1);

create temporary table known_year_one as select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000007',
jsonb_build_array(jsonb_build_object('lead_key',repeat('7',64),'director_fingerprint',repeat('7',64),'person_name_fingerprint',repeat('8',64),'fingerprint_version',2,'identity_quality','medium','birth_year','1970','company_siren','9','payload','{}'::jsonb)),1);
create temporary table known_year_two as select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000008',
jsonb_build_array(jsonb_build_object('lead_key',repeat('9',64),'director_fingerprint',repeat('9',64),'person_name_fingerprint',repeat('8',64),'fingerprint_version',2,'identity_quality','medium','birth_year','1971','company_siren','10','payload','{}'::jsonb)),1);

create temporary table medium_then_strong_same_key as select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000011',
jsonb_build_array(
 jsonb_build_object('lead_key',repeat('0',64),'director_fingerprint',repeat('a',64),'person_name_fingerprint',repeat('a',64),'fingerprint_version',2,'identity_quality','medium','birth_year','1984','company_siren','11','payload','{"choice":"medium"}'::jsonb),
 jsonb_build_object('lead_key',repeat('0',64),'director_fingerprint',repeat('b',64),'person_name_fingerprint',repeat('b',64),'fingerprint_version',3,'identity_quality','strong','birth_year','1984','company_siren','12','payload','{"choice":"strong"}'::jsonb)
),1);
create temporary table strong_then_medium_same_key as select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000012',
jsonb_build_array(
 jsonb_build_object('lead_key',repeat('2',64),'director_fingerprint',repeat('c',64),'person_name_fingerprint',repeat('c',64),'fingerprint_version',3,'identity_quality','strong','birth_year','1985','company_siren','13','payload','{"choice":"strong"}'::jsonb),
 jsonb_build_object('lead_key',repeat('2',64),'director_fingerprint',repeat('d',64),'person_name_fingerprint',repeat('d',64),'fingerprint_version',2,'identity_quality','medium','birth_year','1985','company_siren','14','payload','{"choice":"medium"}'::jsonb)
),1);

select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000013',
jsonb_build_array(jsonb_build_object('lead_key',repeat('3',64),'director_fingerprint',repeat('a',64),'person_name_fingerprint',repeat('a',64),'fingerprint_version',2,'identity_quality','medium','birth_year','1986','company_siren','15','payload','{"choice":"medium"}'::jsonb)),1);
select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000014',
jsonb_build_array(jsonb_build_object('lead_key',repeat('3',64),'director_fingerprint',repeat('b',64),'person_name_fingerprint',repeat('b',64),'fingerprint_version',3,'identity_quality','strong','birth_year','1986','company_siren','16','payload','{"choice":"strong"}'::jsonb)),1);
select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000015',
jsonb_build_array(jsonb_build_object('lead_key',repeat('5',64),'director_fingerprint',repeat('c',64),'person_name_fingerprint',repeat('c',64),'fingerprint_version',3,'identity_quality','strong','birth_year','1987','company_siren','17','payload','{"choice":"strong"}'::jsonb)),1);
select * from reserve_scan_leads(
'90000000-0000-0000-0000-000000000016',
jsonb_build_array(jsonb_build_object('lead_key',repeat('5',64),'director_fingerprint',repeat('d',64),'person_name_fingerprint',repeat('d',64),'fingerprint_version',2,'identity_quality','medium','birth_year','1987','company_siren','18','payload','{"choice":"medium"}'::jsonb)),1);

do $$ begin
  if (select count(*) from weak_then_strong) <> 1 or (select payload->>'choice' from weak_then_strong) <> 'strong' then raise exception 'weak-first same batch did not retain known birth year'; end if;
  if (select count(*) from strong_then_weak) <> 1 or (select payload->>'choice' from strong_then_weak) <> 'strong' then raise exception 'strong-first same batch did not retain known birth year'; end if;
  if (select count(*) from weak_first_batch) <> 1 or (select count(*) from strong_after_weak) <> 0 then raise exception 'weak then strong across batches was redelivered'; end if;
  if (select count(*) from strong_first_batch) <> 1 or (select count(*) from weak_after_strong) <> 0 then raise exception 'strong then weak across batches was redelivered'; end if;
  if (select count(*) from known_year_one) <> 1 or (select count(*) from known_year_two) <> 1 or (select count(*) from lead_deliveries where person_name_fingerprint=repeat('8',64)) <> 2 then raise exception 'different known birth years were collapsed'; end if;
  if (select payload->>'choice' from medium_then_strong_same_key) <> 'strong' or not exists(select 1 from leads where lead_key=repeat('0',64) and director_fingerprint=repeat('b',64) and person_name_fingerprint=repeat('b',64) and fingerprint_version=3 and identity_quality='strong' and company_siren='12') then raise exception 'same-batch medium then strong did not prefer strong'; end if;
  if (select payload->>'choice' from strong_then_medium_same_key) <> 'strong' or not exists(select 1 from leads where lead_key=repeat('2',64) and director_fingerprint=repeat('c',64) and person_name_fingerprint=repeat('c',64) and fingerprint_version=3 and identity_quality='strong' and company_siren='13') then raise exception 'same-batch strong then medium did not retain strong'; end if;
  if not exists(select 1 from leads where lead_key=repeat('3',64) and director_fingerprint=repeat('b',64) and person_name_fingerprint=repeat('b',64) and fingerprint_version=3 and identity_quality='strong' and company_siren='16' and payload->>'choice'='strong') then raise exception 'inter-batch medium was not promoted to strong'; end if;
  if not exists(select 1 from leads where lead_key=repeat('5',64) and director_fingerprint=repeat('c',64) and person_name_fingerprint=repeat('c',64) and fingerprint_version=3 and identity_quality='strong' and company_siren='17' and payload->>'choice'='strong') then raise exception 'inter-batch strong was downgraded to medium'; end if;
end $$;

do $$ declare first_wait integer; second_wait integer; begin
  first_wait := reserve_upstream_slot('behavior-test', 170);
  second_wait := reserve_upstream_slot('behavior-test', 170);
  if first_wait < 0 or second_wait <= 0 then raise exception 'upstream slots were not serialized'; end if;
  if not consume_scan_rate_limit(repeat('d',64), 2, 60) then raise exception 'first quota call refused'; end if;
  if not consume_scan_rate_limit(repeat('d',64), 2, 60) then raise exception 'second quota call refused'; end if;
  if consume_scan_rate_limit(repeat('d',64), 2, 60) then raise exception 'quota allowed too many calls'; end if;
end $$;

do $$ declare
  owner_a uuid := '91000000-0000-0000-0000-000000000001';
  owner_b uuid := '91000000-0000-0000-0000-000000000002';
begin
  if not claim_cache_page(repeat('c',64),1,owner_a,30) then raise exception 'first lease claim refused'; end if;
  if claim_cache_page(repeat('c',64),1,owner_b,30) then raise exception 'active lease was stolen'; end if;
  update cache_page_locks set locked_until=clock_timestamp()-interval '1 second' where query_hash=repeat('c',64) and page=1;
  if not claim_cache_page(repeat('c',64),1,owner_b,30) then raise exception 'expired lease was not reclaimed'; end if;
end $$;

rollback;
