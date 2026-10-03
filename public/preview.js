// 行动结算后的手牌 token 预演 (与引擎 applyMove 顺序一致: 先支付/拿取, 再入账能力 token, 最后才判超 10)
const PEARL_COLORS = ['white', 'blue', 'green', 'red', 'black', 'pearl'];

export function previewTokens(me, opp, board, action, card, extras = {}) {
  const t = { ...me.tokens };
  if (action?.kind === 'take') {
    for (const c of action.cells) t[board[c]]++;
  } else if (action?.kind === 'reserve') {
    t.gold++;
  } else if (action?.kind === 'buy' && card) {
    // 支付: 各色先付足额真 token, 缺口用黄金 (与引擎 paymentFor 一致)
    let goldNeed = 0;
    for (const g of PEARL_COLORS) {
      const eff = Math.max(0, (card.cost[g] ?? 0) - (g === 'pearl' ? 0 : me.bonuses[g] ?? 0));
      const use = Math.min(t[g], eff);
      t[g] -= use;
      goldNeed += eff - use;
    }
    t.gold -= goldNeed;
    // 能力入账: 拿同色 +1 / 偷取 +1
    const ac = card.isAssociate ? (extras.associateColor ?? card.color) : card.color;
    if (card.ability === 'takeSame' && ac && board.includes(ac)) t[ac]++;
    if (card.ability === 'steal' && PEARL_COLORS.some((c) => opp.tokens[c] > 0)) {
      let pick = extras.stealPick && opp.tokens[extras.stealPick] > 0 ? extras.stealPick : null;
      if (!pick) pick = opp.tokens.pearl > 0 ? 'pearl' : PEARL_COLORS.slice().sort((a, b) => opp.tokens[b] - opp.tokens[a])[0];
      t[pick]++;
    }
  }
  // ponytail: 皇家里程碑的偷取未模拟; 预估偏差时引擎按默认贪心弃置兜底
  return t;
}

export const excessOf = (t) => Math.max(0, Object.values(t).reduce((s, n) => s + n, 0) - 10);
