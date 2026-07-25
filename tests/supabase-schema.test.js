import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/20260724000000_central_cache.sql', import.meta.url);

test('le schéma Supabase contient cache, scans et registre anti-doublons workspace', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of ['workspaces', 'api_cache_pages', 'leads', 'scans', 'workspace_lead_deliveries', 'scan_results']) {
    assert.match(sql, new RegExp(`create table public\\.${table}`, 'i'));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  }
  assert.match(sql, /primary key\s*\(workspace_id,\s*lead_key\)/i);
  assert.match(sql, /fingerprint_version smallint not null/i);
  assert.match(sql, /identity_quality text not null/i);
  assert.match(sql, /person_name_fingerprint text not null/i);
  assert.match(sql, /birth_year text not null/i);
  assert.match(sql, /source_status integer not null default 200/i);
  assert.match(sql, /schema_version smallint not null default 1/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /create or replace function public\.reserve_scan_leads/i);
  assert.match(sql, /create or replace function public\.reserve_upstream_slot/i);
  assert.match(sql, /revoke all on function public\.reserve_scan_leads.*from public, anon, authenticated/is);
  assert.match(sql, /grant execute on function public\.reserve_scan_leads.*to service_role/is);
});

test('l’Edge Function garde la clé privilégiée côté serveur', async () => {
  const source = await readFile(new URL('../supabase/functions/scan/index.ts', import.meta.url), 'utf8');
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /reserve_scan_leads/);
  assert.match(source, /api_cache_pages/);
  assert.match(source, /PUBLIC_WORKSPACE_ID/);
  assert.match(source, /renewCacheLease/);
  assert.match(source, /sleepWithLease/);
  assert.match(source, /MAX_RETRY_WAIT_MS = 60_000/);
  assert.match(source, /personNameKey/);
  assert.doesNotMatch(source, /Math\.min\(retryAfterDelay/);
  assert.doesNotMatch(source, /service_role\s*[:=]\s*["'][A-Za-z0-9._-]+["']/i);
});

test('GitHub Pages conserve les modules sous _shared', async () => {
  assert.equal(await readFile(new URL('../.nojekyll', import.meta.url), 'utf8'), '');
});

test('le référentiel NAF embarqué par l’Edge Function reste identique au frontend', async () => {
  const frontend = await readFile(new URL('../data/naf-rev2.json', import.meta.url), 'utf8');
  const edge = await readFile(new URL('../supabase/functions/_shared/naf-rev2.json', import.meta.url), 'utf8');
  assert.equal(edge, frontend);
});