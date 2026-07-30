import assert from 'node:assert/strict';
import postgres from 'postgres';
import { createDb } from '../../server/db.js';

const url = process.env.POSTGRES_TEST_URL;
if (!url) throw new Error('POSTGRES_TEST_URL manquant');

const holder = postgres(url, { max: 1, prepare: false });
const database = createDb(url);
const scanId = '92000000-0000-0000-0000-000000000001';
let releaseLock;
let lockReady;
const ready = new Promise(resolve => { lockReady = resolve; });
const release = new Promise(resolve => { releaseLock = resolve; });
let transaction;

try {
  await holder`
    insert into scans(id, query_hash, filters, target_count)
    values(${scanId}, ${'9'.repeat(64)}, '{}'::jsonb, 1)`;

  transaction = holder.begin(async sql => {
    await sql`select pg_advisory_xact_lock(hashtextextended('global-lead-ledger', 0))`;
    lockReady();
    await release;
  });
  await ready;

  const candidate = {
    lead_key: 'a'.repeat(64),
    director_fingerprint: 'a'.repeat(64),
    person_name_fingerprint: 'b'.repeat(64),
    fingerprint_version: 2,
    identity_quality: 'strong',
    birth_year: '1980',
    company_siren: '123456789',
    payload: { siren: '123456789' },
  };
  const budgetMs = 5_000;
  const started = Date.now();
  await assert.rejects(
    database.reserve(scanId, [candidate], 1, {
      deadline: started + budgetMs,
      now: Date.now,
    }),
    { message: 'server_busy' },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < budgetMs, `réservation bloquée au-delà du budget: ${elapsed}ms`);
  assert.ok(elapsed < 3_500, `lock_timeout de session non respecté: ${elapsed}ms`);
  console.log(`advisory-lock timeout OK (${elapsed}ms, budget ${budgetMs}ms)`);
} finally {
  releaseLock?.();
  await transaction?.catch(() => {});
  await Promise.allSettled([database.close(), holder.end({ timeout: 1 })]);
}
