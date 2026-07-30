import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDbQuery } from '../server/db.js';

function blockedCancelableQuery() {
  let cancelCalls = 0;
  return {
    execute() { return this; },
    then() {},
    cancel() { cancelCalls += 1; },
    get cancelCalls() { return cancelCalls; },
  };
}

test('executeDbQuery annule une vraie query thenable bloquée sur abort et deadline', async t => {
  await t.test('abort', async () => {
    const controller = new AbortController();
    const query = blockedCancelableQuery();
    const started = Date.now();
    const pending = executeDbQuery(query, {
      signal: controller.signal,
      deadline: Date.now() + 2_000,
      now: Date.now,
    });
    setTimeout(() => controller.abort(), 15);

    await assert.rejects(pending, { message: 'request_aborted' });
    assert.equal(query.cancelCalls, 1);
    assert.ok(Date.now() - started < 250);
  });

  await t.test('deadline', async () => {
    const query = blockedCancelableQuery();
    const started = Date.now();

    await assert.rejects(executeDbQuery(query, {
      deadline: Date.now() + 20,
      now: Date.now,
    }), { message: 'scan_deadline_exceeded' });
    assert.equal(query.cancelCalls, 1);
    assert.ok(Date.now() - started < 250);
  });
});

test('executeDbQuery traduit les timeouts PostgreSQL sans détail DB', async () => {
  const rejectedQuery = error => ({
    execute() { return this; },
    then(_resolve, reject) { queueMicrotask(() => reject(error)); },
    cancel() {},
  });

  await assert.rejects(
    executeDbQuery(rejectedQuery(Object.assign(new Error('statement interne'), { code: '57014' }))),
    { message: 'scan_deadline_exceeded' },
  );
  await assert.rejects(
    executeDbQuery(rejectedQuery(Object.assign(new Error('lock interne'), { code: '55P03' }))),
    { message: 'server_busy' },
  );
});
