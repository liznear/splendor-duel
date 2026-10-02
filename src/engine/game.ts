// Splendor Duel 核心类型
export type Gem = 'black' | 'red' | 'green' | 'blue' | 'white';
export type NonGold = Gem | 'pearl'; // 特权/拿取/偷取的目标
export type TokenColor = Gem | 'pearl' | 'gold';

export const GEMS: readonly Gem[] = ['black', 'red', 'green', 'blue', 'white'] as const;
export const TOKEN_COLORS: readonly TokenColor[] = [...GEMS, 'pearl', 'gold'] as const;

export type Ability = 'turn' | 'takeSame' | 'steal' | 'privilege'; // 卡牌/皇家卡能力

export interface Cost {
  pearl: number;
  black: number;
  red: number;
  green: number;
  blue: number;
  white: number;
}

export interface CardDef {
  id: string;
  level: 1 | 2 | 3;
  color: Gem | null; // 购买后的折扣颜色; POINTS 卡为 null
  isAssociate: boolean; // 百搭卡(1 color): 购买时需指定颜色并叠放在同色卡上
  points: number;
  bonus: number; // 折扣数量 1/2
  ability: Ability | null;
  crowns: number;
  cost: Cost;
  blind?: boolean; // 盲留(牌库顶)标记: 对手不可见; 金字塔明留对所有人可见
}

export interface RoyalDef {
  id: string;
  points: number;
  ability: Ability | null;
}

export interface OwnedCard {
  def: CardDef;
  color: Gem | null; // 百搭卡为指定的颜色
}

export interface PlayerState {
  name: string;
  tokens: Record<TokenColor, number>;
  bonuses: Record<Gem, number>;
  cards: OwnedCard[];
  reserved: CardDef[]; // 对对手隐藏
  royals: RoyalDef[];
  privileges: number;
  crowns: number;
  points: number;
  royalsTaken: number; // 皇冠里程碑已领皇家卡数 (3冠/6冠各一次)
}

export interface GameState {
  board: (TokenColor | null)[]; // 25 格, row-major: cell = row*5+col
  bag: TokenColor[];
  decks: CardDef[][]; // [L1, L2, L3], 从末尾抽牌
  pyramid: (CardDef | null)[]; // 12 格: 0-2=L3, 3-6=L2, 7-11=L1
  royals: RoyalDef[]; // 仍可领取的皇家卡
  players: [PlayerState, PlayerState];
  current: 0 | 1;
  extraTurns: number; // 当前玩家剩余额外回合数
  turnCount: number;
  winner: 0 | 1 | null;
  draw: boolean;
  seed: number;
  rngState: number;
  log: string[];
}

export type BuySource =
  | { kind: 'pyramid'; slot: number } // slot: 0-11
  | { kind: 'reserved'; index: number };

export type ReserveFrom =
  | { kind: 'pyramid'; slot: number }
  | { kind: 'deck'; level: 1 | 2 | 3 };

export type MandatoryAction =
  | { kind: 'take'; cells: number[] } // 1-3 个直线相邻格
  | { kind: 'reserve'; goldCell: number; from: ReserveFrom }
  | { kind: 'buy'; from: BuySource };

export interface Move {
  privileges?: number[]; // 用特权: 每个特权拿 1 个指定非金 token
  replenish?: boolean; // 补充棋盘: 对手获得 1 特权
  replenishFirst?: boolean; // true: 先补货后用特权 (实体规则: 两项可选行动顺序任意)
  action: MandatoryAction;
  // 条件性选择(引擎按需校验, 缺省时用默认值)
  associateColor?: Gem; // 购买百搭卡时指定颜色
  royalPick?: number; // 领皇家卡时选 index (state.royals 下标)
  stealPick?: NonGold; // 偷取对手 token 颜色
  takeSameCell?: number; // "拿同色"能力选择的格
  discard?: Partial<Record<TokenColor, number>>; // 超过 10 个 token 时弃置
}

export interface LegalMoves {
  actions: MandatoryAction[];
  canReplenish: boolean;
  mustReplenish: boolean; // 无任何强制行动可行 -> 必须先补充棋盘
  privilegeCells: number[]; // 可用特权拿取的格(非空且非金)
}

// ---------------------------------------------------------------- 基础工具

