// 对局级会话记录: 每局一个 JSONL (sessions/), 记 seed + 双方每步事件.
// resume 原理: 引擎随机性全部走 mulberry32(seed), 同 seed + 同事件序列 => 状态完全可重放.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  applyMove, applyOption, applyReplenish, createGame, type GameState, type Move,
} from './engine/game.js';

/** 创建记录时的元数据 */
export interface RecMeta {
  seed: number;
  names: [string, string];
  specs?: [string, string] | null;
  mode?: string;
  firstSeat?: 0 | 1;
  humanSeat?: 0 | 1; // 人机模式: 人类座位(刷新页面自动续局用)
  resumedFrom?: string;
  /** 续局记录的内嵌前缀: 本文件事件接在前缀之后, 使文件自包含可重放 */
  resume?: { seed: number; firstSeat?: 0 | 1; names?: [string, string]; events: SessionEvent[] };
}

/** 会话文件首行 */
export type SessionMeta = RecMeta & { t: 'meta'; started: string };
export type SessionEvent = { t: 'option' | 'move' | 'replenish' | 'result' | 'names' } & Record<string, unknown>;

const sessionsDir = () => join(process.cwd(), 'sessions');
const fileSafe = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 24) || 'x';

export class GameRecorder {
  readonly path: string;
  private done = false;

  constructor(meta: RecMeta) {
    mkdirSync(sessionsDir(), { recursive: true });
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 17);
    this.path = join(sessionsDir(), `${ts}-${fileSafe(meta.names[0])}-vs-${fileSafe(meta.names[1])}-${Math.random().toString(36).slice(2, 6)}.jsonl`);
    this.write({ t: 'meta', started: ts, mode: 'agents', specs: null, firstSeat: 0, ...meta });
  }

  /** 人类界面的回合内可选行动(即时结算); agent 走法的可选部分在 Move 里, 不走这里 */
  option(seat: 0 | 1, privileges?: number[], replenish?: boolean) {
    this.write({ t: 'option', seat, ...(privileges?.length ? { privileges } : {}), ...(replenish ? { replenish: true } : {}) });
  }

  move(seat: 0 | 1, turn: number, move: Move, desc?: string) {
    this.write({ t: 'move', seat, turn, move, ...(desc ? { desc } : {}) });
  }

  /** 无强制行动时的引擎自动补货(消耗随机数, 重放必须包含) */
  replenish() { this.write({ t: 'replenish' }); }

  result(winner: 0 | 1 | null, turns: number) {
    if (this.done) return;
    this.write({ t: 'result', outcome: winner === null ? 'draw' : `p${winner}`, turns });
    this.done = true;
  }

  private write(e: Record<string, unknown>) {
    if (this.done) return;
    try { appendFileSync(this.path, `${JSON.stringify(e)}\n`); } catch { /* 记录失败不影响对局 */ }
  }
}

export function readSession(file: string): { meta: SessionMeta; events: SessionEvent[]; path: string } {
  const path = join(sessionsDir(), basename(file)); // 只允许 sessions/ 内的文件名
  let lines: unknown[];
  try {
    lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch (e) {
    throw new Error(`无法读取会话文件 ${basename(file)}: ${(e as Error).message}`);
  }
  const meta = lines[0] as SessionMeta;
  if (meta?.t !== 'meta') throw new Error('会话文件缺少 meta 行');
  return { meta, events: lines.slice(1) as SessionEvent[], path };
}

/** 按事件序列确定性重放到任意位置(events 可截断 => 从中途继续); 续局文件先重放内嵌前缀 */
export function replayGame(meta: SessionMeta, events: SessionEvent[]): GameState {
  const r = meta.resume;
  let st = createGame({
    seed: r ? r.seed : meta.seed,
    names: r?.names ?? meta.names,
    firstSeat: r ? r.firstSeat : meta.firstSeat,
  });
  const apply = (e: SessionEvent) => {
    if (st.winner !== null || st.draw) return;
    if (e.t === 'option') st = applyOption(st, { privileges: e.privileges as number[] | undefined, replenish: e.replenish === true });
    else if (e.t === 'move') st = applyMove(st, e.move as Move);
    else if (e.t === 'replenish') st = applyReplenish(st);
    else if (e.t === 'names') (e.names as [string, string]).forEach((name, i) => { st.players[i]!.name = name; });
  };
  for (const e of r ? r.events : []) apply(e);
  for (const e of events) apply(e);
  return st;
}
