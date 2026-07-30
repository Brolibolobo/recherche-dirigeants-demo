import { MAX_BODY_BYTES, publicErrorCode } from './lib/scan-policy.js';
import { edgeErrorStatus } from './lib/http-errors.js';
import { createHandler } from './scan-handler.js';

function firstHeader(value) {
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

function requestUrl(req) {
  const forwardedProto = firstHeader(req.headers['x-forwarded-proto']);
  const protocol = forwardedProto === 'http' || forwardedProto === 'https'
    ? forwardedProto
    : (req.socket?.encrypted ? 'https' : 'http');
  const forwardedHost = firstHeader(req.headers['x-forwarded-host']);
  const host = forwardedHost || firstHeader(req.headers.host);
  if (!host || /[\s/\\]/.test(host)) throw new Error('invalid_request');
  return new URL(req.url || '/', `${protocol}://${host}`).toString();
}

async function readNodeBody(req) {
  if (req.body !== undefined) {
    const rawLength = req.headers['content-length'];
    if (Array.isArray(rawLength) && rawLength.length !== 1) throw new Error('invalid_request');
    const lengthText = String(Array.isArray(rawLength) ? rawLength[0] : rawLength ?? '').trim();
    if (!/^\d+$/.test(lengthText)) throw new Error('invalid_request');
    const declared = Number(lengthText);
    if (!Number.isSafeInteger(declared)) throw new Error('invalid_request');
    const rawBody = Buffer.isBuffer(req.body) || typeof req.body === 'string';
    let body;
    try {
      body = rawBody ? req.body : JSON.stringify(req.body);
    } catch {
      throw new Error('invalid_request');
    }
    if (body === undefined) throw new Error('invalid_request');
    const actual = Buffer.byteLength(body);
    if (declared > MAX_BODY_BYTES || actual > MAX_BODY_BYTES) throw new Error('request_too_large');
    if ((rawBody && declared !== actual) || (!rawBody && declared < actual)) throw new Error('invalid_request');
    return body;
  }
  const declared = Number(firstHeader(req.headers['content-length']));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('request_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('request_too_large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function writeNodeResponse(res, response) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  return response.arrayBuffer().then(buffer => {
    res.end(Buffer.from(buffer));
  });
}

function writeAdapterError(res, error) {
  const code = publicErrorCode(error);
  const body = JSON.stringify({ error: code });
  res.statusCode = edgeErrorStatus(new Error(code));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  res.end(body);
}

export function createNodeHandler({ handler = createHandler() } = {}) {
  return async function nodeHandler(req, res) {
    try {
      const controller = new AbortController();
      req.once?.('aborted', () => controller.abort());
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readNodeBody(req);
      const request = new Request(requestUrl(req), {
        method: req.method,
        headers: req.headers,
        body,
        signal: controller.signal,
      });
      const response = await handler(request);
      await writeNodeResponse(res, response);
    } catch (error) {
      if (!res.headersSent) writeAdapterError(res, error);
      else if (!res.writableEnded) res.end();
    }
  };
}
