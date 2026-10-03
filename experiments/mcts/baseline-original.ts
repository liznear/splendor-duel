// MCTS bot: 轻量模拟核 + UCT + 贪心 rollout (方案: search_based_agent_plan.md 阶段 3)
//
// 组成:
// 1. 模拟核 Sim: 独立"可变状态"实现, 与 engine/game.ts 的结算语义逐条镜像
//    (合法行动集合 / 支付 / 能力 / 皇家里程碑 / 弃置 / 胜负 / 补货 rng 流全部一致),
//    由 test/mcts-sim.test.ts 全随机对拍逐步校验。目标 <10µs/步(方案指标)。
// 2. UCT: 胜负回报 z∈{0, 0.5, 1}(root 视角); 对手节点取 1-mean 对称;
//    额外回合(同方连走)按节点 sim.current 就地判位。
// 3. 贪心 rollout(截断候选集): 对全部强制行动算静态启发分(与 ab.ts 着法排序同源:
//    买入>拿取>预留, 立即取胜巨额加成), 加随机抖动取 argmax。
//    不逐动作 applyMove+估值(方案实测引擎克隆下 7-9 局/s, 太贵)。
// 4. RAVE 未实现(方案标注可选)。特权/自愿补货不进树, root 用引擎 1 层修正(同 ab v1 简化)。
//
// 公平性红线(与 ab.ts 一致, 写死在此):
// - 搜索只用 ctx.view / ctx.legal。对手盲留(id='hidden', 0 费恒可买)视为 0 战力:
//   树内允许其作为 0 收益"过牌"动作推进局面(不虚构未知费用, 不给对手加战力)。
// - 不从真实 GameState 读对手盲留。
// - 补货的不确定性: 模拟核从 view.rngState 出发按镜像规则确定性结算(与 ab 相同的
//   "双方信息面近似对称"近似, 方案风险表已接受并注释; 不额外采样 bag 排列)。
// - agent 内部随机(rollout 抖动)用自带种子的 mulberry32, 不用 Math.random(),
//   同种子同局可复现调试。
import type { Agent, TurnContext } from '../../src/agents/agent.ts';
import {
  applyMove, GEMS, mulberry32Step, SLOT_LEVEL, SPIRAL,
  type CardDef, type GameState, type Gem, type MandatoryAction, type Move, type NonGold, type RoyalDef,
} from '../../src/engine/game.ts';
import { evaluate } from '../../src/agents/greedy.ts';

// ---------------------------------------------------------------- 颜色编码

// 静态颜色编码表: 0-4 = black/red/green/blue/white (GEMS 序), 5 = pearl, 6 = gold; 棋盘 -1 = 空
const COLOR_CODE: Record<string, number> = { black: 0, red: 1, green: 2, blue: 3, white: 4, pearl: 5, gold: 6 };
const PEARL = 5;
const GOLD = 6;
const EMPTY = -1;

// 能力编码: 0 无, 1 turn, 2 takeSame, 3 steal, 4 privilege (rank 与 ab.ts ABILITY_RANK 同源)
const ABILITY_RANK = [0, 40, 10, 10, 20];

interface SimCard {
  cost: Int8Array; // [pearl, black, red, green, blue, white]
  points: number;
  crowns: number;
  bonus: number;
  color: number; // -1 = null(POINTS 卡/盲留)
  ability: number;
  isAssociate: boolean;
}

const cardCache = new Map<string, SimCard>();
function simCard(card: CardDef): SimCard {
  let sc = cardCache.get(card.id);
  if (!sc) {
    sc = {
      cost: Int8Array.of(card.cost.pearl, card.cost.black, card.cost.red, card.cost.green, card.cost.blue, card.cost.white),
      points: card.points,
      crowns: card.crowns,
      bonus: card.bonus,
      color: card.color == null ? -1 : COLOR_CODE[card.color]!,
      ability: card.ability == null ? 0 : card.ability === 'turn' ? 1 : card.ability === 'takeSame' ? 2 : card.ability === 'steal' ? 3 : 4,
      isAssociate: card.isAssociate,
    };
    cardCache.set(card.id, sc);
  }
  return sc;
}

// ---------------------------------------------------------------- 模拟核状态

