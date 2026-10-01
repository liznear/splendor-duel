// Agent 接口: 输入自己视角的局面, 输出一步走法
import type { GameState, LegalMoves, Move } from '../engine/game.js';

export interface TurnContext {
  seat: 0 | 1;
  view: GameState; // playerView: 对手预留卡已隐藏
  legal: LegalMoves;
  turn: number;
}

export interface Agent {
  readonly name: string;
  /** LLM agent: 最近一次模型原始输出 (UI 展示用) */
  lastRaw?: string;
  /** 每回合调用一次; 必须返回合法 Move(引擎仍会校验) */
  chooseMove(ctx: TurnContext): Promise<Move>;
  /** 对局结束通知(可选) */
  onGameOver?(result: { winner: 0 | 1 | null; draw: boolean }): void;
}
