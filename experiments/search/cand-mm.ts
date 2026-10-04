// 候选: 纯 minimax(无 αβ 剪枝) — 研究对照臂。
// 与 src/agents/ab.ts 同估值/同排序/同根胜线检查, 唯一变量: 不做 alpha-beta 剪枝
// (negamax 全宽展开)。用于量化:
//   ① 同深度下与 αβ 的节点数差(剪枝收益);
//   ② 同墙钟下的棋力(αβ 搜得更深 -> 应更强)。
// 引擎核(structuredClone applyMove)。depth= 固定深度, timeMs= 迭代加深(无剪枝版)。
import type { Agent, TurnContext } from '../../src/agents/agent.ts';
import {
  applyMove, applyReplenish, legalMoves, mulberry32Step,
  type GameState, type LegalMoves, type MandatoryAction, type PlayerState,
} from '../../src/engine/game.ts';
import { evaluate } from '../../src/agents/greedy.ts';

const WIN = 1e9;
const MAX_DEPTH = 6;
const NEXT_ITER_GROWTH = 6; // 无剪枝: 下一层耗时增长≈名义分支因子, 预估系数比 ab.ts(3)大
const CLASS_RANK: Record<MandatoryAction['kind'], number> = { buy: 0, reserve: 1, take: 2 };
const ABILITY_RANK: Record<string, number> = { turn: 40, privilege: 20, steal: 10, takeSame: 10 };
const HIDDEN_VALUE: Record<1 | 2 | 3, number> = { 1: 40, 2: 90, 3: 150 };

class Timeout extends Error {}

export interface MmStats {
  moves: number;
  totalMs: number;
  maxDepth: number;
  timeouts: number;
  playouts: number;
  nodes: number;
}

export function makeAgent(opts: { name?: string; timeMs?: number; seed?: number; depth?: number } = {}): Agent & { stats: MmStats } {
  const timeMs = opts.timeMs ?? 1000;
  const rngState = { rngState: opts.seed ?? 0x6d2b79f5 };
  const stats: MmStats = { moves: 0, totalMs: 0, maxDepth: 0, timeouts: 0, playouts: 0, nodes: 0 };
  let deadline = 0;
  let nodes = 0;

  const crownThreat = (p: PlayerState): number => {
    const dist = (p.royalsTaken === 0 ? 3 : 6) - p.crowns;
    return dist === 1 ? 80 : dist === 2 ? 30 : 0;
  };
  const sprint = (p: PlayerState): number => (p.points >= 14 ? (p.points - 13) ** 2 * 6 : 0);
  const evalLeaf = (s: GameState, seat: 0 | 1): number => {
    const opp = s.players[1 - seat]!;
    let hidden = 0;
    for (const c of opp.reserved) if (c.id === 'hidden') hidden += HIDDEN_VALUE[c.level];
    const me = s.players[seat]!;
    return evaluate(s, seat, () => mulberry32Step(rngState))
      - 0.75 * (hidden + crownThreat(opp) + sprint(opp))
      + crownThreat(me) + sprint(me);
  };

  function expand(state: GameState): { state: GameState; lm: LegalMoves } | null {
    let lm = legalMoves(state);
    while (lm.actions.length === 0) {
      if (!lm.canReplenish) return null;
      state = applyReplenish(state);
      lm = legalMoves(state);
    }
    return { state, lm };
  }

  function treeActions(state: GameState, lm: LegalMoves): MandatoryAction[] {
    const p = state.players[state.current]!;
    return lm.actions.filter((a) =>
      !(a.kind === 'buy' && a.from.kind === 'reserved' && p.reserved[a.from.index!]!.id === 'hidden'));
  }

  function staticScore(state: GameState, a: MandatoryAction): number {
    if (a.kind === 'buy') {
      const p = state.players[state.current]!;
      const card = a.from.kind === 'pyramid' ? state.pyramid[a.from.slot]! : p.reserved[a.from.index]!;
      return card.points * 100 + card.crowns * 35 + card.bonus * 14 + (card.ability ? ABILITY_RANK[card.ability] ?? 0 : 0);
    }
    if (a.kind === 'reserve') return 0;
    return a.cells.reduce((s, cell) => s + (state.board[cell] === 'pearl' ? 8 : state.board[cell] ? 1.5 : 0), 0);
  }

  /** 全宽 minimax(无窗口): 返回 state.current 视角分值 */
  function minimax(state: GameState, depth: number, ply: number): number {
    if (state.winner !== null) return state.winner === state.current ? WIN - ply : -WIN + ply;
    const ex = expand(state);
    if (!ex) return 0;
    const { state: st, lm } = ex;
    const who = st.current;
    if (depth <= 0) return evalLeaf(st, who);
    const actions = treeActions(st, lm);
    if (actions.length === 0) return evalLeaf(st, who);
    actions.sort((x, y) => CLASS_RANK[x.kind] - CLASS_RANK[y.kind] || staticScore(st, y) - staticScore(st, x));
    let best = -Infinity;
    for (const action of actions) {
      if ((nodes & 63) === 0 && Date.now() > deadline) throw new Timeout();
      nodes++;
      const child = applyMove(st, { action });
      const v = child.winner === who ? WIN - ply - 1
        : child.current === who
          ? minimax(child, depth - 1, ply + 1)
          : -minimax(child, depth - 1, ply + 1);
      if (v > best) best = v;
      // 无剪枝: 不维护 alpha/beta, 全部展开
    }
    return best;
  }

  const agent: Agent & { stats: MmStats } = {
    name: opts.name ?? 'minimax',
    stats,
    async chooseMove(ctx: TurnContext) {
      const t0 = Date.now();
      deadline = t0 + timeMs;
      nodes = 0;
      stats.moves++;
      const me = ctx.seat;
      const rootSteps = ctx.legal.actions.map((action) => {
        const child = applyMove(ctx.view, { action });
        return { action, child, val: 0 as number };
      });
      for (const s of rootSteps) {
        if (s.child.winner === me) {
          stats.totalMs += Date.now() - t0;
          return { action: s.action };
        }
      }
      rootSteps.sort((x, y) =>
        CLASS_RANK[x.action.kind] - CLASS_RANK[y.action.kind] || evalLeaf(y.child, me) - evalLeaf(x.child, me));

      let best = rootSteps[0]!;
      let lastIterMs = 0;
      const depths = opts.depth !== undefined ? [opts.depth] : Array.from({ length: MAX_DEPTH }, (_, i) => i + 1);
      for (const d of depths) {
        if (opts.depth === undefined && lastIterMs > 0 && Date.now() + lastIterMs * NEXT_ITER_GROWTH > deadline) break;
        const iterStart = Date.now();
        try {
          let bestVal = -Infinity;
          for (const s of rootSteps) {
            const v = s.child.current === me
              ? minimax(s.child, d - 1, 1)
              : -minimax(s.child, d - 1, 1);
            s.val = v;
            if (v > bestVal) { bestVal = v; best = s; }
          }
          rootSteps.sort((a, b) => b.val - a.val);
          stats.maxDepth = Math.max(stats.maxDepth, d);
          lastIterMs = Date.now() - iterStart;
          if (bestVal >= WIN / 2) break;
        } catch {
          if (d > 1) stats.timeouts++;
          break;
        }
      }
      stats.nodes += nodes;
      stats.totalMs += Date.now() - t0;
      return { action: best.action };
    },
  };
  return agent;
}
