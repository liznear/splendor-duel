// 同深度节点对比探针: 同一批局面, 分别测
//   minimax 无剪枝(Sim 核) / αβ(Sim 核) / minimax 无剪枝(引擎核 cand-mm)
// 在 depth 1..3 的节点数与耗时, 以及着法一致性。量化 αβ 剪枝收益与核加速收益。
// bun experiments/search/probe-depth.ts
import { makeAgent as absim } from './cand-absim.ts';
import { makeAgent as mm } from './cand-mm.ts';
import { greedyAgent } from '../../src/agents/greedy.ts';
import { playMatch } from '../../src/arena.ts';
import type { Agent, TurnContext } from '../../src/agents/agent.ts';
import { encodeAction } from '../../src/agents/mcts.ts';

const samples: { turn: number; ctx: TurnContext }[] = [];
const probe: Agent = {
  name: 'probe',
  async chooseMove(ctx) {
    if (ctx.turn >= 12 && ctx.turn % 9 === 0 && samples.length < 6) {
      samples.push({ turn: ctx.turn, ctx: { ...ctx, view: structuredClone(ctx.view), legal: structuredClone(ctx.legal) } });
    }
    return greedyAgent().chooseMove(ctx);
  },
};
await playMatch([probe, greedyAgent()], { seed: 424242, firstSeat: 0, record: false });

const rows: Record<string, unknown>[] = [];
for (const { turn, ctx } of samples) {
  const row: Record<string, unknown> = { turn, branch: ctx.legal.actions.length };
  for (const [label, mk] of [
    ['abSim', (d: number) => absim({ depth: d, seed: 7 })],
    ['mmSim', (d: number) => absim({ depth: d, seed: 7, noPrune: true })],
    ['mmEngine', (d: number) => mm({ depth: d, timeMs: 600000, seed: 7 })],
  ] as const) {
    for (const d of [1, 2, 3]) {
      const a = mk(d);
      const view = structuredClone(ctx.view);
      const legal = structuredClone(ctx.legal);
      const t0 = Date.now();
      const move = await a.chooseMove({ ...ctx, view, legal, seat: ctx.seat });
      const ms = Date.now() - t0;
      row[`${label}.d${d}`] = { nodes: a.stats.nodes, ms, v: encodeAction(move.action) };
    }
  }
  rows.push(row);
}
console.log(JSON.stringify(rows, null, 1));
