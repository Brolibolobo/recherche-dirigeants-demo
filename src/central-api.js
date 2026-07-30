export function isCentralConfigured() {
  return true;
}

export async function scanCentral(payload, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl('/api/scan', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(data.error || `API centrale HTTP ${response.status}`);
    error.code = data.error || 'central_api_error';
    error.status = response.status;
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) error.retryAfter = Number(retryAfter) || 0;
    throw error;
  }
  if (!Array.isArray(data.rows)) throw new Error('Réponse invalide de l’API centrale.');
  return data;
}
