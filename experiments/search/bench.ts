// 通用对拍基准: 任意两个 agent spec, 成对交换座次, 固定种子可复现。
// 用法:
//   bun experiments/search/bench.ts --a ab@1000 --b greedy --games 12 --seed 30000000
//   bun experiments/search/bench.ts --a ./cand-x.ts:uctC=1.2 --b mcts@p400 --games 12
// spec: greedy|random|ab@ms|mcts@ms|mcts@pN|<file.ts>:k=v,k=v(动态 import makeAgent)
// 时间预算: 双方默认相同(--time-ms 或 --playouts); 可用 --a-time-ms/--b-time-ms 覆盖。
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playMatch } from '../../src/arena.ts';
import { applyMove } from '../../src/engine/game.ts';
import { abAgent } from '../../src/agents/ab.ts';
import { mctsAgent } from '../../src/agents/mcts.ts';
import { greedyAgent } from '../../src/agents/greedy.ts';
import { randomAgent } from '../../src/agents/random.ts';
import type { Agent, TurnContext } from '../../src/agents/agent.ts';

export interface BenchAgentStats {
  moves: number;
  totalMs: number;
  maxDepth: number;
  timeouts: number;
  playouts: number;
}

const args = process.argv.slice(2);
const value = (flag: string, fallback: string) => args.includes(flag) ? args[args.indexOf(flag) + 1]! : fallback;
const positive = (flag: string, fallback: number) => {
  const n = Number(value(flag, String(fallback)));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
};
const games = positive('--games', 12);
if (games % 2 !== 0) throw new Error('--games must be even (paired seats)');
const seed = positive('--seed', 30000000);
const maxTurns = positive('--max-turns', 180);
const timeMs = args.includes('--time-ms') ? positive('--time-ms', 1000) : undefined;
const playouts = args.includes('--playouts') ? positive('--playouts', 500) : undefined;
const aTime = args.includes('--a-time-ms') ? positive('--a-time-ms', 1000) : timeMs;
const bTime = args.includes('--b-time-ms') ? positive('--b-time-ms', 1000) : timeMs;
const aPlayouts = args.includes('--a-playouts') ? positive('--a-playouts', 500) : playouts;
const bPlayouts = args.includes('--b-playouts') ? positive('--b-playouts', 500) : playouts;
const specA = value('--a', 'greedy');
const specB = value('--b', 'greedy');

export interface BenchOpts {
  name?: string;
  timeMs?: number;
  playouts?: number;
  seed?: number;
  [k: string]: unknown;
}

async function resolveSpec(rawSpec: string, timeMs: number | undefined, playouts: number | undefined): Promise<{ name: string; make: (opts: BenchOpts) => Agent }> {
  const colon = rawSpec.indexOf(':');
  const pathPart = colon < 0 ? rawSpec : rawSpec.slice(0, colon);
  const kvArgs = colon < 0 ? '' : rawSpec.slice(colon + 1);
  const extra: Record<string, string | number> = {};
  for (const kv of kvArgs.split(',').filter(Boolean)) {
    const eq = kv.indexOf('=');
    if (eq < 0) throw new Error(`bad spec kv: ${kv}`);
    const raw = kv.slice(eq + 1);
    extra[kv.slice(0, eq)] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw; // 数值自动转型(uctC=1.4 等)
  }
  const base = (o: BenchOpts) => ({ ...o, ...(timeMs !== undefined ? { timeMs } : {}), ...(playouts !== undefined ? { playouts } : {}), seed: 7, ...extra });
  if (pathPart === 'greedy') return { name: 'greedy', make: () => greedyAgent('greedy') };
  if (pathPart === 'random') return { name: 'random', make: () => randomAgent() };
  const at = pathPart.indexOf('@');
  const kind = at < 0 ? pathPart : pathPart.slice(0, at);
  const arg = at < 0 ? '' : pathPart.slice(at + 1);
  if (kind === 'ab') return { name: 'ab', make: (o) => abAgent(base({ ...o, ...(arg && !timeMs ? { timeMs: Number(arg) } : {}) })) };
  if (kind === 'mcts') {
    if (arg.startsWith('p')) return { name: 'mcts', make: (o) => mctsAgent(base({ ...o, playouts: playouts ?? Number(arg.slice(1)) })) };
    return { name: 'mcts', make: (o) => mctsAgent(base({ ...o, ...(arg && !timeMs && !playouts ? { timeMs: Number(arg) } : {}) })) };
  }
  const mod = await import(pathToFileURL(resolve(pathPart)).href);
  const factory = extra.factory !== undefined && typeof mod[extra.factory as string] === 'function'
    ? mod[extra.factory as string] as (o: BenchOpts) => Agent
    : mod.makeAgent;
  if (typeof factory !== 'function') throw new Error(`${pathPart} must export makeAgent (或 factory= 指定)`);
  return { name: pathPart, make: (o: BenchOpts) => factory(base(o)) };
}

