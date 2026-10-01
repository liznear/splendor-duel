// LLM agent: 通过 pi coding agent SDK 调用大模型下棋
import type { Agent, TurnContext } from './agent.js';
import {
  applyMove, type CardDef, type GameState, type Gem, type Move, type NonGold, type TokenColor,
} from '../engine/game.js';
import {
  ABILITY_ZH, cellIndex, GEM_ZH, renderActions, TOKEN_ZH,
} from '../render.js';
import { fallbackMove } from './random.js';

type PiModule = typeof import('@earendil-works/pi-coding-agent');

const ZH2CODE: Record<string, TokenColor> = {
  白: 'white', 白色: 'white', 蓝: 'blue', 蓝色: 'blue', 绿: 'green', 绿色: 'green',
  红: 'red', 红色: 'red', 黑: 'black', 黑色: 'black', 珠: 'pearl', 珍珠: 'pearl', 金: 'gold', 黄金: 'gold',
};
const GEM_ZH2CODE: Record<string, Gem> = {
  白: 'white', 白色: 'white', 蓝: 'blue', 蓝色: 'blue', 绿: 'green', 绿色: 'green',
  红: 'red', 红色: 'red', 黑: 'black', 黑色: 'black',
};

const SYSTEM_PROMPT = `你是 Splendor Duel(璀璨宝石对决)棋手, 目标是赢下双人对抗.

规则摘要:
- 棋盘 5x5 随机放 25 个 token: 白/蓝/绿/红/黑各4, 珍珠2, 黄金3. 花掉的 token 进袋, 补货时洗匀回填.
- 每回合: [可选]用特权(每枚从棋盘拿任意非金token) -> [可选]补货(对手得1特权) -> 必须三选一:
  1) 拿1-3个横/竖/斜连续相邻的非金token(黄金和空格会阻断); 若3个同色或含2珍珠, 对手得1特权
  2) 拿1黄金+预留1张卡(金字塔或牌库顶, 最多预留3张)
  3) 购买1张卡(金字塔或自己预留的): 支付费用-已有折扣, 黄金可当任意色, 珍珠无折扣抵扣
- 卡: 左上分数/皇冠, 右上折扣(1-2), 左下费用, 可能有能力: 额外回合/拿同色(拿1个该卡颜色token)/偷取(偷对手1枚非金token)/特权. 百搭卡(无固定色)购买时指定叠放到自己已有的颜色列.
- 买卡当场结算能力; 皇冠达到3/6时立刻从剩余皇家卡中领1张(加分+能力).
- 回合结束时 token 超过10个要弃到10个.
- 胜利(回合结束判定): 20分 或 10皇冠 或 同一颜色卡上累计10分.
- 起始: 随机先手, 后手得1特权. 特权被拿完时可从对手处抢1枚.

你的输出: 只输出一行 JSON, 不要任何其他文字, 格式:
{"i": 行动编号, "privileges": ["C3", ...], "replenish": false,
 "associateColor": "白", "royalPick": 0, "stealPick": "珍珠", "takeSameCell": "B2", "discard": {"白": 2}}
- i: 必填, 行动列表里的编号(1开始)
- privileges: 可选, 用特权时给出棋盘坐标(如 "C3"), 每枚特权一个坐标
- replenish: 可选, true 表示主动补货
- associateColor/royalPick/stealPick/takeSameCell/discard: 仅在对应情况需要选择时给出(颜色用中文: 白蓝绿红黑珍珠; royalPick 是皇家卡列表下标从0开始)
省略不需要的字段. 思考要充分, 但最终只输出 JSON.`;

export interface LlmOptions {
  name?: string;
  model?: string; // "provider/id"; 缺省用 opencode-go/deepseek-v4-flash, 再退回会话默认
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  verbose?: boolean; // 打印模型原始回复(调试)
}

const DEFAULT_MODEL = 'opencode-go/deepseek-v4-flash';