/** 可变状态。owned 卡只保留聚合量(colorPts/colorCnt/bonuses/points/crowns), 卡牌本身不再存储 */
export interface Sim {
  board: Int8Array; // 25, EMPTY/gem/pearl/gold
  bag: Uint8Array; // 容量 32 (全场 token 恒 25, bag ≤ 25)
  bagLen: number;
  decks: CardDef[][]; // [L1, L2, L3], 末尾抽牌(数组自有, 卡对象共享只读)
  pyramid: (CardDef | null)[]; // 12
  royals: RoyalDef[]; // 自有数组, 元素共享只读
  tokens: [Int8Array, Int8Array]; // 7 色/人
  bonuses: [Int8Array, Int8Array]; // 5 宝石/人
  colorPts: [Int8Array, Int8Array]; // 同色卡分累计(胜利判定"同色 10 分")
  colorCnt: [Int8Array, Int8Array]; // 各色卡数(百搭默认色/购买资格)
  reserved: [CardDef[], CardDef[]]; // 对手项可能含 id='hidden' 的盲留
  points: [number, number];
  crowns: [number, number];
  privileges: [number, number];
  royalsTaken: [number, number];
  current: 0 | 1;
  extraTurns: number;
  turnCount: number;
  winner: number; // -1 无
  rngState: number;
}

export function importSim(view: GameState): Sim {
  const [p0, p1] = view.players;
  // 玩家侧导入: token/折扣直接搬运, 同色聚合量(colorPts/colorCnt)由 owned 卡累计
  const imp = (p: typeof p0) => {
    const tokens = Int8Array.from([p.tokens.black, p.tokens.red, p.tokens.green, p.tokens.blue, p.tokens.white, p.tokens.pearl, p.tokens.gold]);
    const bonuses = Int8Array.from([p.bonuses.black, p.bonuses.red, p.bonuses.green, p.bonuses.blue, p.bonuses.white]);
    const colorPts = Int8Array.of(0, 0, 0, 0, 0);
    const colorCnt = Int8Array.of(0, 0, 0, 0, 0);
    for (const oc of p.cards) {
      if (oc.color != null) {
        colorPts[COLOR_CODE[oc.color]!]! += oc.def.points;
        colorCnt[COLOR_CODE[oc.color]!]!++;
      }
    }
    return { tokens, bonuses, colorPts, colorCnt };
  };
  const a = imp(p0!), b = imp(p1!);
  const bag = new Uint8Array(32);
  view.bag.forEach((t, i) => { bag[i] = COLOR_CODE[t]!; });
  return {
    board: Int8Array.from(view.board, (t) => (t == null ? EMPTY : COLOR_CODE[t]!)),
    bag, bagLen: view.bag.length,
    decks: [view.decks[0]!.slice(), view.decks[1]!.slice(), view.decks[2]!.slice()],
    pyramid: view.pyramid.slice(),
    royals: view.royals.slice(),
    tokens: [a.tokens, b.tokens],
    bonuses: [a.bonuses, b.bonuses],
    colorPts: [a.colorPts, b.colorPts],
    colorCnt: [a.colorCnt, b.colorCnt],
    reserved: [p0!.reserved.slice(), p1!.reserved.slice()],
    points: [p0!.points, p1!.points],
    crowns: [p0!.crowns, p1!.crowns],
    privileges: [p0!.privileges, p1!.privileges],
    royalsTaken: [p0!.royalsTaken, p1!.royalsTaken],
    current: view.current,
    extraTurns: view.extraTurns,
    turnCount: view.turnCount,
    winner: view.winner == null ? -1 : view.winner,
    rngState: view.rngState,
  };
}

export function copySim(s: Sim): Sim {
  return {
    board: s.board.slice(),
    bag: s.bag.slice(), bagLen: s.bagLen,
    decks: [s.decks[0]!.slice(), s.decks[1]!.slice(), s.decks[2]!.slice()],
    pyramid: s.pyramid.slice(),
    royals: s.royals.slice(),
    tokens: [s.tokens[0]!.slice(), s.tokens[1]!.slice()],
    bonuses: [s.bonuses[0]!.slice(), s.bonuses[1]!.slice()],
    colorPts: [s.colorPts[0]!.slice(), s.colorPts[1]!.slice()],
    colorCnt: [s.colorCnt[0]!.slice(), s.colorCnt[1]!.slice()],
    reserved: [s.reserved[0]!.slice(), s.reserved[1]!.slice()],
    points: [s.points[0]!, s.points[1]!],
    crowns: [s.crowns[0]!, s.crowns[1]!],
    privileges: [s.privileges[0]!, s.privileges[1]!],
    royalsTaken: [s.royalsTaken[0]!, s.royalsTaken[1]!],
    current: s.current,
    extraTurns: s.extraTurns,
    turnCount: s.turnCount,
    winner: s.winner,
    rngState: s.rngState,
  };
}

