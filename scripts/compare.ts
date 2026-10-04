// A/B 对比: 被测 agent(llm2|llm3|ab[@ms]|mcts[@ms]|mcts2[@ms]) vs baseline(llm|llm2|greedy|ab[@ms]|mcts[@ms]|mcts2[@ms]), 交替座次, 固定种子可复现.
// 用法: bun scripts/compare.ts [对数=6] [--jobs N] [--from N] [--model provider/model]
//                        [--baseline llm|llm2|greedy|ab[@ms]|mcts[@ms]|mcts2[@ms]] [--a llm2|llm3|ab[@ms]|mcts[@ms]|mcts2[@ms]]
//                        [--thinking off|low|medium|high] [--record] [--verbose]
// 并发: 局与局之间 Worker 线程并发, --jobs 并发度(默认 10)。
//   注意: 并发摊薄单局 CPU, ab 的墙钟时间预算会按共享 CPU 折算(深度变浅), 精确测量请 --jobs 1。
// 走 API(默认 opencode-go/deepseek-v4.1-flash), 每局 ~50-65 回合; 记录关闭(不写 sessions/).
import { playMatch } from '../src/arena.ts';
import { llmAgent } from '../src/agents/llm.ts';
import { llm2Agent } from '../src/agents/llm2.ts';
import { llm3Agent } from '../src/agents/llm3.ts';
import { greedyAgent } from '../src/agents/greedy.ts';
import type { AbStats } from '../src/agents/ab.ts';
import { mctsAgent, type MctsStats } from '../src/agents/mcts.ts';
import { mcts2Agent } from '../src/agents/mcts2.ts';
import { parMcts2Agent } from '../src/agents/par-mcts2.ts';
import type { Agent } from '../src/agents/agent.ts';


export interface CompareCfg {
  nGames: number;
  model?: string;
  baseline: string; // llm|llm2|greedy|ab[@ms]
  subject: string; // llm2|llm3|ab[@ms]
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  record: boolean;
  verbose: boolean;
  seedOffset: number; // 局序偏移: 换一批种子跑第二样本
}

const valOf = (argv: string[], flag: string): string | undefined =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;

export function cfgFromArgs(argv: string[]): CompareCfg {
  const thinking = valOf(argv, '--thinking');
  return {
    nGames: Number(argv.find((a) => /^\d+$/.test(a)) ?? 6),
    model: valOf(argv, '--model') || undefined,
    baseline: valOf(argv, '--baseline') ?? 'llm',
    subject: valOf(argv, '--a') ?? 'llm2',
    thinkingLevel: (['off', 'low', 'medium', 'high'] as const).find((x) => x === thinking),
    record: argv.includes('--record'), // 开启后写入 sessions/, 供事后行为分析(如 v2 预留次数)
    verbose: argv.includes('--verbose'),
    seedOffset: Number(valOf(argv, '--from') ?? 0),
  };
}

const specKind = (spec: string) => spec.split('@')[0]!;
const specAbMs = (spec: string) => Number(spec.split('@')[1]) || undefined;

function makeAgent(spec: string, cfg: CompareCfg, llmLabel: string): Agent & { stats?: AbStats } {
  const kind = specKind(spec);
  const thinking = cfg.thinkingLevel ? { thinkingLevel: cfg.thinkingLevel } : {};
  if (kind === 'greedy') return greedyAgent();
  if (kind === 'mcts') return mctsAgent({ name: 'MCTS', timeMs: specAbMs(spec) });
  if (kind === 'mcts2') return mcts2Agent({ name: 'MCTS2', timeMs: specAbMs(spec) });
  if (kind === 'par-mcts2') return parMcts2Agent({ name: 'ParMCTS2', timeMs: specAbMs(spec) });
  const make = kind === 'llm' ? llmAgent : kind === 'llm2' ? llm2Agent : llm3Agent;
  return make({ model: cfg.model, name: llmLabel, ...thinking });
}

export interface GameOutcome {
  i: number;
  seed: number;
  subjectFirst: boolean;
  win: 'subject' | 'baseline' | 'draw' | 'error';
  turns: number;
  tookMin: number;
  recorderPath?: string;
  error?: string;
  stats?: AbStats;
}