const A = await resolveSpec(specA, aTime, aPlayouts);
const B = await resolveSpec(specB, bTime, bPlayouts);

const wins = [0, 0];
let draws = 0, cappedDraws = 0, illegal = 0;
const acc = { a: { moves: 0, totalMs: 0, playouts: 0, maxDepth: 0 }, b: { moves: 0, totalMs: 0, playouts: 0, maxDepth: 0 } };
for (let i = 0; i < games; i++) {
  const makeChecked = (src: { name: string; make: (o: BenchOpts) => Agent & { stats?: Partial<BenchAgentStats> } }, label: string, slot: 'a' | 'b'): { wrap: Agent; inner: Agent & { stats?: Partial<BenchAgentStats> } } => {
    const inner = src.make({ name: label });
    return {
      inner,
      wrap: {
      name: inner.name,
      async chooseMove(ctx: TurnContext) {
        const t0 = Date.now();
        try {
          const move = await inner.chooseMove(ctx);
          applyMove(ctx.view, move); // 合法性即真值(非法即抛)
          acc[slot].moves++;
          acc[slot].totalMs += Date.now() - t0;
          return move;
        } catch (err) { illegal++; throw err; }
      },
      onGameOver: inner.onGameOver?.bind(inner),
      },
    };
  };
  const agentA = makeChecked(A as never, 'A', 'a');
  const agentB = makeChecked(B as never, 'B', 'b');
  const aSeat = (i % 2) as 0 | 1;
  const pair: [Agent, Agent] = aSeat === 0 ? [agentA.wrap, agentB.wrap] : [agentB.wrap, agentA.wrap];
  const gameSeed = seed + Math.floor(i / 2) * 7919;
  const result = await playMatch(pair, { seed: gameSeed, firstSeat: 0, maxTurns, record: false });
  acc.a.playouts += agentA.inner.stats?.playouts ?? 0;
  acc.b.playouts += agentB.inner.stats?.playouts ?? 0;
  acc.a.maxDepth = Math.max(acc.a.maxDepth, agentA.inner.stats?.maxDepth ?? 0);
  acc.b.maxDepth = Math.max(acc.b.maxDepth, agentB.inner.stats?.maxDepth ?? 0);
  if (illegal > 0) throw new Error(`benchmark rejected: ${illegal} failed/illegal moves`);
  if (result.winner === null) {
    draws++;
    if (result.turns >= maxTurns) cappedDraws++;
  } else wins[result.winner === aSeat ? 0 : 1]!++;
  console.log(JSON.stringify({ game: i + 1, seed: gameSeed, aSeat, winner: result.winner === null ? 'draw' : result.winner === aSeat ? 'A' : 'B', turns: result.turns }));
}
console.log(JSON.stringify({
  summary: true, a: specA, b: specB,
  aBudget: aPlayouts !== undefined ? `p${aPlayouts}` : aTime !== undefined ? `${aTime}ms` : 'none',
  bBudget: bPlayouts !== undefined ? `p${bPlayouts}` : bTime !== undefined ? `${bTime}ms` : 'none',
  maxTurns, games, aWins: wins[0], bWins: wins[1], draws, cappedDraws, illegal,
  aMsPerMove: Math.round(acc.a.totalMs / Math.max(1, acc.a.moves)),
  bMsPerMove: Math.round(acc.b.totalMs / Math.max(1, acc.b.moves)),
  aPlayoutsPerMove: Math.round(acc.a.playouts / Math.max(1, acc.a.moves)),
  bPlayoutsPerMove: Math.round(acc.b.playouts / Math.max(1, acc.b.moves)),
}));
