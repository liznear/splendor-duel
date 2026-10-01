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
  /** 两段式: pending=true 时轮询 /api/bot 直至轮到人类或结束 */
  async function settle(id: string, payload: any) {
    let p = payload;
    let guard = 0;
    while (p.pending && guard++ < 30) {
      const r = await api(`/api/bot/${id}`, {});
      p = r.json;
    }
    return p;
  }
  test('开局 -> 人类走一步 -> bot 应答 -> 轮回人类', async () => {
    const { json: g0 } = await api('/api/new', { seed: 11, mode: 'human', p2: 'greedy', humanSeat: 1 });
    const g = await settle(g0.id, g0);
    expect(g.legal).not.toBeNull();
    expect(g.legal.actions.length).toBeGreaterThan(10);
    // 选一个 take 行动
    const take = g.legal.actions.find((a: any) => a.action.kind === 'take');
    expect(take).toBeTruthy();
    const res = await api(`/api/move/${g0.id}`, { seat: 1, move: { action: take.action } });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    // 走法已生效立即返回, pending=true 表示 bot 待行动
    expect(res.json.pending).toBeTrue();
    const after = await settle(g0.id, res.json);
    expect(after.legal != null || after.over).toBeTrue();
  });
  test('可选行动即时执行: 特权确认后立即入账', async () => {
    const { json: g0 } = await api('/api/new', { seed: 22, mode: 'human', p2: 'greedy', humanSeat: 1 });
    const g = await settle(g0.id, g0);
    expect(g.current).toBe(1); // 先手固定 seat0, 人类后手持 1 特权
    expect(g.view.players[1].privileges).toBe(1);
    const cell = g.legal.privilegeCells[0];
    const color = g.view.board[cell];
    const before = g.view.players[1].tokens[color];
    const r = await api(`/api/option/${g0.id}`, { seat: 1, privileges: [cell] });
    expect(r.status).toBe(200);
    expect(r.json.view.players[1].tokens[color]).toBe(before + 1); // 立刻到手
    expect(r.json.view.players[1].privileges).toBe(0); // 立刻扣减
    expect(r.json.view.board[cell]).toBeNull(); // 棋盘立即空格
    // 之后提交不带 privileges 也能正常走
    const take = r.json.legal.actions.find((a: any) => a.action.kind === 'take');
    const m = await api(`/api/move/${g0.id}`, { seat: 1, move: { action: take.action } });
    expect(m.status).toBe(200);
  });
  test('非法走法 400', async () => {
    const { json: g0 } = await api('/api/new', { seed: 33, mode: 'human', p2: 'greedy', humanSeat: 1 });
    await settle(g0.id, g0);
    const res = await api(`/api/move/${g0.id}`, { seat: 1, move: { action: { kind: 'take', cells: [0, 12] } } });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('无效');
  });
  test('非本人回合 400', async () => {
    const { json: g0 } = await api('/api/new', { seed: 44, mode: 'human', p2: 'greedy', humanSeat: 1 });
    const g = await settle(g0.id, g0);
    // 先走一步让它轮到 bot? 不: 直接以错误 seat 提交
    const res = await api(`/api/move/${g0.id}`, { seat: 0, move: { action: g.legal.actions[0].action } });
    expect(res.status).toBe(400);
  });
  test('对手仅盲留卡隐藏, 明留卡可见', async () => {
    const { json: g0 } = await api('/api/new', { seed: 55, mode: 'human', p2: 'greedy', humanSeat: 1 });
    let payload = await settle(g0.id, g0);
    for (let i = 0; i < 20 && !payload.over; i++) {
      const any = payload.legal.actions.find((a: any) => a.action.kind === 'take') ?? payload.legal.actions[0];
      const res = await api(`/api/move/${g0.id}`, { seat: 1, move: { action: any.action } });
      payload = await settle(g0.id, res.json);
    }
    // bot 可能已预留: 盲留应为 hidden 占位, 明留应露出真实卡 id
    const opp = payload.view.players[0];
    for (const c of opp.reserved) {
      if (c.id === 'hidden') {
        expect(c.blind ?? true).toBeTrue();
      } else {
        expect(c.id).toMatch(/^\d-\d+$/);
        expect(c.cost).toBeTruthy();
      }
    }
  });
});

describe('Agent 对战 API', () => {
  test('step 逐步推进直至结束', async () => {
    const { json: g } = await api('/api/new', { seed: 66, mode: 'agents', p1: 'greedy', p2: 'greedy' });
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
    const { json: g } = await api('/api/new', { seed: 77, mode: 'human', p2: 'greedy', humanSeat: 1 });
    const res = await api(`/api/step/${g.id}`, {});
    expect(res.status).toBe(400);
  });
});