export function mulberry32Step(state: { rngState: number }): number {
  // 无需外部依赖的可复现随机数 (mulberry32 单步)
  let t = (state.rngState = (state.rngState + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

// 补充棋盘的螺旋顺序: 从中心出发, 逐环顺时针向外
export const SPIRAL: readonly number[] = (() => {
  const order = [12];
  for (const r of [1, 2]) {
    let row = 2 - r, col = 2 - r; // 从环左上角出发
    order.push(row * 5 + col);
    const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]] as const;
    dirs.forEach(([dr, dc], d) => {
      const steps = d === 3 ? 2 * r - 1 : 2 * r; // 最后一边少走一步避免回到起点
      for (let s = 0; s < steps; s++) {
        row += dr;
        col += dc;
        order.push(row * 5 + col);
      }
    });
  }
  return order;
})();

export const SLOT_LEVEL = (slot: number): 1 | 2 | 3 =>
  slot < 3 ? 3 : slot < 7 ? 2 : 1;

// ---------------------------------------------------------------- 开局

const EMPTY_TOKENS = (): Record<TokenColor, number> => ({
  black: 0, red: 0, green: 0, blue: 0, white: 0, pearl: 0, gold: 0,
});

function newPlayer(name: string): PlayerState {
  return {
    name,
    tokens: EMPTY_TOKENS(),
    bonuses: { black: 0, red: 0, green: 0, blue: 0, white: 0 },
    cards: [],
    reserved: [],
    royals: [],
    privileges: 0,
    crowns: 0,
    points: 0,
    royalsTaken: 0,
  };
}

export interface SetupOptions {
  seed?: number;
  names?: [string, string];
  firstSeat?: 0 | 1; // 指定先手座位; 缺省随机
}

export function createGame(opts: SetupOptions = {}): GameState {
  const seed = opts.seed ?? (Math.random() * 2 ** 31) | 0;
  const st: GameState = {
    board: Array(25).fill(null),
    bag: [],
    decks: [[], [], []],
    pyramid: Array(12).fill(null),
    royals: [],
    players: [newPlayer(opts.names?.[0] ?? 'P1'), newPlayer(opts.names?.[1] ?? 'P2')],
    current: 0,
    extraTurns: 0,
    turnCount: 0,
    winner: null,
    draw: false,
    seed,
    rngState: seed,
    log: [],
  };
  const rng = () => mulberry32Step(st);

  // 25 个 token 入袋, 洗匀后按螺旋放入棋盘
  const bag: TokenColor[] = [];
  for (const g of GEMS) for (let i = 0; i < 4; i++) bag.push(g);
  bag.push('pearl', 'pearl', 'gold', 'gold', 'gold');
  shuffle(bag, rng);
  for (const cell of SPIRAL) st.board[cell] = bag.pop()!;

  // 三级牌库洗牌, 搭建金字塔
  for (let lvl = 1; lvl <= 3; lvl++) {
    const cards = shuffle(
      CARDS.filter((c) => c.level === lvl).map((c) => ({ ...c })),
      rng,
    );
    st.decks[lvl - 1] = cards;
  }
  for (let slot = 0; slot < 12; slot++) {
    st.pyramid[slot] = st.decks[SLOT_LEVEL(slot) - 1]!.pop() ?? null;
  }

  st.royals = ROYALS.map((r) => ({ ...r }));
  // 先手: 可指定 (缺省随机); 后手获得 1 特权
  st.current = opts.firstSeat ?? (rng() < 0.5 ? 1 : 0);
  st.players[1 - st.current]!.privileges = 1;
  return st;
}

// CARDS/ROYALS 从 cards.ts 引入 (cards.ts 仅引回类型, 无运行时循环)
import { CARDS, ROYALS } from './cards.js';

// ---------------------------------------------------------------- 费用与支付

export function effectiveCost(p: PlayerState, card: CardDef): Cost {
  const c = card.cost;
  return {
    pearl: c.pearl,
    black: Math.max(0, c.black - p.bonuses.black),
    red: Math.max(0, c.red - p.bonuses.red),
    green: Math.max(0, c.green - p.bonuses.green),
    blue: Math.max(0, c.blue - p.bonuses.blue),
    white: Math.max(0, c.white - p.bonuses.white),
  };
}

export function canBuy(p: PlayerState, card: CardDef): boolean {
  if (card.isAssociate && !p.cards.some((c) => c.color !== null)) return false;
  const eff = effectiveCost(p, card);
  let need = 0;
  for (const g of GEMS) need += Math.max(0, eff[g] - p.tokens[g]);
  need += Math.max(0, eff.pearl - p.tokens.pearl);
  return need <= p.tokens.gold;
}

/** 标准支付: 各颜色先付足额真 token, 缺口用黄金补齐 (规则下唯一支付方案) */
export function paymentFor(p: PlayerState, card: CardDef): Partial<Record<TokenColor, number>> {
  const eff = effectiveCost(p, card);
  const pay: Partial<Record<TokenColor, number>> = {};
  let goldNeed = 0;
  for (const g of GEMS) {
    const use = Math.min(p.tokens[g], eff[g]);
    if (use > 0) pay[g] = use;
    goldNeed += eff[g] - use;
  }
  const pearlUse = Math.min(p.tokens.pearl, eff.pearl);
  if (pearlUse > 0) pay.pearl = pearlUse;
  goldNeed += eff.pearl - pearlUse;
  if (goldNeed > 0) pay.gold = goldNeed;
  return pay;
}

// ---------------------------------------------------------------- 行动枚举

const DIRS = [[0, 1], [1, 1], [1, 0], [1, -1]] as const; // 东/东南/南/西南

export function takeSegments(board: (TokenColor | null)[]): number[][] {
  const segs: number[][] = [];
  const seen = new Set<string>();
  const push = (cells: number[]) => {
    const key = [...cells].sort((a, b) => a - b).join(',');
    if (!seen.has(key)) {
      seen.add(key);
      segs.push(cells);
    }
  };
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const cell = r * 5 + c;
      if (board[cell] == null || board[cell] === 'gold') continue;
      push([cell]);
      for (const [dr, dc] of DIRS) {
        const line = [cell];
        for (let len = 1; len <= 2; len++) {
          const nr = r + dr * len, nc = c + dc * len;
          if (nr < 0 || nr > 4 || nc < 0 || nc > 4) break;
          const t = board[nr * 5 + nc];
          if (t == null || t === 'gold') break;
          line.push(nr * 5 + nc);
          push([...line]);
        }
      }
    }
  }
  return segs;
}