// ---------------------------------------------------------------- 规则镜像

function pushBagN(s: Sim, c: number, n: number): void {
  for (let i = 0; i < n; i++) s.bag[s.bagLen++] = c;
}

function gainPriv(s: Sim, who: number): void {
  const p = s.privileges[who]!, o = s.privileges[1 - who]!;
  if (p >= 3) return;
  if (p + o < 3) s.privileges[who] = p + 1;
  else if (o > 0) { s.privileges[1 - who] = o - 1; s.privileges[who] = p + 1; }
}

/** 偷取缺省: 对手有珍珠先偷珍珠, 否则数量最多(平分取 GEMS 序最前); 无非金 token 则忽略 */
function stealSim(s: Sim, who: number): void {
  const ot = s.tokens[1 - who]!;
  let color = PEARL;
  if (ot[PEARL] === 0) {
    color = -1;
    for (let c = 0; c < 5; c++) if (ot[c]! > 0 && (color < 0 || ot[c]! > ot[color]!)) color = c;
    if (color < 0) return;
  }
  ot[color]!--;
  s.tokens[who]![color]!++;
}

/** "拿同色"缺省: 棋盘扫描序第一个同色格; 场上无同色则忽略 */
function takeSameSim(s: Sim, who: number, color: number): void {
  if (color < 0) return;
  for (let i = 0; i < 25; i++) {
    if (s.board[i] === color) {
      s.board[i] = EMPTY;
      s.tokens[who]![color]!++;
      return;
    }
  }
}

function resolveRoyalSim(s: Sim, who: number): void {
  const r = s.royals;
  if (r.length === 0) return;
  let idx = r.findIndex((x) => x.ability === 'turn');
  if (idx < 0) idx = r.findIndex((x) => x.ability === 'privilege');
  if (idx < 0) idx = r.findIndex((x) => x.ability === 'steal');
  if (idx < 0) idx = 0;
  const royal = r.splice(idx, 1)[0]!;
  s.points[who]! += royal.points;
  if (royal.ability === 'turn') s.extraTurns++;
  else if (royal.ability === 'privilege') gainPriv(s, who);
  else if (royal.ability === 'steal') stealSim(s, who);
  // takeSame 不可能(皇家卡无颜色)
}

function milestonesSim(s: Sim, who: number): void {
  if (s.royalsTaken[who] === 0 && s.crowns[who]! >= 3) {
    s.royalsTaken[who] = 1;
    resolveRoyalSim(s, who);
  }
  if (s.royalsTaken[who] === 1 && s.crowns[who]! >= 6) {
    s.royalsTaken[who] = 2;
    resolveRoyalSim(s, who);
  }
}

/** 弃置缺省方案: 先最富余宝石(GEMS 序), 再珍珠, 最后黄金 — 与引擎 discardExcess 一致 */
function discardSim(s: Sim, who: number): void {
  const t = s.tokens[who]!;
  let total = 0;
  for (let c = 0; c < 7; c++) total += t[c]!;
  if (total <= 10) return;
  let left = total - 10;
  for (let c = 0; c < 7 && left > 0; c++) {
    const n = Math.min(left, t[c]!);
    if (n > 0) { t[c]! -= n; left -= n; pushBagN(s, c, n); }
  }
}

function canBuySim(s: Sim, seat: number, sc: SimCard): boolean {
  if (sc.isAssociate) {
    const cc = s.colorCnt[seat]!;
    if (cc[0]! + cc[1]! + cc[2]! + cc[3]! + cc[4]! === 0) return false; // 无折扣卡不能买百搭
  }
  const b = s.bonuses[seat]!, t = s.tokens[seat]!;
  let need = 0;
  for (let g = 0; g < 5; g++) {
    const eff = sc.cost[1 + g]! - b[g]!;
    const e = eff > 0 ? eff : 0;
    const gap = e - t[g]!;
    if (gap > 0) need += gap;
  }
  const pGap = sc.cost[0]! - t[PEARL]!;
  if (pGap > 0) need += pGap;
  return need <= t[GOLD]!;
}

