// Arena: 跑完整对局/锦标赛
import type { Agent, TurnContext } from './agents/agent.js';
import {
  applyMove, applyReplenish, createGame, isDeadState, legalMoves, playerView,
  type GameState, type Move,
} from './engine/game.js';
import { fallbackMove } from './agents/random.js';
import { renderState, logTail } from './render.js';

export interface MatchOptions {
  seed?: number;
  maxTurns?: number;
  /** 每步之后展示局面(人机模式) */
  showState?: (state: GameState, seat: 0 | 1) => void;
  /** 展示行动日志 */
  onMove?: (state: GameState) => void;
  verbose?: boolean;
}

export interface MatchResult {
  winner: 0 | 1 | null;
  draw: boolean;
  turns: number;
  finalState: GameState;
  illegalBy?: [string, number];
}

export async function playMatch(
  agents: [Agent, Agent],
  opts: MatchOptions = {},
): Promise<MatchResult> {
  const maxTurns = opts.maxTurns ?? 600;
  let state = createGame({ seed: opts.seed });
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
      state = applyMove(state, move);
    } catch (err) {
      illegalCount++;
      const name = agent.name;
      state.log.push(`⚠ ${name} 走法非法(${(err as Error).message}), 改用兜底`);
      if (illegalCount > 40) throw err;
      move = fallbackMove(ctx);
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
  for (const a of agents) a.onGameOver?.(result);
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