export function legalMoves(state: GameState): LegalMoves {
  const p = state.players[state.current];
  const actions: MandatoryAction[] = [];
  for (const cells of takeSegments(state.board)) {
    actions.push({ kind: 'take', cells });
  }
  for (let cell = 0; cell < 25; cell++) {
    if (state.board[cell] !== 'gold') continue;
    if (p.reserved.length < 3) {
      for (let slot = 0; slot < 12; slot++) {
        if (state.pyramid[slot]) {
          actions.push({ kind: 'reserve', goldCell: cell, from: { kind: 'pyramid', slot } });
        }
      }
      for (let lvl = 1 as 1 | 2 | 3; lvl <= 3; lvl++) {
        if (state.decks[lvl - 1]!.length > 0) {
          actions.push({ kind: 'reserve', goldCell: cell, from: { kind: 'deck', level: lvl } });
        }
      }
    }
  }
  for (let slot = 0; slot < 12; slot++) {
    const card = state.pyramid[slot];
    if (card && canBuy(p, card)) actions.push({ kind: 'buy', from: { kind: 'pyramid', slot } });
  }
  p.reserved.forEach((card, index) => {
    if (canBuy(p, card)) actions.push({ kind: 'buy', from: { kind: 'reserved', index } });
  });

  const canReplenish = state.bag.length > 0;
  return {
    actions,
    canReplenish,
    mustReplenish: actions.length === 0,
    privilegeCells: state.board
      .map((t, i) => (t != null && t !== 'gold' ? i : -1))
      .filter((i) => i >= 0),
  };
}

// ---------------------------------------------------------------- 校验与应用

export class IllegalMove extends Error {}

function cellName(cell: number): string {
  return `${'ABCDE'[cell % 5]}${Math.floor(cell / 5) + 1}`;
}

const COLOR_ABBR: Record<TokenColor, string> = { white: '白', blue: '蓝', green: '绿', red: '红', black: '黑', pearl: '珠', gold: '金' };

