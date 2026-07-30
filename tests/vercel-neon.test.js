import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const execFileAsync = promisify(execFile);

test('le frontend appelle uniquement /api/scan sans configuration Supabase', async () => {
  const [client, app, html] = await Promise.all([read('src/central-api.js'), read('src/app.js'), read('index.html')]);
  assert.match(client, /fetchImpl\('\/api\/scan'/);
  assert.doesNotMatch(client + app + html, /supabase|anon[_ -]?key|publicKey/i);
});

test('le schéma Neon frais conserve les invariants sans dépendance Supabase', async () => {
  const sql = await read('db/migrations/001_initial.sql');
  for (const table of ['api_cache_pages', 'cache_page_locks', 'leads', 'scans', 'lead_deliveries', 'scan_results', 'upstream_rate_limits', 'scan_rate_limits']) {
    assert.match(sql, new RegExp(`create table ${table}`, 'i'));
  }
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /create or replace function reserve_scan_leads/i);
  assert.doesNotMatch(sql, /\bworkspaces?\b|workspace_id|p_workspace_id/i);
  assert.doesNotMatch(sql, /auth\.users|service_role|\banon\b|row level security|create policy|postgrest|multi-?tenant/i);
});

test('le runtime DB est strictement singleton sans dimension workspace', async () => {
  const runtime = await read('server/db.js');
  assert.doesNotMatch(runtime, /WORKSPACE_ID|workspace_id|p_workspace_id|workspace_lead_deliveries/i);
  assert.match(runtime, /from lead_deliveries/i);
});

test('le build statique est une allowlist frontend et Node est épinglé à 22.x', async () => {
  const [manifest, vercel] = await Promise.all([read('package.json'), read('vercel.json')]);
  const pkg = JSON.parse(manifest);
  const config = JSON.parse(vercel);
  assert.equal(pkg.engines.node, '22.x');
  assert.equal(config.outputDirectory, 'dist');
  assert.equal(pkg.scripts.build, 'node scripts/build-static.js');

  await execFileAsync(process.execPath, ['scripts/build-static.js'], { cwd: new URL('../', import.meta.url) });
  const { stdout } = await execFileAsync(process.execPath, ['-e', `
    const { readdir } = require('node:fs/promises');
    (async function walk(dir, base = dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = dir + '/' + entry.name;
        if (entry.isDirectory()) await walk(path, base);
        else console.log(path.slice(base.length + 1));
      }
    })('dist');
  `], { cwd: new URL('../', import.meta.url) });
  const files = stdout.trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(files, [
    '.nojekyll',
    'data/naf-rev2.json',
    'index.html',
    'src/app.js',
    'src/central-api.js',
    'src/csv.js',
    'src/filters.js',
    'src/geo-data.js',
    'src/storage.js',
    'styles.css',
  ]);
  for (const forbidden of ['server/', 'api/', 'scripts/', 'db/', 'tests/', 'legacy/', 'README', 'package']) {
    assert.equal(files.some(file => file.startsWith(forbidden)), false, forbidden);
  }
  const browserSources = await Promise.all(files.filter(file => file.endsWith('.js')).map(file => read(`dist/${file}`)));
  assert.doesNotMatch(browserSources.join('\n'), /\.\.\/server\/|node:|DATABASE_URL/);
});

test('la fonction Vercel est Node, injecte la DB et refuse méthodes/origines/corps invalides', async () => {
  const { createHandler } = await import('../server/scan-handler.js');
  const db = { history: async () => ({ rows: [] }) };
  const handler = createHandler({ db, env: { DIRECTOR_FINGERPRINT_SALT: 'x', RATE_LIMIT_SALT: 'y' } });
  const get = await handler(new Request('https://example.test/api/scan', { method: 'GET' }));
  assert.equal(get.status, 405);
  const foreign = await handler(new Request('https://example.test/api/scan', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(foreign.status, 403);
  const huge = await handler(new Request('https://example.test/api/scan', { method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json', 'content-length': '70000' }, body: '{}' }));
  assert.equal(huge.status, 413);
});

test('la documentation décrit Neon Marketplace, les trois variables et le rollback', async () => {
  const readme = await read('README.md');
  for (const value of ['Vercel Marketplace', 'Neon', 'DATABASE_URL', 'DIRECTOR_FINGERPRINT_SALT', 'RATE_LIMIT_SALT', 'base neuve', 'npm run db:migrate', 'vercel', 'rollback', 'Supabase']) assert.match(readme, new RegExp(value, 'i'));
});
