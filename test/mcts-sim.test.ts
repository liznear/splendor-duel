// MCTS 模拟核对拍 + agent 冒烟
// 对拍: 全随机对局, 引擎 applyMove/applyReplenish 与 sim makeSim/replenishSim 逐步并行,
//       每步比较合法行动集合与全部可观测字段(含 rng 流), 保证镜像语义。
import { describe, expect, test } from 'bun:test';
import {
  applyMove, applyOption, applyReplenish, createGame, GEMS, legalMoves, maxColorPointsOf, mulberry32Step,
  playerView, type GameState, type MandatoryAction, type Move, type TokenColor,
} from '../src/engine/game.js';
import {
  copySim, decodeAction, encodeAction, enumActions, importSim, makeSim, replenishSim, settleSim, takePrivilegesSim,
  type Sim,
} from '../src/agents/mcts.js';
import { mctsAgent } from '../src/agents/mcts.js';
import { greedyAgent } from '../src/agents/greedy.js';
import { isDeadState } from '../src/engine/game.js';

const TOKEN_COLORS: TokenColor[] = [...GEMS, 'pearl', 'gold'];
const codeOf: Record<string, number> = { black: 0, red: 1, green: 2, blue: 3, white: 4, pearl: 5, gold: 6 };

/** 引擎侧快照(仅可观测等价字段) */
function snapEngine(st: GameState): Record<string, unknown> {
  const [p0, p1] = st.players;
  const player = (p: typeof p0) => ({
    tokens: TOKEN_COLORS.map((c) => p.tokens[c]),
    bonuses: GEMS.map((c) => p.bonuses[c]),
    points: p.points,
    crowns: p.crowns,
    privileges: p.privileges,
    royalsTaken: p.royalsTaken,
    reserved: p.reserved.map((c) => c.id),
    colorCnt: GEMS.map((c) => p.cards.filter((oc) => oc.color === c).length),
    maxColorPts: maxColorPointsOf(p),
  });
  return {
    board: st.board.map((t) => (t == null ? -1 : codeOf[t]!)),
    bag: st.bag.map((t) => codeOf[t]!),
    decks: st.decks.map((d) => d.map((c) => c.id)),
    pyramid: st.pyramid.map((c) => (c ? c.id : null)),
    royals: st.royals.map((r) => r.id),
    players: [player(p0!), player(p1!)],
    current: st.current,
    extraTurns: st.extraTurns,
    turnCount: st.turnCount,
    winner: st.winner == null ? -1 : st.winner,
    rngState: st.rngState,
  };
}

function snapSim(sim: Sim): Record<string, unknown> {
  const player = (i: 0 | 1) => ({
    tokens: TOKEN_COLORS.map((_, c) => sim.tokens[i]![c]),
    bonuses: GEMS.map((_, c) => sim.bonuses[i]![c]),
    points: sim.points[i],
    crowns: sim.crowns[i],
    privileges: sim.privileges[i],
    royalsTaken: sim.royalsTaken[i],
    reserved: sim.reserved[i]!.map((c) => c.id),
    colorCnt: GEMS.map((_, c) => sim.colorCnt[i]![c]),
    maxColorPts: Math.max(0, ...GEMS.map((_, c) => sim.colorPts[i]![c]!)),
  });
  return {
    board: Array.from(sim.board),
    bag: Array.from(sim.bag.slice(0, sim.bagLen)),
    decks: sim.decks.map((d) => d.map((c) => c.id)),
    pyramid: sim.pyramid.map((c) => (c ? c.id : null)),
    royals: sim.royals.map((r) => r.id),
    players: [player(0), player(1)],
    current: sim.current,
    extraTurns: sim.extraTurns,
    turnCount: sim.turnCount,
    winner: sim.winner,
    rngState: sim.rngState,
  };
}

const SCRATCH = new Int32Array(512);

