// LLM agent: 通过 pi coding agent SDK 调用大模型下棋 (tool-call 协议)
// 回合分两阶段下发消息: 阶段1(可选行动, 有特权/可补货时才出现) / 阶段2(强制行动, 必有).
// 4 个工具全程激活(不按阶段切换): 阶段约束由各工具内部守卫返回中文错误,
// 避免工具不在激活集时 SDK 返回裸 "tool not found"(模型无法自纠).
// 可选行动在模拟状态上即时结算(applyOption), 阶段2 的合法行动列表按模拟后棋盘重算;
// 特权拿取不消耗随机数, 补货洗牌只依赖袋内容 => 最终拼装的 Move 交给引擎时与模拟完全一致.
import type { Agent, TurnContext } from './agent.js';
import {
  applyMove, applyOption, canBuy, type CardDef, type GameState, legalMoves, type LegalMoves,
  maxColorPointsOf, type Move, type NonGold, ownedColors, type PlayerState, type TokenColor, type Gem,
} from '../engine/game.js';
import { ABILITY_ZH, actionText, cellIndex, cellName, GEM_ZH, renderActions, TOKEN_ZH } from '../render.js';
import { fallbackMove } from './random.js';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

type PiModule = typeof import('@earendil-works/pi-coding-agent');

export const GEM_ZH2CODE: Record<string, Gem> = {
  白: 'white', 白色: 'white', 蓝: 'blue', 蓝色: 'blue', 绿: 'green', 绿色: 'green',
  红: 'red', 红色: 'red', 黑: 'black', 黑色: 'black',
};
export const NON_GOLD_ZH2CODE: Record<string, NonGold> = {
  白: 'white', 白色: 'white', 蓝: 'blue', 蓝色: 'blue', 绿: 'green', 绿色: 'green',
  红: 'red', 红色: 'red', 黑: 'black', 黑色: 'black', 珠: 'pearl', 珍珠: 'pearl',
};
export const TOKEN_ZH2CODE: Record<string, TokenColor> = { ...NON_GOLD_ZH2CODE, 金: 'gold', 黄金: 'gold' };

const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

/** 棋盘上可用特权拿的格子清单 "A1白 B2珠 ..." */
export function privCellsLine(view: GameState): string {
  return view.board
    .map((t, i) => (t != null && t !== 'gold' ? `${cellName(i)}${TOKEN_ZH[t]}` : null))
    .filter(Boolean).join(' ');
}

