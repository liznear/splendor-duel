// cand-mcts-par 的专用 Worker: 每实例持有一个 mcts2Agent(跨回合子树复用保留)。
// 协议: {t:'init', timeMs, seed, playouts?} -> {t:'ready'}
//       {t:'move', ctx} -> {t:'move', bestKey, move, playouts, root: RootChildStat[]}
// bestKey = 该 worker 自选最终 Move 的稳定序列化(命中合并赢家时直接复用, 免父端重 refine)。
import { mcts2Agent } from '../../src/agents/mcts2.ts';
import type { Move } from '../../src/engine/game.ts';
import type { TurnContext } from '../../src/agents/agent.ts';

let agent: ReturnType<typeof mcts2Agent> | null = null;

// SAFETY: worker 模块作用域里 self 即 DedicatedWorkerGlobalScope, 有 postMessage;
// DOM lib 无该类型, 断言为 node:worker_threads 兼容的 Worker 形状只用到 postMessage。
const post = (m: unknown): void => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.t === 'init') {
    agent = mcts2Agent({ timeMs: msg.timeMs, playouts: msg.playouts, seed: msg.seed });
    post({ t: 'ready' });
    return;
  }
  if (msg.t === 'move') {
    const a = agent!;
    a.chooseMove(msg.ctx as TurnContext).then((move: Move) => {
      post({
        t: 'move',
        bestKey: JSON.stringify(move),
        move,
        playouts: a.stats.playouts,
        root: a.stats.lastRoot ?? [],
      });
    }).catch((err: Error) => {
      post({ t: 'error', error: String(err?.stack ?? err) });
    });
  }
};
