// 候选 H6: MCTS 跨回合子树复用 — 不改任何搜索语义(UCT/rollout/首演与 mcts.ts 相同,
// rollout 走到终局 cap=400), 唯一变量: 保存本回合选中子树, 下回合若真实局面与树内
// 后继节点完全一致(Sim 逐字段等价, 含 rngState)则直接作为新根继续搜索。
// 等效于同一预算下拿到更多有效 playouts。视角正确性: 边统计 W 恒为"我的根视角"
// (每次搜索的 root 都是我方回合), 复用后继续累加, 语义不变。
import type { Agent, TurnContext } from '../../src/agents/agent.ts';
import {
  applyMove, GEMS, mulberry32Step, SPIRAL, SLOT_LEVEL,
  type CardDef, type GameState, type Gem, type Move, type NonGold,
} from '../../src/engine/game.ts';
import {
  copySim, decodeAction, enumActions, importSim, makeSim, replenishSim, settleSim, takePrivilegesSim,
  type Sim,
} from '../../src/agents/mcts.ts';

const PEARL = 5, GOLD = 6;
const ABILITY_RANK = [0, 40, 10, 10, 20];
const COLOR_CODE: Record<string, number> = { black: 0, red: 1, green: 2, blue: 3, white: 4, pearl: 5, gold: 6 };
const HIDDEN_VALUE: Record<1 | 2 | 3, number> = { 1: 40, 2: 90, 3: 150 };

interface SimCard {
  cost: Int8Array; points: number; crowns: number; bonus: number; color: number;
  ability: number; isAssociate: boolean;
}
const cardCache = new Map<string, SimCard>();
function simCard(card: CardDef): SimCard {
  let sc = cardCache.get(card.id);
  if (!sc) {
    sc = {
      cost: Int8Array.of(card.cost.pearl, card.cost.black, card.cost.red, card.cost.green, card.cost.blue, card.cost.white),
      points: card.points, crowns: card.crowns, bonus: card.bonus,
      color: card.color == null ? -1 : COLOR_CODE[card.color]!,
      ability: card.ability == null ? 0 : card.ability === 'turn' ? 1 : card.ability === 'takeSame' ? 2 : card.ability === 'steal' ? 3 : 4,
      isAssociate: card.isAssociate,
    };
    cardCache.set(card.id, sc);
  }
  return sc;
}

// ---------------- Sim 侧估值(镜像 ab.ts evalLeaf, 与 cand-absim.evalPlayerS 同式)

function canBuySim(s: Sim, seat: number, sc: SimCard): boolean {
  if (sc.isAssociate) {
    const cc = s.colorCnt[seat]!;
    if (cc[0]! + cc[1]! + cc[2]! + cc[3]! + cc[4]! === 0) return false;
  }
  const b = s.bonuses[seat]!, t = s.tokens[seat]!;
  let need = 0;
  for (let g = 0; g < 5; g++) {
    const eff = sc.cost[1 + g]! - b[g]!;
    const gap = (eff > 0 ? eff : 0) - t[g]!;
    if (gap > 0) need += gap;
  }
  const pGap = sc.cost[0]! - t[PEARL]!;
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
  for (const card of s.pyramid) if (card && canBuySim(s, seat, simCard(card))) affordable += 2;
  for (const card of s.reserved[seat]!) if (canBuySim(s, seat, simCard(card))) affordable += 3;
  return s.points[seat]! * 100 + s.crowns[seat]! * 35 + maxColor * 14 + bonusSum * 14
    + t[PEARL]! * 3.2 + t[GOLD]! * 3.5 + gemTok * 1.1
    + s.privileges[seat]! * 9 + affordable + s.reserved[seat]!.length * 1;
}

function crownThreatS(s: Sim, seat: number): number {
  const dist = (s.royalsTaken[seat] === 0 ? 3 : 6) - s.crowns[seat]!;
  return dist === 1 ? 80 : dist === 2 ? 30 : 0;
}
const sprintS = (pts: number): number => (pts >= 14 ? (pts - 13) ** 2 * 6 : 0);

/** 双方视角估值(rootSeat 视角), sigmoid 映到 (0.01, 0.99) */
function evalZ(s: Sim, rootSeat: number): number {
  const opp = 1 - rootSeat;
  let hidden = 0;
  for (const c of s.reserved[opp]!) if (c.id === 'hidden') hidden += HIDDEN_VALUE[c.level];
  const e = evalPlayerS(s, rootSeat)
    - 0.75 * (hidden + crownThreatS(s, opp) + sprintS(s.points[opp]!))
    + crownThreatS(s, rootSeat) + sprintS(s.points[rootSeat]!);
  const z = 1 / (1 + Math.exp(-e / 800));
  return Math.min(0.99, Math.max(0.01, z));
}

