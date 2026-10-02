// resume 往返: playMatch 录制 -> readSession -> replayGame 状态逐字段一致; 截断事件可从中途重放
import { describe, expect, test } from 'bun:test';
import { playMatch } from '../src/arena.ts';
import { greedyAgent } from '../src/agents/greedy.ts';
import { readSession, replayGame } from '../src/recorder.ts';

describe('会话记录与 resume', () => {
  test('录制 -> 重放, 终局完全一致', async () => {
    const r = await playMatch([greedyAgent('G1'), greedyAgent('G2')], { seed: 777 });
    const s = readSession(r.recorderPath!);
    const st = replayGame(s.meta, s.events.filter((e) => e.t !== 'result'));
    expect(st.winner).toBe(r.winner);
    expect(st.draw).toBe(r.draw);
    expect(st.turnCount).toBe(r.turns);
    expect(st.log).toEqual(r.finalState.log);
    expect(st.board).toEqual(r.finalState.board);
    expect(st.players.map((p) => [p.points, p.crowns, p.tokens])).toEqual(
      r.finalState.players.map((p) => [p.points, p.crowns, p.tokens]),
    );
    const res = s.events.filter((e) => e.t === 'result').pop();
    expect(res?.outcome).toBe(r.winner === null ? 'draw' : `p${r.winner}`);
  });

  test('事件序列截断 => 可重放到任意中途位置', async () => {
    const r = await playMatch([greedyAgent('G1'), greedyAgent('G2')], { seed: 424242 });
    const s = readSession(r.recorderPath!);
    const evs = s.events.filter((e) => e.t !== 'result');
    // 截到第 N 个 move 之前(保留完整的 replenish/option 前缀)
    const moveAt = evs.map((e, i) => (e.t === 'move' ? i : -1)).filter((i) => i >= 0);
    const cut = moveAt[Math.floor(moveAt.length / 2)] ?? evs.length;
    const partial = replayGame(s.meta, evs.slice(0, cut));
    expect(partial.winner).toBeNull();
    expect(partial.turnCount).toBeGreaterThan(0);
    // 全量重放再次确认一致
    const full = replayGame(s.meta, s.events.filter((e) => e.t !== 'result'));
    expect(full.log).toEqual(r.finalState.log);
  });
});