const SYSTEM_PROMPT = `你是 Splendor Duel(璀璨宝石对决)棋手, 目标是赢下双人对抗.
思考与回复一律用中文.

== 身份指代(重要) ==
局面报告里【我方】永远指你自己(当前行动方); 【对手】指与你对弈的另一个人.
其中的玩家名字只是界面标签(可能是 LLM/你/任意字符串), 与"你"的指代无关, 不要被名字干扰.

== 规则摘要 ==
- 棋盘 5x5 随机放 25 个 token: 白/蓝/绿/红/黑各4, 珍珠2, 黄金3. 花掉的 token 进袋, 补货时洗匀回填.
- 每回合分两步:
  [可选] 用特权(每枚从棋盘拿任意非金token) 和/或 补货(对手得1特权), 顺序任选;
  [必须] 三选一: 1) 拿1-3个横/竖/斜连续相邻的非金token(黄金和空格会阻断; 3个同色或含2珍珠 => 对手得1特权)
    2) 拿1黄金+预留1张卡(金字塔或牌库顶, 最多预留3张) 3) 购买1张卡(金字塔或自己预留的).
- 买卡: 支付费用-已有折扣, 黄金可当任意色, 珍珠无折扣抵扣. 卡能力(额外回合/拿同色/偷取/特权/百搭)当场结算.
- 百搭卡(无固定色)购买时指定叠放到自己已有的颜色列, 其分数计入该色(同色胜利用).
- 皇冠达到 3/6 时立刻从剩余皇家卡中领1张(免费分+能力). 回合结束时 token 总数(珍珠与黄金都计入)超过 10 要弃到 10.
- 胜利(回合结束判定): 20分 或 10皇冠 或 同一颜色卡累计10分. 起始随机先手, 后手得1特权; 特权池空时从对手处夺取.

== 交互协议(每回合分阶段; 工具全程可用, 越阶段调用会被工具内校验拦下并给出提示) ==
- 阶段1(仅当有特权可用或可补货): use_privilege / use_replenish / skip_optional.
  use_privilege 给出格子坐标数组(一次1-3格, 可多次调用直到特权用完); 都不划算就 skip_optional.
  补货后仍可用特权(按先补货后特权执行), 但特权与补货不能交错多次.
  可选阶段结束(含调用 skip_optional 之后)请停止调用工具结束本轮, 等待下一条消息.
- 阶段2: 工具 make_move, 从【本条消息】的编号行动列表中选 i(必填), 需要时带条件参数.
  编号列表每回合重新生成, 严禁复用旧消息里的编号.
- 参数校验是严格的: 百搭卡颜色/皇家卡选择/偷取颜色/拿同色格/超10弃置, 只要被触发就必须显式给出且合法,
  缺失或非法会返回具体错误提示(含可选值清单), 按提示修正后重新调用即可, 不会静默采用默认值.
- 不要输出 JSON 文本, 只用工具.

== 每回合思考流程(严格按清单逐项一行短句, 禁止复述局面/长篇分析; 可选行动阶段尤其从简) ==
1. 威胁: 对手下回合能赢吗(看报告中【对手威胁】)? 能 => 一切让位于阻断(买走/预留其获胜卡/拿走其所需色).
2. 对手路线: 对手在冲哪条胜利路线(20分/10冠/同色10分)? 本步如何顺带干扰(拿其色/买走其目标卡/预留)?
3. 我的计划: 我的2-3回合目标(下两张买什么/冲哪条路线)? 对照上回合备忘, 计划变了就更新.
4. 选择: 选同时推进第3项和第2项的行动(双目的最优).
每次提交走法前, 用一行"备忘:"总结当前计划+对手最大威胁(下回合开头先读自己的备忘).

== 战术攻略(splendortactics.com 全部攻略 + 高分玩家数据提炼, 务必遵守) ==
[基本盘] 全局仅15-20回合, 浪费一回合≈输掉5-7%胜率; 胜率统计: 20分~65% / 同色10分~20% / 10冠~10%; 高手平均皇冠≈5.6, 皇家卡≈1.5 => 顺路凑3-6皇冠拿皇家是基线而非可选. 袋内容公开可算: 各色4+珍珠2+黄金3减去棋盘与双方持有即得.
[思考维度] 每回合先看对手棋盘再看自己的: 对手总分/皇冠/单色最高分三个数字(报告已自动检测并列入【对手威胁】); 三个警戒线: 对手15分 / 7皇冠 / 单色6-7分.
[核心心态] 这是 Duel 不是单人跑分: 被动发育=输. 每颗宝石拿了对手就少一颗, 每张卡买了就退出市场. 攻防同体: 等价选择中拿对手需要的那个是免费防守.
[买卡优先级·数据] 赢家平均买17张: L1×10 + L2×4 + L3×2 + 皇家1.5张; 中局时手里没有6-7张L1 = 引擎投资不足.
- L1: 皇冠卡(3费1冠)>拿同色(2+2)>额外回合(2+2+珍珠)>四色(1×4)>1分卡(3+2). 0分别折扣色正确 > 1分别折扣无用; 买前问"这个折扣让哪张未来的卡变便宜?"答不出就换.
- L2(一律总价7): 2分1冠(2+2+2+珍珠)>偷取(4+3)>双折扣(5+2)>特权(4+2+珍珠).
- L3: 3分2冠(5+3+3+珍珠)与4分(6+2+2)是最佳收官; 8费金卡几乎没人买.
- 无折扣金卡全是陷阱(L1/L2/L3合计不到1/3赢家买过一张): 分数不逃引擎, 除非直接终结.
- 能力强度: 额外回合 >> 偷取(2宝石摆动) > 拿同色 > 特权. 额外回合卡出现在市场就认真考虑预留.
- 皇家卡选择同理: 额外回合 > 偷取 > 3分 > 特权.
[开局] 珍珠开局必抢(首回合拿走的token里1/3是珍珠, 回合2就没了; 珍珠无法被折扣抵免). 后手标准强开局: 特权拿珍珠+预留皇冠卡(得黄金). 首购回合3-5, 最强首购=额外回合卡; 皇冠卡更多是被预留而非首购. 前5回合未买卡不慌, 但每回合必须有明确目的.
[token纪律] 宝石是燃料不是财富, 攒4-5个却无下回合购买计划=浪费; 拿3异色优先, 且尽量让3色同时服务两张卡(主目标+顺路L1). 黄金是过桥不是存款, 1-2回合内花掉. 预留=手术刀: 只预留2-3回合内买得起的卡; 手里始终留1张随时买得起的便宜卡当"安全阀"(让对手被迫补货而你吃特权). 拿3同色或2珍珠会送对手特权, 慎重. 超10弃置提前规划.
[防守时机] 前5回合几乎不阻断(自建引擎优先); 中局只做双目的阻断; 危局(对手15分/7冠/单色7分)阻断开为一等公民. 三个具体防守: 对手要拿偷取卡=>先花掉珍珠; 对手下一买触发皇家卡=>用黄金预留那张皇冠卡; 对手能先你买走目标卡=>立即转向别再攒那色.
[胜利路线] 10-12回合前保持至少两条胜利路径(分/皇冠/单色)形成压力迫使对手分散防守, 之后全速冲一条; 领先抢节奏结束, 落后用封锁拖慢. 同色胜利多在中局自然形成: 每次购买后统计自己单色分数, 6-7分时盯住该色高分卡和百搭卡(百搭能让颜色胜利从7跳到10).`;

export interface LlmOptions {
  name?: string;
  model?: string; // "provider/id"; 缺省用 opencode-go/deepseek-v4.1-flash, 再退回会话默认
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  verbose?: boolean; // 打印模型原始回复(调试)
  /** 流式回调: 本回合模型 thinking/文本增量的累积快照(每回合重置), 供界面实时展示 */
  onThinking?: (snapshot: string) => void;
  /** 覆盖系统提示词 (v2 变体用; 缺省用内置攻略提示词) */
  systemPrompt?: string;
  /** 追加到局面报告末尾的额外分析块 (如 v2 的对手预留进度预警) */
  contextExtra?: (view: GameState, seat: 0 | 1) => string;
  /** 自定义强制行动列表渲染; 输出的编号必须对应 lm.actions 下标+1 */
  actionList?: (sim: GameState, seat: 0 | 1, lm: LegalMoves) => string;
  /** 阶段2 行动列表前的分析摘要 (送特权警示/预留评估等) */
  digest?: (sim: GameState, seat: 0 | 1, lm: LegalMoves) => string;
  /** make_move 成功时的 memo 参数写入这里 (外层 agent 读取后注入下回合上下文, v3 用) */
  memoBox?: { current?: string };
}

