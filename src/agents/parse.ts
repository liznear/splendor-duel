// 自然语言走法解析器: 人机模式玩家用文字描述操作("买金字塔3号"/"拿B2C2"/"第2行第3列"/"买第2行第3张"),
// LLM 转成引擎 Move. 协议与 llm 棋手一致(可选行动 → 编号强制行动), 上下文渲染复用 llm.ts;
// 合法性交给引擎 dry-run 校验, 中文错误回喂模型自纠. 需要玩家补充的选择(皇家卡/偷取颜色/百搭叠色/
// 拿同色格)不会静默采用引擎默认值: 工具记录半成品走法并让模型向玩家追问, 玩家下一条回复只需补答
// (服务端把半成品 pending 传回, 不需要重新描述整个指令). 单一选项的条件参数自动补齐不追问.
// 会话为进程级单例(自动压缩上下文); 工具经模块级状态读写本次解析的槽位, 多对局请求串行排队.
import type { Gem, GameState, LegalMoves, MandatoryAction, Move, NonGold, TokenColor } from '../engine/game.js';
import { applyMove, applyOption, GEMS, legalMoves, ownedColors } from '../engine/game.js';
import { ABILITY_ZH, actionText, cellIndex, cellName, GEM_ZH, renderActions, TOKEN_ZH } from '../render.js';
import {
  buildContext, GEM_ZH2CODE, NON_GOLD_ZH2CODE, privCellsLine, stripAnsi, TOKEN_ZH2CODE,
} from './llm.js';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

type PiModule = typeof import('@earendil-works/pi-coding-agent');
type PiSession = Awaited<ReturnType<PiModule['createAgentSession']>>['session'];

const PARSE_SYSTEM = `你是「璀璨宝石对决」人机对战界面的指令解析器. 玩家(人类)用自然语言描述想要的操作, 你的唯一任务是把它精确转换成工具调用; 不要替玩家做战术决策, 不要建议别的走法.

原则:
- 玩家的话是权威: 他指定的格子/卡/颜色必须照办.
- 指令含糊、有歧义或与合法行动列表冲突时, 不要猜, 直接用中文向玩家澄清(纯文本回复, 不调用工具).

位置与卡片的描述方式(玩家常用口语):
- 棋盘格: 坐标(如 "C3") 或「第r行第c列」. 行从上到下 1-5, 列从左到右 1-5(A=第1列..E=第5列), 如 第2行第3列=C2.
- 金字塔卡按编号 1-12 引用, 布局:
    第1行(上, L3, 3张):  1  2  3
    第2行(中, L2, 4张):  4  5  6  7
    第3行(下, L1, 5张):  8  9 10 11 12
  「第r行第k张」= 上表第 r 行从左数第 k 个编号, 如 第3行第2张=9号, 第2行第4张=7号.
- 自己的预留卡按「预留第n张」= 行动列表里的"预留n".

规则速览(理解指令用; 合法性判断只看编号列表):
- 强制行动三选一: 拿 1-3 个横/竖/斜直线连续相邻的非金 token(黄金与空格阻断; 颜色不必相同, 拿 3 同色或含 2 珍珠只是送对手 1 特权, 依然合法) / 拿 1 黄金+预留 1 张卡 / 买 1 张卡(支付费用-折扣, 黄金可当任意色).
- 【可执行的行动】编号列表就是全部合法行动: 在列表里的一定合法, 不在列表里的一定不合法; 不要自行发明列表之外的约束(例如"三格必须同色"不足规则).

交互协议(与界面一致, 分两种消息):
1) 可选行动(仅当消息提到): 玩家指令涉及用特权/补货才调 submit_option, 完全没提就不调用工具, 直接回复"跳过".
2) 强制行动: 从消息里的【可执行的行动】编号列表选 i 调 submit_move.
   - 若工具返回"还需玩家补充" => 行动已被记录, 缺的是选择类信息(皇家卡/偷取颜色/百搭叠色/拿同色格);
     此时停止调用工具, 用中文向玩家追问(列出可选值). 玩家的回答会在下一条消息送达,
     到时结合上下文调 submit_move 补齐(原行动 i 与已给参数保持不变), 不要让玩家重新描述整个指令.
   - 工具参数错误会返回中文提示, 按提示修正后重新调用即可.
- 颜色一律用中文单字: 白/蓝/绿/红/黑/珍珠/金. 回复一律中文, 简短.
- 序数换算: 玩家用「第n张/第n个」描述列表项时对应下标 n-1(第1张=下标0).`;

