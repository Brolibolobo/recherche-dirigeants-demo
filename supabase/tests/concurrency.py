#!/usr/bin/env python3
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import psycopg
from psycopg.types.json import Jsonb

DSN = os.environ.get('SUPABASE_TEST_DSN', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres')
workspace_id = uuid.uuid4()
scan_ids = [uuid.uuid4(), uuid.uuid4()]
lead_keys = ['e' * 64, 'f' * 64]
candidates = [
    {'lead_key': lead_keys[0], 'director_fingerprint': lead_keys[0], 'person_name_fingerprint': '1' * 64, 'birth_year': '1980', 'fingerprint_version': 2, 'identity_quality': 'strong', 'company_siren': '111111111', 'payload': {'nom': 'Alice'}},
    {'lead_key': lead_keys[1], 'director_fingerprint': lead_keys[1], 'person_name_fingerprint': '2' * 64, 'birth_year': '', 'fingerprint_version': 2, 'identity_quality': 'weak', 'company_siren': '222222222', 'payload': {'nom': 'Bob'}},
]
barrier = threading.Barrier(2)

with psycopg.connect(DSN, autocommit=True) as conn:
    conn.execute('insert into public.workspaces (id, name) values (%s, %s)', (workspace_id, 'Concurrent test'))
    for scan_id in scan_ids:
        conn.execute(
            'insert into public.scans (id, workspace_id, query_hash, filters, target_count) values (%s, %s, %s, %s, 1)',
            (scan_id, workspace_id, '9' * 64, Jsonb({})),
        )

def reserve(scan_id):
    with psycopg.connect(DSN) as conn:
        barrier.wait(timeout=10)
        rows = conn.execute(
            'select lead_key from public.reserve_scan_leads(%s, %s, %s, 1)',
            (workspace_id, scan_id, Jsonb(candidates)),
        ).fetchall()
        conn.commit()
        return [row[0] for row in rows]

try:
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, scan_ids))
    flattened = [key for result in results for key in result]
    assert all(len(result) == 1 for result in results), results
    assert len(set(flattened)) == 2, results
    with psycopg.connect(DSN) as conn:
        delivered = conn.execute(
            'select count(*), count(distinct lead_key) from public.workspace_lead_deliveries where workspace_id = %s',
            (workspace_id,),
        ).fetchone()
        assert delivered == (2, 2), delivered
    print(f'concurrency_ok results={results} deliveries={delivered}')
finally:
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute('delete from public.scan_results where scan_id = any(%s)', (scan_ids,))
        conn.execute('delete from public.workspace_lead_deliveries where workspace_id = %s', (workspace_id,))
        conn.execute('delete from public.scans where workspace_id = %s', (workspace_id,))
        conn.execute('delete from public.workspaces where id = %s', (workspace_id,))
        conn.execute('delete from public.leads where lead_key = any(%s)', (lead_keys,))
