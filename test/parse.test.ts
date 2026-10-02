// moveFromParams 纯映射自检 (不含 LLM 调用)
import { describe, expect, test } from 'bun:test';
import { createGame, legalMoves, type CardDef } from '../src/engine/game.js';
import { completeConditionals, moveFromParams } from '../src/agents/parse.js';

const CARD = (over: Partial<CardDef> = {}): CardDef => ({
  id: 't', level: 1, color: null, isAssociate: false, points: 0, bonus: 1,
  ability: null, crowns: 0, cost: { pearl: 0, black: 0, red: 0, green: 0, blue: 0, white: 0 }, ...over,
});
const buyMove = (slot: number) => ({ action: { kind: 'buy' as const, from: { kind: 'pyramid' as const, slot } } });

describe('moveFromParams', () => {
  const st = createGame({ names: ['甲', '乙'], firstSeat: 0, seed: 42 });
  const lm = legalMoves(st);

  test('编号选中对应强制行动', () => {
    const m = moveFromParams(lm.actions, { i: 1 });
    expect(m.action).toBe(lm.actions[0]!);
    const m2 = moveFromParams(lm.actions, { i: lm.actions.length });
    expect(m2.action).toBe(lm.actions.at(-1)!);
  });

  test('非法编号报中文错误', () => {
    expect(() => moveFromParams(lm.actions, { i: 0 })).toThrow(/编号/);
    expect(() => moveFromParams(lm.actions, { i: lm.actions.length + 1 })).toThrow(/编号/);
    expect(() => moveFromParams(lm.actions, { i: 1.5 })).toThrow(/编号/);
  });

  test('中文条件参数映射到引擎枚举', () => {
    const m = moveFromParams(lm.actions, { i: 1, stealPick: '珍珠', takeSameCell: 'B2', discard: { 白: 2, 金: 1 } });
    expect(m.stealPick).toBe('pearl');
    expect(m.takeSameCell).toBe(6); // B2 = 行1列1 => index 6
    expect(m.discard).toEqual({ white: 2, gold: 1 });
  });

  test('base(可选行动部分)并入 Move', () => {
    const m = moveFromParams(lm.actions, { i: 2 }, { replenish: true, privileges: [7] });
    expect(m.replenish).toBe(true);
    expect(m.privileges).toEqual([7]);
    expect(m.action).toBe(lm.actions[1]!);
  });

  test('无法识别的颜色/坐标/弃置键报中文错误', () => {
    expect(() => moveFromParams(lm.actions, { i: 1, associateColor: '紫' })).toThrow(/associateColor/);
    expect(() => moveFromParams(lm.actions, { i: 1, stealPick: '金' })).toThrow(/stealPick/); // 偷取不能偷金
    expect(() => moveFromParams(lm.actions, { i: 1, takeSameCell: 'Z9' })).toThrow(/takeSameCell/);
    expect(() => moveFromParams(lm.actions, { i: 1, discard: { 紫: 1 } })).toThrow(/discard/);
  });
});

describe('completeConditionals (缺参追问检测)', () => {
  const base = createGame({ names: ['甲', '乙'], firstSeat: 0, seed: 1 });
  const st = structuredClone(base);
  st.pyramid[0] = CARD({ id: 'assoc', isAssociate: true, points: 2 });
  st.pyramid[1] = CARD({ id: 'royal', points: 3, crowns: 2 });
  st.pyramid[2] = CARD({ id: 'stealer', points: 1, ability: 'steal' });
  st.players[0].cards.push(
    { def: CARD({ id: 'w' }), color: 'white' },
    { def: CARD({ id: 'r' }), color: 'red' },
  ); // 两色折扣 => 百搭叠色需问
  st.players[0].crowns = 2; // +2 皇冠跨里程碑
  st.players[1].tokens = { white: 1, red: 0, green: 0, blue: 0, black: 2, pearl: 0, gold: 0 }; // 两色可偷

  test('百搭卡多色叠放需追问', () => {
    const mv = buyMove(0) as any;
    const miss = completeConditionals(st, 0, mv);
    expect(miss.map((m) => m.field)).toContain('associateColor');
    expect(mv.associateColor).toBeUndefined();
  });

  test('单色自动补齐不追问', () => {
    const st1 = structuredClone(st);
    st1.players[0].cards = [{ def: CARD({ id: 'w' }), color: 'white' }];
    const mv = buyMove(0) as any;
    expect(completeConditionals(st1, 0, mv)).toEqual([]);
    expect(mv.associateColor).toBe('white');
  });

  test('跨皇冠里程碑且多张皇家卡需追问', () => {
    const mv = buyMove(1) as any;
    const miss = completeConditionals(st, 0, mv);
    expect(miss.map((m) => m.field)).toContain('royalPick');
  });

  test('偷取多色可偷需追问; 单色自动补', () => {
    const mv = buyMove(2) as any;
    expect(completeConditionals(st, 0, mv).map((m) => m.field)).toContain('stealPick');
    const st2 = structuredClone(st);
    st2.players[1].tokens = { white: 0, red: 0, green: 0, blue: 0, black: 3, pearl: 0, gold: 0 };
    const mv2 = buyMove(2) as any;
    expect(completeConditionals(st2, 0, mv2)).toEqual([]);
    expect(mv2.stealPick).toBe('black');
  });

  test('非购买行动不追问', () => {
    const st3 = createGame({ names: ['甲', '乙'], firstSeat: 0, seed: 3 });
    const lm3 = legalMoves(st3);
    expect(completeConditionals(st3, 0, { action: lm3.actions[0]! })).toEqual([]);
  });
});