interface SayMoveParams {
  i: number;
  associateColor?: string;
  royalPick?: number;
  stealPick?: string;
  takeSameCell?: string;
  discard?: Record<string, number>;
}

/** LLM 工具参数 → 引擎 Move (纯映射, 中文参数无法识别时抛中文错误). actions 为编号列表(1 开始) */
export function moveFromParams(actions: MandatoryAction[], params: SayMoveParams, base: Partial<Move> = {}): Move {
  const i = Number(params.i);
  if (!Number.isInteger(i) || i < 1 || i > actions.length) {
    throw new Error(`行动编号 ${JSON.stringify(params.i)} 无效 (须为 1-${actions.length} 的整数, 即【可执行的行动】列表里的编号)`);
  }
  const move: Move = { ...base, action: actions[i - 1]! };
  if (params.associateColor != null) {
    const c = GEM_ZH2CODE[params.associateColor];
    if (!c) throw new Error(`associateColor "${params.associateColor}" 无法识别 (可选: 白/蓝/绿/红/黑)`);
    move.associateColor = c;
  }
  if (params.royalPick != null) move.royalPick = Number(params.royalPick);
  if (params.stealPick != null) {
    const c = NON_GOLD_ZH2CODE[params.stealPick];
    if (!c) throw new Error(`stealPick "${params.stealPick}" 无法识别 (可选: 白/蓝/绿/红/黑/珍珠)`);
    move.stealPick = c;
  }
  if (params.takeSameCell != null) {
    const c = cellIndex(params.takeSameCell);
    if (c == null) throw new Error(`takeSameCell "${params.takeSameCell}" 格式不对 (应为 A-E 列 + 1-5 行, 如 "B2")`);
    move.takeSameCell = c;
  }
  if (params.discard) {
    const d: Partial<Record<TokenColor, number>> = {};
    for (const [k, v] of Object.entries(params.discard)) {
      const code = TOKEN_ZH2CODE[k];
      if (!code || !Number.isInteger(v) || v! < 1) throw new Error(`discard 键 "${k}" 无法识别 (可选: 白/蓝/绿/红/黑/珍珠/金)`);
      d[code] = Number(v);
    }
    move.discard = d;
  }
  return move;
}

interface MissingInfo {
  field: string; // associateColor | royalPick | stealPick | takeSameCell
  hint: string; // 给模型/玩家的中文可选值说明
}

/** 追问上下文: 已解析出的半成品走法 + 还缺的选择 */
export interface PendingAsk {
  move: Move; // 已选定的行动(含可选行动部分与已给条件参数)
  sim: GameState; // 可选行动后的模拟局面(legalMoves 与编号列表的基准)
  actionDesc: string; // 行动中文描述
  missing: MissingInfo[];
}

export interface ParseOptions {
  view: GameState; // playerView(对当前人类玩家)
  seat: 0 | 1;
  turn: number;
  text: string; // 玩家原话
  model?: string;
  /** 流式回调: 解析过程中的模型输出快照(供界面"解析中"展示) */
  onThinking?: (snapshot: string) => void;
  /** 续答: 上次解析追问后的玩家回复(携带半成品走法), 玩家无需重新描述指令 */
  pending?: PendingAsk;
}

export interface ParseResult {
  move: Move | null; // null = 未能解析, 看 reply
  reply: string; // 解析器的中文说明(成功确认或澄清/追问)
  pending?: PendingAsk; // 需玩家补充时携带, 服务端暂存供下次续答
}

// 解析是轻量指令跟随任务: 用小快模型 + 关闭 thinking, 降低延迟; 需要更强解析力时换大模型
const DEFAULT_MODEL = 'opencode-go/qwen3.8-flash';
const FALLBACK_REPLY = '没能理解这句话, 换个说法或直接点击操作试试';

/**
 * 检测购买走法还缺哪些必须由玩家补充的选择(缺省时引擎会静默用默认值, 不问会替玩家做决定).
 * 只剩一个选项的条件参数直接自动补进 mv, 不产生追问.
 */