/** 单局对拍: 随机走完整局, 逐步断言一致。返回总步数 */
function mirrorGame(seed: number): number {
  let st = createGame({ seed, names: ['A', 'B'] });
  const sim = importSim(st);
  const rng = { rngState: (seed ^ 0x9e3779b9) | 0 };
  let steps = 0;
  for (; steps < 600 && st.winner === null && !st.draw; steps++) {
    let lm = legalMoves(st);
    while (lm.actions.length === 0) { // mustReplenish: 引擎/模拟核同路补货
      if (!lm.canReplenish) return steps; // 死局: arena 判和, 结束
      st = applyReplenish(st);
      replenishSim(sim);
      lm = legalMoves(st);
    }
    // 随机插入特权阶段, 校验主行动前不换手且不提前弃置。
    const cells: number[] = [];
    const eligible = lm.privilegeCells.slice();
    for (let i = 0; i < st.players[st.current].privileges && eligible.length && mulberry32Step(rng) < 0.6; i++) {
      cells.push(eligible.splice(Math.floor(mulberry32Step(rng) * eligible.length), 1)[0]!);
    }
    if (cells.length) {
      const next = applyOption(st, { privileges: cells });
      if (legalMoves(next).actions.length > 0) {
        st = next;
        takePrivilegesSim(sim, cells);
        expect(snapSim(sim)).toEqual(snapEngine(st));
        lm = legalMoves(st);
      }
    }
    // 合法行动集合一致(经编码比较; 同时校验 decode 往返)
    const nSim = enumActions(sim, SCRATCH);
    const simSet = Array.from({ length: nSim }, (_, i) => SCRATCH[i]!).sort((a, b) => a - b);
    const engSet = lm.actions.map(encodeAction).sort((a, b) => a - b);
    expect(simSet).toEqual(engSet);
    for (let i = 0; i < nSim; i++) {
      expect(encodeAction(decodeAction(SCRATCH[i]!))).toBe(SCRATCH[i]!);
    }
    // 随机选同一行动(引擎默认条件参数), 双侧结算
    const act: MandatoryAction = lm.actions[Math.floor(mulberry32Step(rng) * lm.actions.length)]!;
    st = applyMove(st, { action: act } as Move);
    makeSim(sim, encodeAction(act));
    // 全字段对拍
    expect(snapSim(sim)).toEqual(snapEngine(st));
    if (isDeadState(st)) break;
  }
  return steps;
}

describe('MCTS 模拟核对拍', () => {
  test('20 个种子的完整随机对局逐步一致', () => {
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) total += mirrorGame(seed);
    console.log(`对拍总步数: ${total}`);
    expect(total).toBeGreaterThan(1000); // 确实走完了足够多的局面
  });

  test('copySim 与原状态等价且独立(修改副本不影响原)', () => {
    const st = createGame({ seed: 99 });
    const a = importSim(st);
    const b = copySim(a);
    expect(snapSim(b)).toEqual(snapSim(a));
    makeSim(b, enumActions(b, SCRATCH) ? SCRATCH[0]! : 0);
    expect(snapSim(a)).toEqual(snapSim(importSim(st))); // 原 sim 未被波及
  });

  test('settleSim 处理 mustReplenish 与死局', () => {
    // 棋盘/袋/牌库/金字塔全空 => 无拿取/预留/买入且无法补货 => 和棋(0 行动)
    // (注意满黄金棋盘不构成死局: 预留行动正是拿黄金)
    const st = createGame({ seed: 7 });
    st.board = Array(25).fill(null);
    st.bag = [];
    st.decks = [[], [], []];
    st.pyramid = Array(12).fill(null);
    const sim = importSim(st);
    expect(legalMoves(st).actions.length).toBe(0);
    expect(settleSim(sim, SCRATCH)).toBe(0);
  });
});

describe('MCTS 特权决策', () => {
  test('固定模拟次数与种子产生相同行动', async () => {
    const st = createGame({ seed: 42, firstSeat: 0 });
    const ctx = { seat: st.current, view: playerView(st, st.current), legal: legalMoves(st), turn: st.turnCount };
    const a = mctsAgent({ playouts: 40, seed: 7 });
    const b = mctsAgent({ playouts: 40, seed: 7 });
    expect(await a.chooseMove(ctx)).toEqual(await b.chooseMove(ctx));
    expect(a.stats.playouts).toBe(40);
    expect(b.stats.playouts).toBe(40);
    expect(() => mctsAgent({ playouts: 0 })).toThrow();
  });

  test('预留卡结合黄金与折扣补缺, 只花必要特权', async () => {
    const st = createGame({ seed: 43, firstSeat: 0 });
    const p = st.players[0];
    p.points = 19;
    p.privileges = 3;
    p.tokens.gold = 1;
    p.bonuses.black = 1;
    st.players[1].privileges = 0;
    st.board = Array(25).fill(null);
    st.board[0] = 'pearl';
    st.board[2] = 'black';
    st.board[4] = 'red';
    st.pyramid = Array(12).fill(null);
    p.reserved = [{
      id: 'priv-reserved-gold', level: 1, color: 'red', isAssociate: false,
      points: 1, bonus: 1, ability: null, crowns: 0,
      cost: { pearl: 1, black: 2, red: 1, green: 0, blue: 0, white: 0 },
    }];
    const move = await mctsAgent({ playouts: 40 }).chooseMove({
      seat: 0, view: playerView(st, 0), legal: legalMoves(st), turn: st.turnCount,
    });
    expect(move.action).toEqual({ kind: 'buy', from: { kind: 'reserved', index: 0 } });
    expect(move.privileges).toEqual([0, 2]);
    const next = applyMove(st, move);
    expect(next.winner).toBe(0);
    expect(next.players[0].privileges).toBe(1);
  });

  for (const count of [1, 2, 3]) {
    test(`使用 ${count} 枚特权解锁本回合获胜购买`, async () => {
      const st = createGame({ seed: 42, firstSeat: 0 });
      st.players[0].points = 19;
      st.players[0].privileges = count;
      st.players[1].privileges = 0;
      st.board = Array(25).fill(null);
      for (let i = 0; i < count; i++) st.board[i * 2] = 'red';
      st.bag = [];
      st.pyramid = Array(12).fill(null);
      st.pyramid[7] = {
        id: `priv-win-${count}`, level: 1, color: 'red', isAssociate: false,
        points: 1, bonus: 1, ability: null, crowns: 0,
        cost: { pearl: 0, black: 0, red: count, green: 0, blue: 0, white: 0 },
      };
      const agent = mctsAgent({ timeMs: 10, seed: 7 });
      const move = await agent.chooseMove({
        seat: 0, view: playerView(st, 0), legal: legalMoves(st), turn: st.turnCount,
      });
      expect(move.privileges?.length).toBe(count);
      expect(applyMove(st, move).winner).toBe(0);
    });
  }
});