/** 标准支付: 各色先付足额真 token, 缺口用黄金补齐(与引擎 paymentFor 一致) */
function paySim(s: Sim, seat: number, sc: SimCard): void {
  const b = s.bonuses[seat]!, t = s.tokens[seat]!;
  let goldNeed = 0;
  for (let g = 0; g < 5; g++) {
    const eff = sc.cost[1 + g]! - b[g]!;
    const e = eff > 0 ? eff : 0;
    const use = Math.min(t[g]!, e);
    if (use > 0) { t[g]! -= use; pushBagN(s, g, use); }
    goldNeed += e - use;
  }
  const pUse = Math.min(t[PEARL]!, sc.cost[0]!);
  if (pUse > 0) { t[PEARL]! -= pUse; pushBagN(s, PEARL, pUse); }
  goldNeed += sc.cost[0]! - pUse;
  if (goldNeed > 0) { t[GOLD]! -= goldNeed; pushBagN(s, GOLD, goldNeed); }
}

/** 百搭默认色: 各色卡数最多, 平分取 GEMS 序最前(与引擎 defaultAssociateColor 一致) */
function defaultColorSim(s: Sim, seat: number): number {
  const c = s.colorCnt[seat]!;
  let best = 0;
  for (let g = 1; g < 5; g++) if (c[g]! > c[best]!) best = g;
  return c[best]! > 0 ? best : -1;
}

function shuffleBag(s: Sim): void {
  // Fisher-Yates, 调用序与引擎 shuffle 完全一致(共享同一条 rng 流)
  for (let i = s.bagLen - 1; i > 0; i--) {
    const j = Math.floor(mulberry32Step(s) * (i + 1));
    const tmp = s.bag[i]!;
    s.bag[i] = s.bag[j]!;
    s.bag[j] = tmp;
  }
}

/** 补货: 洗袋后按螺旋填空格, 对手得 1 特权(与引擎 applyReplenish 一致, current 不变) */
export function replenishSim(s: Sim): void {
  shuffleBag(s);
  for (const cell of SPIRAL) {
    if (s.bagLen === 0) break;
    if (s.board[cell] === EMPTY) s.board[cell] = s.bag[--s.bagLen]!;
  }
  gainPriv(s, 1 - s.current);
}

// ---------------------------------------------------------------- 行动编码与枚举

// 32 位编码:
//   take    kind=0: (c1+1)<<2 | (c2+1)<<7 | (c3+1)<<12   (缺席=0; c1..c3 升序直线相邻)
//   reserve kind=1: (gold+1)<<2 | fromDeck<<7 | idx<<8   (idx: 金字塔 slot 0-11 / 等级 1-3)
//   buy     kind=2: fromReserved<<2 | idx<<3             (idx: slot 0-11 / 预留下标 0-2)

const DR = [0, 1, 1, 1]; // 东/东南/南/西南
const DC = [1, 1, 0, -1];