export function llmAgent(opts: LlmOptions = {}): Agent {
  let session: Awaited<ReturnType<PiModule['createAgentSession']>>['session'] | null = null;
  let pi: PiModule | null = null;
  let useModel = opts.model;

  async function ensureSession() {
    if (session) return session;
    pi = await import('@earendil-works/pi-coding-agent');
    const rt = await pi!.ModelRuntime.create();
    const avail = await rt.getAvailable();
    const find = (spec: string) => {
      const [provider, ...rest] = spec.split('/');
      const id = rest.join('/');
      return (provider && id ? rt.getModel(provider, id) : undefined)
        ?? avail.find((m) => `${m.provider}/${m.id}`.includes(spec));
    };
    let model: unknown;
    if (useModel) {
      model = find(useModel) ?? undefined;
      if (!model) console.warn(`⚠ 未找到模型 ${opts.model}, 尝试默认 ${DEFAULT_MODEL}`);
    }
    if (!model) {
      model = find(DEFAULT_MODEL) ?? avail[0] ?? undefined;
      if (model) useModel = `${(model as { provider: string }).provider}/${(model as { id: string }).id}`;
    }
    const loader = new pi!.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: pi!.getAgentDir(),
      systemPromptOverride: () => SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const { session: s } = await pi!.createAgentSession({
      resourceLoader: loader,
      sessionManager: pi!.SessionManager.inMemory(),
      noTools: 'all',
      ...(model ? { model: model as never } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    });
    session = s;
    return session;
  }

  function extractJson(text: string): Record<string, unknown> | null {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const raw = fenced ? fenced[1]! : text;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  function jsonToMove(ctx: TurnContext, obj: Record<string, unknown>): Move | null {
    const i = Number(obj.i ?? obj.index ?? obj.choose);
    if (!Number.isInteger(i) || i < 1 || i > ctx.legal.actions.length) return null;
    const move: Move & { privileges?: number[]; replenish?: boolean } = { action: ctx.legal.actions[i - 1]! };
    if (Array.isArray(obj.privileges)) {
      const cells = (obj.privileges as unknown[])
        .map((x) => cellIndex(String(x)))
        .filter((x): x is number => x != null);
      if (cells.length > 0) move.privileges = cells;
    }
    if (obj.replenish === true) move.replenish = true;
    const assoc = obj.associateColor;
    if (typeof assoc === 'string' && GEM_ZH2CODE[assoc]) move.associateColor = GEM_ZH2CODE[assoc];
    if (Number.isInteger(obj.royalPick)) move.royalPick = Number(obj.royalPick);
    const steal = obj.stealPick;
    if (typeof steal === 'string' && ZH2CODE[steal] && ZH2CODE[steal] !== 'gold') move.stealPick = ZH2CODE[steal] as NonGold;
    if (typeof obj.takeSameCell === 'string') {
      const c = cellIndex(obj.takeSameCell);
      if (c != null) move.takeSameCell = c;
    }
    if (obj.discard && typeof obj.discard === 'object') {
      const d: Partial<Record<TokenColor, number>> = {};
      for (const [k, v] of Object.entries(obj.discard as Record<string, unknown>)) {
        const code = ZH2CODE[k];
        if (code && Number(v) > 0) d[code] = Number(v);
      }
      if (Object.keys(d).length > 0) move.discard = d;
    }
    return move;
  }

  function buildPrompt(ctx: TurnContext): string {
    const { view, seat } = ctx;
    const me = view.players[seat]!;
    const opp = view.players[1 - seat]!;
    const lines: string[] = [];
    lines.push('【当前局面】(棋盘坐标 A-E 列 1-5 行)');
    lines.push(renderBoardCompact(view));
    lines.push('', '【金字塔】');
    view.pyramid.forEach((c, i) => c && lines.push(`${i + 1}: ${cardCompact(c)}`));
    lines.push(`牌库剩余: L1:${view.decks[0]!.length} L2:${view.decks[1]!.length} L3:${view.decks[2]!.length}`);
    lines.push(`皇家卡(下标从0): ${view.royals.map((r, i) => `${i}:${r.points}分${r.ability ? ABILITY_ZH[r.ability] : ''}`).join(' ') || '无'}`);
    lines.push(`特权池剩余: ${3 - me.privileges - opp.privileges}`);
    lines.push('', `【我方 ${me.name}】分数${me.points} 皇冠${me.crowns} 特权${me.privileges} token:${
      (Object.entries(me.tokens) as [TokenColor, number][])
        .filter(([, n]) => n > 0).map(([c, n]) => `${TOKEN_ZH[c]}${n}`).join(' ') || '无'
    } 折扣:${(Object.entries(me.bonuses) as [Gem, number][]).filter(([, n]) => n > 0).map(([g, n]) => `${GEM_ZH[g]}${n}`).join(' ') || '无'}`);
    if (me.reserved.length > 0) {
      lines.push(`预留: ${me.reserved.map((c) => cardCompact(c)).join(' ; ')}`);
    }
    lines.push('', `【对手 ${opp.name}】分数${opp.points} 皇冠${opp.crowns} 特权${opp.privileges} token:${
      (Object.entries(opp.tokens) as [TokenColor, number][])
        .filter(([, n]) => n > 0).map(([c, n]) => `${TOKEN_ZH[c]}${n}`).join(' ') || '无'
    } 折扣:${(Object.entries(opp.bonuses) as [Gem, number][]).filter(([, n]) => n > 0).map(([g, n]) => `${GEM_ZH[g]}${n}`).join(' ') || '无'}`);
    if (opp.reserved.length > 0) lines.push(`对手预留: ${opp.reserved.length}张(内容保密)`);
    lines.push('', `【我的已购卡】${me.cards.map((c) => `${c.color ? GEM_ZH[c.color] : '分'}${c.def.points}${c.def.crowns ? '♛' + c.def.crowns : ''}`).join(' ') || '无'}`);
    lines.push('', `【可执行的行动】(输入编号 i):`);
    lines.push(renderActions(ctx.view, ctx.seat, ctx.legal));
    lines.push('', '输出 JSON (i 必填; 需要时补充 privileges/associateColor/royalPick/stealPick/takeSameCell/discard):');
    return lines.join('\n');
  }

  function renderBoardCompact(view: GameState): string {
    const rows: string[] = ['    A B C D E'];
    for (let r = 0; r < 5; r++) {
      rows.push(
        `  ${r + 1} ${[0, 1, 2, 3, 4].map((c) => {
          const t = view.board[r * 5 + c];
          return t == null ? '·' : TOKEN_ZH[t];
        }).join(' ')}`,
      );
    }
    return rows.join('\n');
  }

  function cardCompact(c: CardDef): string {
    const cost = Object.entries(c.cost).filter(([, n]) => n > 0).map(([k, n]) => `${TOKEN_ZH[k as TokenColor] ?? k}${n}`).join('');
    return `L${c.level} ${c.isAssociate ? '百搭' : c.color ? GEM_ZH[c.color as Gem] : '分'}卡 ${c.points}分${c.crowns ? `♛${c.crowns}` : ''}${c.bonus ? `折${c.bonus}` : ''} 费${cost || 0}${c.ability ? ` 【${ABILITY_ZH[c.ability] ?? c.ability}】` : ''}`;
  }

  return {
    name: opts.name ?? `LLM${opts.model ? `(${opts.model.split('/').pop()})` : ''}`,
    async chooseMove(ctx: TurnContext): Promise<Move> {
      const s = await ensureSession();
      let lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const prompt = attempt === 0
          ? buildPrompt(ctx)
          : `${buildPrompt(ctx)}\n\n你上次的回答有误: ${lastErr}\n请严格只输出一行合法 JSON.`;
        await s.prompt(prompt);
        const text = s.getLastAssistantText() ?? '';
        if (opts.verbose) console.log(`\n[LLM 原始回复] ${text}`);
        const obj = extractJson(text);
        if (!obj) {
          lastErr = '没有解析到 JSON';
          continue;
        }
        const move = jsonToMove(ctx, obj);
        if (!move) {
          lastErr = '行动编号 i 无效';
          continue;
        }
        try {
          applyMove(ctx.view, move); // 预演校验
          return move;
        } catch (err) {
          lastErr = (err as Error).message;
        }
      }
      console.warn(`⚠ ${this.name} 连续3次输出非法, 使用兜底随机走法`);
      return fallbackMove(ctx);
    },
  };
}
