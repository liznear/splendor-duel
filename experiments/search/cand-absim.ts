// 候选: αβ on Sim 快核 — 与 src/agents/ab.ts 同算法(negamax 迭代加深 + 同一估值修正),
// 但搜索状态用 src/agents/mcts.ts 导出的模拟核(经 test/mcts-sim.test.ts 全随机对拍),
// 不修改任何现有 bot。预期: 节点吞吐大幅提升 -> 同墙钟预算搜得更深。
//
// 与 ab.ts 的镜像关系(刻意保持一致, 使"唯一变量 = 状态核"):
// - 估值: evalLeafSim = greedy.evaluate 语义(points/crowns/colorPts/bonus/token/特权/可购数)
//         + ab.ts 三项修正(盲留折算/皇冠里程碑/终局冲刺), 平分抖动同幅 0.01。
// - 排序: buy>reserve>take 类别 + 静态分(与 ab.ts staticScore 同式, 无费用项)。
// - 树内过滤对手盲留 0 费假购买; 只剩假购买时按现状估值。
// - 根: 一步胜线直接返回; 迭代加深 d1→maxDepth, 下一层预估超时不再启动;
//   条件参数/特权/补货的 1 层修正走引擎 applyMove(语义即真值)。
// 差异(必要): maxDepth 上限默认 12(ab.ts 固定 4); 支持 depth= 固定深度模式(关掉迭代加深,
// 用于同深度节点吞吐对拍)。decodeAction 后必须与 ctx.legal.actions 核对(保险丝)。
import type { Agent, TurnContext } from '../../src/agents/agent.ts';
import {
  applyMove, GEMS, mulberry32Step,
  type CardDef, type GameState, type Gem, type Move, type NonGold,
} from '../../src/engine/game.ts';
import {
  copySim, decodeAction, encodeAction, importSim, makeSim, settleSim, type Sim,
} from '../../src/agents/mcts.ts';

const WIN = 1e9;
const PEARL = 5, GOLD = 6, EMPTY = -1;
const CLASS_RANK = [0, 1, 2]; // kind 位: 0=take 1=reserve 2=buy -> buy 最优先
const ABILITY_RANK: Record<string, number> = { turn: 40, privilege: 20, steal: 10, takeSame: 10 };
const HIDDEN_VALUE: Record<1 | 2 | 3, number> = { 1: 40, 2: 90, 3: 150 };
const NEXT_ITER_GROWTH = 4;

class Timeout extends Error {}

// ---------------------------------------------------------------- Sim 侧估值(镜像 ab.ts evalLeaf)

function canBuyS(s: Sim, seat: number, card: CardDef): boolean {
  if (card.isAssociate) {
    const cc = s.colorCnt[seat]!;
    if (cc[0]! + cc[1]! + cc[2]! + cc[3]! + cc[4]! === 0) return false;
  }
  const b = s.bonuses[seat]!, t = s.tokens[seat]!, c = card.cost;
  let need = 0;
  const gem = (costN: number, g: number) => {
    const eff = costN - b[g]!;
    const gap = (eff > 0 ? eff : 0) - t[g]!;
    if (gap > 0) need += gap;
  };
  gem(c.black, 0); gem(c.red, 1); gem(c.green, 2); gem(c.blue, 3); gem(c.white, 4);
  const pGap = c.pearl - t[PEARL]!;
  if (pGap > 0) need += pGap;
  return need <= t[GOLD]!;
}

function evalPlayerS(s: Sim, seat: number): number {
  const cp = s.colorPts[seat]!;
  let maxColor = 0;
  for (let g = 0; g < 5; g++) if (cp[g]! > maxColor) maxColor = cp[g]!;
  let bonusSum = 0;
  const b = s.bonuses[seat]!;
  for (let g = 0; g < 5; g++) bonusSum += b[g]!;
  const t = s.tokens[seat]!;
  let gemTok = 0;
  for (let g = 0; g < 5; g++) gemTok += t[g]!;
  let affordable = 0;
  for (const card of s.pyramid) if (card && canBuyS(s, seat, card)) affordable += 2;
  for (const card of s.reserved[seat]!) if (canBuyS(s, seat, card)) affordable += 3;
  return s.points[seat]! * 100 + s.crowns[seat]! * 35 + maxColor * 14 + bonusSum * 14
    + t[PEARL]! * 3.2 + t[GOLD]! * 3.5 + gemTok * 1.1
    + s.privileges[seat]! * 9 + affordable + s.reserved[seat]!.length * 1;
}

function crownThreatS(s: Sim, seat: number): number {
  const dist = (s.royalsTaken[seat] === 0 ? 3 : 6) - s.crowns[seat]!;
  return dist === 1 ? 80 : dist === 2 ? 30 : 0;
}
const sprintS = (pts: number): number => (pts >= 14 ? (pts - 13) ** 2 * 6 : 0);

// ---------------------------------------------------------------- 排序(镜像 ab.ts staticScore)

