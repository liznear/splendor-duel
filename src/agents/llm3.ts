// LLM agent v3: 不改 v1 协议/v2 分析, 把"记忆与算术"从模型搬进代码.
// 依据 2026-10-02 gpt-6.1-sol 败局复盘的 6 个败因逐条落地:
//  1. 计划被截无感知(开局连截2次/t64胜卡被买) => 【目标追踪】按卡id持续跟踪, 被买走/被预留当场宣布失效+给替代候选
//  2. 威胁检测只看"下回合能否赢", 无竞速意识(t51后落后无察觉) => 【竞速与阻断】: 双方0/1/2回合可买与胜线, 对手 outs 计数
//  3. 折扣错配(黑5 vs 后期蓝白红高分卡) => 【牌库匹配】: 未见高分卡按色统计 + 折扣溢出预警
//  4. 特权/黄金/额外回合经济差盲区(1:6/0:3/2:4) => 【经济】块 + ⚡规则
//  5. "安全阀/补货时机"等散文规则不落地(全场无安全阀, 被迫补货4次) => 检查项化(【安全阀】【补货建议】)
//  6. 跨回合只有一行自然语言备忘, 历史全是过时快照 => 代码侧【流水账】(每步一行事件)
// ⚡规则 = 触发条件命中时才注入对应战术原文(情境化注入), 不增加常驻 prompt 长度.
import type { Agent } from './agent.js';
import { llmAgent, stripAnsi, type LlmOptions } from './llm.js';
import { digestV2 } from './llm2.js';
import {
  effectiveCost, type Gem, type GameState, GEMS, legalMoves, type LegalMoves,
  maxColorPointsOf, type NonGold, type PlayerState,
} from '../engine/game.js';
import { ABILITY_ZH, actionText, GEM_ZH } from '../render.js';

// ---------------------------------------------------------------- 基础工具(纯函数, 供测试)

/** 买该卡还差几个 token(珍珠+宝石缺口, 黄金可抵; 0=现在就能买). 与 v2 同口径 */
export function shortfall(p: PlayerState, card: CardLike): number {
  const eff = effectiveCost(p, card);
  let need = Math.max(0, eff.pearl - p.tokens.pearl);
  for (const g of GEMS) need += Math.max(0, eff[g] - p.tokens[g]);
  return Math.max(0, need - p.tokens.gold);
}
type CardLike = Parameters<typeof effectiveCost>[1];

const cardShort = (c: CardLike): string => {
  const color = c.isAssociate ? '百搭' : c.color ? GEM_ZH[c.color] : '分';
  const ab = c.ability ? ABILITY_ZH[c.ability] : '';
  return `${color}${c.points ? c.points + '分' : ''}${c.crowns ? c.crowns + '冠' : ''}${c.bonus ? '折' + c.bonus : ''}${ab ? ab : ''}`;
};
const refOf = (where: string, c: CardLike) => `${where}(${c.id} ${cardShort(c)})`;

/** 某颜色列分数(同色胜利用) */
const colorPointsOf = (p: PlayerState, color: Gem): number =>
  p.cards.filter((c) => c.color === color).reduce((s, c) => s + c.def.points, 0);

/** 该玩家买这张卡后是否直接跨胜利线 */
export function crossesWin(p: PlayerState, card: CardLike): string[] {
  const pts = p.points + card.points, cr = p.crowns + card.crowns;
  const cp = card.isAssociate ? maxColorPointsOf(p) + card.points
    : card.color ? colorPointsOf(p, card.color) + card.points : 0;
  const wins: string[] = [];
  if (pts >= 20) wins.push(`总分${pts}`);
  if (cr >= 10) wins.push(`${cr}冠`);
  if (cp >= 10) wins.push('单色10分');
  return wins;
}
/** 买后是否触发皇家里程碑(3/6冠) */
export function triggersRoyal(p: PlayerState, card: CardLike): boolean {
  return (p.royalsTaken === 0 && p.crowns + card.crowns >= 3) || (p.royalsTaken === 1 && p.crowns + card.crowns >= 6);
}

/** 目标价值排序: 分>冠>额外回合, 缺口惩罚 */
const targetScore = (p: PlayerState, c: CardLike): number =>
  c.points * 10 + c.crowns * 14 + (c.ability === 'turn' ? 40 : 0) + (c.ability === 'steal' ? 8 : 0)
  + (c.isAssociate ? 6 : 0) + (c.ability === 'privilege' ? 4 : 0) - shortfall(p, c) * 3;

/** 购买该卡还需要的颜色多重集(拿线/拒绝判断用) */
function needBag(p: PlayerState, card: CardLike): Partial<Record<NonGold, number>> {
  const eff = effectiveCost(p, card);
  const bag: Partial<Record<NonGold, number>> = {};
  const add = (c: NonGold, n: number) => { if (n > 0) bag[c] = (bag[c] ?? 0) + n; };
  add('pearl', Math.max(0, eff.pearl - p.tokens.pearl));
  for (const g of GEMS) add(g, Math.max(0, eff[g] - p.tokens[g]));
  return bag;
}

// ---------------------------------------------------------------- 跨回合状态(代码侧记忆)

