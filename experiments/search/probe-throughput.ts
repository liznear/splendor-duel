// 吞吐探针: 同一批真实局面(贪心自博弈中盘/残局)上, 测
// ① Sim 核 αβ depth=3 的节点吞吐(cand-absim.stats.nodes)
// ② 引擎核 applyMove 吞吐(ab.ts 每节点 ≈ 1 次 applyMove + 1 次估值, 即其节点成本上界)
// 输出 JSON 行, 供台账记录。bun experiments/search/probe-throughput.ts
import { makeAgent } from './cand-absim.ts';
import { greedyAgent } from '../../src/agents/greedy.ts';
import { playMatch } from '../../src/arena.ts';
import { applyMove, legalMoves, playerView } from '../../src/engine/game.ts';
import type { Agent, TurnContext } from '../../src/agents/agent.ts';

// 从一局贪心自博弈采样局面(跳过前 10 回合, 避开开局大分支)
const samples: { turn: number; ctx: TurnContext }[] = [];
const probe: Agent = {
  name: 'probe',
  async chooseMove(ctx) {
    if (ctx.turn >= 10 && ctx.turn % 8 === 0 && samples.length < 8) {
      samples.push({ turn: ctx.turn, ctx: { ...ctx, view: structuredClone(ctx.view), legal: structuredClone(ctx.legal) } });
    }
    return greedyAgent().chooseMove(ctx);
  },
};
await playMatch([probe, greedyAgent()], { seed: 777, firstSeat: 0, record: false });

// ① Sim 核: 每个采样局面跑一次 depth=3 搜索(无墙钟模式)
let simNodes = 0, simMs = 0;
for (const { ctx } of samples) {
  const a = makeAgent({ depth: 3, seed: 7, name: 'probe' });
  await a.chooseMove({ ...ctx, view: structuredClone(ctx.view), legal: structuredClone(ctx.legal) });
  simNodes += a.stats.nodes;
  simMs += a.stats.totalMs;
}

// ② 引擎核: 同局面枚举合法行动并 applyMove, 循环 3 轮取吞吐
let engMoves = 0;
const t0 = Date.now();
for (let round = 0; round < 3; round++) {
  for (const { ctx } of samples) {
    const lm = legalMoves(ctx.view);
    for (const action of lm.actions.slice(0, 25)) {
      applyMove(ctx.view, { action });
      engMoves++;
    }
  }
}
const engMs = Date.now() - t0;
console.log(JSON.stringify({
  samples: samples.map((s) => s.turn),
  sim: { depth: 3, nodes: simNodes, ms: simMs, nodesPerSec: Math.round(simNodes / Math.max(0.001, simMs / 1000)) },
  engine: { moves: engMoves, ms: engMs, movesPerSec: Math.round(engMoves / Math.max(0.001, engMs / 1000)) },
  speedup: Math.round((simNodes / Math.max(0.001, simMs)) / (engMoves / Math.max(0.001, engMs))),
}));