/** token 清单 -> "白×2 红×1" 式摘要 */
function tokenSummary(ts: TokenColor[]): string {
  const m = new Map<TokenColor, number>();
  for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()].map(([c, n]) => `${COLOR_ABBR[c]}×${n}`).join(' ');
}

function takeFromBoard(st: GameState, cell: number, p: PlayerState, why: string): TokenColor {
  const t = st.board[cell];
  if (t == null) throw new IllegalMove(`${why}: ${cellName(cell)} 为空格`);
  st.board[cell] = null;
  p.tokens[t]++;
  return t;
}

function gainPrivilege(st: GameState, who: 0 | 1): void {
  const p = st.players[who]!, o = st.players[1 - who]!;
  if (p.privileges >= 3) return;
  if (p.privileges + o.privileges < 3) {
    p.privileges++;
  } else if (o.privileges > 0) {
    o.privileges--;
    p.privileges++;
  }
}

function steal(st: GameState, thief: 0 | 1, pick: NonGold | undefined): NonGold | null {
  const p = st.players[thief]!, o = st.players[1 - thief]!;
  const avail = ([...GEMS, 'pearl'] as NonGold[]).filter((c) => o.tokens[c] > 0);
  if (avail.length === 0) return null; // 对手没有非金 token, 忽略
  let color: NonGold;
  if (pick && o.tokens[pick] > 0) color = pick;
  else color = o.tokens.pearl > 0 ? 'pearl' : avail.sort((a, b) => o.tokens[b] - o.tokens[a])[0]!;
  o.tokens[color]--;
  p.tokens[color]++;
  return color;
}

function defaultAssociateColor(p: PlayerState): Gem {
  const count: Record<Gem, number> = { black: 0, red: 0, green: 0, blue: 0, white: 0 };
  for (const c of p.cards) if (c.color) count[c.color]++;
  return (Object.entries(count) as [Gem, number][]).sort((a, b) => b[1] - a[1])[0]![0];
}

export function ownedColors(p: PlayerState): Gem[] {
  return [...new Set(p.cards.map((c) => c.color).filter((c): c is Gem => c !== null))];
}

export function maxColorPointsOf(p: PlayerState): number {
  const pts: Partial<Record<Gem, number>> = {};
  for (const c of p.cards) if (c.color) pts[c.color] = (pts[c.color] ?? 0) + c.def.points;
  return Math.max(0, ...Object.values(pts).map((v) => v ?? 0));
}

function resolveAbility(st: GameState, who: 0 | 1, ability: Ability | null, cardColor: Gem | null, move: Move): void {
  const p = st.players[who];
  switch (ability) {
    case 'turn':
      st.extraTurns++;
      st.log.push(`${p.name} 获得额外回合`);
      break;
    case 'privilege':
      gainPrivilege(st, who);
      st.log.push(`${p.name} 获得 1 特权`);
      break;
    case 'steal': {
      const got = steal(st, who, move.stealPick);
      st.log.push(`${p.name} 偷取对手 ${got ? COLOR_ABBR[got] : '(对手无 token)'}`);
      break;
    }
    case 'takeSame': {
      if (!cardColor) break;
      const cells = st.board
        .map((t, i) => (t === cardColor ? i : -1))
        .filter((i) => i >= 0);
      if (cells.length === 0) break; // 场上没有同色 token, 忽略
      const cell =
        move.takeSameCell != null && st.board[move.takeSameCell] === cardColor
          ? move.takeSameCell
          : cells[0]!;
      takeFromBoard(st, cell, p, '拿同色');
      st.log.push(`${p.name} 拿同色 ${COLOR_ABBR[cardColor]}(${cellName(cell)})`);
      break;
    }
  }
}

function resolveRoyal(st: GameState, who: 0 | 1, move: Move): void {
  const p = st.players[who];
  if (st.royals.length === 0) return;
  const idx =
    move.royalPick != null && st.royals[move.royalPick]
      ? move.royalPick
      : // 默认优先: 额外回合 > 特权 > 偷取 > 高分
        st.royals.findIndex((r) => r.ability === 'turn') >= 0
        ? st.royals.findIndex((r) => r.ability === 'turn')
        : st.royals.findIndex((r) => r.ability === 'privilege') >= 0
          ? st.royals.findIndex((r) => r.ability === 'privilege')
          : st.royals.findIndex((r) => r.ability === 'steal') >= 0
            ? st.royals.findIndex((r) => r.ability === 'steal')
            : 0;
  const royal = st.royals.splice(idx, 1)[0]!;
  p.royals.push(royal);
  p.points += royal.points;
  st.log.push(`${p.name} 领取皇家卡 ${royal.id}(+${royal.points}分)`);
  resolveAbility(st, who, royal.ability, null, move);
}