interface Snap {
  ply: number;
  pyramid: string[];
  myCards: { id: string; s: string }[];
  oppCards: { id: string; s: string }[];
  myReserved: { id: string; s: string }[];
  oppOpen: { id: string; s: string }[];
  oppBlind: number;
  me: { points: number; crowns: number; priv: number; royals: number };
  opp: { points: number; crowns: number; priv: number; royals: number };
}

const snapOf = (view: GameState, seat: 0 | 1): Snap => {
  const me = view.players[seat]!, opp = view.players[1 - seat]!;
  return {
    ply: view.turnCount,
    pyramid: view.pyramid.map((c) => c?.id ?? '.'),
    myCards: me.cards.map((c) => ({ id: c.def.id, s: cardShort(c.def) })),
    oppCards: opp.cards.map((c) => ({ id: c.def.id, s: cardShort(c.def) })),
    myReserved: me.reserved.map((c) => ({ id: c.id, s: cardShort(c) })),
    oppOpen: opp.reserved.filter((c) => c.id !== 'hidden').map((c) => ({ id: c.id, s: cardShort(c) })),
    oppBlind: opp.reserved.filter((c) => c.id === 'hidden').length,
    me: { points: me.points, crowns: me.crowns, priv: me.privileges, royals: me.royalsTaken },
    opp: { points: opp.points, crowns: opp.crowns, priv: opp.privileges, royals: opp.royalsTaken },
  };
};

/** 两个快照间双方发生的事件(每步一行, 按卡id辨认) */
export function diffEvents(prev: Snap, cur: Snap): string {
  const newCards = <T extends { id: string }>(a: { id: string }[], b: T[]): T[] =>
    b.filter((c) => !a.some((x) => x.id === c.id));
  const mine: string[] = [], theirs: string[] = [];
  const myBuys = newCards(prev.myCards, cur.myCards);
  if (myBuys.length) mine.push(`买[${myBuys.map((c) => c.s).join(',')}]`);
  const opBuys = newCards(prev.oppCards, cur.oppCards);
  if (opBuys.length) theirs.push(`买[${opBuys.map((c) => c.s).join(',')}]`);
  if (cur.myReserved.length > prev.myReserved.length) mine.push(`预留${cur.myReserved.length - prev.myReserved.length}`);
  if (cur.oppOpen.length > prev.oppOpen.length) {
    const r = newCards(prev.oppOpen, cur.oppOpen);
    theirs.push(`明留[${r.map((c) => c.s).join(',')}]`);
  } else if (cur.oppOpen.length < prev.oppOpen.length || cur.oppBlind !== prev.oppBlind) {
    if (cur.oppOpen.length < prev.oppOpen.length) theirs.push('兑现明留');
    if (cur.oppBlind > prev.oppBlind) theirs.push(`盲留+${cur.oppBlind - prev.oppBlind}`);
  }
  if (cur.me.royals > prev.me.royals) mine.push('领皇家');
  if (cur.opp.royals > prev.opp.royals) theirs.push('领皇家');
  if (mine.length === 0) mine.push(cur.me.priv > prev.me.priv ? '拿token/用特权(特权+1)' : '拿token/补货');
  if (theirs.length === 0) theirs.push(cur.opp.priv > prev.opp.priv ? '拿token(特权+1)' : '拿token/补货');
  const d = (a: Snap['me'], b: Snap['me']) =>
    `${b.points - a.points > 0 ? `+${b.points - a.points}分` : ''}${b.crowns - a.crowns > 0 ? `+${b.crowns - a.crowns}冠` : ''}`;
  const myD = d(prev.me, cur.me), opD = d(prev.opp, cur.opp);
  return `t${prev.ply}-${cur.ply} 我:${mine.join('+')}${myD} / 对手:${theirs.join('+')}${opD}`;
}

export interface V3Memory {
  lastPly: number;
  snap: Snap | null;
  ledger: string[];
  targetIds: string[];
  memoForTurn?: string;
}
export const createMemory = (): V3Memory => ({ lastPly: -1, snap: null, ledger: [], targetIds: [] });

// ---------------------------------------------------------------- 分析块(全部为引擎状态推导的客观事实)

interface Ctx {
  me: PlayerState; opp: PlayerState;
  targets: { c: CardLike; where: string; short: number; oppShort: number }[];
  cands: { c: CardLike; where: string; short: number }[];
}

/** 市场近目标: 金字塔按价值排序, 我缺口≤4 的前3 + 后续候选 */
function marketTargets(view: GameState, seat: 0 | 1): { targets: Ctx['targets']; cands: Ctx['cands'] } {
  const me = view.players[seat]!, opp = view.players[1 - seat]!;
  const pool = view.pyramid
    .map((c, i) => (c ? { c, where: `金字塔${i + 1}号` } : null))
    .filter((x): x is { c: CardLike; where: string } => x !== null)
    .map((x) => ({ ...x, short: shortfall(me, x.c) }))
    .filter((x) => x.short <= 4)
    .sort((a, b) => targetScore(me, b.c) - targetScore(me, a.c));
  const top = pool.slice(0, 3).map((x) => ({ ...x, oppShort: shortfall(opp, x.c) }));
  return { targets: top, cands: pool.slice(3, 5) };
}