export function completeConditionals(sim: GameState, seat: 0 | 1, mv: Move): MissingInfo[] {
  const missing: MissingInfo[] = [];
  if (mv.action.kind !== 'buy') return missing;
  const me = sim.players[seat]!;
  const opp = sim.players[(1 - seat) as 0 | 1]!;
  const card = mv.action.from.kind === 'pyramid' ? sim.pyramid[mv.action.from.slot] : me.reserved[mv.action.from.index];
  if (!card) return missing;

  // 1) 百搭卡叠色
  let color: Gem | null = card.color ?? null;
  if (card.isAssociate) {
    const legal = ownedColors(me);
    if (legal.length === 1) mv.associateColor ??= legal[0]!;
    else if (legal.length > 1 && mv.associateColor == null) {
      missing.push({ field: 'associateColor', hint: `百搭卡叠放颜色(玩家已有卡的颜色): ${legal.map((g) => GEM_ZH[g]).join('/')}` });
    }
    color = mv.associateColor ?? null;
  }

  // 2) 皇家卡 (买这张卡会跨 3/6 皇冠里程碑)
  let royalAbility: string | null = null;
  if (sim.royals.length > 1
    && ((me.royalsTaken === 0 && me.crowns + card.crowns >= 3) || (me.royalsTaken === 1 && me.crowns + card.crowns >= 6))) {
    if (!Number.isInteger(mv.royalPick) || mv.royalPick! < 0 || mv.royalPick! >= sim.royals.length) {
      missing.push({
        field: 'royalPick',
        hint: `皇家卡(皇冠里程碑触发)选哪张: ${sim.royals.map((r, i) => `第${i + 1}张=下标${i} ${r.points}分${r.ability ? `【${ABILITY_ZH[r.ability] ?? r.ability}】` : ''}`).join(' / ')}`,
      });
    } else royalAbility = sim.royals[mv.royalPick!]!.ability;
  }

  // 3) 偷取 (卡能力, 或所选皇家卡的能力)
  const oppHas = ([...GEMS, 'pearl'] as NonGold[]).filter((c) => opp.tokens[c] > 0);
  const stealFrom = card.ability === 'steal' ? '卡的偷取能力' : royalAbility === 'steal' ? '皇家卡的偷取能力' : null;
  if (stealFrom && oppHas.length > 1 && mv.stealPick == null) {
    missing.push({ field: 'stealPick', hint: `偷取对手哪种颜色(触发${stealFrom}): ${oppHas.map((c) => `${TOKEN_ZH[c]}×${opp.tokens[c]}`).join(' ')}` });
  } else if (stealFrom && oppHas.length === 1) {
    mv.stealPick ??= oppHas[0]!;
  }

  // 4) 拿同色
  if (card.ability === 'takeSame' && color) {
    const cells = sim.board.map((t, i) => (t === color ? i : -1)).filter((i) => i >= 0);
    if (cells.length > 1 && mv.takeSameCell == null) {
      missing.push({ field: 'takeSameCell', hint: `「拿同色」选哪个${GEM_ZH[color]}色格: ${cells.map((cc) => cellName(cc)).join(' ')}` });
    } else if (cells.length === 1) {
      mv.takeSameCell ??= cells[0]!;
    }
  }
  return missing;
}

// ---- 进程级单例会话 + 本次解析的槽位(工具 execute 读写) ----
let session: PiSession | null = null;
let stView: GameState | null = null;
let stSim: GameState | null = null; // 可选行动模拟状态
let stSeat: 0 | 1 = 0;
let stLm: LegalMoves | null = null; // 轮2 编号列表(按可选行动后的棋盘重算)
let stBase: Partial<Move> = {}; // moveFromParams 的基底(正常流程=可选部分; 续答=半成品走法)
let stPhase: 'optional' | 'mandatory' = 'mandatory';
let stMove: Move | null = null; // 已接受的走法
let stPending: PendingAsk | null = null; // 需追问的半成品

// ponytail: 全局串行队列避免多对局并发解析时槽位互踩; 需要并行时按 game id 分会话
let chain: Promise<unknown> = Promise.resolve();
export function parseMoveText(opts: ParseOptions): Promise<ParseResult> {
  const p = chain.catch(() => {}).then(() => runParse(opts));
  chain = p;
  return p;
}

