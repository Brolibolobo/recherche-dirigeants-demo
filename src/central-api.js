import { centralConfig } from './central-config.js';

export function isCentralConfigured(config = centralConfig) {
  return Boolean(String(config?.url || '').trim() && String(config?.publicKey || '').trim());
}

export async function scanCentral(payload, { config = centralConfig, fetchImpl = fetch, signal } = {}) {
  if (!isCentralConfigured(config)) throw new Error('Cache central non configuré.');
  const url = `${String(config.url).replace(/\/+$/, '')}/functions/v1/scan`;
  const response = await fetchImpl(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.publicKey}`,
      apikey: config.publicKey,
    },
    body: JSON.stringify(payload),
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Cache central HTTP ${response.status}`);
    error.code = data.error || data.code || 'central_api_error';
    error.status = response.status;
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      error.retryAfter = Number.isFinite(seconds)
        ? Math.max(0, seconds)
        : Math.max(0, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000));
    }
    throw error;
  }
  if (!Array.isArray(data.rows)) throw new Error('Réponse invalide du cache central.');
  return data;
}