/** 阶段判定 */
function phaseLine(view: GameState, seat: 0 | 1): string {
  const me = view.players[seat]!, opp = view.players[1 - seat]!;
  const ply = view.turnCount, round = Math.floor(ply / 2) + 1;
  const oppOut = oppOuts(view, seat).length;
  if (oppOut > 0) return `第${ply}手(约${round}回合): 防守/抢跑 — 对手有${oppOut}条现成胜线, 先看【竞速与阻断】`;
  if (me.points >= 15 || opp.points >= 15 || me.crowns >= 7 || opp.crowns >= 7 || maxColorPointsOf(me) >= 7 || maxColorPointsOf(opp) >= 7)
    return `第${ply}手(约${round}回合): 收官 — 第一优先级是最快买分, 0分折扣卡停买`;
  if (ply >= 30 && me.points < 8)
    return `第${ply}手(约${round}回合): 引擎逾期 — 仅${me.points}分, 立即转向买分, 攒料只为2回合内可买的分卡`;
  if (ply < 10) return `第${ply}手(约${round}回合): 开局 — 珍珠/额外回合卡/皇冠卡优先, 前5回合每步都要有明确目的`;
  return `第${ply}手(约${round}回合): 引擎期 — 折扣色跟随【牌库匹配】, 保持安全阀, 双目的行动`;
}

/** 对手 outs: 现在就能买且直接获胜的卡(独立线计数) */
export function oppOuts(view: GameState, seat: 0 | 1): { where: string; c: CardLike; wins: string[] }[] {
  const opp = view.players[1 - seat]!;
  const pool: { where: string; c: CardLike }[] = [
    ...view.pyramid.map((c, i) => (c ? { where: `金字塔${i + 1}号`, c } : null)),
    ...opp.reserved.map((c, i) => (c && c.id !== 'hidden' ? { where: `对手明留${i + 1}`, c } : null)),
  ].filter((x): x is { where: string; c: CardLike } => x !== null);
  return pool
    .filter(({ c }) => shortfall(opp, c) === 0 && crossesWin(opp, c).length > 0)
    .map(({ where, c }) => ({ where, c, wins: crossesWin(opp, c) }));
}

/** 2回合买分估算: 从 0/1/2 回合可买的卡里贪心凑分(缺口预算≈4+特权) */
function twoTurnPoints(p: PlayerState, pool: { c: CardLike; where: string }[], priv: number): { pts: number; names: string } {
  const cands = pool
    .map((x) => ({ ...x, short: shortfall(p, x.c) }))
    .filter((x) => x.short <= 4 && x.c.points > 0)
    .sort((a, b) => b.c.points - a.c.points || a.short - b.short);
  let budget = 4 + priv, pts = 0;
  const names: string[] = [];
  for (const x of cands) {
    if (x.short <= budget) { budget -= x.short; pts += x.c.points; names.push(`${cardShort(x.c)}(${x.where})`); }
    if (names.length >= 2) break;
  }
  return { pts, names: names.join(' + ') || '无' };
}

/** 竞速与阻断块(阶段2 digest 用; 数字为准) */
export function raceBlock(view: GameState, seat: 0 | 1): string[] {
  const me = view.players[seat]!, opp = view.players[1 - seat]!;
  const lines: string[] = [];
  // 我方: 现在就能买且获胜
  const myPool: { where: string; c: CardLike }[] = [
    ...view.pyramid.map((c, i) => (c ? { where: `金字塔${i + 1}号`, c } : null)),
    ...me.reserved.map((c, i) => ({ where: `我预留${i + 1}`, c })),
  ].filter((x): x is { where: string; c: CardLike } => x !== null);
  const myWin = myPool.filter(({ c }) => shortfall(me, c) === 0 && crossesWin(me, c).length > 0);
  if (myWin.length) lines.push(`⚡我本回合即可获胜: ${myWin.map((x) => refOf(x.where, x.c)).join(' ; ')} — 直接买, 别做别的`);
  else {
    const myBuy = myPool.filter(({ c }) => shortfall(me, c) === 0);
    if (myBuy.length) lines.push(`我本回合可买: ${myBuy.slice(0, 3).map((x) => `${refOf(x.where, x.c)}${crossesWin(me, x.c).length ? '⚡买后' + crossesWin(me, x.c).join('+') : ''}${triggersRoyal(me, x.c) ? '(触发皇家)' : ''}`).join(' ; ')}`);
  }
  // 对手: 现成 outs 与 1-2 回合近 outs
  const outs = oppOuts(view, seat);
  const oppPool: { where: string; c: CardLike }[] = [
    ...view.pyramid.map((c, i) => (c ? { where: `金字塔${i + 1}号`, c } : null)),
    ...opp.reserved.map((c, i) => (c && c.id !== 'hidden' ? { where: `对手明留${i + 1}`, c } : null)),
  ].filter((x): x is { where: string; c: CardLike } => x !== null);
  const near = oppPool
    .map((x) => ({ ...x, short: shortfall(opp, x.c) }))
    .filter((x) => x.short > 0 && x.short <= 2 && crossesWin(opp, x.c).length > 0);
  if (outs.length) {
    lines.push(`对手现成胜线 ${outs.length} 条: ${outs.map((o) => `${refOf(o.where, o.c)}=>${o.wins.join('+')}`).join(' ; ')}`);
    lines.push(outs.length >= 2
      ? `⚡outs≥2 阻断不完(每条独立): 唯一活路是抢跑 — 我${myWin.length ? '有' : '没有'}本回合胜线, 没有就必须先拆最便宜的一条并祈祷`
      : `outs=1: 买走/黄金预留该卡即可拆除; 若我也有胜线且更快, 直接冲线`);
  }
  if (near.length) lines.push(`对手${near.length}条线1-2回合内达成: ${near.slice(0, 3).map((x) => `${refOf(x.where, x.c)}(差${x.short})`).join(' ; ')} — 提前买走/预留/拿走缺口色`);
  const blind = opp.reserved.filter((c) => c.id === 'hidden').length;
  // 2回合分差估算(标明估算)
  const mine = twoTurnPoints(me, myPool, me.privileges);
  const theirs = twoTurnPoints(opp, oppPool, opp.privileges);
  const v = mine.pts > theirs.pts ? '我快' : mine.pts < theirs.pts ? '对手快' : '持平';
  lines.push(`2回合买分估算: 我≈+${mine.pts}分[${mine.names}] vs 对手≈+${theirs.pts}分[${theirs.names}]${blind ? `(另有对手盲留${blind}张未计入)` : ''} => ${v}`);
  return lines;
}