function staticS(s: Sim, v: number): number {
  const kind = v & 3;
  if (kind === 2) {
    const who = s.current;
    const card = (v >> 2) & 1 ? s.reserved[who]![(v >> 3) & 15]! : s.pyramid[(v >> 3) & 15]!;
    return card.points * 100 + card.crowns * 35 + card.bonus * 14 + (card.ability ? ABILITY_RANK[card.ability] ?? 0 : 0);
  }
  if (kind === 1) return 0;
  const b = s.board;
  let sum = b[((v >> 2) & 31) - 1]! === PEARL ? 8 : 1.5;
  const c2 = ((v >> 7) & 31) - 1;
  if (c2 >= 0) sum += b[c2]! === PEARL ? 8 : 1.5;
  const c3 = ((v >> 12) & 31) - 1;
  if (c3 >= 0) sum += b[c3]! === PEARL ? 8 : 1.5;
  return sum;
}

const isHiddenBuy = (s: Sim, who: number, v: number): boolean =>
  (v & 3) === 2 && ((v >> 2) & 1) === 1 && s.reserved[who]![(v >> 3) & 15]!.id === 'hidden';

// ---------------------------------------------------------------- 根 1 层修正(与 ab.ts/mcts.ts 同源)

function trySimE(view: GameState, seat: 0 | 1, move: Move, rnd: () => number): number {
  try {
    const s = applyMove(view, move);
    const me = s.players[seat]!;
    return me.points * 100 + me.crowns * 35; // 轻量代理分: 仅用于条件参数择优
  } catch { return -Infinity; }
}

