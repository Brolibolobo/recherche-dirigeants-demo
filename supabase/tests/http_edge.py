#!/usr/bin/env python3
"""Local Edge Function contract tests. Requires the local Supabase stack and function server."""

import hashlib
import json
import os
import subprocess
import urllib.error
import urllib.request

import psycopg
from psycopg.types.json import Jsonb

BASE_URL = os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321')
ANON_KEY = os.environ['SUPABASE_ANON_KEY']
DB_URL = os.environ['SUPABASE_DB_URL']
WORKSPACE_ID = os.environ['PUBLIC_WORKSPACE_ID']
RATE_LIMIT_SALT = os.environ['RATE_LIMIT_SALT']
ENDPOINT = f"{BASE_URL.rstrip('/')}/functions/v1/scan"


def call(method='POST', payload=None, raw=None, origin=None):
    body = raw if raw is not None else json.dumps(payload or {}).encode()
    headers = {'Authorization': f'Bearer {ANON_KEY}', 'Content-Type': 'application/json'}
    if origin:
        headers['Origin'] = origin
    request = urllib.request.Request(ENDPOINT, data=body if method != 'GET' else None, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(request, timeout=35)
        status = response.status
        data = json.loads(response.read()) if response.length != 0 else {}
    except urllib.error.HTTPError as error:
        status = error.code
        data = json.loads(error.read())
    return status, data


def clear_rate_limit(conn):
    conn.execute('truncate public.scan_rate_limits')
    conn.commit()


def assert_error(conn, expected_status, expected_code, **kwargs):
    clear_rate_limit(conn)
    status, data = call(**kwargs)
    assert status == expected_status, (status, data)
    assert data.get('error') == expected_code, data


def main():
    with psycopg.connect(DB_URL) as conn:
        assert_error(conn, 405, 'method_not_allowed', method='GET')
        assert_error(conn, 403, 'origin_not_allowed', payload={'target': 1}, origin='https://evil.example')
        assert_error(conn, 400, 'invalid_json', raw=b'{')
        assert_error(conn, 400, 'invalid_target', payload={'target': 101})
        assert_error(conn, 400, 'invalid_legal', payload={'target': 1, 'filters': {'legal': ['inconnue']}})
        assert_error(conn, 413, 'request_too_large', raw=json.dumps({'target': 1, 'padding': 'x' * 17_000}).encode())

        clear_rate_limit(conn)
        global_budget_hash = hashlib.sha256(f'{RATE_LIMIT_SALT}|global-upstream-budget'.encode()).hexdigest()
        conn.execute(
            """insert into public.scan_rate_limits (identifier_hash, window_start, request_count)
               values (%s, to_timestamp(floor(extract(epoch from clock_timestamp()) / 60) * 60), 120)""",
            (global_budget_hash,),
        )
        conn.commit()
        status, data = call(payload={'target': 1, 'filters': {'sectors': ['C'], 'geo': 'region:99'}})
        assert status == 429, (status, data)
        assert data.get('error') == 'global_upstream_budget_exhausted', data

        filters = {}
        query_hash = subprocess.check_output([
            'node', '--input-type=module', '-e',
            "import {sanitizeScanFilters} from './supabase/functions/_shared/scan-policy.js';"
            "import {canonicalApiFilterKey} from './supabase/functions/_shared/cache.js';"
            "import {createHash} from 'node:crypto';"
            "process.stdout.write(createHash('sha256').update(canonicalApiFilterKey(sanitizeScanFilters({}))).digest('hex'));",
        ], text=True).strip()
        company = {
            'nom_complet': 'Entreprise locale de test',
            'siren': '123456789',
            'nature_juridique': '5710',
            'activite_principale': '81.21Z',
            'tranche_effectif_salarie': '02',
            'siege': {'siret': '12345678900011', 'code_postal': '75001', 'libelle_commune': 'Paris'},
            'dirigeants': [{
                'type_dirigeant': 'personne physique',
                'nom': 'DUPONT',
                'prenoms': 'Alice',
                'qualite': 'Présidente',
                'date_de_naissance': '1980-01',
            }],
        }
        conn.execute('delete from public.workspace_lead_deliveries where workspace_id = %s', (WORKSPACE_ID,))
        conn.execute('delete from public.scans where workspace_id = %s', (WORKSPACE_ID,))
        conn.execute('delete from public.api_cache_pages where query_hash = %s', (query_hash,))
        conn.execute(
            """insert into public.api_cache_pages (query_hash, page, request, response, fetched_at)
               values (%s, 1, %s, %s, now()),
                      (%s, 2, %s, %s, now())""",
            (
                query_hash,
                Jsonb(filters),
                Jsonb({'total_pages': 2, 'results': [company]}),
                query_hash,
                Jsonb(filters),
                Jsonb({'total_pages': 2, 'results': {}}),
            ),
        )
        clear_rate_limit(conn)
        status, data = call(payload={'target': 2, 'filters': {}})
        assert status == 200, (status, data)
        assert data.get('partial') is True, data
        assert data.get('warning') == 'upstream_invalid_payload', data
        assert len(data.get('rows', [])) == 1, data
        assert data.get('cache', {}).get('hit_pages') == 2, data

        conn.execute('delete from public.workspace_lead_deliveries where workspace_id = %s', (WORKSPACE_ID,))
        conn.execute('delete from public.scans where workspace_id = %s', (WORKSPACE_ID,))
        conn.execute('delete from public.api_cache_pages where query_hash = %s', (query_hash,))
        clear_rate_limit(conn)

    print('http_edge_ok contracts=8 partial_after_reservation=1')


if __name__ == '__main__':
    main()