/** 经济块: 特权/黄金/额外回合差 + ⚡ */
export function economyBlock(view: GameState, seat: 0 | 1): string[] {
  const me = view.players[seat]!, opp = view.players[1 - seat]!;
  const turnCards = (p: PlayerState) => p.cards.filter((c) => c.def.ability === 'turn').length;
  const myT = turnCards(me), opT = turnCards(opp);
  const marketTurn = [...view.pyramid, ...view.decks.flat()].filter((c) => c && c.ability === 'turn').length;
  const lines = [`特权 我${me.privileges}/对手${opp.privileges} | 黄金 我${me.tokens.gold}/对手${opp.tokens.gold} | 额外回合卡 我${myT}/对手${opT} | 市场未见额外回合卡剩${marketTurn}张`];
  if (opT - myT >= 2) lines.push(`⚡额外回合卡落后${opT - myT}张(每张=1个整回合): 市场新出现的额外回合卡优先预留/购买`);
  if (opp.privileges - me.privileges >= 2) lines.push(`⚡特权落后${opp.privileges - me.privileges}枚(每枚=1个免费token): 少送特权, 多用3同色/2珍珠迫使对手权衡`);
  return lines;
}

/** 牌库匹配: 未见高分卡按色 + 折扣溢出预警 */
export function deckMatchBlock(view: GameState, seat: 0 | 1): string[] {
  const me = view.players[seat]!;
  const unseen = [...view.decks.flat(), ...view.pyramid].filter((c): c is CardLike => c !== null);
  const ptsByColor: Record<string, number> = {};
  for (const c of unseen) if (c.color) ptsByColor[c.color] = (ptsByColor[c.color] ?? 0) + c.points;
  const assoc = unseen.filter((c) => c.isAssociate).length;
  const rank = (Object.entries(ptsByColor) as [Gem, number][]).sort((a, b) => b[1] - a[1]);
  const lines = [`未见高分卡(牌库+市场): ${rank.map(([g, n]) => `${GEM_ZH[g]}${n}分`).join(' ')} | 百搭${assoc}张 | 折扣色建议: ${rank.slice(0, 2).map(([g]) => GEM_ZH[g]).join('/')}`];
  for (const [g, n] of Object.entries(ptsByColor) as [Gem, number][]) {
    if (me.bonuses[g] >= 3 && n <= 4)
      lines.push(`⚡折扣溢出: ${GEM_ZH[g]}折扣已${me.bonuses[g]}, 但市场+未见牌该色仅剩${n}分可买 — 停止叠${GEM_ZH[g]}, 转投${rank[0] ? GEM_ZH[rank[0][0]] : '高分色'}`);
  }
  return lines;
}

/** 安全阀: 是否有 1-2 回合内买得起的便宜卡 */
export function valveLine(view: GameState, seat: 0 | 1): string {
  const me = view.players[seat]!;
  const pool = view.pyramid.filter((c): c is CardLike => c !== null);
  const near = pool.map((c) => ({ c, short: shortfall(me, c) })).filter((x) => x.short <= 2)
    .sort((a, b) => a.short - b.short)[0];
  return near
    ? `安全阀✓: ${refOf('', near.c).slice(1)} 差${near.short}token, 对手不敢让你白白补货吃特权`
    : '⚡无安全阀: 市场没有任何1-2回合内买得起的卡 — 对手可从容攒料, 你会被迫补货送特权; 优先买张便宜的或预留';
}

