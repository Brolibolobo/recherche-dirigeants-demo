import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../src/storage.js';

test('le snapshot local conserve résultats, filtres et date', () => {
  const snapshot = normalizeSnapshot({
    rows: [{ siren: '123456789' }],
    filters: { nafCode: '81.21Z', maxRows: 25 },
    savedAt: '2026-07-23T00:00:00.000Z',
  });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.filters.nafCode, '81.21Z');
  assert.equal(snapshot.savedAt, '2026-07-23T00:00:00.000Z');
});
