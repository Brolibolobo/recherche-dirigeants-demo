import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeErrorStatus } from '../server/lib/http-errors.js';

test('les erreurs client de l’Edge Function répondent 400', () => {
  assert.equal(edgeErrorStatus(new SyntaxError('JSON invalide')), 400);
  assert.equal(edgeErrorStatus(new Error('invalid_target')), 400);
  assert.equal(edgeErrorStatus(new Error('Choisissez au moins un code APE ou un secteur.')), 400);
  assert.equal(edgeErrorStatus(new Error('L’effectif minimum doit être inférieur ou égal au maximum.')), 400);
  assert.equal(edgeErrorStatus(new Error('L’âge minimum doit être inférieur ou égal au maximum.')), 400);
  assert.equal(edgeErrorStatus(new Error('Zone invalide : utilisez un département.')), 400);
  assert.equal(edgeErrorStatus(new Error('Code APE invalide : choisissez une entrée.')), 400);
});

test('les erreurs CORS et serveur gardent leur statut', () => {
  assert.equal(edgeErrorStatus(new Error('origin_not_allowed')), 403);
  assert.equal(edgeErrorStatus(new Error('request_too_large')), 413);
  assert.equal(edgeErrorStatus(new Error('server_busy')), 503);
  assert.equal(edgeErrorStatus(new Error('cache_write:database down')), 500);
});