function checkCrownMilestones(st: GameState, who: 0 | 1, move: Move): void {
  const p = st.players[who];
  if (p.royalsTaken === 0 && p.crowns >= 3) {
    p.royalsTaken = 1;
    resolveRoyal(st, who, move);
  }
  if (p.royalsTaken === 1 && p.crowns >= 6) {
    p.royalsTaken = 2;
    resolveRoyal(st, who, move);
  }
}

function discardExcess(st: GameState, who: 0 | 1, move: Move): void {
  const p = st.players[who];
  const total = TOKEN_COLORS.reduce((s, c) => s + p.tokens[c], 0);
  if (total <= 10) return;
  let excess = total - 10;
  const plan: Partial<Record<TokenColor, number>> = { ...move.discard };
  // 校验弃置方案合法: 每色不超持有, 总数正好
  let planned = 0;
  for (const c of TOKEN_COLORS) {
    const n = plan[c] ?? 0;
    if (n < 0 || n > p.tokens[c]) {
      plan[c] = undefined;
      continue;
    }
    planned += n;
  }
  if (planned !== excess) {
    // 默认方案: 先弃最富余的宝石, 再珍珠, 最后黄金
    plan.black = plan.red = plan.green = plan.blue = plan.white = plan.pearl = plan.gold = undefined;
    const order: TokenColor[] = [...GEMS, 'pearl', 'gold'];
    let left = excess;
    for (const c of order) {
      const n = Math.min(left, p.tokens[c]);
      if (n > 0) plan[c] = n;
      left -= n;
    }
  }
  for (const c of TOKEN_COLORS) {
    const n = plan[c] ?? 0;
    if (n > 0) {
      p.tokens[c] -= n;
      st.bag.push(...Array<TokenColor>(n).fill(c));
    }
  }
  st.log.push(`${p.name} 弃置 ${excess} 枚 token`);
}

/** 回合内可选行动 (特权拿 token / 主动补货); 可单独即时执行, applyMove 内部复用 */
export function applyOption(prev: GameState, opts: { privileges?: number[]; replenish?: boolean }): GameState {
  if (prev.winner !== null || prev.draw) throw new IllegalMove('对局已结束');
  const st = structuredClone(prev);
  runOptional(st, opts);
  return st;
}

function runOptional(st: GameState, opts: { privileges?: number[]; replenish?: boolean }): void {
  const who = st.current;
  const p = st.players[who]!, o = st.players[1 - who]!;
  if (opts.privileges?.length) {
    const got: TokenColor[] = [];
    for (const cell of opts.privileges) {
      if (p.privileges <= 0) throw new IllegalMove('没有特权可用');
      const t = st.board[cell];
      if (t == null || t === 'gold') throw new IllegalMove(`特权不能拿 ${cellName(cell)}`);
      got.push(takeFromBoard(st, cell, p, '特权'));
      p.privileges--; // 特权用掍后归还公共池 (池数 = 3 - 双方持有)
    }
    if (got.length) st.log.push(`${p.name} 用特权拿 ${tokenSummary(got)}`);
  }
  if (opts.replenish) {
    if (st.bag.length === 0) throw new IllegalMove('袋中没有 token, 无法补充棋盘');
    shuffle(st.bag, () => mulberry32Step(st));
    for (const cell of SPIRAL) {
      if (st.bag.length === 0) break;
      if (st.board[cell] == null) st.board[cell] = st.bag.pop()!;
    }
    gainPrivilege(st, (1 - who) as 0 | 1);
    st.log.push(`${p.name} 补充了棋盘, ${o.name} 获得 1 特权`);
  }
}

