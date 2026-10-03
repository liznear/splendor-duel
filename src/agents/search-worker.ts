// 搜索 agent 专用 Worker: 把 CPU 密集的同步搜索挪出主线程, 事件循环不再被堵死
// 协议: 收 {spec:'ab'|'mcts', timeMs?, ctx} → 回 {move, ms}; 一次性任务, 用完 terminate
import { abAgent } from './ab.ts';
import { mctsAgent } from './mcts.ts';
import type { Move } from '../engine/game.ts';
import type { TurnContext } from './agent.ts';

self.onmessage = (e: MessageEvent) => {
  const { spec, timeMs, ctx } = e.data as { spec: 'ab' | 'mcts'; timeMs?: number; ctx: TurnContext };
  const t0 = Date.now();
  const agent = spec === 'ab' ? abAgent({ timeMs }) : mctsAgent({ timeMs });
  agent.chooseMove(ctx).then((move: Move) => {
    (self as unknown as Worker).postMessage({ move, ms: Date.now() - t0 });
  }).catch((err: Error) => {
    (self as unknown as Worker).postMessage({ error: err.message });
  });
};
