// CLI 入口: 菜单选择模式 (也可用参数直接跑)
import { playMatch, playTournament } from './arena.ts';
import { randomAgent } from './agents/random.ts';
import { greedyAgent } from './agents/greedy.ts';
import { humanAgent } from './agents/human.ts';
import { llmAgent } from './agents/llm.ts';
import type { Agent } from './agents/agent.ts';
import { renderState, logTail } from './render.ts';
import * as readline from 'node:readline/promises';

function makeAgent(spec: string): Agent {
  const [kind, ...rest] = spec.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'random': return randomAgent();
    case 'greedy': return greedyAgent();
    case 'human': return humanAgent();
    case 'llm': return llmAgent({ model: arg || undefined });
    default:
      console.error(`未知 agent: ${spec} (可用: random | greedy | llm | human)`);
      process.exit(1);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  // 参数模式: bun run src/cli.ts <p1> <p2> [局数]
  if (argv.length >= 2) {
    const games = Number(argv[2] ?? 1);
    const a1 = makeAgent(argv[0]!);
    const a2 = makeAgent(argv[1]!);
    if (games > 1) {
      const t = await playTournament([a1, a2], games, { verbose: true });
      console.log(`\n═══ ${games} 局结果 ═══`);
      console.log(`${a1.name}: ${t.wins[0]} 胜 | ${a2.name}: ${t.wins[1]} 胜 | 和局: ${t.draws} | 平均 ${t.avgTurns.toFixed(0)} 回合`);
    } else {
      const r = await playMatch([a1, a2], {
        showState: (st) => console.log('\n' + renderState(st, st.current) + '\n'),
        onMove: (st) => console.log(logTail(st, 2)),
      });
      console.log(r.draw ? '和局' : `🏆 ${[a1, a2][r.winner!]!.name} 获胜 (${r.turns} 回合)`);
    }
    return;
  }

  // 菜单模式
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => rl.question(q).then((a) => a.trim());
  console.log('═══════ 璀璨宝石对决 Arena ═══════');
  console.log('1) 人机对战 (你 vs Agent)');
  console.log('2) Agent 单局对战 (带展示)');
  console.log('3) Agent 批量对局统计');
  console.log('提示: WebUI 请运行 `bun run web` 后打开 http://localhost:3000');
  const mode = await ask('选择 [1-3]: ');
  const listAgents = () => 'random(随机) / greedy(贪心) / llm[:provider/model] / human(人)';

  if (mode === '1') {
    const spec = await ask(`对手 Agent? ${listAgents} (默认 greedy): `) || 'greedy';
    const seatIn = await ask('你执先手还是后手? 1=先手 2=后手 (默认后手, 后手先得1特权): ');
    const humanSeat = seatIn === '1' ? 0 : 1;
    const bot = makeAgent(spec);
    const pair: [Agent, Agent] = humanSeat === 0 ? [humanAgent('你'), bot] : [bot, humanAgent('你')];
    const r = await playMatch(pair, {
      showState: (st, seat) => {
        if (pair[seat]!.name === '你') console.log('\n' + renderState(st, seat));
      },
      onMove: (st) => console.log(logTail(st, 3)),
    });
    console.log(r.draw ? '🤝 和局' : `🏆 ${pair[r.winner!]!.name} 获胜 (${r.turns} 回合)`);
  } else if (mode === '2') {
    const s1 = await ask(`先手 Agent? ${listAgents} (默认 greedy): `) || 'greedy';
    const s2 = await ask(`后手 Agent? ${listAgents} (默认 random): `) || 'random';
    const r = await playMatch([makeAgent(s1), makeAgent(s2)], {
      showState: (st) => console.log('\n' + renderState(st, st.current)),
      onMove: (st) => console.log(logTail(st, 2)),
    });
    console.log(r.draw ? '🤝 和局' : `🏆 ${r.winner === 0 ? s1 : s2} 获胜 (${r.turns} 回合)`);
  } else if (mode === '3') {
    const s1 = await ask(`先手 Agent? ${listAgents} (默认 greedy): `) || 'greedy';
    const s2 = await ask(`后手 Agent? ${listAgents} (默认 random): `) || 'random';
    const n = Number(await ask('局数? (默认 20): ') || 20);
    const t = await playTournament([makeAgent(s1), makeAgent(s2)], n, { verbose: true });
    console.log(`\n═══ ${n} 局结果 ═══`);
    console.log(`${s1}: ${t.wins[0]} 胜 | ${s2}: ${t.wins[1]} 胜 | 和局: ${t.draws} | 平均 ${t.avgTurns.toFixed(0)} 回合`);
  }
  rl.close();
}

await main();