/** 补货/预留建议(阶段1) */
export function optionalAdvice(view: GameState, seat: 0 | 1): string {
  const me = view.players[seat]!, opp = view.players[1 - seat]!;
  const lm = legalMoves(view);
  const { targets, cands } = marketTargets(view, seat);
  const oppNear = view.pyramid
    .map((c, i) => (c ? { c, where: `金字塔${i + 1}号` } : null)).filter((x): x is { c: CardLike; where: string } => x !== null)
    .map((x) => ({ ...x, short: shortfall(opp, x.c) })).filter((x) => x.short <= 2 && (x.c.points > 0 || x.c.crowns > 0 || x.c.ability === 'turn'))
    .slice(0, 3);
  // 需要(自己目标) 与 干扰(对手近买) 的颜色多重集
  const bags: Partial<Record<NonGold, number>>[] = [];
  for (const t of targets) bags.push(needBag(me, t.c));
  for (const o of oppNear) bags.push(needBag(opp, o.c));
  const useful = (cells: number[]): number => {
    let cnt = 0;
    const local = bags.map((b) => ({ ...b }));
    for (const cell of cells) {
      const t = view.board[cell];
      if (t == null || t === 'gold') continue;
      for (const b of local) {
        if ((b[t as NonGold] ?? 0) > 0) { b[t as NonGold]!--; cnt++; break; }
      }
    }
    return cnt;
  };
  const hasUseful = lm.actions.some((a) => a.kind === 'take' && useful(a.cells) >= 2);
  const buyable = view.pyramid.some((c) => c && shortfall(me, c) === 0);
  const gold = view.board.filter((t) => t === 'gold').length;
  const contested = targets.some((t) => t.oppShort <= 2);
  const lines: string[] = [];
  if (hasUseful) lines.push('棋盘仍有服务目标/干扰对手的有效线 → 通常不补货(补货=送对手1特权)');
  if (!hasUseful && !buyable && lm.canReplenish) lines.push('⚡棋盘已无有效线且无卡可买 → 建议主动补货(送1特权, 但好过空转); 有黄金则优先预留锁卡');
  if (gold > 0 && me.reserved.length < 3 && contested) lines.push(`⚡你有被截风险的目标且棋盘有黄金×${gold} → 黄金预留=拿万能token+锁卡, 一石二鸟`);
  if (oppNear.length) lines.push(`对手1-2回合内在攒: ${oppNear.map((x) => `${refOf(x.where, x.c)}`).join(' ; ')}`);
  if (targets.length === 0 && cands.length === 0) lines.push('市场无2回合内可达目标: 预留高分卡/等补货, 别裸拿无关色');
  return lines.join('\n');
}

/** 目标追踪 + 失效宣布(跨回合, 写入 memory) */
export function targetBlock(view: GameState, seat: 0 | 1, mem: V3Memory): string[] {
  const me = view.players[seat]!, opp = view.players[1 - seat]!;
  const { targets, cands } = marketTargets(view, seat);
  const pyramidIds = new Set(view.pyramid.map((c) => c?.id));
  const lines: string[] = [];
  // 旧目标失效检测
  for (const id of mem.targetIds) {
    if (pyramidIds.has(id) || me.reserved.some((c) => c.id === id) || me.cards.some((c) => c.def.id === id)) continue;
    const stolen = opp.cards.some((c) => c.def.id === id)
      ? '已被对手买走'
      : opp.reserved.some((c) => c.id === id) ? '已被对手明留锁走' : '已离开市场';
    const alt = cands.length ? `从候选换: ${cands.map((x) => refOf(x.where, x.c)).join(' ; ')}` : '市场暂无近目标, 转预留/补货';
    lines.push(`⚡原目标(id ${id}) ${stolen} — 你的旧备忘已过期, ${alt}`);
  }
  mem.targetIds = targets.map((t) => t.c.id);
  if (targets.length === 0) {
    lines.push('无 1-2 回合内可买的市场目标 — 裸攒token是浪费, 优先黄金预留高分卡或补货');
  } else {
    lines.push(...targets.map((t) =>
      `- ${refOf(t.where, t.c)} 我差${t.short}token${t.short > 0 ? `(≈${Math.ceil(t.short / 2)}回合)` : '(现在就能买!)'}${t.oppShort <= 2 ? ` ⚠对手${t.oppShort === 0 ? '现在就能' : '1-2回合内可'}买走: 现在买/黄金预留/换目标` : ''}`));
  }
  for (const [i, c] of me.reserved.entries()) {
    const s = shortfall(me, c);
    const w = crossesWin(me, c);
    lines.push(`- 我预留${i + 1}(${c.id} ${cardShort(c)}) 差${s}token${s === 0 ? ' 现在就能买!' : ''}${w.length && s <= 2 ? ` ⚠买后${w.join('+')}` : ''}`);
  }
  return lines;
}

/** 跨回合推进: 每个新 turnCount 只做一次(快照diff→流水账); 返回是否刚推进(供 memo 一次性消费) */
function advance(view: GameState, seat: 0 | 1, mem: V3Memory): boolean {
  if (mem.lastPly === view.turnCount) return false;
  const cur = snapOf(view, seat);
  if (mem.snap && cur.ply > mem.snap.ply) {
    mem.ledger.push(diffEvents(mem.snap, cur));
    if (mem.ledger.length > 12) mem.ledger.shift();
  }
  mem.snap = cur;
  mem.lastPly = view.turnCount;
  return true;
}

// ---------------------------------------------------------------- 行动列表 v3: v2 去重/⚠ + 稳定卡id

const reserveKey = (a: Extract<LegalMoves['actions'][number], { kind: 'reserve' }>): string =>
  a.from.kind === 'pyramid' ? `p${a.from.slot}` : `d${a.from.level}`;

function giftsPrivilege(board: GameState['board'], cells: number[]): boolean {
  const toks = cells.map((c) => board[c]!);
  return (toks.length === 3 && toks.every((t) => t === toks[0])) || toks.filter((t) => t === 'pearl').length >= 2;
}