async function runParse(opts: ParseOptions): Promise<ParseResult> {
  const { view, seat, text } = opts;
  const s = session ??= await ensureSession(opts.model, opts.onThinking);
  s.setActiveToolsByName(['submit_option', 'submit_move']);

  stView = view;
  stSim = view;
  stSeat = seat;
  stBase = {};
  stPhase = 'mandatory';
  stMove = null;
  stPending = null;
  try {
    // 续答: 玩家在回答上次的追问(也可能是全新指令), 从半成品继续(跳过轮1, stBase 即半成品)
    if (opts.pending) {
      stBase = opts.pending.move;
      stSim = opts.pending.sim;
    } else {
      const lm0 = legalMoves(view);
      const me = view.players[seat]!;
      const canPriv = me.privileges > 0 && lm0.privilegeCells.length > 0;
      const canRep = lm0.canReplenish;

      // ---- 轮1: 解析可选行动 (仅当有特权可拿或可补货); 模型回复"跳过"是正常路径, 继续轮2 ----
      if (canPriv || canRep) {
        stPhase = 'optional';
        await s.prompt(buildSayPrompt1(view, seat, opts.turn, text, canPriv, canRep));
        stPhase = 'mandatory';
      }
    }

    // ---- 轮2: 从(可选行动后的)编号列表选强制行动 ----
    const sim = stSim!;
    stLm = legalMoves(sim);
    if (stLm.actions.length === 0) return { move: null, reply: '当前没有可执行的强制行动(可能需要补货)' };
    const from2 = s.messages.length;
    for (let attempt = 0; attempt < 3 && !stMove; attempt++) {
      await s.prompt(buildSayPrompt2(sim, seat, text, stBase, stLm, opts.pending));
      if (stMove) return { move: stMove, reply: collectText(s, from2) || '已执行' };
      const r = collectText(s, from2);
      if (r) return { move: null, reply: r, pending: stPending ?? undefined }; // 模型用文字向玩家澄清/追问
    }
    return { move: null, reply: FALLBACK_REPLY, pending: stPending ?? undefined };
  } finally {
    stView = stSim = stLm = null;
    stBase = {};
    stMove = null;
    stPending = null;
  }
}