function refineConditional(view: GameState, seat: 0 | 1, move: Move): Move {
  let best = move;
  let bestScore = trySimE(view, seat, move);
  const cands: Move[] = [];
  if (move.action.kind === 'buy') {
    const p = view.players[seat]!;
    const card = move.action.from.kind === 'pyramid'
      ? view.pyramid[move.action.from.slot]!
      : p.reserved[move.action.from.index]!;
    if (card.ability === 'steal') {
      for (const c of [...GEMS, 'pearl'] as NonGold[]) cands.push({ ...move, stealPick: c });
    }
    if (card.ability === 'takeSame' && card.color) {
      view.board.forEach((t, i) => { if (t === card.color) cands.push({ ...move, takeSameCell: i }); });
    }
    if (card.isAssociate) {
      for (const c of new Set(p.cards.map((oc) => oc.color).filter((c): c is Gem => c != null))) {
        cands.push({ ...move, associateColor: c });
      }
    }
    const crownsAfter = p.crowns + card.crowns;
    if ((crownsAfter >= 3 && p.royalsTaken === 0) || (crownsAfter >= 6 && p.royalsTaken <= 1)) {
      for (let i = 0; i < view.royals.length; i++) cands.push({ ...move, royalPick: i });
    }
  }
  for (const m of cands) {
    const s = trySimE(view, seat, m);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

function refinePrivileges(ctx: TurnContext, move: Move): Move {
  const p = ctx.view.players[ctx.seat]!;
  let cur = move;
  let curScore = trySimE(ctx.view, ctx.seat, cur);
  for (let k = 0; k < p.privileges; k++) {
    let bestCell: number | null = null;
    for (const cell of ctx.legal.privilegeCells) {
      if ((cur.privileges ?? []).includes(cell)) continue;
      const s = trySimE(ctx.view, ctx.seat, { ...cur, privileges: [...(cur.privileges ?? []), cell] });
      if (s > curScore) { curScore = s; bestCell = cell; }
    }
    if (bestCell == null) break;
    cur = { ...cur, privileges: [...(cur.privileges ?? []), bestCell] };
  }
  return cur;
}

function refineReplenish(view: GameState, seat: 0 | 1, move: Move): Move {
  const r = trySimE(view, seat, { ...move, replenish: true });
  return r > trySimE(view, seat, move) + 5 ? { ...move, replenish: true } : move;
}

function sameAction(a: { kind: string }, b: { kind: string }): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------- agent

export interface AbsimStats {
  moves: number;
  totalMs: number;
  maxDepth: number;
  timeouts: number;
  playouts: number; // 恒 0(bench 汇总兼容)
  nodes: number;
  /** 最近一次搜索的根行动编码 -> 迭代加深估值(供混合候选作 MCTS 根先验) */
  rootVals: { v: number; val: number }[];
}

export function makeAgent(opts: { name?: string; timeMs?: number; seed?: number; depth?: number; maxDepth?: number; noPrune?: boolean } = {}): Agent & { stats: AbsimStats } {
  const timeMs = opts.timeMs ?? 1000;
  const maxDepth = opts.maxDepth ?? 12;
  const rngState = { rngState: opts.seed ?? 0x6d2b79f5 };
  const rnd = () => mulberry32Step(rngState);
  const stats: AbsimStats = { moves: 0, totalMs: 0, maxDepth: 0, timeouts: 0, playouts: 0, nodes: 0, rootVals: [] };
  const scratch = new Int32Array(512);
  let deadline = 0;
  let nodes = 0;

  const evalLeafS = (s: Sim, seat: number): number => {
    const opp = 1 - seat;
    let hidden = 0;
    for (const c of s.reserved[opp]!) if (c.id === 'hidden') hidden += HIDDEN_VALUE[c.level];
    return evalPlayerS(s, seat)
      - 0.75 * (hidden + crownThreatS(s, opp) + sprintS(s.points[opp]!))
      + crownThreatS(s, seat) + sprintS(s.points[seat]!) + rnd() * 0.01;
  };

  function negamax(s: Sim, depth: number, alpha: number, beta: number, ply: number, rootSeat: number): number {
    nodes++;
    if (s.winner >= 0) return s.winner === s.current ? WIN - ply : -WIN + ply;
    const n = settleSim(s, scratch);
    if (n === 0) return 0; // 死局和棋
    const who = s.current;
    if (depth <= 0) return evalLeafS(s, who);
    const acts: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = scratch[i]!;
      if (who !== rootSeat && isHiddenBuy(s, who, v)) continue;
      acts.push(v);
    }
    if (acts.length === 0) return evalLeafS(s, who);
    acts.sort((x, y) => CLASS_RANK[y & 3]! - CLASS_RANK[x & 3]! || staticS(s, y) - staticS(s, x));
    let best = -Infinity;
    for (const v of acts) {
      if ((nodes & 255) === 0 && Date.now() > deadline) throw new Timeout();
      const child = copySim(s);
      makeSim(child, v);
      const val = child.winner === who ? WIN - ply - 1
        : child.current === who
          ? negamax(child, depth - 1, alpha, beta, ply + 1, rootSeat)
          : -negamax(child, depth - 1, -beta, -alpha, ply + 1, rootSeat);
      if (val > best) best = val;
      if (best > alpha) alpha = best;
      if (!opts.noPrune && alpha >= beta) break; // noPrune: 关闭剪枝的对照臂
    }
    return best;
  }

  const agent: Agent & { stats: AbsimStats } = {
    name: opts.name ?? 'αβ-sim',
    stats,
    async chooseMove(ctx: TurnContext) {
      const t0 = Date.now();
      deadline = t0 + timeMs;
      nodes = 0;
      stats.moves++;
      const me = ctx.seat;

      // 根子状态一次算好(引擎合法行动 -> Sim 编码), 一步胜线直接返回
      const root = importSim(ctx.view);
      const steps = ctx.legal.actions.map((action) => {
        const v = encodeAction(action);
        const child = copySim(root);
        makeSim(child, v);
        return { v, child, val: 0 as number };
      });
      for (const st of steps) {
        if (st.child.winner === me) {
          const move = refineReplenish(ctx.view, me, refineConditional(ctx.view, me, { action: decodeAction(st.v) }));
          stats.totalMs += Date.now() - t0;
          return move;
        }
      }
      steps.sort((x, y) => CLASS_RANK[y.v & 3]! - CLASS_RANK[x.v & 3]! || staticS(root, y.v) - staticS(root, x.v));

      let best = steps[0]!;
      let lastIterMs = 0;
      const depths = opts.depth !== undefined ? [opts.depth] : Array.from({ length: maxDepth }, (_, i) => i + 1);
      for (const d of depths) {
        if (!opts.depth && lastIterMs > 0 && Date.now() + lastIterMs * NEXT_ITER_GROWTH > deadline) break;
        const iterStart = Date.now();
        try {
          let alpha = -Infinity;
          for (const st of steps) {
            const val = st.child.current === me
              ? negamax(st.child, d - 1, alpha, Infinity, 1, me)
              : -negamax(st.child, d - 1, -Infinity, -alpha, 1, me);
            st.val = val;
            if (val > alpha) { alpha = val; best = st; }
          }
          steps.sort((a, b) => b.val - a.val);
          stats.maxDepth = Math.max(stats.maxDepth, d);
          stats.rootVals = steps.map(({ v, val }) => ({ v, val })); // 每层完整结果均可作先验
          lastIterMs = Date.now() - iterStart;
          if (alpha >= WIN / 2) break;
        } catch {
          if (d > 1) stats.timeouts++;
          break;
        }
      }

      stats.nodes += nodes;
      let selected: Move = { action: decodeAction(best.v) };
      if (!ctx.legal.actions.some((a) => sameAction(a, selected.action))) {
        selected = { action: ctx.legal.actions[0]! }; // 保险丝: Sim 与引擎分歧(对拍测试保证不应发生)
      }
      const move = refineReplenish(ctx.view, me, refinePrivileges(ctx, refineConditional(ctx.view, me, selected)));
      stats.totalMs += Date.now() - t0;
      return move;
    },
  };
  return agent;
}
