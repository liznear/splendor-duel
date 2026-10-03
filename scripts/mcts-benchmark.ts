// 固定种子成对交换座次; 不调用 LLM、不写 sessions。playouts 模式可复现, time-ms 模式比较棋力。
// bun scripts/mcts-benchmark.ts --games 12 --playouts 500 --baseline greedy
// bun scripts/mcts-benchmark.ts --games 12 --time-ms 120 --baseline /tmp/splender-mcts-before.ts
// bun scripts/mcts-benchmark.ts --games 12 --time-ms 240 --baseline mcts --baseline-time-ms 60
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playMatch } from '../src/arena.ts';
import { applyMove } from '../src/engine/game.ts';
import { mctsAgent, type MctsOptions, type MctsStats } from '../src/agents/mcts.ts';
import { greedyAgent } from '../src/agents/greedy.ts';
import type { Agent } from '../src/agents/agent.ts';

const args = process.argv.slice(2);
const value = (flag: string, fallback: string) => args.includes(flag) ? args[args.indexOf(flag) + 1]! : fallback;
const positive = (flag: string, fallback: number) => {
  const n = Number(value(flag, String(fallback)));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
};
const games = positive('--games', 12);
if (games % 2 !== 0) throw new Error('--games must be even (paired seats)');
const seed = positive('--seed', 20261003);
const maxTurns = positive('--max-turns', 600);
const baseline = value('--baseline', 'greedy');
if (args.includes('--time-ms') && args.includes('--playouts')) throw new Error('choose --time-ms or --playouts, not both');
const options: MctsOptions = args.includes('--time-ms')
  ? { timeMs: positive('--time-ms', 120), seed: 7 }
  : { playouts: positive('--playouts', 500), seed: 7 };
if (args.includes('--baseline-time-ms') && args.includes('--baseline-playouts')) {
  throw new Error('choose --baseline-time-ms or --baseline-playouts, not both');
}
if (baseline === 'greedy' && (args.includes('--baseline-time-ms') || args.includes('--baseline-playouts'))) {
  throw new Error('greedy has no search budget');
}
const baselineOptions: MctsOptions = args.includes('--baseline-time-ms')
  ? { timeMs: positive('--baseline-time-ms', 120), seed: 7 }
  : args.includes('--baseline-playouts')
    ? { playouts: positive('--baseline-playouts', 500), seed: 7 }
    : options;
const baselineFactory: (options: MctsOptions) => Agent & { stats?: MctsStats } = baseline === 'greedy'
  ? () => greedyAgent('G')
  : baseline === 'mcts' ? mctsAgent
    : (await import(pathToFileURL(resolve(baseline)).href)).mctsAgent;
const wins = [0, 0];
let draws = 0, cappedDraws = 0, illegal = 0, privilegeTokens = 0, moves = 0, playouts = 0, totalMs = 0;
let baselineMoves = 0, baselinePlayouts = 0, baselineMs = 0;
for (let i = 0; i < games; i++) {
  const subject = mctsAgent({ ...options, name: 'candidate' });
  let used = 0;
  const checked = (agent: Agent, countPrivileges = false): Agent => ({
    name: agent.name,
    async chooseMove(ctx) {
      try {
        const move = await agent.chooseMove(ctx);
        applyMove(ctx.view, move);
        if (countPrivileges) used += move.privileges?.length ?? 0;
        return move;
      } catch (err) { illegal++; throw err; }
    },
  });
  const candidate = checked(subject, true);
  const opponentAgent = baselineFactory({ ...baselineOptions, name: 'baseline' });
  const opponent = checked(opponentAgent);
  const seat = (i % 2) as 0 | 1;
  const pair: [Agent, Agent] = seat === 0 ? [candidate, opponent] : [opponent, candidate];
  const gameSeed = seed + Math.floor(i / 2) * 7919;
  const result = await playMatch(pair, { seed: gameSeed, firstSeat: 0, maxTurns, record: false });
  if (illegal > 0) throw new Error(`benchmark rejected: ${illegal} failed/illegal moves`);
  if (result.winner === null) {
    draws++;
    if (result.turns >= maxTurns) cappedDraws++;
  }
  else wins[result.winner === seat ? 0 : 1]!++;
  privilegeTokens += used;
  moves += subject.stats.moves;
  playouts += subject.stats.playouts;
  totalMs += subject.stats.totalMs;
  baselineMoves += opponentAgent.stats?.moves ?? 0;
  baselinePlayouts += opponentAgent.stats?.playouts ?? 0;
  baselineMs += opponentAgent.stats?.totalMs ?? 0;
  console.log(JSON.stringify({ game: i + 1, seed: gameSeed, seat, winner: result.winner === null ? 'draw' : result.winner === seat ? 'candidate' : 'baseline', turns: result.turns, privilegeTokens: used }));
}
console.log(JSON.stringify({
  summary: true, baseline, options, baselineOptions, maxTurns, games, wins, draws, cappedDraws, illegal,
  privilegeTokens, moves, baselineMoves,
  playoutsPerMove: Math.round(playouts / Math.max(1, moves)),
  baselinePlayoutsPerMove: Math.round(baselinePlayouts / Math.max(1, baselineMoves)),
  msPerMove: Math.round(totalMs / Math.max(1, moves)),
  baselineMsPerMove: Math.round(baselineMs / Math.max(1, baselineMoves)),
  playoutsPerSecond: Math.round(playouts / Math.max(0.001, totalMs / 1000)),
}));
