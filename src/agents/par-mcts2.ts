// ParMCTS2 bot: 并行 MCTS(worker 池 + 根子统计合并)。
// 每个 worker 独立完整运行 mcts2Agent(不同 rollout 种子, 各自保留跨回合子树复用),
// 父端按根行动(v|priv)求和 N/W 取 ΣN 最大稳健子 —— 等价于根层面聚合出 ~N倍 playouts
// 的单树语义(R9 台账: 多数票合并有害已弃用; 统计合并与 mcts2 同预算 ≈ 打平偏正)。
//
// 生命周期: per-agent 池, onGameOver 终止(arena 流程); server 不触发 onGameOver,
// 由模块级 LRU 上限兕底(默认同时最多 2 池; 超限逐出最旧并 terminate)。
// ponytail: LRU cap=2 是兕底而非并发控制; 若要多局真并行, 提高上限并按核数分池。
import { Worker } from 'node:worker_threads';
import { decodeAction } from './mcts.ts';
import { refineConditional, refineReplenish } from './mcts2.ts';
import type { RootChildStat } from './mcts2.ts';
import type { Agent, TurnContext } from './agent.ts';
import type { Move } from '../engine/game.ts';

export interface ParMcts2Stats {
  moves: number;
  totalMs: number;
  maxDepth: number; // 未用(汇总兼容)
  timeouts: number; // 未用
  playouts: number;
  workers: number;
}

export interface ParMcts2Options {
  name?: string;
  timeMs?: number; // 每步搜索时间上限(spec 可调 par-mcts2@ms)
  playouts?: number; // 固定模拟次数(替代墙钟预算), 用于可复现测试
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

// 模块级 LRU 活池登记(server 长驻进程可能并发多局, onGameOver 之外的兕底)
const livePools: { ws: Worker[]; dead: boolean }[] = [];
function evictOld(): void {
  while (livePools.length >= 2) {
    const old = livePools.shift()!;
    old.dead = true;
    for (const w of old.ws) void w.terminate();
  }
}

export function parMcts2Agent(opts: ParMcts2Options = {}): Agent & { stats: ParMcts2Stats } {
  if (opts.playouts !== undefined && (!Number.isSafeInteger(opts.playouts) || opts.playouts < 1)) {
    throw new RangeError('playouts 必须是正整数');
  }
  const timeMs = opts.timeMs ?? 4000;
  const n = opts.workers ?? 8;
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('workers 必须是正整数');
  const seed = opts.seed ?? 0x51ed270b;
  const stats: ParMcts2Stats = { moves: 0, totalMs: 0, maxDepth: 0, timeouts: 0, playouts: 0, workers: n };
  const timerMs = Math.max(3 * timeMs, 60_000) + 10_000;

  let pool: { ws: Worker[]; dead: boolean } | null = null;
  let lastPlayouts: number[] = [];
  const teardown = (): void => {
    if (!pool) return;
    pool.dead = true;
    const i = livePools.indexOf(pool);
    if (i >= 0) livePools.splice(i, 1);
    for (const w of pool.ws) void w.terminate();
    pool = null;
  };
  const ensurePool = async (): Promise<Worker[]> => {
    if (pool && !pool.dead) return pool.ws;
    teardown();
    evictOld();
    const p = { ws: [] as Worker[], dead: false };
    for (let i = 0; i < n; i++) {
      // SAFETY: node:worker_threads 类型缺 type 字段, 但 Bun 运行时需要 'module' 才按 ESM 加载 .ts worker
      const w = new Worker(new URL('./par-worker.ts', import.meta.url), { type: 'module' } as ConstructorParameters<typeof Worker>[1]);
      w.unref(); // 不阻止进程退出(仅影响事件循环存活, 不影响消息收发)
      attach(w);
      p.ws.push(w);
    }
    livePools.push(p);
    pool = p;
    await Promise.all(p.ws.map((w, i) =>
      call(w, { t: 'init', timeMs, playouts: opts.playouts, seed: (seed + i * 0x9e3779b9) | 0 }, timerMs)));
    lastPlayouts = p.ws.map(() => 0);
    return p.ws;
  };

  const searchOnce = async (ctx: TurnContext): Promise<Move> => {
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
      // 保险丝(与 mcts2 根同款): 模拟核与引擎分歧时兕底
      const ok = winner.priv
        ? (() => { try { refineConditional(ctx.view, ctx.seat, selected); return true; } catch { return false; } })()
        : ctx.legal.actions.some((a) => JSON.stringify(a) === JSON.stringify(selected!.action));
      if (!ok) selected = { action: ctx.legal.actions[0]! };
      selected = refineReplenish(ctx.view, ctx.seat, refineConditional(ctx.view, ctx.seat, selected));
    }
    stats.totalMs += Date.now() - t0;
    return selected;
  };

  const agent: Agent & { stats: ParMcts2Stats } = {
    name: opts.name ?? `ParMCTS2bot(${n}w${Math.round(timeMs / 1000)}s)`,
    stats,
    async chooseMove(ctx: TurnContext) {
      stats.moves++;
      // worker 池被 LRU 逐出/意外死亡时重建重试一次
      try {
        return await searchOnce(ctx);
      } catch (e) {
        teardown();
        return await searchOnce(ctx);
      }
    },
    onGameOver() {
      teardown();
    },
  };
  return agent;
}
