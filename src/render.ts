// 中文终端渲染
import type { GameState, Move, MandatoryAction, TokenColor, Gem, CardDef, LegalMoves, NonGold, Cost } from './engine/game.js';
import { GEMS, paymentFor, SLOT_LEVEL } from './engine/game.js';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  white: '\x1b[97m', blue: '\x1b[94m', green: '\x1b[92m',
  red: '\x1b[91m', black: '\x1b[90m', pearl: '\x1b[95m', gold: '\x1b[93m',
  cyan: '\x1b[96m',
} as const;

export const TOKEN_ZH: Record<TokenColor, string> = {
  white: '白', blue: '蓝', green: '绿', red: '红', black: '黑', pearl: '珠', gold: '金',
};
const TOKEN_COLOR: Record<TokenColor, string> = {
  white: C.white, blue: C.blue, green: C.green, red: C.red,
  black: C.black, pearl: C.pearl, gold: C.gold,
};
export const GEM_ZH: Record<Gem, string> = { white: '白', blue: '蓝', green: '绿', red: '红', black: '黑' };
export const ABILITY_ZH: Record<string, string> = {
  turn: '额外回合', takeSame: '拿同色', steal: '偷取', privilege: '特权',
};

export function cellName(cell: number): string {
  return `${'ABCDE'[cell % 5]}${Math.floor(cell / 5) + 1}`;
}
export function cellIndex(name: string): number | null {
  const m = /^([A-Ea-e])([1-5])$/.exec(name.trim());
  if (!m) return null;
  return (Number(m[2]) - 1) * 5 + 'ABCDE'.indexOf(m[1]!.toUpperCase());
}

export function tokenText(t: TokenColor): string {
  return `${TOKEN_COLOR[t]}${TOKEN_ZH[t]}${C.reset}`;
}

export function costText(cost: Cost): string {
  return (Object.entries(cost) as [TokenColor, number][])
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${TOKEN_COLOR[c]}${TOKEN_ZH[c]}${n}${C.reset}`)
    .join(' ') || '—';
}

export function cardText(card: CardDef, slot?: number): string {
  const colorPart = card.isAssociate
    ? `${C.bold}百搭${C.reset}`
    : card.color
      ? `${TOKEN_COLOR[card.color]}${GEM_ZH[card.color]}卡${C.reset}`
      : `${C.dim}分卡${C.reset}`;
  const parts = [
    slot != null ? `${C.cyan}[${String(slot).padStart(2)}]${C.reset}` : '    ',
    `L${card.level}`,
    colorPart,
    card.points > 0 ? `${C.bold}${card.points}分${C.reset}` : ' 0分',
  ];
  if (card.crowns > 0) parts.push(`${C.gold}♛${card.crowns}${C.reset}`);
  if (card.bonus > 0) parts.push(`${C.dim}折扣${card.bonus}${C.reset}`);
  parts.push(`费用 ${costText(card.cost)}`);
  if (card.ability) parts.push(`${C.green}【${ABILITY_ZH[card.ability] ?? card.ability}】${C.reset}`);
  return parts.join(' ');
}

export function renderBoard(state: GameState): string {
  const lines = [`  ${C.bold}棋盘 (5×5)${C.reset}`, '    A  B  C  D  E'];
  for (let r = 0; r < 5; r++) {
    const cells = [`${C.dim}${r + 1}${C.reset} `];
    for (let c = 0; c < 5; c++) {
      const t = state.board[r * 5 + c];
      cells.push(t == null ? `${C.dim} · ${C.reset}` : ` ${TOKEN_COLOR[t]}${TOKEN_ZH[t]}${C.reset} `);
    }
    lines.push(cells.join(''));
  }
  return lines.join('\n');
}

export function renderPyramid(state: GameState): string {
  const lines = [`${C.bold}金字塔${C.reset} (上方 3 张 L3, 中 4 张 L2, 下 5 张 L1)`];
  for (let slot = 0; slot < 12; slot++) {
    const card = state.pyramid[slot];
    lines.push(card ? cardText(card, slot + 1) : `${C.cyan}[${String(slot + 1).padStart(2)}]${C.reset} (空)`);
  }
  const deckInfo = state.decks
    .map((d, i) => `L${i + 1} 剩${d.length}`)
    .join(' ');
  lines.push(`${C.dim}牌库: ${deckInfo} | 皇家卡: ${
    state.royals.map((r) => `${r.id}(${r.points}分${r.ability ? ABILITY_ZH[r.ability] : '无能力'})`).join(' ') || '无'
  } | 特权池: ${3 - state.players[0].privileges - state.players[1].privileges}${C.reset}`);
  return lines.join('\n');
}

function tokensLine(p: GameState['players'][number]): string {
  const parts = (Object.entries(p.tokens) as [TokenColor, number][])
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${TOKEN_COLOR[c]}${TOKEN_ZH[c]}×${n}${C.reset}`);
  const bonuses = (Object.entries(p.bonuses) as [Gem, number][])
    .filter(([, n]) => n > 0)
    .map(([g, n]) => `${TOKEN_COLOR[g]}${GEM_ZH[g]}折${n}${C.reset}`);
  return [
    parts.length ? `token: ${parts.join(' ')}` : 'token: 无',
    bonuses.length ? `折扣: ${bonuses.join(' ')}` : '',
    p.privileges ? `特权×${p.privileges}` : '',
  ].filter(Boolean).join(' | ');
}