// ---------------- 从 mcts.ts 复制的树/rollout 件(唯一改动见 rollout 的 cap+evalZ)

function staticSim(s: Sim, v: number): number {
  const who = s.current;
  const kind = v & 3;
  if (kind === 2) {
    const card = (v >> 2) & 1 ? s.reserved[who]![(v >> 3) & 15]! : s.pyramid[(v >> 3) & 15]!;
    const sc = simCard(card);
    let color = sc.color;
    if (sc.isAssociate) color = defaultColorSim(s, who);
    if (
      s.points[who]! + sc.points >= 20 ||
      s.crowns[who]! + sc.crowns >= 10 ||
      (color >= 0 && s.colorPts[who]![color]! + sc.points >= 10)
    ) return 10000;
    const b = s.bonuses[who]!;
    let tie = sc.cost[0]!;
    for (let g = 0; g < 5; g++) tie += Math.max(0, sc.cost[1 + g]! - b[g]!);
    return sc.points * 100 + sc.crowns * 35 + sc.bonus * 14 + ABILITY_RANK[sc.ability]! - tie * 1.2;
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

function defaultColorSim(s: Sim, seat: number): number {
  const c = s.colorCnt[seat]!;
  let best = 0;
  for (let g = 1; g < 5; g++) if (c[g]! > c[best]!) best = g;
  return c[best]! > 0 ? best : -1;
}

function privilegePlans(s: Sim): { v: number; cells: number[] }[] {
  const who = s.current, budget = s.privileges[who]!;
  if (budget === 0) return [];
  const plans: { v: number; cells: number[] }[] = [];
  for (let i = 0; i < 12 + s.reserved[who]!.length; i++) {
    const card = i < 12 ? s.pyramid[i] : s.reserved[who]![i - 12];
    if (!card) continue;
    const sc = simCard(card), t = s.tokens[who]!, b = s.bonuses[who]!;
    if (sc.isAssociate && defaultColorSim(s, who) < 0) continue;
    const gaps = [Math.max(0, sc.cost[0]! - t[PEARL]!)];
    for (let g = 0; g < 5; g++) gaps.push(Math.max(0, sc.cost[g + 1]! - b[g]! - t[g]!));
    let need = gaps.reduce((a, v) => a + v, 0) - t[GOLD]!;
    if (need <= 0 || need > budget) continue;
    const cells: number[] = [];
    for (let g = 0; g < 6 && need > 0 && cells.length < budget; g++) {
      const color = g === 0 ? PEARL : g - 1;
      for (let cell = 0; cell < 25 && gaps[g]! > 0 && need > 0 && cells.length < budget; cell++) {
        if (s.board[cell] !== color) continue;
        cells.push(cell);
        gaps[g]!--;
        need--;
      }
    }
    if (need === 0) {
      const v = i < 12 ? 2 | (i << 3) : 2 | (1 << 2) | ((i - 12) << 3);
      plans.push({ v, cells });
    }
  }
  return plans;
}

interface MChild { v: number; privileges?: number[]; node: MNode | null; N: number; W: number; prior: number }
interface MNode { sim: Sim; n: number; children: MChild[] | null; terminal: number }

const SCRATCH_A = new Int32Array(512);
const SCRATCH_B = new Int32Array(512);

function expandNode(node: MNode): void {
  const n = enumActions(node.sim, SCRATCH_A);
  const ch: MChild[] = [];
  for (let i = 0; i < n; i++) {
    const v = SCRATCH_A[i]!;
    ch.push({ v, node: null, N: 0, W: 0, prior: staticSim(node.sim, v) });
  }
  for (const { v, cells } of privilegePlans(node.sim)) {
    ch.push({ v, privileges: cells, node: null, N: 0, W: 0, prior: staticSim(node.sim, v) });
  }
  ch.sort((a, b) => b.prior - a.prior);
  node.children = ch;
}

function expandChild(node: MNode, ch: MChild, rootSeat: number): MNode {
  const sim = copySim(node.sim);
  if (ch.privileges) takePrivilegesSim(sim, ch.privileges);
  makeSim(sim, ch.v);
  const nn: MNode = { sim, n: 0, children: null, terminal: -1 };
  if (sim.winner >= 0) nn.terminal = sim.winner === rootSeat ? 1 : 0;
  else if (settleSim(sim, SCRATCH_B) === 0) nn.terminal = 0.5;
  ch.node = nn;
  return nn;
}

function selectBest(node: MNode, rootSeat: number, uctC: number): MChild {
  const logN = Math.log(node.n + 1);
  const maxing = node.sim.current === rootSeat;
  let best: MChild | null = null;
  let bestS = -Infinity;
  for (const ch of node.children!) {
    const mean = ch.N === 0 ? 0.5 : ch.W / ch.N;
    const u = (maxing ? mean : 1 - mean) + uctC * Math.sqrt(logN / (ch.N + 1));
    if (u > bestS) { bestS = u; best = ch; }
  }
  return best!;
}

/** 唯一改动: 步数上限 rolloutCap(缺省 12), 触顶返回 evalZ(估值回传)而非 0.5 */
function rollout(s0: Sim, rootSeat: number, rnd: () => number, jitter: number, cap: number): number {
  const s = copySim(s0);
  for (let step = 0; step < cap; step++) {
    if (s.winner >= 0) return s.winner === rootSeat ? 1 : 0;
    const n = enumActions(s, SCRATCH_A);
    if (n === 0) {
      if (s.bagLen === 0) return 0.5;
      replenishSim(s);
      continue;
    }
    let bestV = -1;
    let bestS = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = SCRATCH_A[i]!;
      const sc = staticSim(s, v) + rnd() * jitter;
      if (sc > bestS) { bestS = sc; bestV = v; }
    }
    let bestCells: number[] | undefined;
    for (const { v, cells } of privilegePlans(s)) {
      const score = staticSim(s, v) - cells.length * 0.01;
      if (score > bestS) { bestS = score; bestV = v; bestCells = cells; }
    }
    if (bestCells) takePrivilegesSim(s, bestCells);
    makeSim(s, bestV);
  }
  return s.winner >= 0 ? (s.winner === rootSeat ? 1 : 0) : evalZ(s, rootSeat);
}

function playout(root: MNode, rootSeat: number, rnd: () => number, uctC: number, jitter: number, cap: number): void {
  const path: MChild[] = [];
  let node = root;
  let z: number;
  for (;;) {
    node.n++;
    if (node.terminal >= 0) { z = node.terminal; break; }
    if (!node.children) expandNode(node);
    let child: MChild | undefined;
    for (const ch of node.children!) {
      if (ch.node === null) { child = ch; break; }
    }
    if (child === undefined) child = selectBest(node, rootSeat, uctC);
    path.push(child);
    if (child.node === null) {
      const nn = expandChild(node, child, rootSeat);
      z = nn.terminal >= 0 ? nn.terminal : rollout(nn.sim, rootSeat, rnd, jitter, cap);
      break;
    }
    node = child.node;
  }
  for (const ch of path) {
    ch.N++;
    ch.W += z;
  }
}

// ---------------- 根 1 层修正(与 mcts.ts 同源)

function trySimE(view: GameState, seat: 0 | 1, move: Move): number {
  try {
    const s = applyMove(view, move);
    const me = s.players[seat]!;
    return me.points * 100 + me.crowns * 35;
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

function refineReplenish(view: GameState, seat: 0 | 1, move: Move): Move {
  const r = trySimE(view, seat, { ...move, replenish: true });
  return r > trySimE(view, seat, move) + 5 ? { ...move, replenish: true } : move;
}

function sameAction(a: { kind: string }, b: { kind: string }): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------- agent

export interface EvalMctsStats {
  moves: number; totalMs: number; maxDepth: number; timeouts: number; playouts: number;
  reusedRoots: number; // 实际命中复用的回合数
}

/** Sim 逐字段等价判定(含 rngState; decks/pyramid/royals/reserved 按 id 序) */
function simEq(a: Sim, b: Sim): boolean {
  if (a.current !== b.current || a.extraTurns !== b.extraTurns || a.turnCount !== b.turnCount
    || a.winner !== b.winner || a.rngState !== b.rngState || a.bagLen !== b.bagLen) return false;
  for (let i = 0; i < 25; i++) if (a.board[i] !== b.board[i]) return false;
  for (let i = 0; i < a.bagLen; i++) if (a.bag[i] !== b.bag[i]) return false;
  for (let i = a.bagLen; i < 32; i++) if (a.bag[i] !== b.bag[i]) return false; // 尾部也应一致(同一 rng 历史)
  for (const f of ['tokens', 'bonuses', 'colorPts', 'colorCnt'] as const) {
    for (let p = 0; p < 2; p++) {
      const x = a[f][p]!, y = b[f][p]!;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    }
  }
  for (let p = 0; p < 2; p++) {
    const ar = a.reserved[p]!, br = b.reserved[p]!;
    if (ar.length !== br.length) return false;
    for (let i = 0; i < ar.length; i++) if (ar[i]!.id !== br[i]!.id) return false;
    if (a.points[p] !== b.points[p] || a.crowns[p] !== b.crowns[p]
      || a.privileges[p] !== b.privileges[p] || a.royalsTaken[p] !== b.royalsTaken[p]) return false;
  }
  for (let lvl = 0; lvl < 3; lvl++) {
    const ad = a.decks[lvl]!, bd = b.decks[lvl]!;
    if (ad.length !== bd.length) return false;
    for (let i = 0; i < ad.length; i++) if (ad[i]!.id !== bd[i]!.id) return false;
  }
  for (let s = 0; s < 12; s++) {
    const ac = a.pyramid[s], bc = b.pyramid[s];
    if ((ac == null) !== (bc == null)) return false;
    if (ac && bc && ac.id !== bc.id) return false;
  }
  if (a.royals.length !== b.royals.length) return false;
  for (let i = 0; i < a.royals.length; i++) if (a.royals[i]!.id !== b.royals[i]!.id) return false;
  return true;
}

export function makeAgent(opts: {
  name?: string; timeMs?: number; playouts?: number; seed?: number;
  uctC?: number; jitter?: number; rolloutCap?: number;
} = {}): Agent & { stats: EvalMctsStats } {
  if (opts.playouts !== undefined && (!Number.isSafeInteger(opts.playouts) || opts.playouts < 1)) {
    throw new RangeError('playouts 必须是正整数');
  }
  const timeMs = opts.timeMs ?? 1000;
  const uctC = opts.uctC ?? 0.7;
  const jitter = opts.jitter ?? 3;
  const cap = opts.rolloutCap ?? 400; // 走到终局(与原 mcts 相同)
  const rngState = { rngState: opts.seed ?? 0x51ed270b };
  const rnd = (): number => mulberry32Step(rngState);
  const stats: EvalMctsStats = { moves: 0, totalMs: 0, maxDepth: 0, timeouts: 0, playouts: 0, reusedRoots: 0 };
  let prevAnchor: MNode | null = null; // 上一回合选中的 child 节点(对手回复后即新根候选)

  const agent: Agent & { stats: EvalMctsStats } = {
    name: opts.name ?? 'mcts-eval',
    stats,
    async chooseMove(ctx: TurnContext) {
      stats.moves++;
      const t0 = Date.now();
      const deadline = t0 + timeMs;
      const me = ctx.seat;
      // 子树复用: 上回合选中节点(若我获得额外回合)或其子节点(对手已回复)中,
      // 找与当前真实局面完全一致者作新根; 找不到则全新树
      const rootSim = importSim(ctx.view);
      let root: MNode | null = null;
      if (prevAnchor) {
        const cands: MNode[] = prevAnchor.sim.current === me
          ? [prevAnchor]
          : (prevAnchor.children ?? []).filter((c) => c.node != null).map((c) => c.node!);
        for (const nd of cands) {
          if (simEq(nd.sim, rootSim)) { root = nd; stats.reusedRoots++; break; }
        }
      }
      prevAnchor = null;
      if (!root) root = { sim: rootSim, n: 0, children: null, terminal: -1 };
      expandNode(root);
      const children = root.children!;
      for (const ch of children) {
        const nn = expandChild(root, ch, me);
        if (nn.terminal === 1) {
          const move = refineConditional(ctx.view, me, { action: decodeAction(ch.v), privileges: ch.privileges });
          stats.totalMs += Date.now() - t0;
          return move;
        }
      }
      let best = children[0]!;
      if (children.length > 1) {
        let n = 0;
        while (opts.playouts !== undefined ? n < opts.playouts : Date.now() < deadline) {
          playout(root, me, rnd, uctC, jitter, cap);
          n++;
        }
        stats.playouts += n;
        for (const ch of children) if (ch.N > best.N) best = ch;
        if (!best.node) expandChild(root, best, me); // 供下回合复用
        prevAnchor = best.node ?? null;
      }
      let selected: Move = { action: decodeAction(best.v), privileges: best.privileges };
      if (best.privileges) {
        if (!Number.isFinite(trySimE(ctx.view, me, selected))) selected = { action: ctx.legal.actions[0]! };
      } else if (!ctx.legal.actions.some((a) => sameAction(a, selected.action))) {
        selected = { action: ctx.legal.actions[0]! };
      }
      const move = refineReplenish(ctx.view, me, refineConditional(ctx.view, me, selected));
      stats.totalMs += Date.now() - t0;
      return move;
    },
  };
  return agent;
}