async function ensureSession(model?: string, onThinking?: (s: string) => void): Promise<PiSession> {
  const pi = await import('@earendil-works/pi-coding-agent');
  const rt = await pi.ModelRuntime.create();
  const avail = await rt.getAvailable();
  const find = (spec: string) => {
    const [provider, ...rest] = spec.split('/');
    const id = rest.join('/');
    return (provider && id ? rt.getModel(provider, id) : undefined)
      ?? avail.find((m) => `${m.provider}/${m.id}`.includes(spec));
  };
  const modelObj = (model && find(model)) || find(DEFAULT_MODEL) || avail[0];

  // submit_option: 轮1 一次性提交整个可选行动部分(特权格子 + 补货 + 顺序)
  const optionTool = defineTool({
    name: 'submit_option',
    label: '提交可选行动',
    description: '提交玩家指令中的可选行动: 用特权拿的格子数组(不用则省略) 与/或 是否补货. 玩家没提特权/补货就不要调用本工具.',
    promptSnippet: '用 submit_option 提交特权/补货',
    parameters: Type.Object({
      privileges: Type.Optional(Type.Array(Type.String(), {
        maxItems: 3,
        description: '用特权拿的格子坐标数组, 如 ["C3","C4"]; 数量不得超过剩余特权; 不用特权则省略',
      })),
      replenish: Type.Optional(Type.Boolean({ description: '是否主动补货(对手得1特权)' })),
      replenishFirst: Type.Optional(Type.Boolean({ description: 'true=先补货再用特权(顺序影响棋盘回填结果)' })),
    }),
    async execute(_id, params) {
      if (stPhase !== 'optional' || !stSim) return errTool('现在不是可选行动阶段, 请等编号行动列表消息再调 submit_move');
      const cells = (params.privileges ?? []).map(cellIndex);
      if (cells.some((c) => c == null)) {
        return errTool(`坐标格式不对(应为 A-E 列 + 1-5 行, 如 "C3", 或按"第r行第c列"换算). 可拿的格子: ${privCellsLine(stSim)}`);
      }
      let next = stSim;
      const wantRep = params.replenish === true;
      try {
        if (wantRep && params.replenishFirst) next = applyOption(next, { replenish: true });
        if (cells.length) next = applyOption(next, { privileges: cells as number[] });
        if (wantRep && !params.replenishFirst) next = applyOption(next, { replenish: true });
      } catch (e) {
        return errTool(`${(e as Error).message}. 剩余特权 ${next.players[next.current]!.privileges}; 可拿的格子: ${privCellsLine(next)}`);
      }
      stSim = next;
      const base: Partial<Move> = {};
      if (cells.length) base.privileges = cells as number[];
      if (wantRep) {
        base.replenish = true;
        if (params.replenishFirst && cells.length) base.replenishFirst = true;
      }
      stBase = base;
      return okTool('OK: 可选行动已记录, 请停止调用工具, 等下一条带【可执行的行动】编号列表的消息.');
    },
  });

  // submit_move: 轮2 从编号列表选强制行动; 引擎 dry-run 校验错误自纠, 缺选择类参数则记录半成品转追问
  const moveTool = defineTool({
    name: 'submit_move',
    label: '提交强制行动',
    description: '从【可执行的行动】编号列表中选 i(必填); 触发条件效果时按需带条件参数. 指令无法对应任何编号时不要硬选, 直接文字向玩家澄清.',
    promptSnippet: '用 submit_move 提交强制行动',
    parameters: Type.Object({
      i: Type.Integer({ description: '必填. 【可执行的行动】列表里的编号(1开始)' }),
      associateColor: Type.Optional(Type.String({ description: '购买百搭卡时: 叠放颜色(白/蓝/绿/红/黑, 须为玩家已有卡的颜色)' })),
      royalPick: Type.Optional(Type.Integer({ description: '领皇家卡时: 皇家卡下标(0开始, 玩家说第n张则填 n-1)' })),
      stealPick: Type.Optional(Type.String({ description: '触发偷取时: 偷对手 token 的颜色(白/蓝/绿/红/黑/珍珠)' })),
      takeSameCell: Type.Optional(Type.String({ description: '触发「拿同色」时: 拿的棋盘坐标, 如 "B2"' })),
      discard: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 1 }), {
        description: '回合末 token 超 10 时: 如 {"白":2,"珍珠":1}; 键为颜色中文, 总数须等于超出量',
      })),
    }),
    async execute(_id, params) {
      if (stPhase !== 'mandatory' || !stLm || !stView || !stSim) return errTool('现在还在可选行动阶段: 请先处理 submit_option 或回复"跳过"');
      let mv: Move;
      try {
        mv = moveFromParams(stLm.actions, params as SayMoveParams, stBase);
      } catch (e) {
        return errTool(`${(e as Error).message}; 请修正后重新调用 submit_move`);
      }
      const missing = completeConditionals(stSim, stSeat, mv); // 单一选项的条件参数已自动补进 mv
      const desc = stripAnsi(actionText(stSim, stSeat, mv.action));
      try {
        applyMove(stView, mv); // dry-run: 全量校验(含可选行动重放与条件参数)
      } catch (e) {
        return errTool(`${(e as Error).message}. 你选择的行动: ${desc}. 请修正参数重新调用 submit_move; 若玩家指令本身做不到, 请停止调用工具并用中文向玩家说明`);
      }
      if (missing.length > 0) {
        stPending = { move: mv, sim: stSim, actionDesc: desc, missing };
        return errTool(`行动已记录: ${desc}. 还需玩家补充: ${missing.map((m) => m.hint).join('; ')}. 请停止调用工具, 用中文向玩家追问这些信息(给出可选值); 玩家的回答会在下一条消息送达, 到时保持 i 与已给参数不变, 补齐追问的参数重新调用 submit_move 即可, 不要让玩家重新描述整个指令.`);
      }
      stMove = mv;
      stPending = null;
      return okTool('OK, 已接受');
    },
  });

  const loader = new pi.DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: pi.getAgentDir(),
    systemPromptOverride: () => PARSE_SYSTEM,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { session: s2 } = await pi.createAgentSession({
    resourceLoader: loader,
    sessionManager: pi.SessionManager.inMemory(),
    tools: ['submit_option', 'submit_move'],
    customTools: [optionTool as never, moveTool as never],
    thinkingLevel: 'off', // 解析不需要深度思考, 换延迟
    ...(modelObj ? { model: modelObj as never } : {}),
  });
  if (onThinking) {
    let live = '';
    s2.subscribe((event) => {
      if (event.type !== 'message_update') return;
      const e = event.assistantMessageEvent;
      if ((e.type === 'thinking_delta' || e.type === 'text_delta') && e.delta) {
        live += e.delta;
        onThinking(live.replace(/\n{2,}/g, '\n').trim());
      }
    });
  }
  return s2;
}

