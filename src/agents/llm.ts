// LLM agent: 通过 pi coding agent SDK 调用大模型下棋 (tool-call 协议)
import type { Agent, TurnContext } from './agent.js';
import {
  applyMove, type CardDef, type GameState, type Gem, type Move, type NonGold, type TokenColor,
} from '../engine/game.js';
import {
  ABILITY_ZH, cellIndex, GEM_ZH, renderActions, TOKEN_ZH,
} from '../render.js';
import { fallbackMove } from './random.js';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

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

提交走法: 唯一方式是调用 make_move 工具, 参数即走法(i 必填, 其余仅在需要时给出).
参数不合法时工具会返回错误, 修正参数后重新调用. 不要输出 JSON 文本, 只用工具.`;

export interface LlmOptions {
  name?: string;
  model?: string; // "provider/id"; 缺省用 opencode-go/deepseek-v4.1-flash, 再退回会话默认
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  verbose?: boolean; // 打印模型原始回复(调试)
}

const DEFAULT_MODEL = 'opencode-go/qwen3.8-flash';

const ZH_COLORS = ['白', '蓝', '绿', '红', '黑', '珍珠'] as const;
const ZH_GEMS = ['白', '蓝', '绿', '红', '黑'] as const;

// make_move 工具参数 schema: 结构化保证字段名/类型/枚举合法, 剩余语义由 execute 校验
const MOVE_PARAMS = Type.Object({
  i: Type.Integer({ description: '必填. 【可执行的行动】列表里的编号(1开始)' }),
  privileges: Type.Optional(Type.Array(Type.String(), {
    description: '用特权拿 token 的棋盘坐标, 每枚特权一格, 如 ["C3","C4"]',
  })),
  replenish: Type.Optional(Type.Boolean({ description: 'true = 主动补货(对手得1特权)' })),
  associateColor: Type.Optional(Type.Union(ZH_GEMS.map((c) => Type.Literal(c)), {
    description: '购买百搭卡时叠放到的颜色列',
  })),
  royalPick: Type.Optional(Type.Integer({ description: '领皇家卡: 皇家卡列表下标(0开始)' })),
  stealPick: Type.Optional(Type.Union(ZH_COLORS.map((c) => Type.Literal(c)), {
    description: '偷取对手 token 的颜色(非金)',
  })),
  takeSameCell: Type.Optional(Type.String({ description: '「拿同色」选择的棋盘坐标, 如 "B2"' })),
  discard: Type.Optional(
    Type.Record(Type.String(), Type.Integer({ minimum: 1 }), {
      description: '超 10 弃置, 如 {"白": 2, "珍珠": 1}; 键为颜色中文, 总数须正好等于超出量',
    }),
  ),
});

export function llmAgent(opts: LlmOptions = {}): Agent {
  let session: Awaited<ReturnType<PiModule['createAgentSession']>>['session'] | null = null;
  let pi: PiModule | null = null;
  let useModel = opts.model;
  // 当前回合的提交槽: execute 写入, chooseMove 读取
  let slot: { ctx: TurnContext; move: Move | null } | null = null;
  let lastRaw = '';

  const moveTool = defineTool({
    name: 'make_move',
    label: '提交走法',
    description: '提交本回合走法(唯一方式). i 必填; 其余字段仅在对应情况需要时给出. 参数不合法会返回错误, 修正后重新调用.',
    promptSnippet: '用 make_move 提交走法',
    parameters: MOVE_PARAMS,
    async execute(_toolCallId, params) {
      if (!slot) return { content: [{ type: 'text', text: '错误: 当前没有进行中的回合' }], details: {} };
      const raw = JSON.stringify(params);
      // SAFETY: TypeBox Static 类型无索引签名; 参数结构与 jsonToMove 的宽松 Record 契约一致, 语义由 applyMove 预演兜底
      const move = jsonToMove(slot.ctx, params as unknown as Record<string, unknown>);
      if (!move) {
        return { content: [{ type: 'text', text: `错误: 行动编号 i 无效 (须为 1-${slot.ctx.legal.actions.length}). 请重选后重新调用 make_move` }], details: {} };
      }
      try {
        applyMove(slot.ctx.view, move); // 预演校验, 不修改 view
      } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${(err as Error).message}. 请修正参数后重新调用 make_move` }], details: {} };
      }
      lastRaw = raw;
      slot.move = move;
      return { content: [{ type: 'text', text: 'OK, 走法已接受' }], details: {} };
    },
  });

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
      tools: ['make_move'], // 只启用 make_move, 禁掉全部内置工具
      customTools: [moveTool as never],
      ...(model ? { model: model as never } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    });
    session = s;
    return session;
  }

  function jsonToMove(ctx: TurnContext, obj: Record<string, unknown>): Move | null {
    const i = Number(obj.i);
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
    if (opp.reserved.length > 0) {
      // 明留(金字塔)公开, 盲留(牌库顶)仅数量
      const open = opp.reserved.filter((c) => c.id !== 'hidden');
      const blindN = opp.reserved.length - open.length;
      if (open.length > 0) lines.push(`对手明留卡: ${open.map((c) => cardCompact(c)).join(' ; ')}`);
      if (blindN > 0) lines.push(`对手盲留: ${blindN}张(内容保密)`);
    }
    lines.push('', `【我的已购卡】${me.cards.map((c) => `${c.color ? GEM_ZH[c.color] : '分'}${c.def.points}${c.def.crowns ? '♛' + c.def.crowns : ''}`).join(' ') || '无'}`);
    lines.push('', `【可执行的行动】(输入编号 i):`);
    lines.push(renderActions(ctx.view, ctx.seat, ctx.legal));
    lines.push('', '调用 make_move 工具提交走法 (i 必填; 需要时补充 privileges/associateColor/royalPick/stealPick/takeSameCell/discard):');
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
    // 最近一次模型原始输出(接受的工具调用参数或失败时的文本), UI 展示用
    get lastRaw() { return lastRaw; },
    async chooseMove(ctx: TurnContext): Promise<Move> {
      const s = await ensureSession();
      let lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const prompt = attempt === 0
          ? buildPrompt(ctx)
          : `${buildPrompt(ctx)}\n\n上一次失败: ${lastErr}\n请调用 make_move 工具提交合法走法.`;
        slot = { ctx, move: null };
        await s.prompt(prompt); // 参数错误已由工具结果即时反馈给模型, 同一 run 内自动修正
        if (slot.move) return slot.move;
        lastRaw = s.getLastAssistantText() ?? '';
        if (opts.verbose) console.log(`\n[LLM 原始回复] ${lastRaw}`);
        lastErr = '没有调用 make_move 工具(或参数始终非法)';
      }
      console.warn(`⚠ ${opts.name ?? 'LLM'} 连续3次未提交合法走法, 使用兜底随机走法`);
      return fallbackMove(ctx);
    },
  };
}
