import { describe, expect, test } from 'bun:test';
// @ts-expect-error 浏览器侧公共模块, 无类型声明
import { agentConfig, requestFor, api } from '../public/api.js';

describe('browser API adapter', () => {
  test('translates UI choices and routes to v1', () => {
    expect(agentConfig('ab@1000')).toEqual({ kind: 'alpha-beta', timeMs: 1000 });
    expect(agentConfig('par-mcts2@2000')).toEqual({ kind: 'mcts', timeMs: 2000, parallelism: 8 });
    expect(requestFor('/api/new', { mode: 'human', humanSeat: 0, p2: 'greedy' })).toEqual({
      path: '/api/v1/games', body: { mode: 'human', humanSeat: 0, seed: undefined, players: [{ kind: 'greedy' }, { kind: 'greedy' }] },
    });
    expect(requestFor('/api/state/g123?seat=1').path).toBe('/api/v1/games/g123?seat=1');
    expect(requestFor('/api/move/g123', {}).path).toBe('/api/v1/games/g123/moves');
    expect(requestFor('/api/option/g123', {}).path).toBe('/api/v1/games/g123/options');
    expect(requestFor('/api/bot/g123', {}).path).toBe('/api/v1/games/g123/bot');
    expect(requestFor('/api/step/g123', {}).path).toBe('/api/v1/games/g123/step');
    expect(requestFor('/api/resume', {}).path).toBe('/api/v1/sessions/resume');
    expect(requestFor('/api/sessions').path).toBe('/api/v1/sessions');
  });
  test('adapts v1 success and propagates server errors', async () => {
    const original = globalThis.fetch;
    try {
      let actualPath: RequestInfo | URL | undefined;
      let actualBody: unknown;
      globalThis.fetch = Object.assign(async (path: RequestInfo | URL, options?: RequestInit) => {
        actualPath = path; actualBody = JSON.parse(String(options?.body));
        return Response.json({ current: 1, pending: true });
      }, { preconnect: original.preconnect });
      const body = { seat: 0, move: { action: { kind: 'take', cells: [0] } } };
      const result = await api('/api/move/g123', body);
      expect(actualPath).toBe('/api/v1/games/g123/moves');
      expect(actualBody).toEqual(body);
      expect(result.ok).toBe(true);
      globalThis.fetch = Object.assign(async () => Response.json({ error: 'invalid turn', code: 'invalid_request' }, { status: 400 }), { preconnect: original.preconnect });
      await expect(api('/api/move/g123', body)).rejects.toThrow('invalid turn');
    } finally { globalThis.fetch = original; }
  });
});
