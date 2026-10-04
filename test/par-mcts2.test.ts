// par-mcts2 (worker 池并行 + 根子统计合并) 单元测试: 参数校验 / 合法性 / 确定性 / 池生命周期
import { describe, expect, test } from 'bun:test';
import { createGame, legalMoves, playerView, applyMove } from '../src/engine/game.ts';
import { parMcts2Agent } from '../src/agents/par-mcts2.ts';
import type { TurnContext } from '../src/agents/agent.ts';

const ctxOf = (seed: number): TurnContext => {
  let st = createGame({ seed, firstSeat: 0 });
  for (let i = 0; i < 6; i++) {
    st = applyMove(st, { action: legalMoves(st).actions[0]! });
  }
  return { seat: st.current, view: playerView(st, st.current), legal: legalMoves(st), turn: st.turnCount };
};

describe('parMcts2Agent', () => {
  test('workers 非正整数抛 RangeError', () => {
    expect(() => parMcts2Agent({ workers: 0 })).toThrow(RangeError);
    expect(() => parMcts2Agent({ workers: 1.5 })).toThrow(RangeError);
    expect(() => parMcts2Agent({ playouts: 0 })).toThrow(RangeError);
  });

  test('返回引擎合法着法(固定 playouts 确定性)', async () => {
    const ctx = ctxOf(21);
    const a = parMcts2Agent({ workers: 2, playouts: 40, timeMs: 5000 });
    const move = await a.chooseMove(ctx);
    expect(() => applyMove(ctx.view, move)).not.toThrow();
    // 同种子同局完全可复现
    const b = parMcts2Agent({ workers: 2, playouts: 40, timeMs: 5000 });
    expect(JSON.stringify(await b.chooseMove(ctx))).toBe(JSON.stringify(move));
  });

  test('池跨回合复用 + onGameOver 清池不报错', async () => {
    const a = parMcts2Agent({ workers: 2, playouts: 10, timeMs: 5000 });
    const ctx1 = ctxOf(22);
    const m1 = await a.chooseMove(ctx1);
    const st2 = applyMove(ctx1.view, m1);
    const ctx2 = { seat: st2.current, view: playerView(st2, st2.current), legal: legalMoves(st2), turn: st2.turnCount };
    const m2 = await a.chooseMove(ctx2);
    expect(() => applyMove(ctx2.view, m2)).not.toThrow();
    expect(a.stats.moves).toBe(2);
    expect(a.stats.playouts).toBeGreaterThan(0);
    a.onGameOver?.({ winner: 0, draw: false });
  });
});