export function renderPlayer(state: GameState, seat: 0 | 1, opts: { showReserved?: boolean } = {}): string {
  const p = state.players[seat]!;
  const mark = state.current === seat ? `${C.green}▶${C.reset}` : ' ';
  const lines = [
    `${mark} ${C.bold}${p.name}${C.reset}  积分${C.bold}${p.points}${C.reset} 皇冠${C.gold}♛${p.crowns}${C.reset} 皇家卡×${p.royals.length}`,
    `   ${tokensLine(p)}`,
  ];
  if (p.cards.length > 0) {
    const byColor = new Map<Gem | null, string[]>();
    for (const c of p.cards) {
      const k = c.color;
      byColor.set(k, [...(byColor.get(k) ?? []), `${c.def.points}${c.def.crowns ? `♛${c.def.crowns}` : ''}${c.def.ability ? `(${ABILITY_ZH[c.def.ability] ?? c.def.ability})` : ''}`]);
    }
    const cardSummary = [...byColor.entries()]
      .map(([g, list]) => `${g ? TOKEN_COLOR[g] + GEM_ZH[g] + C.reset : C.dim + '分' + C.reset}[${list.join(',')}]`)
      .join(' ');
    lines.push(`   已购卡: ${cardSummary}`);
  }
  if (p.reserved.length > 0) {
    if (opts.showReserved) {
      lines.push(`   预留: ${p.reserved.map((c) => cardText(c)).join(' ; ')}`);
    } else {
      lines.push(`   预留: ${p.reserved.length} 张(保密)`);
    }
  }
  return lines.join('\n');
}

export function renderState(state: GameState, seat: 0 | 1): string {
  const other = (1 - seat) as 0 | 1;
  return [
    renderBoard(state),
    '',
    renderPyramid(state),
    '',
    renderPlayer(state, other),
    renderPlayer(state, seat, { showReserved: true }),
    '',
    state.winner !== null
      ? `${C.bold}★ ${state.players[state.winner]!.name} 获胜!${C.reset}`
      : state.draw ? `${C.bold}和局${C.reset}` : `轮到: ${C.bold}${state.players[state.current]!.name}${C.reset}`,
  ].join('\n');
}

/** 强制行动的中文描述(带编号供菜单/LLM 使用) */
export function actionText(view: GameState, seat: 0 | 1, act: MandatoryAction): string {
  const p = view.players[seat]!;
  if (act.kind === 'take') {
    const desc = act.cells.map((c) => `${cellName(c)}${TOKEN_COLOR[view.board[c] as TokenColor]}${TOKEN_ZH[view.board[c] as TokenColor]}${C.reset}`).join(' ');
    return `拿取 ${desc}`;
  }
  if (act.kind === 'reserve') {
    const card = act.from.kind === 'pyramid' ? view.pyramid[act.from.slot] : null;
    const src = act.from.kind === 'pyramid'
      ? `金字塔${act.from.slot + 1}号${card ? `(${cardText(card)})` : ''}`
      : `L${act.from.level}牌库顶(未知卡)`;
    return `黄金+预留 ${src}`;
  }
  const card = act.from.kind === 'pyramid'
    ? view.pyramid[act.from.slot]!
    : p.reserved[act.from.index]!;
  const pay = Object.entries(paymentFor(p, card))
    .filter(([, n]) => n! > 0)
    .map(([c, n]) => `${TOKEN_COLOR[c as TokenColor]}${TOKEN_ZH[c as TokenColor]}${n}${C.reset}`)
    .join(' ');
  return `购买 ${act.from.kind === 'pyramid' ? `金字塔${act.from.slot + 1}号` : `预留${act.from.index + 1}`} ${cardText(card)} 支付${pay || '免单'}`;
}

export function renderActions(view: GameState, seat: 0 | 1, legal: LegalMoves): string {
  const lines: string[] = [];
  if (legal.actions.length === 0) {
    lines.push(`${C.red}没有可行的强制行动${C.reset}${legal.canReplenish ? ', 必须先补充棋盘' : ', 且无法补充 => 和局'}`);
  }
  legal.actions.forEach((act, i) => {
    lines.push(`${C.cyan}${String(i + 1).padStart(3)}.${C.reset} ${actionText(view, seat, act)}`);
  });
  return lines.join('\n');
}

export function logTail(state: GameState, n = 6): string {
  return state.log.slice(-n).map((l) => `${C.dim}${l}${C.reset}`).join('\n');
}

/** 非 LLM agent 也能读懂的紧凑局面串(LLM 调试/日志用) */
export function compactState(view: GameState, seat: 0 | 1): string {
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) {
    rows.push(
      [1, 2, 3, 4, 5].map((rn) => rn - 1 === r).map(Boolean).map(() => r).map((rr) =>
        [0, 1, 2, 3, 4].map((cc) => {
          const t = view.board[rr * 5 + cc];
          return t == null ? '·' : TOKEN_ZH[t];
        }).join(''),
      )[0]!,
    );
  }
  const board = rows.map((row, i) => `${i + 1} ${row}`).join(' / ');
  return board;
}

export { GEMS, NonGold };
