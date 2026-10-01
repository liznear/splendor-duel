// 贪心 bot: 1 层前瞻 + 启发式估值; 特权单枚贪心尝试
import type { Agent, TurnContext } from './agent.js';
import {
  applyMove, canBuy, GEMS, maxColorPointsOf, type GameState, type Move, type PlayerState,
} from '../engine/game.js';

function evalPlayer(p: PlayerState, view: GameState): number {
  let s = p.points * 100 + p.crowns * 35 + maxColorPointsOf(p) * 14;
  let bonusSum = 0;
  for (const g of GEMS) bonusSum += p.bonuses[g];
  s += bonusSum * 14;
  s += p.tokens.pearl * 3.2 + p.tokens.gold * 3.5;
  for (const g of GEMS) s += p.tokens[g] * 1.1;
  s += p.privileges * 9;
  // 可立即购买的卡数(含预留)
  let affordable = 0;
  for (const card of view.pyramid) if (card && canBuy(p, card)) affordable += 2;
  for (const card of p.reserved) if (canBuy(p, card)) affordable += 3;
  s += affordable;
  s += p.reserved.length * 1;
  return s;
}

export function evaluate(state: GameState, seat: 0 | 1): number {
  if (state.winner === seat) return 1e9;
  if (state.winner !== null) return -1e9;
  const me = evalPlayer(state.players[seat]!, state);
  const opp = evalPlayer(state.players[1 - seat]!, state);
  return me - 0.75 * opp + Math.random() * 0.01;
}

function trySim(ctx: TurnContext, move: Move): number | null {
  try {
    return evaluate(applyMove(ctx.view, move), ctx.seat);
  } catch {
    return null;
  }
}

export function greedyAgent(name = '贪心bot'): Agent {
  return {
    name,
    async chooseMove(ctx: TurnContext) {
      const p = ctx.view.players[ctx.seat]!;
      let best: Move | null = null;
      let bestScore = -Infinity;
      for (const action of ctx.legal.actions) {
        const score = trySim(ctx, { action }) ?? -Infinity;
        if (score > bestScore) {
          bestScore = score;
          best = { action };
        }
      }
      // 特权: 对已选行动, 贪心尝试逐枚补上最优特权格
      if (best && p.privileges > 0 && ctx.legal.privilegeCells.length > 0) {
        for (let k = 0; k < p.privileges; k++) {
          let bestPriv: number | null = null;
          let privScore = bestScore;
          for (const cell of ctx.legal.privilegeCells) {
            const cur = (best as { privileges?: number[] }).privileges ?? [];
            if (cur.includes(cell)) continue;
            const score = trySim(ctx, { ...best, privileges: [...cur, cell] });
            if (score != null && score > privScore) {
              privScore = score;
              bestPriv = cell;
            }
          }
          if (bestPriv == null) break;
          (best as { privileges?: number[] }).privileges = [
            ...((best as { privileges?: number[] }).privileges ?? []),
            bestPriv,
          ];
          bestScore = privScore;
        }
      }
      // 自愿补货只在明显有利时(简化: 不主动补货)
      return best!;
    },
  };
}
