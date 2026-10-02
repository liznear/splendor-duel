// 冒烟测试: LLM agent 分阶段协议真实对局 (LLM vs greedy, 少量回合)
// 用法: bun run test/llm.smoke.ts [model]
import { playMatch } from '../src/arena.js';
import { llmAgent } from '../src/agents/llm.js';
import { greedyAgent } from '../src/agents/greedy.js';

const model = process.argv[2];
const llm = llmAgent({ model, verbose: true, name: 'LLM-SMOKE' });
const res = await playMatch([llm, greedyAgent('贪心')], {
  seed: 42,
  maxTurns: 14, // 只验证协议跑通, 不打完
  onMove: (st) => console.log(st.log.at(-1)),
});
console.log(`\n== 冒烟结束: ${res.turns} 回合, winner=${res.winner} draw=${res.draw}`);
process.exit(0);