/** 枚举全部强制行动, 写入 out, 返回数量(与引擎 legalMoves 的行动集合一致, 含盲留 0 费"过牌"买入) */
export function enumActions(s: Sim, out: Int32Array): number {
  let n = 0;
  const b = s.board;
  for (let cell = 0; cell < 25; cell++) {
    const t = b[cell]!;
    if (t === EMPTY || t === GOLD) continue;
    out[n++] = (cell + 1) << 2;
    const r = (cell / 5) | 0, c = cell % 5;
    for (let d = 0; d < 4; d++) {
      let v = (cell + 1) << 2;
      for (let len = 1; len <= 2; len++) {
        const nr = r + DR[d]! * len, nc = c + DC[d]! * len;
        if (nr < 0 || nr > 4 || nc < 0 || nc > 4) break;
        const t2 = b[nr * 5 + nc]!;
        if (t2 === EMPTY || t2 === GOLD) break;
        v += ((nr * 5 + nc) + 1) << (2 + 5 * len);
        out[n++] = v;
      }
    }
  }
  const me = s.current;
  if (s.reserved[me]!.length < 3) {
    for (let cell = 0; cell < 25; cell++) {
      if (b[cell] !== GOLD) continue;
      for (let slot = 0; slot < 12; slot++) {
        if (s.pyramid[slot]) out[n++] = 1 | ((cell + 1) << 2) | (slot << 8);
      }
      for (let lvl = 1; lvl <= 3; lvl++) {
        if (s.decks[lvl - 1]!.length > 0) out[n++] = 1 | ((cell + 1) << 2) | (1 << 7) | (lvl << 8);
      }
    }
  }
  for (let slot = 0; slot < 12; slot++) {
    const card = s.pyramid[slot];
    if (card && canBuySim(s, me, simCard(card))) out[n++] = 2 | (slot << 3);
  }
  const rs = s.reserved[me]!;
  for (let i = 0; i < rs.length; i++) {
    if (canBuySim(s, me, simCard(rs[i]!))) out[n++] = 2 | (1 << 2) | (i << 3);
  }
  return n;
}

/** 应用一个编码行动(假定由 enumActions 产生, 即引擎意义下合法); 终局置 s.winner */
export function makeSim(s: Sim, v: number): void {
  const who = s.current;
  const kind = v & 3;
  if (kind === 0) {
    const c1 = ((v >> 2) & 31) - 1, c2 = ((v >> 7) & 31) - 1, c3 = ((v >> 12) & 31) - 1;
    const t = s.tokens[who]!, b = s.board;
    const t1 = b[c1]!; b[c1] = EMPTY; t[t1]!++;
    let nP = t1 === PEARL ? 1 : 0;
    let same = true;
    if (c2 >= 0) {
      const t2 = b[c2]!; b[c2] = EMPTY; t[t2]!++;
      if (t2 === PEARL) nP++;
      if (t2 !== t1) same = false;
      if (c3 >= 0) {
        const t3 = b[c3]!; b[c3] = EMPTY; t[t3]!++;
        if (t3 === PEARL) nP++;
        if (t3 !== t1) same = false;
      }
    }
    // 3 同色 或 ≥2 珍珠 -> 对手得 1 特权(2 格拿 2 珍珠同样触发, 与引擎一致)
    if ((c3 >= 0 && same) || nP >= 2) gainPriv(s, 1 - who);
  } else if (kind === 1) {
    const gold = ((v >> 2) & 31) - 1;
    const fromDeck = (v >> 7) & 1;
    const idx = (v >> 8) & 15;
    s.board[gold] = EMPTY;
    s.tokens[who]![GOLD]!++;
    let card: CardDef;
    if (fromDeck) card = s.decks[idx - 1]!.pop()!;
    else {
      card = s.pyramid[idx]!;
      s.pyramid[idx] = s.decks[SLOT_LEVEL(idx) - 1]!.pop() ?? null;
    }
    s.reserved[who]!.push(card);
  } else {
    const fromRes = (v >> 2) & 1;
    const idx = (v >> 3) & 15;
    const card = fromRes ? s.reserved[who]![idx]! : s.pyramid[idx]!;
    const sc = simCard(card);
    paySim(s, who, sc);
    if (fromRes) s.reserved[who]!.splice(idx, 1);
    else s.pyramid[idx] = s.decks[SLOT_LEVEL(idx) - 1]!.pop() ?? null;
    let color = sc.color;
    if (sc.isAssociate) color = defaultColorSim(s, who);
    if (color >= 0) {
      s.bonuses[who]![color]! += sc.bonus;
      s.colorPts[who]![color]! += sc.points;
      s.colorCnt[who]![color]!++;
    }
    s.points[who]! += sc.points;
    s.crowns[who]! += sc.crowns;
    if (sc.ability === 1) s.extraTurns++;
    else if (sc.ability === 4) gainPriv(s, who);
    else if (sc.ability === 3) stealSim(s, who);
    else if (sc.ability === 2) takeSameSim(s, who, color);
    milestonesSim(s, who);
  }
  discardSim(s, who);
  const cp = s.colorPts[who]!;
  if (
    s.points[who]! >= 20 || s.crowns[who]! >= 10 ||
    Math.max(cp[0]!, cp[1]!, cp[2]!, cp[3]!, cp[4]!) >= 10
  ) {
    s.winner = who;
    return;
  }
  if (s.extraTurns > 0) s.extraTurns--;
  else s.current = (1 - who) as 0 | 1;
  s.turnCount++;
}