export function applyMove(prev: GameState, move: Move): GameState {
  if (prev.winner !== null || prev.draw) throw new IllegalMove('对局已结束');
  const st = structuredClone(prev);
  const who = prev.current;
  const p = st.players[who]!;
  st.log.push(`—— 第 ${st.turnCount + 1} 回合 ${p.name} ——`);

  // 可选行动: 用特权 / 补货 (顺序由 replenishFirst 决定; 逻辑在 runOptional, applyOption 可单独即时执行)
  if (move.replenishFirst) {
    if (move.replenish) runOptional(st, { replenish: true });
    if (move.privileges?.length) runOptional(st, { privileges: move.privileges });
  } else {
    runOptional(st, { privileges: move.privileges, replenish: move.replenish });
  }

  // 3. 强制行动
  const act = move.action;
  if (act.kind === 'take') {
    const cells = act.cells;
    if (cells.length < 1 || cells.length > 3) throw new IllegalMove('只能拿 1-3 个 token');
    const set = new Set(cells);
    if (set.size !== cells.length) throw new IllegalMove('不能重复同一格');
    // 校验直线相邻且无空格/黄金
    const pts = cells.map((c) => [Math.floor(c / 5), c % 5] as const);
    const [r0, c0] = pts[0]!;
    const aligned = pts.every(([r, c]) => r - r0 === 0 || c - c0 === 0 || Math.abs(r - r0) === Math.abs(c - c0));
    if (!aligned) throw new IllegalMove('token 必须横/竖/斜对齐');
    const dr = Math.sign(pts[0]![0] - (pts[1]?.[0] ?? pts[0]![0]));
    const dc = Math.sign(pts[0]![1] - (pts[1]?.[1] ?? pts[0]![1]));
    for (let i = 0; i < cells.length; i++) {
      const r = r0 - dr * i, c = c0 - dc * i;
      const cell = cells[i]!;
      if (r < 0 || r > 4 || c < 0 || c > 4 || r * 5 + c !== cell) {
        throw new IllegalMove('token 必须连续相邻');
      }
      const t = st.board[cell];
      if (t == null) throw new IllegalMove(`${cellName(cell)} 为空格`);
      if (t === 'gold') throw new IllegalMove('此行动不能拿黄金');
    }
    const taken = cells.map((cell) => takeFromBoard(st, cell, p, '拿取'));
    // 3 个同色 或 其中 2 个珍珠 -> 对手获得 1 特权
    if (taken.length === 3 && taken.every((t) => t === taken[0])) gainPrivilege(st, (1 - who) as 0 | 1);
    else if (taken.filter((t) => t === 'pearl').length >= 2) gainPrivilege(st, (1 - who) as 0 | 1);
    st.log.push(`${p.name} 拿取 ${tokenSummary(taken)}`);
  } else if (act.kind === 'reserve') {
    if (p.reserved.length >= 3) throw new IllegalMove('最多预留 3 张卡');
    const gold = takeFromBoard(st, act.goldCell, p, '预留');
    if (gold !== 'gold') throw new IllegalMove('预留行动必须拿 1 枚黄金');
    let card: CardDef;
    if (act.from.kind === 'pyramid') {
      const c = st.pyramid[act.from.slot];
      if (!c) throw new IllegalMove('金字塔该位置没有卡');
      card = c;
      const lvl = SLOT_LEVEL(act.from.slot);
      st.pyramid[act.from.slot] = st.decks[lvl - 1]!.pop() ?? null;
    } else {
      const deck = st.decks[act.from.level - 1]!;
      if (deck.length === 0) throw new IllegalMove('该等级牌库已空');
      card = deck.pop()!;
      card.blind = true;
    }
    p.reserved.push(card);
    st.log.push(
      `${p.name} 预留 ${card.id} (来源: ${act.from.kind === 'pyramid' ? `金字塔${act.from.slot + 1}号位` : `L${act.from.level} 牌库顶`})`,
    );
  } else {
    // buy
    let card: CardDef;
    if (act.from.kind === 'pyramid') {
      const c = st.pyramid[act.from.slot];
      if (!c) throw new IllegalMove('金字塔该位置没有卡');
      card = c;
    } else {
      const c = p.reserved[act.from.index];
      if (!c) throw new IllegalMove('没有这张预留卡');
      card = c;
    }
    if (!canBuy(p, card)) throw new IllegalMove(`买不起 ${card.id}`);
    let color = card.color;
    if (card.isAssociate) {
      const colors = ownedColors(p);
      if (colors.length === 0) throw new IllegalMove('没有折扣卡, 不能购买百搭卡');
      const pick = move.associateColor;
      if (pick && !colors.includes(pick)) throw new IllegalMove('只能叠放在自己已有的折扣卡颜色上');
      color = pick ?? defaultAssociateColor(p);
    }
    // 标准支付
    const pay = paymentFor(p, card);
    for (const c of TOKEN_COLORS) {
      const n = pay[c] ?? 0;
      p.tokens[c] -= n;
      if (n > 0) st.bag.push(...Array<TokenColor>(n).fill(c));
    }
    if (act.from.kind === 'pyramid') {
      const lvl = SLOT_LEVEL(act.from.slot);
      st.pyramid[act.from.slot] = st.decks[lvl - 1]!.pop() ?? null;
    } else {
      p.reserved.splice(act.from.index, 1);
    }
    const owned: OwnedCard = { def: card, color };
    p.cards.push(owned);
    if (color) p.bonuses[color] += card.bonus;
    p.points += card.points;
    p.crowns += card.crowns;
    st.log.push(
      `${p.name} 购买 ${card.id}${color ? `(${COLOR_ABBR[color]})` : ''} 支付 ${
        Object.entries(pay).filter(([, n]) => n! > 0).map(([c, n]) => `${COLOR_ABBR[c as TokenColor]}×${n}`).join(' ') || '无'
      }`,
    );
    resolveAbility(st, who, card.ability, color, move);
    checkCrownMilestones(st, who, move);
  }

  // 4. token 上限 10
  discardExcess(st, who, move);

  // 5. 胜利判定 (仅当前玩家, 回合结束时)
  if (p.points >= 20 || p.crowns >= 10 || maxColorPointsOf(p) >= 10) {
    st.winner = who;
    const reason = p.points >= 20 ? '20 分' : p.crowns >= 10 ? '10 皇冠' : '同色 10 分';
    st.log.push(`${p.name} 达成胜利条件: ${reason}`);
    return st;
  }

  // 6. 回合推进
  if (st.extraTurns > 0) {
    st.extraTurns--;
  } else {
    st.current = (1 - who) as 0 | 1;
  }
  st.turnCount++;
  return st;
}

