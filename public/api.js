// The renderer consumes this stable model. Wire routes and schema translation
// live here, so server migrations do not spread through UI event handlers.
export function agentConfig(spec) {
  const [kind, ms] = spec.split('@');
  const config = { kind: (kind === 'ab' || kind === 'par-ab') ? 'alpha-beta' : kind === 'par-mcts2' ? 'mcts' : kind };
  if (ms) config.timeMs = Number(ms);
  if (kind === 'par-mcts2' || kind === 'par-ab') config.parallelism = 8;
  return config;
}

export function requestFor(path, body) {
  const url = new URL(path, 'http://localhost');
  let target;
  if (url.pathname === '/api/new') {
    target = '/api/v1/games';
    const players = [body.p1, body.p2].map(spec => agentConfig(spec || 'greedy'));
    body = { mode: body.mode, players, humanSeat: body.humanSeat, seed: body.seed };
  } else if (url.pathname === '/api/resume') {
    target = '/api/v1/sessions/resume';
  } else if (url.pathname === '/api/sessions') {
    target = '/api/v1/sessions';
  } else {
    const match = /^\/api\/(state|move|option|bot|step|undo)\/([\w-]+)$/.exec(url.pathname);
    if (!match) throw new Error(`Unknown API operation: ${path}`);
    const [, operation, id] = match;
    const suffix = { state: '', move: '/moves', option: '/options', bot: '/bot', step: '/step', undo: '/undo' }[operation];
    target = `/api/v1/games/${id}${suffix}`;
  }
  return { path: target + url.search, body };
}

export async function api(path, body) {
  const request = requestFor(path, body);
  const response = await fetch(request.path, request.body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  // Legacy UI uses `ok` on move/step replies. v1 success is the HTTP status.
  if (!Array.isArray(payload)) payload.ok = true;
  return payload;
}
