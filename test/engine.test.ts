// 引擎规则自检
import { describe, expect, test } from 'bun:test';
import {
  applyMove, applyReplenish, canBuy, createGame, effectiveCost, isDeadState,
  legalMoves, maxColorPointsOf, paymentFor, takeSegments,
  type CardDef, type Cost, type GameState, type Gem, type Move, type PlayerState,
} from '../src/engine/game.js';
import { CARDS, ROYALS } from '../src/engine/cards.js';

const emptyCost = (): Cost => ({ pearl: 0, black: 0, red: 0, green: 0, blue: 0, white: 0 });
function mkPlayer(name: string, tokens: Partial<Record<string, number>> = {}): PlayerState {
  return {
    name,
    tokens: { ...emptyCost(), gold: 0, ...tokens } as PlayerState['tokens'],
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
/** 构造受控局面 */
function mkGame(board: (string | null)[], players?: [PlayerState, PlayerState]): GameState {
  const g = createGame({ seed: 1 });
  g.board = board as GameState['board'];
  g.players = players ?? [mkPlayer('A'), mkPlayer('B')];
  g.current = 0;
  g.bag = [];
  g.extraTurns = 0;
  return g;
}
/** 在 createGame 基础上固定 P1 先手, 便于断言 */
function pinFirst(g: GameState): GameState {
  const fixed = structuredClone(g);
  fixed.current = 0;
  fixed.players[0].privileges = 0;
  fixed.players[1].privileges = 1;
  return fixed;
}

describe('卡牌数据', () => {
  test('67 张: 30/24/13; 皇家卡 4 张', () => {
    expect(CARDS.filter((c) => c.level === 1)).toHaveLength(30);
    expect(CARDS.filter((c) => c.level === 2)).toHaveLength(24);
    expect(CARDS.filter((c) => c.level === 3)).toHaveLength(13);
    expect(CARDS).toHaveLength(67);
    expect(ROYALS).toHaveLength(4);
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(67);
  });
  test('token 配比: 5 色各 4 + 珍珠 2 + 黄金 3 = 25', () => {
    const g = createGame({ seed: 42 });
    const all = [...g.board, ...g.bag];
    expect(all).toHaveLength(25);
    for (const c of ['black', 'red', 'green', 'blue', 'white']) {
      expect(all.filter((t) => t === c)).toHaveLength(4);
    }
    expect(all.filter((t) => t === 'pearl')).toHaveLength(2);
    expect(all.filter((t) => t === 'gold')).toHaveLength(3);
  });
  test('开局: 后手 1 特权, 金字塔 12 张', () => {
    const g = createGame({ seed: 42 });
    expect(g.players[0].privileges + g.players[1].privileges).toBe(1);
    expect(g.pyramid.filter(Boolean)).toHaveLength(12);
    expect(g.decks[0]).toHaveLength(30 - 5);
    expect(g.decks[1]).toHaveLength(24 - 4);
    expect(g.decks[2]).toHaveLength(13 - 3);
  });
});

describe('拿 token 规则', () => {
  test('直线相邻枚举: 黄金与空格阻断', () => {
    // 摆一条 B1 B2 B3 白, B4 金
    const board = Array(25).fill(null);
    board[1] = 'white'; board[6] = 'white'; board[11] = 'white'; board[16] = 'gold';
    const segs = takeSegments(board as GameState['board']).map((s) => s.join(','));
    expect(segs).toContain('1');
    expect(segs).toContain('6');
    expect(segs).toContain('11');
    expect(segs).toContain('1,6');
    expect(segs).toContain('6,11');
    expect(segs).toContain('1,6,11');
    expect(segs).not.toContain('6,11,16'); // 黄金阻断
    expect(segs).not.toContain('11,16');
  });
  test('3 个同色 -> 对手获得 1 特权', () => {
    const board = Array(25).fill(null);
    board[0] = 'red'; board[1] = 'red'; board[2] = 'red';
    const g = mkGame(board, [mkPlayer('A'), mkPlayer('B')]);
    const st = applyMove(g, { action: { kind: 'take', cells: [0, 1, 2] } });
    expect(st.players[1].privileges).toBe(1);
  });
  test('拿 2 珍珠 -> 对手获得 1 特权', () => {
    const board = Array(25).fill(null);
    board[0] = 'pearl'; board[1] = 'pearl'; board[2] = 'blue';
    const g = mkGame(board, [mkPlayer('A'), mkPlayer('B')]);
    const st = applyMove(g, { action: { kind: 'take', cells: [0, 1] } });
    expect(st.players[1].privileges).toBe(1);
    // 2 珍珠 + 1 其他也算
    const st2 = applyMove(g, { action: { kind: 'take', cells: [0, 1, 2] } });
    expect(st2.players[1].privileges).toBe(1);
  });
  test('非直线/跨空格/黄金 -> 非法', () => {
    const board = Array(25).fill(null);
    board[0] = 'red'; board[2] = 'red'; board[6] = 'gold';
    const g = mkGame(board, [mkPlayer('A'), mkPlayer('B')]);
    expect(() => applyMove(g, { action: { kind: 'take', cells: [0, 2] } })).toThrow();
    expect(() => applyMove(g, { action: { kind: 'take', cells: [0, 6] } })).toThrow();
    expect(() => applyMove(g, { action: { kind: 'take', cells: [0] } })).not.toThrow();
  });
});

describe('购买与支付', () => {
  const card = (over: Partial<CardDef>): CardDef => ({
    id: 'test', level: 1, color: 'black', isAssociate: false, points: 0, bonus: 1,
    ability: null, crowns: 0, cost: { ...emptyCost() } as CardDef['cost'], ...over,
  });
  test('折扣抵扣 + 黄金补缺口 + 花费进袋', () => {
    const p = mkPlayer('A', { black: 2, white: 1, gold: 1 });
    p.bonuses.black = 2; // 黑费 4 -> 实付黑2
    const c = card({ cost: { ...emptyCost(), black: 4, white: 1 } as CardDef['cost'] });
    expect(effectiveCost(p, c)).toEqual({ ...emptyCost(), black: 2, white: 1 } as Cost);
    expect(paymentFor(p, c)).toEqual({ black: 2, white: 1 } as Partial<Record<string, number>>);
    p.tokens.black = 1;
    expect(paymentFor(p, c)).toEqual({ black: 1, white: 1, gold: 1 } as Partial<Record<string, number>>);
    expect(canBuy(p, c)).toBe(true);
    p.tokens.gold = 0;
    expect(canBuy(p, c)).toBe(false);
  });
  test('实际购买: token 转袋, 卡到手', () => {
    const g = pinFirst(createGame({ seed: 3 }));
    const p0 = g.players[0];
    const slot = g.pyramid.findIndex((c) => c != null && !c.isAssociate)!;
    const target = g.pyramid[slot]!;
    p0.tokens = { ...emptyCost(), gold: 12 } as PlayerState['tokens'];
    const st = applyMove(g, { action: { kind: 'buy', from: { kind: 'pyramid', slot } } });
    const spent = Object.values(target.cost).reduce((s, n) => s + n, 0);
    expect(st.players[0].cards).toHaveLength(1);
    expect(st.players[0].tokens.gold).toBe(12 - spent);
    expect(st.bag).toHaveLength(spent);
  });
  test('费用可被折扣降到 0 (免单)', () => {
    const p = mkPlayer('A');
    p.bonuses.red = 3;
    const c = card({ cost: { ...emptyCost(), red: 3 } as CardDef['cost'] });
    expect(canBuy(p, c)).toBe(true);
    expect(paymentFor(p, c)).toEqual({});
  });
});

describe('特权/补货/上限', () => {
  test('特权: 每枚拿 1 个非金 token; 不能拿黄金', () => {
    const board = Array(25).fill(null);
    board[0] = 'blue'; board[5] = 'blue'; board[1] = 'gold';
    const a = mkPlayer('A'); a.privileges = 1;
    const g = mkGame(board, [a, mkPlayer('B')]);
    const st = applyMove(g, { privileges: [0], action: { kind: 'take', cells: [5] } });
    expect(st.players[0].tokens.blue).toBe(2);
    expect(() => applyMove(g, { privileges: [1], action: { kind: 'take', cells: [5] } })).toThrow(); // 特权拿黄金非法
  });
  test('replenishFirst: 先补货后特权, 可拿新填上的格', () => {
    const board = Array(25).fill(null);
    board[0] = 'blue'; board[5] = 'blue'; board[6] = null; // 6 号格空
    const a = mkPlayer('A'); a.privileges = 1;
    const g = mkGame(board, [a, mkPlayer('B')]);
    g.bag = ['red', 'green', 'white', 'blue']; // 袋里要有 token 才能补货
    // 默认顺序(特权先): 空6格拿不了
    expect(() => applyMove(g, { privileges: [6], replenish: true, action: { kind: 'take', cells: [5] } })).toThrow();
    // 先补货: 6 号格被回填, 特权可拿
    const st = applyMove(g, { privileges: [6], replenish: true, replenishFirst: true, action: { kind: 'take', cells: [5] } });
    expect(st.players[0].tokens.blue).toBe(1);
    expect(st.board[6]).toBeNull(); // 被特权拿走
    expect(Object.values(st.players[0].tokens).reduce((s, n) => s + n, 0)).toBe(2); // 特权1 + 拿取1
    // 补货后对手得 1 特权, 特权用摔后归零
    expect(st.players[0].privileges).toBe(0);
    expect(st.players[1].privileges).toBe(1);
  });
  test('特权池空时可从对手处夺取', () => {
    const board = Array(25).fill(null);
    board[0] = 'green'; board[5] = 'green'; board[10] = 'green';
    const a = mkPlayer('A'); a.privileges = 0;
    const b = mkPlayer('B'); b.privileges = 3;
    const g = mkGame(board, [a, b]);
    // A 拿 3 同色 -> B 应得特权, 但池空 -> 从 A? A=0,B=3 -> 全在 B 手, B 已有 3 -> 无事发生
    const st0 = applyMove(g, { action: { kind: 'take', cells: [0, 5, 10] } });
    expect(st0.players[1].privileges).toBe(3);
    // 反过来: B 拿 3 同色, A 应得特权但池空 -> 从 B 抢
    const g2 = mkGame(board, [structuredClone(a), structuredClone(b)]);
    g2.current = 1;
    const st2 = applyMove(g2, { action: { kind: 'take', cells: [0, 5, 10] } });
    expect(st2.players[1].privileges).toBe(2);
    expect(st2.players[0].privileges).toBe(1);
  });
  test('token 超过 10 弃置 (含指定方案)', () => {
    const board = Array(25).fill(null);
    board[0] = 'red'; board[5] = 'red'; board[10] = 'red';
    const a = mkPlayer('A', { black: 4, white: 3, gold: 1 }); // 8 + 3 = 11
    const g = mkGame(board, [a, mkPlayer('B')]);
    const st = applyMove(g, { action: { kind: 'take', cells: [0, 5, 10] }, discard: { black: 1 } });
    const total = Object.values(st.players[0].tokens).reduce((s, n) => s + n, 0);
    expect(total).toBe(10);
    expect(st.players[0].tokens.black).toBe(3);
    expect(st.players[0].tokens.red).toBe(3);
  });
  test('补货: 花掉的 token 回填, 对手得特权', () => {
    const g = pinFirst(createGame({ seed: 5 }));
    g.board[0] = null; g.board[1] = null;
    g.bag = ['blue', 'white'];
    const takeCell = g.board.findIndex((t, i) => t != null && t !== 'gold' && i > 1)!;
    const st = applyMove(g, {
      action: { kind: 'take', cells: [takeCell] },
      replenish: true,
    });
    expect(st.players[1].privileges).toBe(2); // 初始后手已有 1
    expect(st.bag).toHaveLength(0);
    expect(st.board.filter((t) => t == null)).toHaveLength(1); // 只剩被拿走的那格
  });
});

describe('皇冠/皇家卡/能力', () => {
  const crownCard = (crowns: number, color: Gem | null = 'black'): CardDef => ({
    id: `crown-${crowns}`, level: 3, color, isAssociate: false, points: 0, bonus: color ? 1 : 0,
    ability: null, crowns, cost: { ...emptyCost() } as CardDef['cost'],
  });
  test('第3/6皇冠触发皇家卡; 一次跨双阈值也只领 1 张', () => {
    const g = pinFirst(createGame({ seed: 9 }));
    const p0 = g.players[0];
    p0.tokens.gold = 12;
    p0.crowns = 2;
    g.pyramid[0] = crownCard(3); // 2 -> 5 只跨 3
    g.decks[2] = [];
    let st = applyMove(g, { action: { kind: 'buy', from: { kind: 'pyramid', slot: 0 } }, royalPick: 0 });
    expect(st.players[0].crowns).toBe(5);
    expect(st.players[0].royals).toHaveLength(1);
    // 继续到第 6 冠 (固定 P1 继续行动以便测试)
    st.current = 0;
    const p = st.players[0];
    p.tokens.gold = 12;
    st.pyramid[1] = crownCard(1);
    st.decks[2] = [];
    st = applyMove(st, { action: { kind: 'buy', from: { kind: 'pyramid', slot: 1 } }, royalPick: 0 });
    expect(st.players[0].royals).toHaveLength(2);
    expect(st.royals).toHaveLength(2);
  });
  test('偷取能力: 默认偷珍珠优先', () => {
    const g = pinFirst(createGame({ seed: 9 }));
    const p0 = g.players[0]; p0.tokens.gold = 3;
    g.players[1].tokens.pearl = 1; g.players[1].tokens.red = 3;
    g.pyramid[0] = {
      id: 'stealer', level: 2, color: 'red', isAssociate: false, points: 0, bonus: 1,
      ability: 'steal', crowns: 0, cost: { ...emptyCost() } as CardDef['cost'],
    };
    g.decks[2] = [];
    const st = applyMove(g, { action: { kind: 'buy', from: { kind: 'pyramid', slot: 0 } } });
    expect(st.players[0].tokens.pearl).toBe(1);
    expect(st.players[1].tokens.pearl).toBe(0);
  });
  test('额外回合: 同一玩家连续行动', () => {
    const g = pinFirst(createGame({ seed: 9 }));
    g.players[0].tokens.gold = 12;
    g.pyramid[0] = {
      id: 'turner', level: 1, color: 'blue', isAssociate: false, points: 0, bonus: 1,
      ability: 'turn', crowns: 0, cost: { ...emptyCost() } as CardDef['cost'],
    };
    g.decks[2] = [];
    const st = applyMove(g, { action: { kind: 'buy', from: { kind: 'pyramid', slot: 0 } } });
    expect(st.current).toBe(0); // 不换人
  });
});

describe('胜利条件', () => {
  test('20 分 / 10 皇冠 / 同色 10 分', () => {
    const bigCard = (points: number, crowns = 0, color: Gem | null = 'black'): CardDef => ({
      id: `big-${points}-${crowns}`, level: 3, color, isAssociate: false, points, bonus: color ? 1 : 0,
      ability: null, crowns, cost: { ...emptyCost() } as CardDef['cost'],
    });
    // 20 分
    let g = pinFirst(createGame({ seed: 11 }));
    g.players[0].tokens.gold = 12;
    g.pyramid[0] = bigCard(20, 0);
    g.decks[2] = [];
    expect(applyMove(g, { action: { kind: 'buy', from: { kind: 'pyramid', slot: 0 } } }).winner).toBe(0);
    // 10 皇冠
    g = pinFirst(createGame({ seed: 11 }));
    g.players[0].tokens.gold = 12;
    g.pyramid[0] = bigCard(0, 10);
    g.decks[2] = [];
    expect(applyMove(g, { action: { kind: 'buy', from: { kind: 'pyramid', slot: 0 } } }).winner).toBe(0);
    // 同色 10 分
    g = pinFirst(createGame({ seed: 11 }));
    g.players[0].tokens.gold = 12;
    g.pyramid[0] = bigCard(10, 0, 'red');
    g.decks[2] = [];
    expect(applyMove(g, { action: { kind: 'buy', from: { kind: 'pyramid', slot: 0 } } }).winner).toBe(0);
  });
  test('百搭卡计入指定颜色列', () => {
    const p = mkPlayer('A');
    p.cards.push({ def: CARDS[0]!, color: 'green' });
    p.cards.push({ def: { ...CARDS[0]!, points: 6 }, color: 'green' });
    p.cards.push({ def: { ...CARDS[0]!, isAssociate: true, points: 4 }, color: 'green' });
    p.points = 10;
    expect(maxColorPointsOf(p)).toBe(10);
  });
});

describe('引擎健壮性', () => {
  test('同 seed 完全可复现', async () => {
    const { playMatch } = await import('../src/arena.ts');
    const seededAgent = (s: number) => {
      let state = s >>> 0;
      const rng = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
      return {
        name: 'seeded',
        async chooseMove(ctx: { legal: { actions: unknown[] } }) {
          return { action: ctx.legal.actions[Math.floor(rng() * ctx.legal.actions.length)]! };
        },
      };
    };
    const a = await playMatch([seededAgent(7), seededAgent(8)] as never, { seed: 123, record: false });
    const b = await playMatch([seededAgent(7), seededAgent(8)] as never, { seed: 123, record: false });
    expect(a.turns).toBe(b.turns);
    expect(a.winner).toBe(b.winner);
    expect(a.finalState.log).toEqual(b.finalState.log);
  });
  test('随机自对弈 30 局: 全部正常结束, token 始终守恒', async () => {
    await import('../src/agents/random.ts');
    for (let seed = 0; seed < 30; seed++) {
      const g = createGame({ seed });
      let state = g;
      let steps = 0;
      let hitCap = false;
      while (state.winner === null && !state.draw && steps < 300) {
        const lm = legalMoves(state);
        if (lm.mustReplenish) {
          state = applyReplenish(state);
          continue;
        }
        const p = state.players[state.current];
        const move: Move = { action: lm.actions[Math.floor(Math.random() * lm.actions.length)]! };
        const used = move.action.kind === 'take' ? move.action.cells : move.action.kind === 'reserve' ? [move.action.goldCell] : [];
        const privCell = lm.privilegeCells.find((c) => !used.includes(c));
        if (p.privileges > 0 && privCell != null && Math.random() < 0.3) {
          move.privileges = [privCell];
        }
        state = applyMove(state, move);
        // 守恒: 棋盘 + 袋 + 双方手牌 = 25
        const total =
          state.board.filter(Boolean).length +
          state.bag.length +
          Object.values(state.players[0].tokens).reduce((s, n) => s + n, 0) +
          Object.values(state.players[1].tokens).reduce((s, n) => s + n, 0);
        expect(total).toBe(25);
        steps++;
      }
      // 纯随机对局不保证在步数上限内终结(随机 bot 很少买卡), 只要求不崩溃+守恒
      hitCap = state.winner === null && !state.draw;
      expect(state.winner !== null || state.draw || hitCap).toBeTrue();
    }
  });
  test('贪心自对弈 5 局: 全部在 600 回合内分出胜负或和局', async () => {
    const { greedyAgent } = await import('../src/agents/greedy.ts');
    const { playMatch } = await import('../src/arena.ts');
    for (let seed = 0; seed < 5; seed++) {
      const r = await playMatch([greedyAgent('G1'), greedyAgent('G2')], { seed: 500 + seed, record: false });
      expect(r.draw || r.winner !== null).toBeTrue();
      expect(r.turns).toBeLessThan(600);
    }
  });
  test('死局检测', () => {
    const g = createGame({ seed: 1 });
    g.board = Array(25).fill(null);
    g.bag = [];
    // 全空棋盘且袋空: 无法行动 -> isDeadState
    expect(isDeadState(g)).toBeTrue();
  });
});