/** mustReplenish 处理(与 arena 主循环一致): 无行动则补货直到有行动或死局(袋空)。返回行动数 */
export function settleSim(s: Sim, out: Int32Array): number {
  for (;;) {
    const n = enumActions(s, out);
    if (n > 0) return n;
    if (s.bagLen === 0) return 0; // 双方均无法行动: 和棋
    replenishSim(s);
  }
}

export function decodeAction(v: number): MandatoryAction {
  const kind = v & 3;
  if (kind === 0) {
    const cells = [((v >> 2) & 31) - 1];
    const c2 = ((v >> 7) & 31) - 1;
    if (c2 >= 0) cells.push(c2);
    const c3 = ((v >> 12) & 31) - 1;
    if (c3 >= 0) cells.push(c3);
    return { kind: 'take', cells };
  }
  if (kind === 1) {
    const goldCell = ((v >> 2) & 31) - 1;
    const fromDeck = (v >> 7) & 1;
    const idx = (v >> 8) & 15;
    return {
      kind: 'reserve',
      goldCell,
      from: fromDeck ? { kind: 'deck', level: idx as 1 | 2 | 3 } : { kind: 'pyramid', slot: idx },
    };
  }
  const fromRes = (v >> 2) & 1;
  const idx = (v >> 3) & 15;
  return { kind: 'buy', from: fromRes ? { kind: 'reserved', index: idx } : { kind: 'pyramid', slot: idx } };
}

export function encodeAction(a: MandatoryAction): number {
  if (a.kind === 'take') {
    const [c1, c2, c3] = a.cells;
    return ((c1! + 1) << 2) | ((c2 != null ? c2 + 1 : 0) << 7) | ((c3 != null ? c3 + 1 : 0) << 12);
  }
  if (a.kind === 'reserve') {
    const fromDeck = a.from.kind === 'deck' ? 1 : 0;
    const idx = a.from.kind === 'deck' ? a.from.level : a.from.slot;
    return 1 | ((a.goldCell + 1) << 2) | (fromDeck << 7) | (idx << 8);
  }
  const fromRes = a.from.kind === 'reserved' ? 1 : 0;
  const idx = a.from.kind === 'reserved' ? a.from.index : a.from.slot;
  return 2 | (fromRes << 2) | (idx << 3);
}

// ---------------------------------------------------------------- 静态启发分(先验/rollout)

/** 不 applyMove 的静态分(排序/rollout 用, 与 ab.ts staticScore 同源):
 *  买入 = 分/冠/折扣/能力 − 预估占用资金; 立即取胜巨额; 拿取 = token 价值(珍珠 8, 宝石 1.5); 预留 = 0 */
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
    ) return 10000; // 买了即赢
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

// ---------------------------------------------------------------- MCTS

interface MChild {
  v: number; // 编码行动
  node: MNode | null;
  N: number;
  W: number; // root 视角累计回报
  prior: number;
}

interface MNode {
  sim: Sim;
  n: number;
  children: MChild[] | null;
  terminal: number; // -1 非终局; 否则 root 视角 z (1/0.5/0)
}

const SCRATCH_A = new Int32Array(512); // enumActions 暂存(单线程内顺序复用)
const SCRATCH_B = new Int32Array(512);

function expandNode(node: MNode): void {
  const n = enumActions(node.sim, SCRATCH_A);
  const ch: MChild[] = [];
  for (let i = 0; i < n; i++) {
    const v = SCRATCH_A[i]!;
    ch.push({ v, node: null, N: 0, W: 0, prior: staticSim(node.sim, v) });
  }
  ch.sort((a, b) => b.prior - a.prior); // 先验降序: 未访问子节点按此序首演
  node.children = ch;
}

function expandChild(node: MNode, ch: MChild, rootSeat: number): MNode {
  const sim = copySim(node.sim);
  makeSim(sim, ch.v);
  const nn: MNode = { sim, n: 0, children: null, terminal: -1 };
  if (sim.winner >= 0) nn.terminal = sim.winner === rootSeat ? 1 : 0;
  else if (settleSim(sim, SCRATCH_B) === 0) nn.terminal = 0.5; // 死局和棋
  ch.node = nn;
  return nn;
}

