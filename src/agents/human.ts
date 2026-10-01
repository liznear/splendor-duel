// 人类玩家: 终端中文交互
import type { Agent, TurnContext } from './agent.js';
import {
  applyMove, canBuy, paymentFor, GEMS, type Gem, type Move, type NonGold, type TokenColor,
} from '../engine/game.js';
import {
  ABILITY_ZH, cellIndex, cellName, GEM_ZH, logTail, renderActions, renderState,
} from '../render.js';
import * as readline from 'node:readline/promises';

const ZH2TOKEN: Record<string, TokenColor> = {
  白: 'white', 蓝: 'blue', 绿: 'green', 红: 'red', 黑: 'black', 珠: 'pearl', 珍珠: 'pearl', 金: 'gold', 黄金: 'gold',
};
const ZH2GEM: Record<string, Gem> = { 白: 'white', 蓝: 'blue', 绿: 'green', 红: 'red', 黑: 'black' };

type Draft = Partial<Move>;

export function humanAgent(name = '你'): Agent {
  return {
    name,
    async chooseMove(ctx: TurnContext): Promise<Move> {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const { view, seat, legal } = ctx;
      const me = view.players[seat]!;
      const opp = view.players[1 - seat]!;
      const ask = (q: string) => rl.question(q).then((a) => a.trim());

      try {
        for (;;) {
          console.log('\x1b[2J\x1b[H' + renderState(view, seat));
          console.log(logTail(view, 4));
          console.log(`\n${'─'.repeat(50)}\n可执行行动:`);
          console.log(renderActions(view, seat, legal));
          const move: Draft = {};

          // 1) 特权
          if (me.privileges > 0 && legal.privilegeCells.length > 0) {
            const ans = await ask(`\n使用特权拿 token? (你有 ${me.privileges} 枚; 格式如 ${cellName(legal.privilegeCells[0]!)}, 多格逗号分隔; 回车跳过): `);
            if (ans) {
              const cells = ans.split(/[\s,，]+/).map((s) => cellIndex(s)).filter((x): x is number => x != null);
              if (cells.length === 0 || cells.length > me.privileges) {
                console.log('⚠ 格式无效'); continue;
              }
              move.privileges = cells;
            }
          }
          // 2) 补货
          if (legal.canReplenish && legal.actions.length > 0) {
            const ans = await ask('主动补充棋盘? (对手获得1特权) y/N: ');
            if (ans.toLowerCase().startsWith('y')) move.replenish = true;
          }
          // 3) 强制行动
          const num = Number(await ask('\n选择行动编号: '));
          if (!Number.isInteger(num) || num < 1 || num > legal.actions.length) {
            console.log('⚠ 编号无效'); continue;
          }
          move.action = legal.actions[num - 1]!;

          // 4) 条件性选择
          if (move.action.kind === 'buy') {
            const card = move.action.from.kind === 'pyramid'
              ? view.pyramid[move.action.from.slot]
              : me.reserved[move.action.from.index];
            if (card) {
              if (card.isAssociate) {
                const colors = [...new Set(me.cards.map((c) => c.color).filter((c): c is Gem => c !== null))];
                const ans = await ask(`百搭卡叠放到哪个颜色? (${colors.map((c) => GEM_ZH[c]).join('/')}): `);
                const gem = ZH2GEM[ans];
                if (!gem || !colors.includes(gem)) { console.log('⚠ 颜色无效'); continue; }
                move.associateColor = gem;
              }
              if (card.ability === 'steal') {
                const avail = ([...GEMS, 'pearl'] as NonGold[]).filter((t) => opp.tokens[t] > 0);
                const ans = await ask(`偷取对手哪种 token? (${avail.map((t) => (t === 'pearl' ? '珍珠' : GEM_ZH[t])).join('/')}): `);
                const tok = ZH2TOKEN[ans];
                if (!tok || tok === 'gold' || opp.tokens[tok] <= 0) { console.log('⚠ 选择无效'); continue; }
                move.stealPick = tok as NonGold;
              }
              if (card.ability === 'takeSame' && card.color) {
                const cells = view.board.map((t, i) => (t === card.color ? i : -1)).filter((i) => i >= 0);
                if (cells.length > 1) {
                  const ans = await ask(`「拿同色」从哪格拿 ${GEM_ZH[card.color]} token? (${cells.map(cellName).join('/')}): `);
                  const c = cellIndex(ans);
                  if (c == null || view.board[c] !== card.color) { console.log('⚠ 格子无效'); continue; }
                  move.takeSameCell = c;
                }
              }
              const cross3 = me.crowns < 3 && me.crowns + card.crowns >= 3;
              const cross6 = me.crowns < 6 && me.crowns + card.crowns >= 6;
              if ((cross3 || cross6) && view.royals.length > 0) {
                const ans = await ask(
                  `将达成皇冠里程碑! 选皇家卡 (0-${view.royals.length - 1}: ${view.royals.map((r, i) => `${i}=${r.id}(${r.points}分${r.ability ? ABILITY_ZH[r.ability] : '无'})`).join(' ')}): `,
                );
                const n = Number(ans);
                if (!Number.isInteger(n) || n < 0 || n >= view.royals.length) { console.log('⚠ 编号无效'); continue; }
                move.royalPick = n;
              }
              // 预估 token 是否超 10
              const held = (Object.values(me.tokens) as number[]).reduce((s, n) => s + n, 0);
              const pay = canBuy(me, card) ? (Object.values(paymentFor(me, card)) as number[]).reduce((s, n) => s + (n ?? 0), 0) : 0;
              if (held + (move.privileges?.length ?? 0) - pay > 10) {
                const ans = await ask('token 将超过10个, 弃置哪些? (如 白2珠1; 回车=自动): ');
                if (ans) {
                  const d: Partial<Record<TokenColor, number>> = {};
                  for (const part of ans.split(/[\s,，]+/)) {
                    const m = /^(白|蓝|绿|红|黑|珠|珍珠|金|黄金)(\d+)$/.exec(part);
                    if (m) d[ZH2TOKEN[m[1]!]!] = Number(m[2]);
                  }
                  move.discard = d;
                }
              }
            }
          }
          // 5) 本地预演校验
          try {
            applyMove(view, move as Move);
            return move as Move;
          } catch (err) {
            console.log(`\n⚠ 走法无效: ${(err as Error).message}, 按回车重选`);
            await ask('');
          }
        }
      } finally {
        rl.close();
      }
    },
  };
}