export function actionListV3(sim: GameState, seat: 0 | 1, lm: LegalMoves): string {
  const me = sim.players[seat]!;
  const lines: string[] = [];
  const seen = new Set<string>();
  lm.actions.forEach((a, i) => {
    const s = stripAnsi(actionText(sim, seat, a));
    if (a.kind === 'take') {
      lines.push(`${i + 1}. ${s}${giftsPrivilege(sim.board, a.cells) ? '  ⚠送对手1特权' : ''}`);
    } else if (a.kind === 'reserve') {
      const key = reserveKey(a);
      if (seen.has(key)) return;
      seen.add(key);
      const c = a.from.kind === 'pyramid' ? sim.pyramid[a.from.slot] : null;
      lines.push(`${i + 1}. ${s}${c ? ` [id ${c.id}]` : ''}`);
    } else {
      const c = a.from.kind === 'pyramid' ? sim.pyramid[a.from.slot]! : me.reserved[a.from.index]!;
      lines.push(`${i + 1}. ${s} [id ${c.id}]`);
    }
  });
  if (seen.size > 0) lines.push('(预留已按卡去重: 黄金格等价, 用所列编号; [id] 是卡牌稳定编号, 与分析块一致)');
  return lines.join('\n');
}

/** 上回合备忘: make_move 的 memo 参数原文 + 提及卡的存活核对 + 防守承诺未兑现⚡ */
export function memoBlock(view: GameState, seat: 0 | 1, memo: string | undefined): string[] {
  if (!memo) return ['(上回合未留备忘 — 请在本回合 make_move 附带 memo 参数: 一句话计划+对手威胁)'];
  const me = view.players[seat]!, opp = view.players[1 - seat]!;
  const lines = [`原文: ${memo}`];
  const ids = [...new Set(memo.match(/\d+-\d+/g) ?? [])].slice(0, 4);
  const inPyramid = (id: string) => view.pyramid.some((c) => c?.id === id);
  const mine = (id: string) => me.cards.some((c) => c.def.id === id) || me.reserved.some((c) => c.id === id);
  for (const id of ids) {
    const slot = view.pyramid.findIndex((c) => c?.id === id);
    const st = slot >= 0 ? `仍在金字塔${slot + 1}号`
      : mine(id) ? '已被我买入/预留 ✓计划兑现'
      : opp.cards.some((c) => c.def.id === id) ? '⚠已被对手买走'
      : opp.reserved.some((c) => c.id === id) ? '⚠已被对手预留'
      : '已离开市场';
    lines.push(`- 卡 ${id}: ${st}`);
  }
  const defensive = /锁|预留|阻断|防/.test(memo);
  const threatAlive = ids.some((id) => inPyramid(id) && !mine(id));
  const secured = ids.some((id) => mine(id));
  if (defensive && threatAlive && !secured)
    lines.push('⚡你上回合承诺了锁定/阻断但尚未兑现, 威胁卡仍在市场: 本回合必须处置(买走/黄金预留/拿其缺口色)或说明放弃理由');
  return lines;
}

// ---------------------------------------------------------------- v3 工厂

export interface V3 {
  contextExtra: (view: GameState, seat: 0 | 1) => string;
  digest: (sim: GameState, seat: 0 | 1, lm: LegalMoves) => string;
  memory: V3Memory;
}

/** 纯分析部分(测试用): 两个钩子共享同一份跨回合记忆; memoBox 接 make_move 的 memo 参数 */
export function createV3(memoBox?: { current?: string }): V3 {
  const memory = createMemory();
  const safe = (fn: () => string): string => {
    try { return fn(); } catch (e) { console.warn(`[llm3] 分析块生成失败: ${(e as Error).message}`); return ''; }
    };
  const memoNow = (didAdvance: boolean): string | undefined => {
    if (didAdvance) { // 新回合第一次钩子: 消费上回合 memo(一次性, 领外回合覆盖前一次)
      memory.memoForTurn = memoBox?.current;
      if (memoBox) memoBox.current = undefined;
    }
    return memory.memoForTurn;
  };
  return {
    memory,
    contextExtra: (view, seat) => safe(() => {
      const memo = memoNow(advance(view, seat, memory));
      const blocks = [
        `【上回合备忘】\n${memoBlock(view, seat, memo).join('\n')}`,
        `【流水账】(近${Math.min(memory.ledger.length, 8)}步)\n${memory.ledger.slice(-8).join('\n') || '(开局)'}`,
        `【目标追踪】\n${targetBlock(view, seat, memory).join('\n')}`,
        `【经济】\n${economyBlock(view, seat).join('\n')}`,
        `【牌库匹配】\n${deckMatchBlock(view, seat).join('\n')}`,
        `【安全阀】${valveLine(view, seat)}`,
        `【补货/预留建议】\n${optionalAdvice(view, seat)}`,
        `【阶段判定】${phaseLine(view, seat)}`,
      ];
      return `\n${blocks.join('\n\n')}`;
    }),
    digest: (sim, seat, _lm) => safe(() => {
      const memo = memoNow(advance(sim, seat, memory));
      return [`【上回合备忘】${memo ? memoBlock(sim, seat, memo).join(' ; ') : '(无)'}`, '', '【竞速与阻断】', ...raceBlock(sim, seat), '', digestV2(sim, seat, _lm)].join('\n');
    }),
  };
}