describe('MCTS agent 冒烟', () => {
  test(
    'vs greedy 完整对局: 走法全部被引擎接受',
    async () => {
      const mcts = mctsAgent({ timeMs: 120, seed: 7, name: 'M' });
      const opp = greedyAgent('G');
      let state = createGame({ seed: 20261003, names: ['M', 'G'] });
      const agents = [mcts, opp];
      let illegal = 0;
      for (let guard = 0; guard < 600 && state.winner === null && !state.draw; guard++) {
        let lm = legalMoves(state);
        while (lm.actions.length === 0) {
          if (!lm.canReplenish) break;
          state = applyReplenish(state);
          lm = legalMoves(state);
        }
        if (lm.actions.length === 0) break;
        const seat = state.current;
        const ctx = {
          seat, view: playerView(state, seat), legal: lm, turn: state.turnCount,
        };
        const move = await agents[seat]!.chooseMove(ctx);
        try {
          state = applyMove(state, move);
        } catch (err) {
          illegal++;
          console.error(`非法走法: ${(err as Error).message}`);
          state = applyMove(state, { action: lm.actions[0]! });
        }
      }
      console.log(`冒烟对局: turns=${state.turnCount} winner=${state.winner} illegal=${illegal} playouts/move≈${(mcts.stats.playouts / Math.max(1, mcts.stats.moves)).toFixed(0)} (${mcts.stats.playouts} playouts / ${mcts.stats.moves} moves, ${(mcts.stats.totalMs / Math.max(1, mcts.stats.moves)).toFixed(0)}ms/step)`);
      expect(illegal).toBe(0);
      expect(state.winner !== null || state.draw).toBe(true);
      expect(mcts.stats.playouts).toBeGreaterThan(0);
    },
    120_000,
  );

  test(
    '模拟速度: 中局状态每秒 playouts 达标(方案目标 ≥1000 局/s)',
    async () => {
      // 推进到中局(~40 步)
      let st = createGame({ seed: 4242, names: ['A', 'B'] });
      const rng = { rngState: 12345 };
      for (let i = 0; i < 40 && st.winner === null; i++) {
        let lm = legalMoves(st);
        while (lm.actions.length === 0) {
          if (!lm.canReplenish) break;
          st = applyReplenish(st);
          lm = legalMoves(st);
        }
        if (lm.actions.length === 0) break;
        st = applyMove(st, { action: lm.actions[Math.floor(mulberry32Step(rng) * lm.actions.length)]! });
      }
      const agent = mctsAgent({ timeMs: 1000, seed: 3, name: 'BENCH' });
      const lm = legalMoves(st);
      await agent.chooseMove({ seat: st.current, view: playerView(st, st.current), legal: lm, turn: st.turnCount });
      const pps = agent.stats.playouts / (agent.stats.totalMs / 1000);
      console.log(`中局单步: ${agent.stats.playouts} playouts in ${agent.stats.totalMs}ms => ${pps.toFixed(0)} playouts/s`);
      expect(pps).toBeGreaterThan(1000);
    },
    30_000,
  );
});