/** 若当前玩家完全无法行动(含无法补充棋盘), 判和局 */
export function isDeadState(state: GameState): boolean {
  if (state.winner !== null || state.draw) return false;
  const lm = legalMoves(state);
  return lm.actions.length === 0 && !lm.canReplenish;
}

// ---------------------------------------------------------------- 视图

const HIDDEN_CARD = (level: 1 | 2 | 3): CardDef => ({
  id: 'hidden',
  level,
  color: null,
  isAssociate: false,
  points: 0,
  bonus: 0,
  ability: null,
  crowns: 0,
  cost: { pearl: 0, black: 0, red: 0, green: 0, blue: 0, white: 0 },
});

/** 给 seat 玩家的视图: 只隐藏对手的盲留卡(牌库顶预留), 金字塔明留公开可见 */
export function playerView(state: GameState, seat: 0 | 1): GameState {
  const view = structuredClone(state);
  const opp = view.players[1 - seat]!;
  opp.reserved = opp.reserved.map((c) => (c.blind ? HIDDEN_CARD(c.level) : c));
  return view;
}

/** 独立的补充棋盘行动(当没有任何强制行动可行时由 arena 自动触发) */
export function applyReplenish(prev: GameState): GameState {
  if (prev.winner !== null || prev.draw) throw new IllegalMove('对局已结束');
  if (prev.bag.length === 0) throw new IllegalMove('袋中没有 token');
  const st = structuredClone(prev);
  const rng = () => mulberry32Step(st);
  const who = st.current;
  shuffle(st.bag, rng);
  for (const cell of SPIRAL) {
    if (st.bag.length === 0) break;
    if (st.board[cell] == null) st.board[cell] = st.bag.pop()!;
  }
  gainPrivilege(st, (1 - who) as 0 | 1);
  st.log.push(`${st.players[who]!.name} 被迫补充棋盘, ${st.players[1 - who]!.name} 获得 1 特权`);
  return st;
}
