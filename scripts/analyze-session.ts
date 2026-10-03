// 重放一局 session, 按回合打印双方 points/crowns/卡数, 定位节奏差 (一次性分析脚本)
import { readFileSync } from 'node:fs';
import { applyMove, applyOption, applyReplenish, createGame } from '../src/engine/game.js';

const file = process.argv[2] ?? 'sessions/2026-10-03-01-21--LLM3_gpt-6.1-sol_-vs-_-el0x.jsonl';
let lines: Record<string, unknown>[];
try {
  lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
} catch (err) {
  console.error(`读取/解析 ${file} 失败:`, err instanceof Error ? err.message : err);
  process.exit(1);
}
// SAFETY: session 文件首行必为 meta (recorder 先写 meta 再写事件), 此 cast 仅为取 seed/firstSeat
const meta = lines[0] as unknown as Record<string, unknown>;

let st = createGame({ seed: meta.seed as number, ...(meta.firstSeat !== undefined ? { firstSeat: meta.firstSeat as 0 | 1 } : {}) });
let prev = [0, 0, 0, 0]; // p0 pts, p0 crowns, p1 pts, p1 crowns
const fmt = (s: typeof st) => `p0:${s.players[0]!.points}分${s.players[0]!.crowns}冠(卡${s.players[0]!.cards.length}) | p1:${s.players[1]!.points}分${s.players[1]!.crowns}冠(卡${s.players[1]!.cards.length})`;
for (const e of lines) {
  if (e.t === 'meta') continue;
  try {
    if (e.t === 'option') st = applyOption(st, { privileges: (e.privileges as number[] | undefined) ?? undefined, replenish: (e.replenish as boolean | undefined) ?? undefined });
    else if (e.t === 'replenish') st = applyReplenish(st);
    else if (e.t === 'move') st = applyMove(st, e.move as never);
  } catch (err) { console.log('APPLY FAIL', JSON.stringify(e).slice(0, 200), String(err)); break; }
  if (e.t === 'move') {
    const cur = [st.players[0]!.points, st.players[0]!.crowns, st.players[1]!.points, st.players[1]!.crowns];
    const delta = cur.some((v, i) => v !== prev[i]);
    if (delta || st.winner !== null) {
      console.log(`turn${String(e.turn).padStart(3)} seat${e.seat} ${fmt(st)}${st.winner !== null ? `  WINNER=p${st.winner}` : ''}`);
      prev = cur;
    }
  }
}
console.log('\nfinal:', fmt(st), 'winner=', st.winner, 'turns=', st.turnCount);
