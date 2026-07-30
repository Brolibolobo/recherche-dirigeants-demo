const CLIENT_ERROR_PREFIXES = [
  'invalid_',
  'Choisissez au moins un code APE ou un secteur.',
  'L’effectif minimum doit être inférieur ou égal au maximum.',
  'L’âge minimum doit être inférieur ou égal au maximum.',
  'Zone invalide :',
  'Code APE invalide :',
];

export function edgeErrorStatus(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'origin_not_allowed') return 403;
  if (message === 'request_too_large') return 413;
  if (message === 'global_upstream_budget_exhausted') return 429;
  if (message === 'scan_deadline_exceeded') return 503;
  if (message.startsWith('government_api_') || message === 'upstream_invalid_payload') return 502;
  if (error instanceof SyntaxError || CLIENT_ERROR_PREFIXES.some(prefix => message.startsWith(prefix))) return 400;
  return 500;
}