/** 跑一局(可在 Worker 线程内执行), 打印单局结果行并返回结构化结果 */
export async function runGame(i: number, cfg: CompareCfg): Promise<GameOutcome> {
  const seed = 20261002 + (i + cfg.seedOffset) * 7919;
  const subjectFirst = i % 2 === 0;
  const subjectName = specKind(cfg.subject).toUpperCase();
  const baseName = specKind(cfg.baseline).toUpperCase();
  const t0 = Date.now();
  try {
    const subject = makeAgent(cfg.subject, cfg, subjectName);
    const pair: Agent[] = subjectFirst
      ? [subject, makeAgent(cfg.baseline, cfg, baseName)]
      : [makeAgent(cfg.baseline, cfg, baseName), subject];
    let lastMoveAt = Date.now();
    const res = await playMatch(pair as [Agent, Agent], {
      seed, record: cfg.record,
      ...(cfg.verbose ? {
        onMove: (state) => {
          const who = pair[state.current === 0 ? 1 : 0]!.name; // onMove 在走完后调, current 已切到对方 => 刚走的是 1-current
          const dt = ((Date.now() - lastMoveAt) / 1000).toFixed(0);
          lastMoveAt = Date.now();
          console.log(`  t${state.turnCount - 1} ${who} ${dt}s`);
        },
      } : {}),
    });
    const subjectSeat = subjectFirst ? 0 : 1;
    const win = res.draw ? 'draw' : res.winner === subjectSeat ? 'subject' : 'baseline';
    const winText = res.draw ? '和' : win === 'subject' ? subjectName : baseName;
    console.log(`第${i + 1}/${cfg.nGames}局 seed=${seed} ${subjectName}${subjectFirst ? '先手' : '后手'}: ${winText}胜 (${res.turns}回合, 本局${((Date.now() - t0) / 60000).toFixed(1)}分)${res.recorderPath ? ' 记录: ' + res.recorderPath : ''}`);
    return {
      i, seed, subjectFirst, win, turns: res.turns,
      tookMin: (Date.now() - t0) / 60000,
      recorderPath: res.recorderPath,
      stats: subject.stats,
    };
  } catch (err) {
    console.error(`第${i + 1}/${cfg.nGames}局 seed=${seed} 异常: ${(err as Error).message}`);
    return { i, seed, subjectFirst, win: 'error', turns: 0, tookMin: (Date.now() - t0) / 60000, error: (err as Error).message };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = cfgFromArgs(argv);
  const jobs = Math.max(1, Math.min(cfg.nGames, Number(valOf(argv, '--jobs') ?? 10)));
  const t0 = Date.now();
  const outcomes: GameOutcome[] = [];

  if (jobs === 1) {
    for (let i = 0; i < cfg.nGames; i++) outcomes.push(await runGame(i, cfg));
  } else {
    const queue = Array.from({ length: cfg.nGames }, (_, i) => i);
    await new Promise<void>((resolveAll) => {
      let finished = 0;
      const spawn = (): Worker => {
        const w = new Worker(new URL('./compare-worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent) => {
          outcomes.push(e.data as GameOutcome);
          finished++;
          const next = queue.pop();
          if (next === undefined) w.terminate();
          if (finished === cfg.nGames) resolveAll();
          else if (next !== undefined) w.postMessage({ i: next, argv });
        };
        w.onerror = (e) => {
          console.error(`worker 异常: ${e.message}`);
          finished++;
          if (finished === cfg.nGames) resolveAll();
        };
        const i = queue.pop();
        if (i !== undefined) w.postMessage({ i, argv });
        return w;
      };
      for (let k = 0; k < jobs; k++) spawn();
    });
  }

  const subjectName = specKind(cfg.subject).toUpperCase();
  const baseName = specKind(cfg.baseline).toUpperCase();
  const v2Wins = outcomes.filter((o) => o.win === 'subject').length;
  const baseWins = outcomes.filter((o) => o.win === 'baseline').length;
  const draws = outcomes.filter((o) => o.win === 'draw').length;
  const total = outcomes.length;
  console.log(`\n=== ${subjectName} vs ${baseName} (${total}局, --jobs ${jobs}) ===`);
  console.log(`${subjectName} ${v2Wins}胜 / ${baseName} ${baseWins}胜 / 和${draws}  (${subjectName} 胜率 ${(v2Wins / Math.max(1, total) * 100).toFixed(0)}%) 总耗时${((Date.now() - t0) / 60000).toFixed(1)}分`);
  const sum = outcomes.reduce((acc: AbStats, o) => {
    if (!o.stats) return acc;
    acc.moves += o.stats.moves; acc.totalMs += o.stats.totalMs;
    acc.maxDepth = Math.max(acc.maxDepth, o.stats.maxDepth); acc.timeouts += o.stats.timeouts;
    return acc;
  }, { moves: 0, totalMs: 0, maxDepth: 0, timeouts: 0 });
  if (specKind(cfg.subject) === 'ab' && sum.moves > 0) {
    console.log(`AB 统计: 平均步时 ${(sum.totalMs / sum.moves).toFixed(0)}ms, 最深 d${sum.maxDepth}, 超时率 ${(sum.timeouts / sum.moves * 100).toFixed(0)}%`);
  }
  if (specKind(cfg.subject) === 'mcts' && sum.moves > 0) {
    const pl = outcomes.reduce((a, o) => a + ((o.stats as MctsStats | undefined)?.playouts ?? 0), 0);
    console.log(`MCTS 统计: 平均步时 ${(sum.totalMs / sum.moves).toFixed(0)}ms, 平均 playouts/步 ${(pl / sum.moves).toFixed(0)}`);
  }
}

if (import.meta.main) await main().then(() => process.exit(0)); // LLM SDK keepalive 句柄会悬住进程, 显式退出
