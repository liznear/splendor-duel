// R9 候选: 并行 MCTS(根子统计合并)。worker 池内各自完整运行 mcts2Agent(不同 rollout
// 种子, 各自保留跨回合子树复用), 父端按根行动(v|priv)求和 N/W, 取 ΣN 最大稳健子 ——
// 等价于根层面聚合出 ~N倍 playouts 的单树语义。与 mcts2@同预算的唯一变量: 并行度。
// 注: 首版"最终 Move 多数票"合并 12 局 4-8 负于 mcts2(vote 放大贪心共识偏差), 已废弃。
// 协议遵循 experiments/search/README.md: 本文件只做候选, 不改 src/。
import { Worker } from 'node:worker_threads';
import { decodeAction } from '../../src/agents/mcts.ts';
import { refineConditional, refineReplenish } from '../../src/agents/mcts2.ts';
import type { RootChildStat } from '../../src/agents/mcts2.ts';
import type { Agent, TurnContext } from '../../src/agents/agent.ts';
import type { Move } from '../../src/engine/game.ts';

export interface ParStats {
  moves: number;
  totalMs: number;
  maxDepth: number; // 未用(汇总兼容)
  timeouts: number; // 未用
  playouts: number;
}

export interface ParOptions {
  name?: string;
  timeMs?: number;
  playouts?: number;
  seed?: number;
  workers?: number; // 并行 worker 数(默认 8)
}

interface Req {
  t: 'init' | 'move';
  timeMs?: number;
  playouts?: number;
  seed?: number;
  ctx?: TurnContext;
}

interface MoveReply {
  t: 'move';
  bestKey: string;
  move: Move;
  playouts: number;
  root: RootChildStat[];
}
type Reply = { t: 'ready' } | MoveReply | { t: 'error'; error: string };

// 每 worker 常驻单一 handler(串行一请求一回复), 避免每步 add/remove listener 泄漏。
const pending = new WeakMap<Worker, (r: Reply) => void>();
// 进程级共享 worker 池, 按 worker 数分池(见 ensurePool 的 ponytail 注释)
const sharedPools = new Map<number, Worker[]>();

function attach(w: Worker): void {
  const fail = (why: string): void => {
    const p = pending.get(w);
    if (p) { pending.delete(w); p({ t: 'error', error: why }); }
  };
  w.on('message', (r: Reply) => {
    const p = pending.get(w);
    if (p) { pending.delete(w); p(r); }
  });
  w.on('messageerror', (e) => fail(`messageerror: ${e}`));
  w.on('exit', (c) => fail(`worker exited unexpectedly (code ${c})`));
}

