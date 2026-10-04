// 候选 H7: 相位切换混合 — 根分支 ≤ phaseAt(缺省 10)时整段预算交给 αβ(Sim 快核,
// 低分支下可搜很深、竞速终局接近精确解), 否则用原版 mcts(src, 未修改)。
// 唯一变量: 相位切换规则; 两分支内部均用现成实现。
import type { Agent } from '../../src/agents/agent.ts';
import { mctsAgent } from '../../src/agents/mcts.ts';
import { makeAgent as makeAbsim } from './cand-absim.ts';

export interface PhaseStats {
  moves: number; totalMs: number; maxDepth: number; timeouts: number; playouts: number;
  abTurns: number;
}

export function makeAgent(opts: {
  name?: string; timeMs?: number; playouts?: number; seed?: number; phaseAt?: number;
} = {}): Agent & { stats: PhaseStats } {
  const timeMs = opts.timeMs ?? 1000;
  const phaseAt = opts.phaseAt ?? 10;
  const stats: PhaseStats = { moves: 0, totalMs: 0, maxDepth: 0, timeouts: 0, playouts: 0, abTurns: 0 };
  const ab = makeAbsim({ timeMs, seed: opts.seed, maxDepth: 14, name: opts.name });
  const mcts = mctsAgent({ timeMs, seed: opts.seed, name: opts.name });
  let lastAbMs = 0, lastAbPl = 0, lastMctsMs = 0, lastMctsPl = 0;
  return {
    name: opts.name ?? 'phase-hybrid',
    stats,
    async chooseMove(ctx) {
      stats.moves++;
      const useAb = ctx.legal.actions.length <= phaseAt;
      const agent = useAb ? ab : mcts;
      const move = await agent.chooseMove(ctx);
      if (useAb) {
        stats.abTurns++;
        stats.totalMs += ab.stats.totalMs - lastAbMs;
        stats.playouts += ab.stats.playouts - lastAbPl;
        lastAbMs = ab.stats.totalMs; lastAbPl = ab.stats.playouts;
      } else {
        stats.totalMs += mcts.stats.totalMs - lastMctsMs;
        stats.playouts += mcts.stats.playouts - lastMctsPl;
        lastMctsMs = mcts.stats.totalMs; lastMctsPl = mcts.stats.playouts;
      }
      stats.maxDepth = Math.max(stats.maxDepth, agent.stats.maxDepth);
      return move;
    },
  };
}