// ---------------------------------------------------------------- 系统提示词 v3

const SYSTEM_PROMPT_V3 = `你是 Splendor Duel(璀璨宝石对决)棋手, 目标是赢下双人对抗.
思考与回复一律用中文.

== 身份指代(重要) ==
局面报告里【我方】永远指你自己(当前行动方); 【对手】指与你对弈的另一个人.
其中的玩家名字只是界面标签(可能是 LLM/你/任意字符串), 与"你"的指代无关, 不要被名字干扰.

== 规则摘要 ==
- 棋盘 5x5 随机放 25 个 token: 白/蓝/绿/红/黑各4, 珍珠2, 黄金3. 花掉的 token 进袋, 补货时洗匀回填.
- 每回合分两步:
  [可选] 用特权(每枚从棋盘拿任意非金token) 和/或 补货(对手得1特权), 顺序任选;
  [必须] 三选一: 1) 拿1-3个横/竖/斜连续相邻的非金token(黄金和空格会阻断; 3个同色或含2珍珠 => 对手得1特权, 列表中已标 ⚠)
    2) 预留: 从棋盘拿1枚黄金入手 + 预留1张卡(金字塔任意张明留或牌库顶盲留, 最多3张). 注意: 黄金是【拿入手】的万能token(之后买卡时当任意色支付), 预留不花费任何东西; 前提是棋盘上还有黄金格.
    3) 购买1张卡(金字塔或自己预留的).
- 买卡: 支付费用-已有折扣, 黄金可当任意色, 珍珠无折扣抵扣. 卡能力(额外回合/拿同色/偷取/特权/百搭)当场结算.
- 百搭卡(无固定色)购买时指定叠放到自己已有的颜色列, 其分数计入该色(同色胜利用).
- 皇冠达到 3/6 时立刻从剩余皇家卡中领1张(免费分+能力). 回合结束时 token 总数(珍珠与黄金都计入)超过 10 要弃到 10.
- 胜利(回合结束判定): 20分 或 10皇冠 或 同一颜色卡累计10分. 起始随机先手, 后手得1特权; 特权池空时从对手处夺取.

== 交互协议(每回合分阶段; 工具全程可用, 越阶段调用会被工具内校验拦下并给出提示) ==
- 阶段1(仅当有特权可用或可补货): use_privilege / use_replenish / skip_optional.
  use_privilege 给出格子坐标数组(一次1-3格, 可多次调用直到特权用完); 都不划算就 skip_optional.
  补货后仍可用特权(按先补货后特权执行), 但特权与补货不能交错多次.
  可选阶段结束(含调用 skip_optional 之后)请停止调用工具结束本轮, 等待下一条消息.
- 阶段2: 工具 make_move, 从【本条消息】的编号行动列表中选 i(必填), 需要时带条件参数(可选 memo: 一句话计划备忘, 下回合注入供核对).
  编号列表每回合重新生成, 严禁复用旧消息里的编号.
- 参数校验是严格的: 百搭卡颜色/皇家卡选择/偷取颜色/拿同色格/超10弃置, 只要被触发就必须显式给出且合法,
  缺失或非法会返回具体错误提示(含可选值清单), 按提示修正后重新调用即可, 不会静默采用默认值.
- 不要输出 JSON 文本, 只用工具.

== 代码侧分析块(每回合注入, 全部由引擎状态推导, 是客观事实; 与你的记忆冲突时以分析块为准) ==
【上回合备忘】你上回合的 memo 原文+提及卡的存活状态(承诺未兑现会标⚡) | 【流水账】双方近几步事件(按卡id辨认买/留) | 【目标追踪】你的近目标+缺口+存活状态(被截会显式宣布+给替代候选)
【竞速与阻断】双方0/1/2回合可买与胜线、对手outs计数 | 【经济】特权/黄金/额外回合差
【牌库匹配】未见高分卡按色分布+折扣溢出预警 | 【安全阀】 | 【补货/预留建议】 | 【阶段判定】
⚡开头的行是触发条件命中的战术铁律: 每条要么执行, 要么用一句话说明为何不适用; 不允许无视.

== 每回合思考流程(先读分析块, 再逐项一行短句; 每项必须引用分析块的数字/结论, 禁止复述局面) ==
0. 对表: 【上回合备忘】(你上回合 make_move 附带的 memo) + 【目标追踪】 vs 当前局面 — 计划里的卡还活着吗? 已被对手买走就立即换到给出的替代候选; 若备忘承诺了锁定/阻断而未兑现(⚡行), 本回合必须处置或说明放弃理由.
1. 竞速: 引用【竞速与阻断】=> 我领先/持平/落后; 对手outs=? (outs≥2 => 不阻断只抢跑; outs=1 => 阻断与抢跑取更快者; 0 => 推进自己计划).
2. 阶段: 引用【阶段判定】的第一优先级.
3. 经济: 【经济】+【安全阀】; 可选阶段先读【补货/预留建议】再决定 use_privilege/use_replenish/skip.
4. 选择: 双目的最优; 棋盘有黄金且预留未满3 => 认真读【预留评估】, 预留=拿万能金+锁卡二合一.
提交 make_move 时附带 memo 参数(≤80字): 本回合决定 + 下回合计划(带卡id) + 对手最大威胁; 它会在下回合原样注入, 与之冲突的计划必须说明原因.

== 战术攻略(splendortactics.com 全部攻略 + 高分玩家数据提炼, 务必遵守) ==
[基本盘] 全局仅15-20回合, 浪费一回合≈输掉5-7%胜率; 胜率统计: 20分~65% / 同色10分~20% / 10冠~10%; 高手平均皇冠≈5.6, 皇家卡≈1.5 => 顺路凑3-6皇冠拿皇家是基线而非可选. 袋内容公开可算: 各色4+珍珠2+黄金3减去棋盘与双方持有即得.
[黄金经济] 全局仅3枚黄金在棋盘流转, 每枚=1次万能支付+1次锁卡; 对手连番预留会把黄金抽干, 之后所有人都无法预留. 拿金的两条硬理由: (a)你1-2回合内要用万能金补缺色买卡; (b)对手1-2回合内能买走的卡(尤其其明留目标/跨胜利线的卡)值得锁. 两条都不满足才考虑别的.
[思考维度] 每回合先看对手棋盘再看自己的: 对手总分/皇冠/单色最高分三个数字(报告已自动检测并列入【对手威胁】); 三个警戒线: 对手15分 / 7皇冠 / 单色6-7分.
[核心心态] 这是 Duel 不是单人跑分: 被动发育=输. 每颗宝石拿了对手就少一颗, 每张卡买了就退出市场. 攻防同体: 等价选择中拿对手需要的那个是免费防守.
[买卡优先级·数据] 赢家平均买17张: L1×10 + L2×4 + L3×2 + 皇家1.5张; 中局时手里没有6-7张L1 = 引擎投资不足.
- L1: 皇冠卡(3费1冠)>拿同色(2+2)>额外回合(2+2+珍珠)>四色(1×4)>1分卡(3+2). 0分别折扣色正确 > 1分别折扣无用; 买前问"这个折扣让哪张未来的卡变便宜?"答不出就换(答案应来自【牌库匹配】).
- L2(一律总价7): 2分1冠(2+2+2+珍珠)>偷取(4+3)>双折扣(5+2)>特权(4+2+珍珠).
- L3: 3分2冠(5+3+3+珍珠)与4分(6+2+2)是最佳收官; 8费金卡几乎没人买.
- 无折扣金卡全是陷阱: 分数不逃引擎, 除非直接终结.
- 能力强度: 额外回合 >> 偷取(2宝石摆动) > 拿同色 > 特权. 额外回合卡出现在市场就认真考虑预留.
- 皇家卡选择同理: 额外回合 > 偷取 > 3分 > 特权.
[开局] 珍珠开局必抢(珍珠无法被折扣抵免). 后手标准强开局: 特权拿珍珠+预留皇冠卡(得黄金). 首购回合3-5, 最强首购=额外回合卡; 皇冠卡更多是被预留而非首购. 前5回合未买卡不慌, 但每回合必须有明确目的.
[token纪律] 宝石是燃料不是财富, 攒4-5个却无下回合购买计划=浪费; 拿3异色优先, 且尽量让3色同时服务两张卡(主目标+顺路L1). 黄金是过桥不是存款, 1-2回合内花掉. 手里始终留1张随时买得起的便宜卡当"安全阀"【安全阀】块会检查. 拿3同色或2珍珠会送对手特权(列表已标⚠), 慎重. 超10弃置提前规划.
[防守时机] 前5回合几乎不阻断(自建引擎优先); 中局只做双目的阻断; 危局(对手15分/7冠/单色7分)阻断升为一等公民. 三个具体防守: 对手要拿偷取卡=>先花掉珍珠; 对手下一买触发皇家卡=>用黄金预留那张皇冠卡; 对手能先你买走目标卡=>立即转向别再攒那色(【目标追踪】⚠即此情形).
[胜利路线] 10-12回合前保持至少两条胜利路径(分/皇冠/单色)形成压力迫使对手分散防守, 之后全速冲一条; 领先抢节奏结束, 落后用封锁拖慢. 同色胜利多在中局自然形成: 6-7分时盯住该色高分卡和百搭卡(百搭能让颜色胜利从7跳到10).
[v3数字规则] 折扣颜色跟随【牌库匹配】的剩余分分布, 单色折扣>3仅当明确走单色胜利线; 额外回合卡差≥2时市场新出的额外回合卡优先截; 对手outs≥2时放弃阻断全力抢跑; 任何时刻保持安全阀; 第15回合仍<8分立即转买分(【阶段判定】会提示).`;

export function llm3Agent(opts: LlmOptions = {}): Agent {
  const memoBox: { current?: string } = {};
  const v3 = createV3(memoBox);
  return llmAgent({
    ...opts,
    memoBox,
    name: opts.name ?? 'LLM3',
    systemPrompt: opts.systemPrompt ?? SYSTEM_PROMPT_V3,
    contextExtra: (view, seat) => {
      const extra = opts.contextExtra?.(view, seat) ?? '';
      return v3.contextExtra(view, seat) + extra;
    },
    actionList: opts.actionList ?? actionListV3,
    digest: (sim, seat, lm) => v3.digest(sim, seat, lm) + (opts.digest ? '\n' + opts.digest(sim, seat, lm) : ''),
  });
}