function selectBest(node: MNode, rootSeat: number, uctC: number): MChild {
  const logN = Math.log(node.n + 1);
  const maxing = node.sim.current === rootSeat; // 额外回合时同方连走, 就地判位
  let best: MChild | null = null;
  let bestS = -Infinity;
  for (const ch of node.children!) {
    const mean = ch.N === 0 ? 0.5 : ch.W / ch.N;
    const u = (maxing ? mean : 1 - mean) + uctC * Math.sqrt(logN / (ch.N + 1));
    if (u > bestS) { bestS = u; best = ch; }
  }
  return best!;
}

/** 贪心 rollout: 全候选静态分 + 随机抖动取 argmax(打破平分产生多样性) */
function rollout(s0: Sim, rootSeat: number, rnd: () => number, jitter: number): number {
  const s = copySim(s0);
  for (let step = 0; step < 400; step++) {
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
    makeSim(s, bestV);
  }
  return 0.5; // 步数上限兜底(400 > 单方可达步数): 和
}

/** 单次模拟: 选择 -> 展开 -> rollout -> 回传 */
function playout(root: MNode, rootSeat: number, rnd: () => number, uctC: number, jitter: number): void {
  const path: MChild[] = [];
  let node = root;
  let z: number;
  for (;;) {
    node.n++;
    if (node.terminal >= 0) { z = node.terminal; break; }
    if (!node.children) expandNode(node);
    let child: MChild | undefined;
    for (const ch of node.children!) {
      if (ch.node === null) { child = ch; break; } // 先验序首演
    }
    if (child === undefined) child = selectBest(node, rootSeat, uctC);
    path.push(child);
    if (child.node === null) {
      const nn = expandChild(node, child, rootSeat);
      z = nn.terminal >= 0 ? nn.terminal : rollout(nn.sim, rootSeat, rnd, jitter);
      break;
    }
    node = child.node;
  }
  for (const ch of path) {
    ch.N++;
    ch.W += z;
  }
}

// ---------------------------------------------------------------- root 1 层修正
// (与 ab.ts 同一套逻辑; ab.ts 未导出, 在此复制并保持一致。全部走引擎 applyMove, 语义即真值)

function trySim(view: GameState, seat: 0 | 1, move: Move, rnd: () => number): number {
  try {
    return evaluate(applyMove(view, move), seat, rnd);
  } catch {
    return -Infinity;
  }
}

