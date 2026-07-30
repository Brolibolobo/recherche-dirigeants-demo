import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createNodeHandler } from '../server/node-adapter.js';
import vercelHandler from '../api/scan.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function send(port, { method = 'POST', body = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/scan?adapter=1', method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function sendParsed(body, headers = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method: 'POST', url: '/api/scan', headers, body, socket: {} });
  return new Promise(resolve => {
    const responseHeaders = {};
    const res = {
      headersSent: false,
      writableEnded: false,
      setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
      end(value = '') {
        this.headersSent = true;
        this.writableEnded = true;
        resolve({ status: this.statusCode, headers: responseHeaders, body: String(value) });
      },
    };
    createNodeHandler({ handler: async request => Response.json({ body: await request.json(), origin: new URL(request.url).origin }) })(req, res);
  });
}

test('api/scan exporte un vrai handler Node Vercel', () => {
  assert.equal(typeof vercelHandler, 'function');
  assert.equal(vercelHandler.length, 2);
});

test('adaptateur IncomingMessage/ServerResponse transmet méthode, body, headers et réponse', async t => {
  const seen = [];
  const core = async request => {
    seen.push({
      method: request.method,
      body: request.method === 'POST' ? await request.json() : null,
      contentType: request.headers.get('content-type'),
      origin: new URL(request.url).origin,
    });
    return Response.json({ accepted: true }, { status: 201, headers: { 'X-Adapter': 'node' } });
  };
  const server = http.createServer(createNodeHandler({ handler: core }));
  const address = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const result = await send(address.port, {
    body: JSON.stringify({ target: 7 }),
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(JSON.stringify({ target: 7 }))),
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'public.example.test',
    },
  });
  assert.equal(result.status, 201);
  assert.equal(result.headers['x-adapter'], 'node');
  assert.deepEqual(JSON.parse(result.body), { accepted: true });
  assert.deepEqual(seen[0], {
    method: 'POST',
    body: { target: 7 },
    contentType: 'application/json; charset=utf-8',
    origin: 'https://public.example.test',
  });

  const get = await send(address.port, { method: 'GET' });
  assert.equal(get.status, 201);
  assert.equal(seen[1].method, 'GET');
});

test('adaptateur Node applique réellement la limite de 16 KiB', async t => {
  let called = false;
  const server = http.createServer(createNodeHandler({ handler: async () => { called = true; return Response.json({ ok: true }); } }));
  const address = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await send(address.port, {
    body: 'x'.repeat(16_385),
    headers: { 'content-type': 'application/json', 'content-length': '16385' },
  });
  assert.equal(result.status, 413);
  assert.deepEqual(JSON.parse(result.body), { error: 'request_too_large' });
  assert.equal(called, false);
});

test('adaptateur Node rejette un body déjà parsé sans Content-Length fiable', async () => {
  const result = await sendParsed({ target: 1 }, {
    host: 'example.test',
    origin: 'https://example.test',
    'content-type': 'application/json',
    'x-forwarded-proto': 'https',
  });
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(result.body), { error: 'invalid_request' });
});

test('adaptateur Node contrôle Content-Length avant un body déjà parsé et accepte le frontend normal', async () => {
  const oversized = await sendParsed({ target: 1 }, {
    host: 'example.test',
    'content-type': 'application/json',
    'content-length': '16385',
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(JSON.parse(oversized.body), { error: 'request_too_large' });

  const body = { target: 1 };
  const normal = await sendParsed(body, {
    host: 'example.test',
    origin: 'https://example.test',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(JSON.stringify(body))),
    'x-forwarded-proto': 'https',
  });
  assert.equal(normal.status, 200);
  assert.deepEqual(JSON.parse(normal.body), { body, origin: 'https://example.test' });
});

test('adaptateur Node mesure le body préparsé malgré un Content-Length mensonger', async () => {
  const oversized = await sendParsed({ payload: 'x'.repeat(16_384) }, {
    host: 'example.test',
    'content-type': 'application/json',
    'content-length': '1',
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(JSON.parse(oversized.body), { error: 'request_too_large' });

  for (const body of ['{"target":1}', Buffer.from('{"target":1}')]) {
    const mismatched = await sendParsed(body, {
      host: 'example.test',
      'content-type': 'application/json',
      'content-length': '1',
    });
    assert.equal(mismatched.status, 400);
    assert.deepEqual(JSON.parse(mismatched.body), { error: 'invalid_request' });
  }
});

test('adaptateur Node rejette un petit objet préparsé plus long que Content-Length', async () => {
  const result = await sendParsed({ target: 1 }, {
    host: 'example.test',
    'content-type': 'application/json',
    'content-length': '1',
  });
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(result.body), { error: 'invalid_request' });
});

test('adaptateur Node rejette un Content-Length syntaxiquement invalide', async () => {
  const result = await sendParsed({ target: 1 }, {
    host: 'example.test',
    'content-type': 'application/json',
    'content-length': '12x',
  });
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(result.body), { error: 'invalid_request' });
});
