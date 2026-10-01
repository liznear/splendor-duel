// 随机 bot: 均匀随机选强制行动; 偶尔用特权
import type { Agent, TurnContext } from './agent.js';

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

export function randomAgent(name = '随机bot'): Agent {
  return {
    name,
    async chooseMove(ctx: TurnContext) {
      // arena 保证 actions 非空(必须补货时已自动处理)
      const move: { privileges?: number[]; action: unknown } = {
        action: pick(ctx.legal.actions),
      };
      const p = ctx.view.players[ctx.seat]!;
      if (p.privileges > 0 && ctx.legal.privilegeCells.length > 0 && Math.random() < 0.3) {
        move.privileges = [pick(ctx.legal.privilegeCells)];
      }
      return move as never;
    },
  };
}

/** 兜底走法: arena 在 agent 走法非法/超时时使用 */
export function fallbackMove(ctx: TurnContext) {
  return {
    action: ctx.legal.actions[Math.floor(Math.random() * ctx.legal.actions.length)]!,
  };
}