function call(w: Worker, msg: Req, timeoutMs: number): Promise<Reply> {
  if (pending.get(w)) return Promise.reject(new Error('par worker: 并发调用(设计外)'));
  return new Promise((resolve, reject) => {
    // 兜底超时: 卡死时大声失败而不是无限挂起
    const timer = setTimeout(() => {
      pending.delete(w);
      reject(new Error(`par worker: reply timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(w, (r) => {
      clearTimeout(timer);
      if (r.t === 'error') reject(new Error(`par worker: ${r.error}`));
      else resolve(r);
    });
    w.postMessage(msg);
  });
}

const childKey = (c: RootChildStat): string => `${c.v}|${c.priv?.join(',') ?? ''}`;

export function makeAgent(opts: ParOptions = {}): Agent & { stats: ParStats } {
  const timeMs = opts.timeMs ?? 4000;
  const n = opts.workers ?? 8;
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('workers 必须是正整数');
  const seed = opts.seed ?? 0x51ed270b;
  const stats: ParStats = { moves: 0, totalMs: 0, maxDepth: 0, timeouts: 0, playouts: 0 };

  let myPool: Worker[] | null = null; // 本 agent 快照(共享池被接管后防误用)
  let lastPlayouts: number[] = [];
  const timerMs = Math.max(3 * timeMs, 60_000) + 10_000; // 回复超时 = 搜索预算 3 倍+10s
  // ponytail: 进程级按 n 分池 —— bench 串行对局, 同参数同时只有一个 par agent 活跃;
  // 每局新 agent 接管时全体 re-init, 丢弃旧树, 消除逐局累积的 worker/内存泄漏
  // (首版每局新建 8 worker 且不 terminate, 6 局后 ~56 worker 拖垮 30G 内存卡死对局)。
  // 若未来需要多 par agent 真并行, 改按全参数分池或加互斥队列。
  const ensurePool = async (): Promise<Worker[]> => {
    if (myPool) return myPool;
    let pool = sharedPools.get(n);
    if (!pool) {
      pool = [];
      for (let i = 0; i < n; i++) {
        // SAFETY: node:worker_threads 类型缺 type 字段, 但 Bun 运行时需要 'module' 才按 ESM 加载 .ts worker
        const w = new Worker(new URL('./par-worker.ts', import.meta.url), { type: 'module' } as ConstructorParameters<typeof Worker>[1]);
        w.unref(); // 不阻止进程退出(仅影响事件循环存活, 不影响消息收发)
        attach(w);
        pool.push(w);
      }
      sharedPools.set(n, pool);
    }
    await Promise.all(pool.map((w, i) =>
      call(w, { t: 'init', timeMs, playouts: opts.playouts, seed: (seed + i * 0x9e3779b9) | 0 }, timerMs)));
    myPool = pool;
    lastPlayouts = pool.map(() => 0);
    return myPool;
  };

  const agent: Agent & { stats: ParStats } = {
    name: opts.name ?? `ParMCTS(${n}w${Math.round(timeMs / 1000)}s)`,
    stats,
    async chooseMove(ctx: TurnContext) {
      stats.moves++;
      const t0 = Date.now();
      const ws = await ensurePool();
      const replies = await Promise.all(ws.map((w, i) => call(w, { t: 'move', ctx }, timerMs).then((r) => {
        if (r.t !== 'move') throw new Error('par worker: unexpected reply');
        // 统计口径与 mcts2 一致: 仅计本次新增 playouts(子树复用继承的 N 不计入)
        stats.playouts += r.playouts - lastPlayouts[i]!;
        lastPlayouts[i] = r.playouts;
        return r;
      })));

      // 根子统计合并: ΣN/ΣW 按行动求和, 稳健子 = ΣN 最大(平票取 ΣW, 再取 key 字典序)
      const agg = new Map<string, { c: RootChildStat }>();
      for (const r of replies) {
        for (const c of r.root) {
          const k = childKey(c);
          const cur = agg.get(k);
          if (cur) { cur.c.N += c.N; cur.c.W += c.W; }
          else agg.set(k, { c: { v: c.v, priv: c.priv, N: c.N, W: c.W } });
        }
      }
      let bestKey = '';
      let bestN = -1, bestW = -Infinity;
      for (const [k, { c }] of agg) {
        if (c.N > bestN || (c.N === bestN && (c.W > bestW || (c.W === bestW && k < bestKey)))) {
          bestKey = k; bestN = c.N; bestW = c.W;
        }
      }
      const winner = agg.get(bestKey)!.c;

      // 最终 Move: 某 worker 自选命中合并赢家则复用其已 refine 的 Move; 否则父端构造+refine
      let selected: Move | null = null;
      for (const r of replies) {
        if (r.root.length > 0 && childKey(r.root.reduce((a, b) => (b.N > a.N ? b : a))!) === bestKey) {
          selected = r.move; // 该 worker 的最终选择即赢家(含全部 refine/保险丝处理)
          break;
        }
      }
      if (!selected) {
        selected = { action: decodeAction(winner.v), privileges: winner.priv };
        // 保险丝(与 mcts2 根同款): 模拟核与引擎分歧时兜底
        const ok = winner.priv
          ? (() => { try { refineConditional(ctx.view, ctx.seat, selected); return true; } catch { return false; } })()
          : ctx.legal.actions.some((a) => JSON.stringify(a) === JSON.stringify(selected!.action));
        if (!ok) selected = { action: ctx.legal.actions[0]! };
        selected = refineReplenish(ctx.view, ctx.seat, refineConditional(ctx.view, ctx.seat, selected));
      }

      stats.totalMs += Date.now() - t0;
      return selected;
    },
  };
  return agent;
}
