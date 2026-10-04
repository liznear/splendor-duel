// 复用命中探针: mcts2 vs greedy 各 2 局, 打印 reusedRoots / moves 命中率
import { mcts2Agent } from '../../src/agents/mcts2.ts';
import { greedyAgent } from '../../src/agents/greedy.ts';
import { playMatch } from '../../src/arena.ts';

for (const seed of [5001, 5002]) {
  const a = mcts2Agent({ name: 'M2', timeMs: 100 });
  const res = await playMatch([a, greedyAgent()], { seed, firstSeat: 0, record: false });
  console.log(JSON.stringify({
    seed, winner: res.winner, turns: res.turns,
    moves: a.stats.moves, reusedRoots: a.stats.reusedRoots,
    hitRate: +(a.stats.reusedRoots / Math.max(1, a.stats.moves)).toFixed(2),
  }));
}
