// Arena: 跑完整对局/锦标赛
import type { Agent, TurnContext } from './agents/agent.js';
import {
  applyMove, applyReplenish, createGame, isDeadState, legalMoves, playerView,
  type GameState, type Move,
} from './engine/game.js';
import { fallbackMove } from './agents/random.js';
import { renderState, logTail } from './render.js';
import { GameRecorder, type RecMeta } from './recorder.js';

export interface MatchOptions {
  seed?: number;
  firstSeat?: 0 | 1; // 缺省随机; 会记入会话 meta 供重放
  maxTurns?: number;
  /** 每步之后展示局面(人机模式) */
  showState?: (state: GameState, seat: 0 | 1) => void;
  /** 展示行动日志 */
  onMove?: (state: GameState) => void;
  verbose?: boolean;
  /** 从已重放的状态继续对局(resume); resumePrefix 使新会话文件自包含可重放 */
  initialState?: GameState;
  resumePrefix?: RecMeta['resume'];
  /** 写会话记录到 sessions/ (默认开; 测试可关) */
  record?: boolean;
}

export interface MatchResult {
  winner: 0 | 1 | null;
  draw: boolean;
  turns: number;
  finalState: GameState;
  illegalBy?: [string, number];
  /** 本局会话记录文件(未开启记录时为 undefined) */
  recorderPath?: string;
}

export async function playMatch(
  agents: [Agent, Agent],
  opts: MatchOptions = {},
): Promise<MatchResult> {
  const maxTurns = opts.maxTurns ?? 600;
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  let state = opts.initialState ?? createGame({ seed, names: [agents[0].name, agents[1].name], ...(opts.firstSeat !== undefined ? { firstSeat: opts.firstSeat } : {}) });
  const recorder = opts.record === false ? null : new GameRecorder(
    opts.resumePrefix
      ? { ...opts.resumePrefix, names: [agents[0].name, agents[1].name], specs: null, resumedFrom: 'replay' }
      : { seed, names: [agents[0].name, agents[1].name], firstSeat: state.current }, // turnCount=0 时 current 即先手
  );
  let illegalCount = 0;

  while (state.winner === null && !state.draw) {
    if (state.turnCount >= maxTurns) {
      state = { ...state, draw: true };
      state.log.push('超过回合上限, 判和局');
      break;
    }
    if (isDeadState(state)) {
      state = { ...state, draw: true };
      state.log.push('双方均无法行动, 判和局');
      break;
    }
    // 无强制行动可行时自动补货(对手得 1 特权)
    let lm = legalMoves(state);
    if (lm.mustReplenish) {
      recorder?.replenish();
      state = applyReplenish(state);
      lm = legalMoves(state);
      if (lm.actions.length === 0) continue; // 仍无法行动 -> 下一轮判和
    }

    const seat = state.current;
    const agent = agents[seat]!;
    const ctx: TurnContext = {
      seat,
      view: playerView(state, seat),
      legal: lm,
      turn: state.turnCount,
    };
    opts.showState?.(state, seat);

    let move: Move;
    try {
      move = await agent.chooseMove(ctx);
      recorder?.move(seat, state.turnCount, move, undefined, agent.lastRaw || undefined);
      state = applyMove(state, move);
    } catch (err) {
      illegalCount++;
      const name = agent.name;
      state.log.push(`⚠ ${name} 走法非法(${(err as Error).message}), 改用兜底`);
      if (illegalCount > 40) throw err;
      move = fallbackMove(ctx);
      recorder?.move(seat, state.turnCount, move);
      state = applyMove(state, move);
    }
    opts.onMove?.(state);
  }

  const result: MatchResult = {
    winner: state.winner,
    draw: state.draw,
    turns: state.turnCount,
    finalState: state,
  };
  recorder?.result(state.winner, state.turnCount);
  for (const a of agents) a.onGameOver?.(result);
  result.recorderPath = recorder?.path;
  return result;
}

export interface TourResult {
  games: number;
  wins: [number, number];
  draws: number;
  avgTurns: number;
}

export async function playTournament(
  agents: [Agent, Agent],
  games: number,
  opts: { verbose?: boolean } = {},
): Promise<TourResult> {
  const wins: [number, number] = [0, 0];
  let draws = 0;
  let totalTurns = 0;
  for (let i = 0; i < games; i++) {
    const pair: [Agent, Agent] = i % 2 === 0 ? agents : [agents[1]!, agents[0]!];
    const res = await playMatch(pair, { seed: 1000 + i * 7919 });
    const baseIdx = i % 2 === 0 ? [0, 1] : [1, 0];
    if (res.draw) draws++;
    else if (res.winner !== null) wins[baseIdx[res.winner]!]!++;
    totalTurns += res.turns;
    if (opts.verbose) {
      console.log(
        `第${i + 1}局: ${res.draw ? '和局' : `${pair[res.winner!]!.name} 胜`} (${res.turns}回合)`,
      );
    }
  }
  return { games, wins, draws, avgTurns: totalTurns / games };
}