const DEFAULT_MODEL = 'opencode-go/deepseek-v4.1-flash';
const ZH_GEMS = ['白', '蓝', '绿', '红', '黑'] as const;
const ZH_NON_GOLD = ['白', '蓝', '绿', '红', '黑', '珍珠'] as const;

// 当前回合的提交槽: 各工具 execute 读写, chooseMove 驱动
interface TurnSlot {
  base: GameState; // 回合初始状态: make_move 预演用(可选行动尚未执行, 预演时连可选行动一起重放)
  sim: GameState; // 模拟状态: 阶段1 每次可选行动后前进(上下文/合法性重算用)
  part: Partial<Move>; // 组装中的走法
  phase: 'optional' | 'mandatory' | 'done';
  lm: LegalMoves; // 阶段2 用: 按 sim 重算的合法行动
  submitted: boolean;
}

const err = (text: string) => ({ content: [{ type: 'text' as const, text: `错误: ${text}` }], details: {} });
const ok = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });

// ---- 上下文渲染 (llm 棋手与自然语言解析器共用) ----

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

function playerCompact(view: GameState, seat: 0 | 1): string {
  const p = view.players[seat]!;
  const tokens = (Object.entries(p.tokens) as [TokenColor, number][])
    .filter(([, n]) => n > 0).map(([c, n]) => `${TOKEN_ZH[c]}${n}`).join(' ') || '无';
  const tokenTotal = (Object.values(p.tokens) as number[]).reduce((a, b) => a + b, 0);
  const bonuses = (Object.entries(p.bonuses) as [Gem, number][])
    .filter(([, n]) => n > 0).map(([g, n]) => `${GEM_ZH[g]}${n}`).join(' ') || '无';
  const label = seat === view.current ? '我方(当前行动方)' : '对手';
  return [
    `${label}: 分数${p.points}/20 皇冠${p.crowns}/10 特权${p.privileges} token: ${tokens} 共${tokenTotal}/10`,
    `  折扣: ${bonuses} 单色最高分: ${maxColorPointsOf(p)}/10${p.royals.length ? ` 皇家卡×${p.royals.length}` : ''}`,
    `  已购卡: ${p.cards.map((c) => `${c.color ? GEM_ZH[c.color] : '分'}${c.def.points}${c.def.crowns ? '♛' + c.def.crowns : ''}`).join(' ') || '无'}`,
  ].join('\n');
}

/** 某颜色列的分数(同色胜利用); 百搭卡由调用方按最优色处理 */
function colorPointsOf(p: PlayerState, color: Gem): number {
  return p.cards.filter((c) => c.color === color).reduce((s, c) => s + c.def.points, 0);
}

/** 共享局面块(不含行动列表), 供 LLM 棋手两阶段与自然语言解析器复用 */
export function buildContext(view: GameState, seat: 0 | 1): string {
  const me = view.players[seat]!;
  const opp = view.players[1 - seat]!;
  const lines: string[] = [];
  lines.push('【棋盘】(坐标 A-E 列 1-5 行)');
  lines.push(renderBoardCompact(view));
  lines.push('', '【金字塔】');
  view.pyramid.forEach((c, i) => c && lines.push(`${i + 1}: ${cardCompact(c)}`));
  lines.push(`牌库剩余: L1:${view.decks[0]!.length} L2:${view.decks[1]!.length} L3:${view.decks[2]!.length}`);
  lines.push(`皇家卡(下标从0): ${view.royals.map((r, i) => `${i}:${r.points}分${r.ability ? ABILITY_ZH[r.ability] : ''}`).join(' ') || '无'}`);
  lines.push(`公共特权池剩余: ${3 - me.privileges - opp.privileges}  袋中token: ${view.bag.length}`);
  lines.push('', `【我方】\n${playerCompact(view, seat)}`);
  if (me.reserved.length > 0) lines.push(`  预留: ${me.reserved.map((c) => cardCompact(c)).join(' ; ')}`);
  lines.push('', `【对手】\n${playerCompact(view, (1 - seat) as 0 | 1)}`);
  if (opp.reserved.length > 0) {
    // 明留(金字塔)公开, 盲留(牌库顶)仅数量
    const open = opp.reserved.filter((c) => c.id !== 'hidden');
    const blindN = opp.reserved.length - open.length;
    if (open.length > 0) lines.push(`  对手明留卡: ${open.map((c) => cardCompact(c)).join(' ; ')}`);
    if (blindN > 0) lines.push(`  对手盲留: ${blindN}张(内容保密)`);
  }
  // 威胁提示(5秒习惯自动化)
  const threats: string[] = [];
  if (opp.crowns >= 7) threats.push(`对手皇冠 ${opp.crowns}/10, 一张皇冠卡就可能获胜 => 皇冠封锁最优先`);
  else if (opp.crowns >= 5) threats.push(`对手皇冠 ${opp.crowns}/10, 接近警戒线7`);
  if (maxColorPointsOf(opp) >= 7) threats.push(`对手单色最高 ${maxColorPointsOf(opp)}/10 分 => 高分卡/百搭卡警惕被其凑满`);
  if (opp.points >= 15) threats.push(`对手 ${opp.points}/20 分, 一张L3+皇家卡可能一波结束 => 评估其下回合能否获胜`);
  if (me.points >= 15 || me.crowns >= 8 || maxColorPointsOf(me) >= 8) threats.push(`我方已接近胜利(${me.points}分/${me.crowns}冠/单色${maxColorPointsOf(me)}分), 优先冲终点而非发育`);

  // 对手已能直接购买的卡(金字塔+明留): 自动回答"对手下回合能否获胜"
  const buys: string[] = [];
  const candidates: { c: CardDef; where: string }[] = [
    ...view.pyramid.map((c, i) => (c ? { c, where: `金字塔${i + 1}` } : null)),
    ...opp.reserved.map((c, i) => (c && c.id !== 'hidden' ? { c, where: `对手已留${i + 1}` } : null)),
  ].filter((x): x is { c: CardDef; where: string } => x !== null);
  for (const { c, where } of candidates) {
    if (!canBuy(opp, c)) continue;
    const pts = opp.points + c.points;
    const cr = opp.crowns + c.crowns;
    const cp = c.isAssociate ? maxColorPointsOf(opp) + c.points : c.color ? colorPointsOf(opp, c.color) + c.points : 0;
    const wins: string[] = [];
    if (pts >= 20) wins.push(`总分${pts}`);
    if (cr >= 10) wins.push(`${cr}冠`);
    if (cp >= 10) wins.push('单色10分');
    const royal = (opp.royalsTaken === 0 && cr >= 3) || (opp.royalsTaken === 1 && cr >= 6);
    if (wins.length) buys.push(`${where}: ${cardCompact(c)} => 买后${wins.join('+')}获胜, 必须阻断!`);
    else if (royal) buys.push(`${where}: ${cardCompact(c)} => 买后触发皇家卡, 分数可能跳跃`);
  }
  if (buys.length) threats.push(`对手现在就能买: \n- ${buys.slice(0, 6).join('\n- ')}`);
  if (threats.length) lines.push('', `【威胁检测】\n- ${threats.join('\n- ')}`);
  return lines.join('\n');
}