/** 条件参数枚举修正: stealPick / takeSameCell / associateColor / royalPick 引擎缺省有默认, root 逐项试最优 */
function refineConditional(view: GameState, seat: 0 | 1, move: Move, rnd: () => number): Move {
  let best = move;
  let bestScore = trySim(view, seat, move, rnd);
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
    // 跨 3/6 冠里程碑会领皇家卡: 逐张试
    const crownsAfter = p.crowns + card.crowns;
    if ((crownsAfter >= 3 && p.royalsTaken === 0) || (crownsAfter >= 6 && p.royalsTaken <= 1)) {
      for (let i = 0; i < view.royals.length; i++) cands.push({ ...move, royalPick: i });
    }
  }
  for (const m of cands) {
    const s = trySim(view, seat, m, rnd);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

/** 特权: 对已选行动逐枚贪心补最优格(特权在 action 前结算, 用行动前的棋盘格) */
function refinePrivileges(ctx: TurnContext, move: Move, rnd: () => number): Move {
  const p = ctx.view.players[ctx.seat]!;
  let cur = move;
  let curScore = trySim(ctx.view, ctx.seat, cur, rnd);
  for (let k = 0; k < p.privileges; k++) {
    let bestCell: number | null = null;
    for (const cell of ctx.legal.privilegeCells) {
      if ((cur.privileges ?? []).includes(cell)) continue;
      const s = trySim(ctx.view, ctx.seat, { ...cur, privileges: [...(cur.privileges ?? []), cell] }, rnd);
      if (s > curScore) { curScore = s; bestCell = cell; }
    }
    if (bestCell == null) break;
    cur = { ...cur, privileges: [...(cur.privileges ?? []), bestCell] };
  }
  return cur;
}

/** 自愿补货只在明显有利时(补货给对手 1 特权 ≈ -6.75 估值, 阈值 5) */
function refineReplenish(view: GameState, seat: 0 | 1, move: Move, rnd: () => number): Move {
  const r = trySim(view, seat, { ...move, replenish: true }, rnd);
  return r > trySim(view, seat, move, rnd) + 5 ? { ...move, replenish: true } : move;
}

// ---------------------------------------------------------------- agent

export interface MctsStats {
  // 与 AbStats 同形(供 compare.ts 汇总), 另附 playouts
  moves: number;
  totalMs: number;
  maxDepth: number; // 未用(保持 0, 汇总兼容)
  timeouts: number; // 未用(保持 0, MCTS 按时间预算自然截止)
  playouts: number;
}

export interface MctsOptions {
  name?: string;
  timeMs?: number; // 每步时间上限(spec 可调 mcts@ms)
  seed?: number;
  uctC?: number; // UCT 探索常数(胜负 0/1 尺度)
  playouts?: number;
  jitter?: number; // rollout 静态分抖动幅度
}

function sameAction(a: MandatoryAction, b: MandatoryAction): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'take' && b.kind === 'take') return a.cells.join(',') === b.cells.join(',');
  if (a.kind === 'reserve' && b.kind === 'reserve') {
    return a.goldCell === b.goldCell && a.from.kind === b.from.kind &&
      (a.from.kind === 'pyramid' ? a.from.slot === (b.from as typeof a.from).slot : a.from.level === (b.from as typeof a.from).level);
  }
  if (a.kind === 'buy' && b.kind === 'buy') {
    return a.from.kind === b.from.kind &&
      (a.from.kind === 'pyramid' ? a.from.slot === (b.from as typeof a.from).slot : a.from.index === (b.from as typeof a.from).index);
  }
  return false;
}

export function mctsAgent(opts: MctsOptions = {}): Agent & { stats: MctsStats } {
  const timeMs = opts.timeMs ?? 4000;
  const uctC = opts.uctC ?? 0.7;
  const jitter = opts.jitter ?? 3;
  const rngState = { rngState: opts.seed ?? 0x51ed270b };
  const rnd = (): number => mulberry32Step(rngState); // 共享随机流: 抖动/估值平分用
  const stats: MctsStats = { moves: 0, totalMs: 0, maxDepth: 0, timeouts: 0, playouts: 0 };

  const agent: Agent & { stats: MctsStats } = {
    name: opts.name ?? `MCTSbot(${Math.round(timeMs / 1000)}s)`,
    stats,
    async chooseMove(ctx: TurnContext) {
      stats.moves++;
      const t0 = Date.now();
      const deadline = t0 + timeMs;
      const me = ctx.seat;

      const root: MNode = { sim: importSim(ctx.view), n: 0, children: null, terminal: -1 };
      expandNode(root);
      const children = root.children!;

      // 根全量展开一次(首演即建节点) + 一步胜线: 买了即赢直接返回
      for (const ch of children) {
        const nn = expandChild(root, ch, me);
        if (nn.terminal === 1) {
          stats.totalMs += Date.now() - t0;
          return { action: decodeAction(ch.v) };
        }
      }

      let action: MandatoryAction;
      if (children.length === 1) {
        action = decodeAction(children[0]!.v); // 唯一行动: 免搜索
      } else {
        let n = 0;
        while (opts.playouts !== undefined ? n < opts.playouts : Date.now() < deadline) {
          playout(root, me, rnd, uctC, jitter);
          n++;
        }
        stats.playouts += n;
        let best = children[0]!;
        for (const ch of children) if (ch.N > best.N) best = ch; // 稳健子: 访问数最多
        action = decodeAction(best.v);
      }

      // 保险丝: 模拟核与引擎分歧时兜底(对拍测试保证不应发生)
      if (!ctx.legal.actions.some((a) => sameAction(a, action))) action = ctx.legal.actions[0]!;

      const move = refineReplenish(
        ctx.view, me,
        refinePrivileges(ctx, refineConditional(ctx.view, me, { action }, rnd), rnd),
      );
      stats.totalMs += Date.now() - t0;
      return move;
    },
  };
  return agent;
}
