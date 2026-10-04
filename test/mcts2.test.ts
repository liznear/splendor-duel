// mcts2 (跨回合子树复用) 单元测试: 等价判定 / 确定性 / 复用真实命中 / 合法性
import { describe, expect, test } from 'bun:test';
import { createGame, legalMoves, playerView, applyMove } from '../src/engine/game.ts';
import { importSim, copySim } from '../src/agents/mcts.ts';
import { mcts2Agent, simEq } from '../src/agents/mcts2.ts';
import { greedyAgent } from '../src/agents/greedy.ts';
import { playMatch } from '../src/arena.ts';
import type { TurnContext } from '../src/agents/agent.ts';

const ctxOf = (seed: number): TurnContext => {
  let st = createGame({ seed, firstSeat: 0 });
  for (let i = 0; i < 6; i++) {
    // 直接取首个合法行动推进几步, 拿到非开局局面
    st = applyMove(st, { action: legalMoves(st).actions[0]! });
  }
  return { seat: st.current, view: playerView(st, st.current), legal: legalMoves(st), turn: st.turnCount };
};

describe('simEq 等价判定', () => {
  test('同一局面的两个导入互为等价', async () => {
    const ctx = await ctxOf(11);
    expect(simEq(importSim(ctx.view), importSim(ctx.view))).toBe(true);
  });
  test('rngState / 棋盘 / 牌库任一差异即不等价', async () => {
    const ctx = await ctxOf(12);
    const a = importSim(ctx.view);
    const b = copySim(a);
    expect(simEq(a, b)).toBe(true);
    b.rngState ^= 1;
    expect(simEq(a, b)).toBe(false);
    const c = copySim(a);
    const i = c.board.findIndex((t) => t === -1); // Int8Array 无 null, 空格 = EMPTY(-1)
    if (i >= 0) c.board[i] = 1; else c.board[0] = 1;
    expect(simEq(a, c)).toBe(false);
    const d = copySim(a);
    if (d.decks[0]!.length > 0) d.decks[0]!.pop();
    expect(simEq(a, d)).toBe(false);
  });
});

describe('mcts2Agent', () => {
  test('固定 playouts 同种子确定可复现', async () => {
    const ctx = await ctxOf(21);
    const m1 = await mcts2Agent({ playouts: 50, seed: 7 }).chooseMove({ ...ctx, view: structuredClone(ctx.view), legal: structuredClone(ctx.legal) });
    const m2 = await mcts2Agent({ playouts: 50, seed: 7 }).chooseMove({ ...ctx, view: structuredClone(ctx.view), legal: structuredClone(ctx.legal) });
    expect(JSON.stringify(m1.action)).toBe(JSON.stringify(m2.action));
  });
  test('自博弈若干回合: 走法始终合法且子树复用真实命中', async () => {
    const a = mcts2Agent({ playouts: 40, seed: 7, name: 'M2' });
    const res = await playMatch([a, greedyAgent()], { seed: 31, firstSeat: 0, maxTurns: 40, record: false });
    expect(a.stats.moves).toBeGreaterThan(3);
    expect(a.stats.reusedRoots).toBeGreaterThan(0); // 复用机制确实生效
    expect(res.winner === null || res.winner === 0 || res.winner === 1).toBe(true);
  });
  test('playouts 非法参数抛错', () => {
    expect(() => mcts2Agent({ playouts: 0 })).toThrow();
  });
});