export function llmAgent(opts: LlmOptions = {}): Agent {
  let session: Awaited<ReturnType<PiModule['createAgentSession']>>['session'] | null = null;
  let useModel = opts.model;
  let slot: TurnSlot | null = null;
  let lastRaw = '';
  let liveRaw = ''; // 流式累积: onThinking 快照用

  // 汇总 prompt 期间新增的 assistant 消息(thinking/文本/工具调用), 供界面展示; 模型思考在 content 的 thinking 块里
  const tidy = (s: string) => s.replace(/\n{2,}/g, '\n').trim(); // 压掉连续空行
  function collectReply(s: NonNullable<typeof session>, from: number): string {
    const parts: string[] = [];
    for (const m of s.messages.slice(from)) {
      if (m.role !== 'assistant') continue;
      for (const c of m.content) {
        if (c.type === 'thinking' && c.thinking.trim()) parts.push(c.thinking.trim());
        else if (c.type === 'text' && c.text.trim()) parts.push(c.text.trim());
        else if (c.type === 'toolCall') parts.push(`[调用 ${c.name} ${JSON.stringify(c.arguments)}]`);
      }
    }
    return tidy(parts.join('\n'));
  }

  // ---- 阶段1 工具: 用特权 (可在一次 run 内多次调用, 每次即时结算并展示新棋盘) ----
  const privilegeTool = defineTool({
    name: 'use_privilege',
    label: '用特权拿 token',
    description: '用特权: 每枚特权从棋盘拿 1 个任意非金 token. 参数为格子坐标数组(如 ["C3","C4"]), 一次 1-3 格, 可多次调用. 特权拿过的格子本回合强制行动不可再拿.',
    promptSnippet: '用 use_privilege 提交特权拿取的格子',
    parameters: Type.Object({
      cells: Type.Array(Type.String(), {
        minItems: 1, maxItems: 3,
        description: '格子坐标数组, 如 ["C3","C4"]; 数量不得超过剩余特权',
      }),
    }),
    async execute(_id, params) {
      if (!slot || slot.phase !== 'optional') return err('当前不在可选行动阶段');
      if (slot.part.replenish && slot.part.privileges?.length) {
        return err('特权与补货不能交错使用(已补货且已用过特权)');
      }
      const cells = params.cells.map(cellIndex);
      if (cells.some((c) => c == null)) {
        return err(`坐标格式不对, 应为 A-E 列 + 1-5 行, 如 "C3"; 收到 ${JSON.stringify(params.cells)}. 可拿的格子: ${privCellsLine(slot.sim)}`);
      }
      try {
        slot.sim = applyOption(slot.sim, { privileges: cells as number[] });
      } catch (e) {
        return err(`${(e as Error).message}. 剩余特权 ${slot.sim.players[slot.sim.current]!.privileges} 枚; 可拿的格子(非金非空): ${privCellsLine(slot.sim)}\n${renderBoardCompact(slot.sim)}\n请修正后重新调用 use_privilege`);
      }
      slot.part.privileges = [...(slot.part.privileges ?? []), ...(cells as number[])];
      const left = slot.sim.players[slot.sim.current]!.privileges;
      return ok(`OK: 已用特权拿 ${cells.map((c) => cellName(c!)).join(' ')}. 剩余特权 ${left}.\n${renderBoardCompact(slot.sim)}\n可继续 use_privilege / use_replenish, 或 skip_optional 结束可选阶段; 之后停手, 等下一条编号列表消息.`);
    },
  });

  // ---- 阶段1 工具: 主动补货 (对手得 1 特权) ----
  const replenishTool = defineTool({
    name: 'use_replenish',
    label: '主动补货',
    description: '主动补充棋盘: 洗袋按螺旋回填空格, 但对手获得 1 特权. 仅当棋盘已无可用的好线/好卡时才值得. 补货后仍可用特权(按先补货后特权执行).',
    promptSnippet: '用 use_replenish 主动补货',
    parameters: Type.Object({}),
    async execute() {
      if (!slot || slot.phase !== 'optional') return err('当前不在可选行动阶段');
      if (slot.part.replenish) return err('每回合只能补货一次');
      try {
        slot.sim = applyOption(slot.sim, { replenish: true });
      } catch (e) {
        return err(`${(e as Error).message}. 请修正后重新调用`);
      }
      slot.part.replenish = true;
      if (!slot.part.privileges?.length) slot.part.replenishFirst = true; // 先补货后特权
      return ok(`OK: 棋盘已补充, 对手获得 1 特权.\n${renderBoardCompact(slot.sim)}\n可再 use_privilege(将按先补货后特权执行), 或 skip_optional 结束可选阶段; 之后停手, 等下一条编号列表消息.`);
    },
  });

  // ---- 阶段1 工具: 跳过可选行动 ----
  const skipTool = defineTool({
    name: 'skip_optional',
    label: '跳过可选行动',
    description: '不用特权也不补货, 结束可选行动(编号行动列表由下一条消息给出).',
    promptSnippet: '用 skip_optional 跳过可选行动',
    parameters: Type.Object({}),
    async execute() {
      if (!slot || slot.phase !== 'optional') return err('当前不在可选行动阶段');
      slot.phase = 'done';
      return ok('OK: 已跳过可选行动. 请结束本轮回复(不再调用任何工具), 等下一条带【可执行的行动】编号列表的消息里选 i 再调 make_move.');
    },
  });

  // ---- 阶段2 工具: 提交强制行动 ----
  const MOVE_PARAMS = Type.Object({
    i: Type.Integer({ description: '必填. 【可执行的行动】列表里的编号(1开始)' }),
    associateColor: Type.Optional(Type.Union(ZH_GEMS.map((c) => Type.Literal(c)), {
      description: '购买百搭卡时必须给出: 叠放到的颜色列(须为自己已有卡的颜色)',
    })),
    royalPick: Type.Optional(Type.Integer({ description: '领皇家卡时必须给出: 皇家卡列表下标(0开始)' })),
    stealPick: Type.Optional(Type.Union(ZH_NON_GOLD.map((c) => Type.Literal(c)), {
      description: '触发偷取时必须给出: 偷对手 token 的颜色(非金)',
    })),
    takeSameCell: Type.Optional(Type.String({ description: '触发「拿同色」时必须给出: 拿的棋盘坐标, 如 "B2"' })),
    discard: Type.Optional(
      Type.Record(Type.String(), Type.Integer({ minimum: 1 }), {
        description: '回合末 token 超 10 时必须给出: 如 {"白": 2, "珍珠": 1}; 键为颜色中文, 总数须正好等于超出量',
      }),
    ),
    memo: Type.Optional(Type.String({
      description: '可选. 一句话备忘(≤80字): 本回合决定 + 下回合计划(带卡id) + 对手最大威胁; 会在下回合开头原样注入供你核对, 计划变更时需说明原因',
    })),
  });

  const moveTool = defineTool({
    name: 'make_move',
    label: '提交强制行动',
    description: '从【可执行的行动】编号列表中选择 i(必填); 触发条件效果(百搭卡/皇家卡/偷取/拿同色/超10弃置)时对应参数必填, 缺失或非法会返回具体错误(不会静默用默认值), 修正后重新调用.',
    promptSnippet: '用 make_move 提交强制行动',
    parameters: MOVE_PARAMS,
    async execute(_toolCallId, params) {
      if (!slot || slot.phase !== 'mandatory') {
        const hint = !slot
          ? '当前不在强制行动阶段'
          : slot.phase === 'optional'
            ? '当前是【可选行动阶段】: 请先 use_privilege / use_replenish / skip_optional (或什么都不调), 本轮结束后下一条消息会给出编号行动列表, 到时再调 make_move'
            : '可选行动已结束, 编号行动列表将在下一条消息给出; 请勿用旧列表编号调用 make_move';
        return err(hint);
      }
      const i = Number(params.i);
      if (!Number.isInteger(i) || i < 1 || i > slot.lm.actions.length) {
        return err(`行动编号 i=${JSON.stringify(params.i)} 无效 (须为 1-${slot.lm.actions.length} 的整数, 即【可执行的行动】列表里的编号). 请重选后重新调用 make_move`);
      }
      const sim = slot.sim;
      const me = sim.players[sim.current]!;
      const opp = sim.players[1 - sim.current]!;
      const action = slot.lm.actions[i - 1]!;
      const move: Partial<Move> = { ...slot.part, action };
      const bad: string[] = [];
      const actDesc = stripAnsi(actionText(sim, sim.current, action));

      // ---- 条件参数严格校验: 缺失/非法直接报错让模型自纠, 不静默回退引擎默认 ----
      const card = action.kind === 'buy'
        ? (action.from.kind === 'pyramid' ? sim.pyramid[action.from.slot] : me.reserved[action.from.index])
        : null;

      // 1) 百搭卡颜色
      let color: Gem | null = card?.color ?? null;
      if (card?.isAssociate) {
        const legal = ownedColors(me);
        const zh = legal.map((g) => GEM_ZH[g]).join('/');
        const raw = params.associateColor;
        const picked = typeof raw === 'string' ? GEM_ZH2CODE[raw] : undefined;
        if (picked == null) bad.push(`购买百搭卡必须指定 associateColor(收到 ${JSON.stringify(raw ?? null)}); 可选(你已有卡的颜色): ${zh}, 如 {"associateColor":"${legal.length ? GEM_ZH[legal[0]!] : ''}"}`);
        else if (!legal.includes(picked)) bad.push(`associateColor "${raw}" 不是你已有卡的颜色; 可选: ${zh}`);
        else color = picked;
      }

      // 2) 皇家卡 (皇冠过 3/6 里程碑时领取)
      let royalAbility: string | null = null;
      if (card && sim.royals.length > 1
        && ((me.royalsTaken === 0 && me.crowns + card.crowns >= 3) || (me.royalsTaken === 1 && me.crowns + card.crowns >= 6))) {
        const rp = params.royalPick;
        if (!Number.isInteger(rp) || rp! < 0 || rp! >= sim.royals.length) {
          bad.push(`本次购买将触发领取皇家卡(皇冠到 ${me.royalsTaken === 0 ? 3 : 6}), 必须指定 royalPick(收到 ${JSON.stringify(rp ?? null)}); 可选: ${sim.royals.map((r, idx) => `${idx}:${r.points}分${r.ability ? `【${ABILITY_ZH[r.ability] ?? r.ability}】` : ''}`).join('  ')}; 注意选中有偷取能力的还需 stealPick`);
        } else {
          move.royalPick = Number(rp);
          royalAbility = sim.royals[Number(rp)]!.ability;
        }
      } else if (Number.isInteger(params.royalPick)) {
        move.royalPick = Number(params.royalPick);
      }

      // 3) 偷取 (卡能力或所选皇家卡能力)
      const oppHas = (['white', 'blue', 'green', 'red', 'black', 'pearl'] as NonGold[]).filter((c) => opp.tokens[c] > 0);
      const stealFrom = card?.ability === 'steal' ? '卡的偷取能力' : royalAbility === 'steal' ? '皇家卡的偷取能力' : null;
      if (stealFrom && oppHas.length > 0) {
        const raw = params.stealPick;
        const picked = typeof raw === 'string' ? NON_GOLD_ZH2CODE[raw] : undefined;
        if (picked == null || opp.tokens[picked] <= 0) {
          bad.push(`将触发偷取(${stealFrom}), 必须指定 stealPick(收到 ${JSON.stringify(raw ?? null)}); 对手持有非金 token: ${oppHas.map((c) => `${TOKEN_ZH[c]}×${opp.tokens[c]}`).join(' ')}, 如 {"stealPick":"${TOKEN_ZH[oppHas[0]!]}"}`);
        } else move.stealPick = picked;
      }

      // 4) 拿同色
      if (card?.ability === 'takeSame' && color) {
        const cells = sim.board.map((t, idx) => (t === color ? idx : -1)).filter((x) => x >= 0);
        if (cells.length > 0) {
          const raw = params.takeSameCell;
          const c = typeof raw === 'string' ? cellIndex(raw) : null;
          if (c == null || sim.board[c] !== color) {
            bad.push(`将触发「拿同色」, 必须指定 takeSameCell 为 1 个${GEM_ZH[color]}色格(收到 ${JSON.stringify(raw ?? null)}); 场上可选: ${cells.map((cc) => cellName(cc)).join(' ')}`);
          } else move.takeSameCell = c;
        }
      }

      // 5) 弃置: 预演后从日志读取超出量, 要求 discard 总数恰等于它
      if (bad.length === 0) {
        let after: GameState;
        try {
          after = applyMove(slot.base, move as Move); // 预演: 从回合初始状态整体重放(可选+强制), 不修改 base/sim
        } catch (e) {
          return err(`${(e as Error).message}.\n你选择的行动: ${actDesc}\n当前 token: ${(Object.entries(me.tokens) as [TokenColor, number][]).filter(([, n]) => n > 0).map(([c, n]) => `${TOKEN_ZH[c]}×${n}`).join(' ') || '无'}. 请修正参数后重新调用 make_move`);
        }
        const dlog = after.log.filter((l) => l.includes('弃置')).pop() ?? '';
        const excess = Number(/弃置 (\d+) 枚/.exec(dlog)?.[1] ?? 0);
        const d: Partial<Record<TokenColor, number>> = {};
        const unknown: string[] = [];
        if (params.discard && typeof params.discard === 'object') {
          for (const [k, v] of Object.entries(params.discard)) {
            const code = TOKEN_ZH2CODE[k];
            if (code && Number(v) > 0) d[code] = Number(v);
            else if (!code) unknown.push(k);
          }
        }
        const totalD = Object.values(d).reduce((s, n) => s + (n ?? 0), 0);
        const inv = (Object.entries(me.tokens) as [TokenColor, number][])
          .filter(([, n]) => n > 0).map(([c, n]) => `${TOKEN_ZH[c]}×${n}`).join(' ') || '无';
        if (excess === 0) {
          if (params.discard && Object.keys(params.discard).length > 0) bad.push(`回合末 token 未超 10, 无需 discard(你给了 ${JSON.stringify(params.discard)})`);
        } else if (totalD !== excess || unknown.length > 0) {
          const ex = (Object.entries(me.tokens) as [TokenColor, number][]).find(([, n]) => n > 0);
          bad.push(`回合结束 token 将超 10, 必须弃 ${excess} 枚, 但你的 discard 共 ${totalD} 枚${unknown.length ? `(无法识别的颜色键: ${unknown.join(',')})` : ''}; 行动前 token: ${inv}(本次行动可能还会增加); 请给出总数恰为 ${excess} 的 discard, 如 {"discard":{"${ex ? TOKEN_ZH[ex[0]] : '白'}":${Math.min(ex?.[1] ?? 1, excess)}}}`);
        } else {
          // 软上限: 行动前持有 + 拿取量 + 1(能力增益)
          const takeGain: Partial<Record<TokenColor, number>> = {};
          if (action.kind === 'take') {
            for (const cc of action.cells) {
              const t = sim.board[cc]!;
              takeGain[t] = (takeGain[t] ?? 0) + 1;
            }
          }
          for (const [c, n] of Object.entries(d) as [TokenColor, number][]) {
            const cap = me.tokens[c] + (takeGain[c] ?? 0) + 1;
            if (n > cap) bad.push(`discard 中 ${TOKEN_ZH[c]}×${n} 超过可能的持有量(约 ≤${cap}; 当前 ${me.tokens[c]} + 拿取 ${(takeGain[c] ?? 0)} + 能力≤1)`);
          }
          if (bad.length === 0 && Object.keys(d).length > 0) move.discard = d;
        }
      }

      if (bad.length > 0) {
        return err(`你选择的行动: ${actDesc}\n${bad.map((b, k) => `${k + 1}. ${b}`).join('\n')}\n请修正后重新调用 make_move(其余参数不变)`);
      }
      slot.part = move;
      slot.submitted = true;
      if (opts.memoBox && typeof params.memo === 'string' && params.memo.trim())
        opts.memoBox.current = params.memo.trim().slice(0, 120); // 成功才写入, 后一次(额外回合)覆盖前一次
      return ok('OK, 走法已接受');
    },
  });

  async function ensureSession() {
    if (session) return session;
    const pi = await import('@earendil-works/pi-coding-agent');
    const rt = await pi.ModelRuntime.create();
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
    const loader = new pi.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: pi.getAgentDir(),
      systemPromptOverride: () => opts.systemPrompt ?? SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const { session: s } = await pi.createAgentSession({
      resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(),
      // 代码内固定 thinking 预算, 不读也不改任何配置文件 (low=4K 供批量 A/B 提速用)
      settingsManager: pi.SettingsManager.inMemory({ thinkingBudgets: { low: 4096, medium: 16384 } }),
      tools: ['use_privilege', 'use_replenish', 'skip_optional', 'make_move'], // 全量注册且全程激活; 阶段约束由各工具内部校验
      customTools: [privilegeTool as never, replenishTool as never, skipTool as never, moveTool as never],
      ...(model ? { model: model as never } : {}),
      thinkingLevel: opts.thinkingLevel ?? 'medium',
    });
    session = s;
    if (opts.onThinking) {
      // 流式: 订阅 thinking/文本增量, 回调给宿主实时展示(工具调用仍由 collectReply 事后汇总)
      s.subscribe((event) => {
        if (event.type !== 'message_update') return;
        const e = event.assistantMessageEvent;
        if ((e.type === 'thinking_delta' || e.type === 'text_delta') && e.delta) {
          liveRaw += e.delta;
          opts.onThinking?.(tidy(liveRaw));
        }
      });
    }
    return session;
  }

  // ---- 上下文渲染: 见下方模块级 buildContext (与自然语言解析器共用) ----

  function summarizeOptional(part: Partial<Move>, before: GameState): string {
    const parts: string[] = [];
    if (part.privileges?.length) {
      const cells = part.privileges.map((c) => `${cellName(c)}(${before.board[c] ? TOKEN_ZH[before.board[c]!] : '?'})`).join(' ');
      parts.push(`已用特权 ${part.privileges.length} 枚拿了: ${cells}`);
    }
    if (part.replenish) parts.push('已主动补货(对手得1特权)');
    return parts.length ? parts.join('; ') : '未使用(直接跳过)';
  }

  function buildPhase1Prompt(ctx: TurnContext, sim: GameState): string {
    const me = sim.players[ctx.seat]!;
    const lm = legalMoves(sim);
    const nTake = lm.actions.filter((a) => a.kind === 'take').length;
    const nRes = lm.actions.filter((a) => a.kind === 'reserve').length;
    const nBuy = lm.actions.filter((a) => a.kind === 'buy').length;
    const lines: string[] = [];
    lines.push(`第 ${ctx.turn + 1} 回合, 轮到你. 先决定【可选行动】(可以都不用):`);
    lines.push(buildContext(sim, ctx.seat));
    if (opts.contextExtra) lines.push(opts.contextExtra(sim, ctx.seat));
    lines.push('', '【可选行动阶段】');
    if (me.privileges > 0) {
      lines.push(`你有特权 ${me.privileges} 枚, 每枚可拿棋盘任意非金格: ${privCellsLine(sim)}`);
    }
    if (lm.canReplenish) {
      lines.push(`可主动补货(袋中 ${sim.bag.length} 枚): 洗袋回填空格, 但对手得 1 特权.`);
    }
    lines.push(`强制行动预览(可选行动后可能变化): 拿取 ${nTake} 种 / 预留 ${nRes} 种 / 购买 ${nBuy} 种.`);
    lines.push('提示: 特权优先拿珍珠或对手急需的色; 棋盘还有好线/可买的卡时通常不补货; 特权拿过的格子强制行动阶段不可再拿.');
    const canUsePriv = me.privileges > 0 && lm.privilegeCells.length > 0;
    const toolList = [
      ...(canUsePriv ? ['use_privilege(格子数组)'] : []),
      ...(lm.canReplenish ? ['use_replenish()'] : []),
      'skip_optional()',
    ].join(' / ');
    lines.push(`调用工具提交: ${toolList}. 结束后停止调用工具, make_move 需等下一条带编号行动列表的消息.`);
    return lines.join('\n');
  }

  function buildPhase2Prompt(ctx: TurnContext, sim: GameState, part: Partial<Move>, lm: LegalMoves, failMsg: string): string {
    const me = sim.players[ctx.seat]!;
    const lines: string[] = [];
    lines.push(`继续第 ${ctx.turn + 1} 回合 —— 现在【必须】从下面列表选一个强制行动:`);
    lines.push(buildContext(sim, ctx.seat));
    lines.push('', `本回合可选行动: ${summarizeOptional(part, ctx.view)}`);
    if (me.reserved.length > 0) lines.push(`我的预留卡: ${me.reserved.map((c, i) => `${i + 1}: ${cardCompact(c)}`).join(' ; ')}`);
    if (opts.digest) lines.push('', opts.digest(sim, ctx.seat, lm));
    lines.push('', `【可执行的行动】(编号 i, 共 ${lm.actions.length} 个):`);
    lines.push(opts.actionList ? opts.actionList(sim, ctx.seat, lm) : stripAnsi(renderActions(sim, ctx.seat, lm)));
    lines.push('', '调用 make_move 提交 (i 必填; 触发时必填: associateColor=买百搭卡选色 / royalPick=领皇家卡下标 / stealPick=偷取颜色 / takeSameCell=拿同色格 / discard=超10弃置. 缺失会返回错误并列出可选值, 按提示补齐重调; memo 可选: 一句话计划备忘, 下回合注入):');
    if (failMsg) lines.push(`上一次失败: ${failMsg}\n请调用 make_move 工具提交合法走法.`);
    return lines.join('\n');
  }

  return {
    name: opts.name ?? `LLM${opts.model ? `(${opts.model.split('/').pop()})` : ''}`,
    get lastRaw() { return lastRaw; },
    async chooseMove(ctx: TurnContext): Promise<Move> {
      const s = await ensureSession();
      liveRaw = ''; // 重置本回合流式缓冲
      // 工具全程激活(不按阶段切换): 阶段约束由工具内部守卫报中文错误, 避免 SDK 裸 "tool not found"
      s.setActiveToolsByName(['use_privilege', 'use_replenish', 'skip_optional', 'make_move']);
      const msgFrom = s.messages.length; // 本回合消息起点, 收集 thinking 用
      const me = ctx.view.players[ctx.seat]!;
      const canPriv = me.privileges > 0 && ctx.legal.privilegeCells.length > 0;

      // ---- 阶段1: 可选行动 (仅当有特权或可补货) ----
      let sim = ctx.view;
      const part: Partial<Move> = {};
      if (canPriv || ctx.legal.canReplenish) {
        slot = { base: ctx.view, sim, part, phase: 'optional', lm: ctx.legal, submitted: false };
        await s.prompt(buildPhase1Prompt(ctx, sim));
        if (opts.verbose) console.log(`\n[LLM 阶段1] ${(slot.part.privileges?.length ?? 0)}枚特权, 补货=${slot.part.replenish === true}`);
        sim = slot.sim;
        // 未调用任何工具 = 视为跳过; 调用过但全失败也按已提交的部分算(可能为空 => 跳过)
      }

      // ---- 阶段2: 强制行动 (合法列表按可选行动后的棋盘重算) ----
      const lm = legalMoves(sim);
      if (lm.actions.length === 0) {
        // 理论不可达(arena 已处理 mustReplenish); 兜底
        console.warn(`⚠ ${opts.name ?? 'LLM'} 可选行动后无强制行动, 使用兜底`);
        return fallbackMove(ctx);
      }
      let lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        slot = { base: ctx.view, sim, part: { ...part }, phase: 'mandatory', lm, submitted: false };
        await s.prompt(buildPhase2Prompt(ctx, sim, part, lm, lastErr));
        if (slot.submitted) {
          lastRaw = collectReply(s, msgFrom);
          return slot.part as Move;
        }
        if (opts.verbose) console.log(`\n[LLM 原始回复] ${collectReply(s, msgFrom)}`);
        lastErr = '没有调用 make_move 工具(或参数始终非法)';
      }
      console.warn(`⚠ ${opts.name ?? 'LLM'} 连续3次未提交合法走法, 使用兜底随机走法`);
      lastRaw = collectReply(s, msgFrom);
      return fallbackMove(ctx);
    },
  };
}
