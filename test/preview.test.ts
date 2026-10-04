// previewTokens 预演逻辑: 超 10 判定发生在支付之后, 弃置候选含刚拿到的 token
import { describe, expect, test } from 'bun:test';
// @ts-expect-error 浏览器侧公共模块, 无类型声明
import { previewTokens, excessOf } from '../public/preview.js';

const tokens = (o: Record<string, number> = {}) => ({ white: 0, blue: 0, green: 0, red: 0, black: 0, pearl: 0, gold: 0, ...o });
const sum = (t: Record<string, number>) => Object.values(t).reduce((s, n) => s + n, 0);
const me10 = () => ({ tokens: tokens({ white: 3, blue: 3, green: 2, red: 1, black: 1 }), bonuses: { white: 0, blue: 0, green: 0, red: 0, black: 0 } });
const opp = () => ({ tokens: tokens({ pearl: 1, black: 1 }) });
const takeSameCard = { ability: 'takeSame', color: 'white', isAssociate: false, cost: { white: 2, blue: 2, green: 0, red: 0, black: 0, pearl: 0 } };

describe('previewTokens', () => {
  test('bug 场景: 10 token 买拿同色卡 -> 支付后再判, 不需弃置', () => {
    const t = previewTokens(me10(), opp(), ['white', ...Array(24).fill(null)], { kind: 'buy' }, takeSameCard);
    expect(excessOf(t)).toBe(0);
    expect(sum(t)).toBe(7); // 10 - 支付4 + 拿同色1
    expect(t.white).toBe(2); // 3-2+1
  });

  test('特权到 11 个再买, 支付后仍 <= 10', () => {
    const me = me10();
    me.tokens.gold = 1;
    const t = previewTokens(me, opp(), ['white', ...Array(24).fill(null)], { kind: 'buy' }, takeSameCard);
    expect(excessOf(t)).toBe(0); // 11 - 4 + 1 = 8
  });

  test('拿 3 枚超限: 超额 2, 且候选含刚拿到的颜色', () => {
    const me = { ...me10(), tokens: tokens({ white: 2, blue: 2, green: 2, red: 2, black: 1 }) }; // 9 个
    const board = Array<string | null>(25).fill(null);
    board[0] = board[1] = board[2] = 'red';
    const t = previewTokens(me, opp(), board, { kind: 'take', cells: [0, 1, 2] });
    expect(excessOf(t)).toBe(2);
    expect(t.red).toBe(5); // 2 + 刚拿的 3
  });

  test('支付用黄金补缺口: 1 黑 + 1 金, 剩余 2 金', () => {
    const me = me10();
    me.tokens = tokens({ black: 1, gold: 3 }); // 欠 1 黑用黄金
    const card = { ...takeSameCard, ability: null, color: null, cost: { white: 0, blue: 0, green: 0, red: 0, black: 2, pearl: 0 } };
    const t = previewTokens(me, opp(), Array(25).fill(null), { kind: 'buy' }, card);
    expect(t.black).toBe(0);
    expect(t.gold).toBe(2);
    expect(sum(t)).toBe(2);
  });

  test('偷取卡: +1 对手珍珠 (未选色默认珍珠)', () => {
    const card = { ability: 'steal', color: 'blue', isAssociate: false, cost: { white: 0, blue: 1, green: 0, red: 0, black: 0, pearl: 0 } };
    const t = previewTokens(me10(), opp(), Array(25).fill(null), { kind: 'buy' }, card);
    expect(t.pearl).toBe(1);
  });

  test('预留: +1 黄金', () => {
    const t = previewTokens(me10(), opp(), Array(25).fill(null), { kind: 'reserve' }, null);
    expect(excessOf(t)).toBe(1);
  });
});