const errTool = (text: string) => ({ content: [{ type: 'text' as const, text: `错误: ${text}` }], details: {} });
const okTool = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });

function collectText(s: PiSession, from: number): string {
  const parts: string[] = [];
  for (const m of s.messages.slice(from)) {
    if (m.role !== 'assistant') continue;
    for (const c of m.content) {
      if (c.type === 'text' && c.text.trim()) parts.push(c.text.trim()); // 只要最终文本, 不泄漏思考过程
    }
  }
  return parts.join('\n').replace(/\n{2,}/g, '\n').trim();
}

function buildSayPrompt1(
  view: GameState, seat: 0 | 1, turn: number, text: string, canPriv: boolean, canRep: boolean,
): string {
  const me = view.players[seat]!;
  const lines: string[] = [];
  lines.push(`第 ${turn + 1} 回合, 【我方】(玩家)输入了一条指令, 先解析其中是否包含【可选行动】(特权/补货):`);
  lines.push(buildContext(view, seat));
  lines.push('', `【玩家指令】${text}`);
  lines.push('', '【可选行动阶段】');
  if (canPriv) lines.push(`玩家有特权 ${me.privileges} 枚, 每枚可拿 1 个非金格: ${privCellsLine(view)}`);
  if (canRep) lines.push(`可主动补货(袋中 ${view.bag.length} 枚, 对手得 1 特权).`);
  lines.push('指令提到了特权或补货 => 调 submit_option 提交; 完全没提 => 不调用任何工具, 直接回复"跳过".');
  return lines.join('\n');
}

function buildSayPrompt2(
  sim: GameState, seat: 0 | 1, text: string, part: Partial<Move>, lm: LegalMoves, pending?: PendingAsk,
): string {
  const optSummary = [
    part.privileges?.length ? `已用特权拿: ${part.privileges.map(cellName).join(' ')}` : '',
    part.replenish ? '已主动补货(对手得1特权)' : '',
  ].filter(Boolean).join('; ') || '无';
  const lines: string[] = [];
  if (pending) {
    lines.push('【续答】玩家此前想执行(已解析): ' + pending.actionDesc);
    lines.push(`你向玩家追问了: ${pending.missing.map((m) => m.hint).join('; ')}`);
    lines.push(`【玩家回复】${text}`);
    lines.push('若回复是在回答追问 => 调 submit_move, 行动编号 i 保持原值, 补齐追问的参数(已给的其他参数不变).');
    lines.push('若回复是全新指令(与追问无关) => 忽略追问, 按新指令从下方编号列表重新选择 i.');
    lines.push('');
  }
  lines.push('继续解析玩家指令 —— 从【可执行的行动】编号列表中选出符合玩家意图的一项:');
  lines.push(buildContext(sim, seat));
  if (!pending) lines.push('', `【玩家指令】${text}`);
  lines.push(`本回合可选行动: ${optSummary}`);
  lines.push('', `【可执行的行动】(编号 i, 共 ${lm.actions.length} 个):`);
  lines.push(stripAnsi(renderActions(sim, seat, lm)));
  lines.push('', '调 submit_move 提交 (i 必填; 触发时按说明补齐: associateColor / royalPick / stealPick / takeSameCell / discard). 缺选择类参数时工具会提示你向玩家追问; 指令无法对应任何编号、或与玩家意图冲突时, 不要硬选, 直接中文回复向玩家澄清.');
  return lines.join('\n');
}
