// Web 服务端到端验证 (对着运行中的服务跑): bun test test/web.e2e.test.ts
import { describe, expect, test } from 'bun:test';

const BASE = process.env.ARENA_URL ?? 'http://localhost:3457';

async function api(path: string, body?: unknown) {
  const r = await fetch(BASE + path, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const text = await r.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json } as { status: number; json: any };
}

describe('静态资源', () => {
  test('/ 返回中文页面', async () => {
    const r = await fetch(BASE + '/');
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain('璀璨宝石对决');
    expect(html).toContain('/app.js');
  });
  test('app.js / style.css 可访问', async () => {
    for (const f of ['/app.js', '/style.css']) {
      const r = await fetch(BASE + f);
      expect(r.status).toBe(200);
    }
  });
});

describe('人机对战 API', () => {
  test('开局 -> 人类走一步 -> bot 应答 -> 轮回人类', async () => {
    const { json: g } = await api('/api/new', { mode: 'human', p2: 'greedy', humanSeat: 1 });
    expect(g.id).toBeTruthy();
    expect(g.legal).not.toBeNull();
    expect(g.legal.actions.length).toBeGreaterThan(10);
    // 选一个 take 行动
    const take = g.legal.actions.find((a: any) => a.action.kind === 'take');
    expect(take).toBeTruthy();
    const res = await api(`/api/move/${g.id}`, { seat: 1, move: { action: take.action } });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    // bot 已行动, 又轮到人类 (或已结束)
    expect(res.json.legal != null || res.json.over).toBeTrue();
  });
  test('非法走法 400', async () => {
    const { json: g } = await api('/api/new', { mode: 'human', p2: 'greedy', humanSeat: 1 });
    const res = await api(`/api/move/${g.id}`, { seat: 1, move: { action: { kind: 'take', cells: [0, 12] } } });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('无效');
  });
  test('非本人回合 400', async () => {
    const { json: g } = await api('/api/new', { mode: 'human', p2: 'greedy', humanSeat: 1 });
    // 先走一步让它轮到 bot? 不: 直接以错误 seat 提交
    const res = await api(`/api/move/${g.id}`, { seat: 0, move: { action: g.legal.actions[0].action } });
    expect(res.status).toBe(400);
  });
  test('对手预留卡对人类隐藏', async () => {
    const { json: g } = await api('/api/new', { mode: 'human', p2: 'greedy', humanSeat: 1 });
    // 走几步后 bot 可能预留; 检查视图里对手 reserved 的内容是 hidden
    let payload = g;
    for (let i = 0; i < 6 && !payload.over; i++) {
      const take = payload.legal.actions.find((a: any) => a.action.kind === 'take');
      const res = await api(`/api/move/${g.id}`, { seat: 1, move: { action: take.action } });
      payload = res.json;
    }
    const opp = payload.view.players[0];
    for (const c of opp.reserved) {
      expect(c.id === 'hidden' || c.id.startsWith('hidden')).toBeTrue();
    }
  });
});

describe('Agent 对战 API', () => {
  test('step 逐步推进直至结束', async () => {
    const { json: g } = await api('/api/new', { mode: 'agents', p1: 'greedy', p2: 'greedy' });
    let payload = g;
    let steps = 0;
    while (!payload.over && steps < 600) {
      const res = await api(`/api/step/${g.id}`, {});
      payload = res.json;
      steps++;
    }
    expect(payload.over).toBeTrue();
    expect(payload.turn).toBeLessThan(600);
  }, 60000);
  test('人机对局不接受 step', async () => {
    const { json: g } = await api('/api/new', { mode: 'human', p2: 'greedy', humanSeat: 1 });
    const res = await api(`/api/step/${g.id}`, {});
    expect(res.status).toBe(400);
  });
});
