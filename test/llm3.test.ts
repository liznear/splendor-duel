// llm3 纯分析函数自检: 跨回合记忆 / 目标追踪 / 竞速与 outs / 行动列表 id (不调 LLM)
import { describe, expect, test } from 'bun:test';
import { applyMove, applyReplenish, createGame, legalMoves, playerView, type GameState } from '../src/engine/game.js';
import {
  actionListV3, createV3, crossesWin, memoBlock, oppOuts, raceBlock, routeBlock, routeThreatBlock, shortfall, targetBlock,
} from '../src/agents/llm3.js';
import { CARDS } from '../src/engine/cards.js';

/** 固定走法推进: 每步选第一个合法行动(确定性) */
function step(st: GameState): GameState {
  const lm = legalMoves(st);
  if (lm.actions.length === 0) return applyReplenish(st);
  return applyMove(st, { action: lm.actions[0]! });
}

describe('llm3 跨回合状态', () => {
  test('流水账按步累积且能辨认买卡', () => {
    let st = createGame({ seed: 42 });
    const v3 = createV3();
    for (let i = 0; i < 10; i++) {
      v3.contextExtra(playerView(st, st.current), st.current); // 当前方视角推进记忆
      st = step(st);
    }
    expect(v3.memory.ledger.length).toBeGreaterThanOrEqual(4);
    expect(v3.memory.ledger.some((l) => l.includes('我:'))).toBe(true);
    const txt = v3.contextExtra(playerView(st, st.current), st.current);
    for (const key of ['【流水账】', '【目标追踪】', '【经济】', '【牌库匹配】', '【安全阀】', '【补货/预留建议】', '【阶段判定】']) {
      expect(txt).toContain(key);
    }
    // 同一回合第二次调用(phase2)不重复推进
    const before = v3.memory.ledger.length;
    v3.contextExtra(playerView(st, st.current), st.current);
    expect(v3.memory.ledger.length).toBe(before);
  });

  test('目标被对手买走时显式宣布失效', () => {
    const st = createGame({ seed: 7 });
    const v3 = createV3();
    const view = playerView(st, 0);
    v3.contextExtra(view, 0); // 初始化
    const victim = view.pyramid.find((c) => c != null)!;
    v3.memory.targetIds = [victim!.id];
    // 模拟对手买走该卡: 卡进对手已购, 金字塔置空
    const st2 = structuredClone(st);
    st2.players[1]!.cards.push({ def: victim!, color: victim!.color });
    const slot = st2.pyramid.findIndex((c) => c?.id === victim!.id);
    st2.pyramid[slot] = null;
    const lines = targetBlock(playerView(st2, 0), 0, v3.memory).join('\n');
    expect(lines).toContain(victim!.id);
    expect(lines).toMatch(/已被对手买走|已离开市场/);
  });
});

describe('llm3 备忘注入', () => {
  test('make_move memo 经 memoBox 注入下回合并核对卡存活', () => {
    const memoBox: { current?: string } = {};
    const v3 = createV3(memoBox);
    let st = createGame({ seed: 11 });
    const victim = playerView(st, 0).pyramid.find((c) => c != null)!;
    v3.contextExtra(playerView(st, 0), 0); // t0 初始化
    memoBox.current = `计划: 下回合预留金字塔里的 ${victim!.id} 阻断对手蓝线`;
    for (let i = 0; i < 2; i++) st = step(st); // 推进两个 ply, turnCount 变化
    const txt = v3.contextExtra(playerView(st, 0), 0);
    expect(txt).toContain('【上回合备忘】');
    expect(txt).toContain(victim!.id);
    expect(memoBox.current).toBeUndefined(); // 一次性消费
    const txt2 = v3.contextExtra(playerView(st, 0), 0); // 同回合 phase2 不重复消费
    expect(txt2).toContain('【上回合备忘】');
  });

  test('防守承诺未兑现且威胁仍在时标⚡', () => {
    const st = createGame({ seed: 7 });
    const view = playerView(st, 0);
    const victim = view.pyramid.find((c) => c != null)!;
    const lines = memoBlock(view, 0, `计划: 预留 ${victim!.id} 阻断对手`).join('\n');
    expect(lines).toContain('⚡');
    expect(lines).toContain(`仍在金字塔`);
  });
});


describe('llm3 路线威胁与中期路线', () => {
  test('对手单色线临门+免费推进卡时触发⚡处置', () => {
    const st = createGame({ seed: 3 });
    const opp = st.players[1]!;
    // 对手蓝列 9 分: 蓝3分 + 蓝4分 + 蓝2分
    for (const id of ['3-7', '3-8', '2-16']) {
      const def = CARDS.find((c) => c.id === id)!;
      opp.cards.push({ def, color: def.color });
    }
    opp.points = 9; opp.bonuses.blue = 3;
    // 金字塔放一张对手免费的蓝1分卡
    const blue1 = CARDS.find((c) => c.color === 'blue' && c.points === 1)!;
    opp.tokens = { black: 4, red: 4, green: 4, blue: 0, white: 4, pearl: 2, gold: 3 };
    st.pyramid[1] = structuredClone(blue1);
    const lines = routeThreatBlock(playerView(st, 0), 0).join('\n');
    expect(lines).toContain('单色线(蓝) 9/10');
    expect(lines).toContain('⚡');
    expect(lines).toContain('对手0成本可买');
  });

  test('中期路线跨回合维持, 关键卡失守才变更', () => {
    const mem = createV3().memory;
    const st = createGame({ seed: 4 });
    const v0 = playerView(st, 0);
    const first = routeBlock(v0, 0, mem).join('\n');
    expect(first).toMatch(/当前锚定: (总分线|皇冠线|单色线)/);
    expect(first).toMatch(/关键卡|暂无/);
    const r1 = mem.route!;
    // 同局面再算: 维持不告警
    const again = routeBlock(playerView(st, 0), 0, mem).join('\n');
    expect(again).not.toContain('⚠路线变更');
    expect(mem.route!.name).toBe(r1.name);
  });
});

describe('llm3 竞速与阻断', () => {
  test('对手能买致胜卡时被计为 outs 并给出裁决', () => {
    const st = createGame({ seed: 99 });
    const card = st.pyramid.filter((c) => c != null).sort((a, b) => b!.points - a!.points)[0]!;
    const opp = st.players[1]!;
    opp.points = 20 - card.points; // 买后正好到 20
    opp.tokens = { black: 4, red: 4, green: 4, blue: 4, white: 4, pearl: 2, gold: 3 }; // 万事俱备
    const outs = oppOuts(playerView(st, 0), 0);
    expect(outs.length).toBeGreaterThanOrEqual(1);
    expect(crossesWin(opp, card)).toContain('总分20');
    expect(shortfall(opp, card)).toBe(0);
    const race = raceBlock(playerView(st, 0), 0).join('\n');
    expect(race).toContain('现成胜线');
    expect(race).toMatch(/拆除|抢跑|阻断/);
  });
});

describe('llm3 行动列表', () => {
  test('买/预留行带稳定卡 id, 拿取标注送特权', () => {
    const st = createGame({ seed: 5 });
    const lm = legalMoves(st);
    const list = actionListV3(st, st.current, lm);
    expect(list).toMatch(/\[id \d-\d+\]/);
    // 预留去重: 黄金格数 × 卡数 远多于列出的预留行
    const resLines = list.split('\n').filter((l) => l.includes('黄金+预留'));
    const resActs = lm.actions.filter((a) => a.kind === 'reserve').length;
    if (resActs > 0) expect(resLines.length).toBeLessThanOrEqual(resActs);
  });
});
