// Worker 化搜索 agent: 与 abAgent/mctsAgent 同名接入, 搜索在子线程执行, 不堵主线程事件循环
// (ab/mcts 的搜索是纯同步 CPU 循环; 进程内直跑会冻结 Bun 服务端, Web 图片/轮询全部挂起)
// 保持 spec 语义 'ab'/'ab@ms'/'mcts'/'mcts@ms'/'mcts2'/'mcts2@ms', 供 web server 使用。
import { abAgent } from './ab.js';
import { mctsAgent } from './mcts.js';
import { mcts2Agent } from './mcts2.js';
import type { Agent, TurnContext } from './agent.js';
import type { Move } from '../engine/game.js';

/** 从 'ab' | 'ab@2500' | 'mcts' | 'mcts@800' | 'mcts2' | 'mcts2@800' 提取 kind 与每步时间上限 */
export function parseSearchSpec(spec: string): { kind: 'ab' | 'mcts' | 'mcts2'; timeMs?: number } {
  const at = spec.indexOf('@');
  const kind = (at < 0 ? spec : spec.slice(0, at)) as 'ab' | 'mcts' | 'mcts2';
  const ms = at >= 0 ? Number(spec.slice(at + 1)) : NaN;
  return { kind, ...(ms > 0 ? { timeMs: ms } : {}) };
}

/** 进程内直跑(CLI/对比脚本用): 搜索仍会阻塞调用方事件循环 */
export function inlineSearchAgent(spec: string, name?: string): Agent {
  const { kind, timeMs } = parseSearchSpec(spec);
  return kind === 'ab' ? abAgent({ timeMs, name })
    : kind === 'mcts' ? mctsAgent({ timeMs, name })
      : mcts2Agent({ timeMs, name });
}

/** Worker 化: 每次 chooseMove 起一次性 worker, 返回前销毁(每步秒级, 起停开销可忽略) */
export function workerSearchAgent(spec: string, name?: string): Agent {
  const { kind, timeMs } = parseSearchSpec(spec);
  const inline = inlineSearchAgent(spec, name); // 复用命名(αβbot(n)s / MCTSbot(n)s)
  return {
    get name() { return inline.name; },
    get lastRaw() { return inline.lastRaw; },
    async chooseMove(ctx: TurnContext): Promise<Move> {
      const w = new Worker(new URL('./search-worker.js', import.meta.url), { type: 'module' });
      try {
        return await new Promise<Move>((resolve, reject) => {
          w.onmessage = (e: MessageEvent) => {
            const d = e.data as { move?: Move; error?: string };
            if (d.error) reject(new Error(d.error));
            else resolve(d.move!);
          };
          w.onerror = (e) => reject(new Error(e.message || 'search worker 崩溃'));
          w.postMessage({ spec: kind, timeMs, ctx });
        });
      } finally {
        w.terminate();
      }
    },
  };
}
