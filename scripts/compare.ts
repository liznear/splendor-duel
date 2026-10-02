// A/B 对比: 被测 agent(llm2|llm3) vs baseline(llm|llm2|greedy), 交替座次, 固定种子可复现.
// 用法: bun scripts/compare.ts [对数=6] [--model provider/model] [--baseline llm|llm2|greedy]
//                        [--a llm2|llm3] [--thinking off|low|medium|high]
// 走 API(默认 opencode-go/deepseek-v4.1-flash), 每局 ~50-65 回合; 记录关闭(不写 sessions/).
import { playMatch } from '../src/arena.ts';
import { llmAgent } from '../src/agents/llm.ts';
import { llm2Agent } from '../src/agents/llm2.ts';
import { llm3Agent } from '../src/agents/llm3.ts';
import { greedyAgent } from '../src/agents/greedy.ts';

const args = process.argv.slice(2);
const nGames = Number(args.find((a) => /^\d+$/.test(a)) ?? 6);
const valOf = (flag: string): string | undefined =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const modelArg = valOf('--model');
const baselineArg = (valOf('--baseline') ?? 'llm') as 'llm' | 'llm2' | 'greedy';
const subjectArg = (valOf('--a') ?? 'llm2') as 'llm2' | 'llm3';
const thinkingArg = valOf('--thinking') as 'off' | 'low' | 'medium' | 'high' | undefined;

const model = modelArg || undefined;
const verbose = args.includes('--verbose');
const record = args.includes('--record'); // 开启后写入 sessions/, 供事后行为分析(如 v2 预留次数)
const thinking = thinkingArg ? { thinkingLevel: thinkingArg } : {};
const subjectName = subjectArg.toUpperCase();
const makeSubject = () => (subjectArg === 'llm3' ? llm3Agent : llm2Agent)({ model, name: subjectName, ...thinking });
const makeBase = () => (baselineArg === 'greedy' ? greedyAgent() : baselineArg === 'llm2' ? llm2Agent({ model, name: 'LLM2', ...thinking }) : llmAgent({ model, name: 'LLM', ...thinking }));

let v2Wins = 0, baseWins = 0, draws = 0;
const t0 = Date.now();
for (let i = 0; i < nGames; i++) {
  const seed = 20261002 + i * 7919;
  const v2First = i % 2 === 0;
  const pair = v2First
    ? [makeSubject(), makeBase()]
    : [makeBase(), makeSubject()];
  let lastMoveAt = Date.now();
  const res = await playMatch(pair as [typeof pair[0], typeof pair[0]], {
    seed, record,
    ...(verbose ? {
      onMove: (state) => {
        const who = pair[state.current === 0 ? 1 : 0]!.name; // onMove 在走完后调, current 已切到对方 => 刚走的是 1-current
        const dt = ((Date.now() - lastMoveAt) / 1000).toFixed(0);
        lastMoveAt = Date.now();
        console.log(`  t${state.turnCount - 1} ${who} ${dt}s`);
      },
    } : {}),
  });
  const v2Seat = v2First ? 0 : 1;
  const win = res.draw ? '和' : res.winner === v2Seat ? subjectName : baselineArg.toUpperCase();
  if (res.draw) draws++;
  else if (res.winner === v2Seat) v2Wins++;
  else baseWins++;
  console.log(`第${i + 1}/${nGames}局 seed=${seed} ${subjectName}${v2First ? '先手' : '后手'}: ${win}胜 (${res.turns}回合, 累计${((Date.now() - t0) / 60000).toFixed(1)}分)${res.recorderPath ? ' 记录: ' + res.recorderPath : ''}`);
}
const total = v2Wins + baseWins + draws;
console.log(`\n=== ${subjectName} vs ${baselineArg.toUpperCase()} (${total}局) ===`);
console.log(`${subjectName} ${v2Wins}胜 / ${baselineArg.toUpperCase()} ${baseWins}胜 / 和${draws}  (${subjectName} 胜率 ${(v2Wins / Math.max(1, total) * 100).toFixed(0)}%)`);
