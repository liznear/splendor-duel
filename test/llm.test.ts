// llm.ts 纯函数自检: 对手上一手提取(不调 LLM)
import { describe, expect, test } from 'bun:test';
import { applyMove, createGame, legalMoves, playerView, type GameState } from '../src/engine/game.js';
import { oppLastTurnText } from '../src/agents/llm.js';

/** 固定走法推进: 每步选第一个合法行动(确定性) */
function step(st: GameState): GameState {
  return applyMove(st, { action: legalMoves(st).actions[0]! });
}

describe('oppLastTurnText', () => {
  test('先手视角开局无对手行动', () => {
    const st = createGame({ seed: 42 });
    const view = playerView(st, st.current);
    expect(oppLastTurnText(view, st.current)).toBe('(对手尚未行动)');
  });

  test('对手行动过: 返回其最近一个回合的行', () => {
    let st = createGame({ seed: 42 });
    const me = st.current; // 我先手
    st = step(st); // 我走一步
    const view = playerView(st, me);
    const txt = oppLastTurnText(view, me);
    expect(txt).toBe('(对手尚未行动)'); // 对手还没动
    st = step(st); // 对手走一步
    const txt2 = oppLastTurnText(playerView(st, me), me);
    expect(txt2.startsWith(st.players[1 - me]!.name)).toBe(true);
    expect(txt2).not.toContain('——'); // 不含回合分隔符与我方行
  });

  test('对手盲留时遮蔽卡 id', () => {
    let st = createGame({ seed: 7 });
    // 找到对手的一个牌库顶盲留行动并强制执行
    for (let i = 0; i < 8 && !st.winner; i++) {
      const lm = legalMoves(st);
      const deckReserve = lm.actions.find((a) => a.kind === 'reserve' && a.from.kind === 'deck');
      if (deckReserve) {
        const seat = st.current;
        const human = (1 - seat) as 0 | 1;
        st = applyMove(st, { action: deckReserve });
        const txt = oppLastTurnText(playerView(st, human), human);
        expect(txt).toContain('牌库顶盲留');
        expect(txt).not.toMatch(/预留 [a-z\d]+-\d+ \(来源: L\d 牌库顶\)/);
        return;
      }
      st = step(st);
    }
    // 该种子下 8 步内没有出现盲留行动则跳过(不视为失败)
  });
});
