// LLM agent v2: 在 v1 (llm.ts) 之上叠加确定性分析, 修复实测行为缺陷:
//  1. 预留盲区: 行动列表里预留按金格重复(最多45条)无价值标注 => 按卡去重 + 【预留评估】摘要(金=万能/锁卡价值)
//  2. 规则误解: 模型曾以为"预留需手里有黄金支付" => 提示词明确"黄金是拿入手的万能token"
//  3. 威胁只报"现在就能买": 对手预留卡无进度预警 => 【对手预留进度】(还差几个token/是否跨胜利线)
//  4. 送特权拿取无标注 => 列表内联 ⚠送对手1特权 (3同色/含2珍珠)
// v1 保持原样, 二者可同场 A/B (scripts/compare.ts).
import type { Agent } from './agent.js';
import { llmAgent, stripAnsi, type LlmOptions } from './llm.js';
import {
  type CardDef, effectiveCost, type Gem, type GameState, GEMS, type LegalMoves, maxColorPointsOf,
  type PlayerState,
} from '../engine/game.js';
import { ABILITY_ZH, actionText, cardText } from '../render.js';

const plainCard = (c: CardDef) => stripAnsi(cardText(c));

/** 某颜色列的分数(同色胜利用) */
const colorPointsOf = (p: PlayerState, color: Gem): number =>
  p.cards.filter((c) => c.color === color).reduce((s, c) => s + c.def.points, 0);

/** 买该卡还差几个 token(宝石缺口 - 手持黄金; 0 = 现在就能买) */
const shortfall = (p: PlayerState, c: CardDef): number => {
  const eff = effectiveCost(p, c);
  let need = Math.max(0, eff.pearl - p.tokens.pearl);
  for (const g of GEMS) need += Math.max(0, eff[g] - p.tokens[g]);
  return Math.max(0, need - p.tokens.gold);
};

/** v2 追加局面块: 对手预留卡的购买进度 + 跨胜利线预警 (v1 只报"现在就能买") */
export function reserveThreats(view: GameState, seat: 0 | 1): string {
  const opp = view.players[1 - seat]!;
  if (opp.reserved.length === 0) return '';
  const lines: string[] = [];
  opp.reserved.forEach((c, i) => {
    if (c.id === 'hidden') {
      lines.push(`- 盲留${i + 1}: 内容保密, 无法评估`);
      return;
    }
    const need = shortfall(opp, c);
    const pts = opp.points + c.points;
    const cr = opp.crowns + c.crowns;
    const cp = c.isAssociate ? maxColorPointsOf(opp) + c.points : c.color ? colorPointsOf(opp, c.color) + c.points : 0;
    const royal = (opp.royalsTaken === 0 && cr >= 3) || (opp.royalsTaken === 1 && cr >= 6);
    const wins: string[] = [];
    if (pts >= 20) wins.push(`总分${pts}`);
    if (cr >= 10) wins.push(`${cr}冠`);
    if (cp >= 10) wins.push('单色10分');
    const when = need === 0 ? '现在就能买!' : `还差${need}个token(约${Math.ceil(need / 2)}回合)`;
    let flag = '';
    if (wins.length > 0) flag = need === 0 ? ` => ⚠买后${wins.join('+')}获胜, 对手本回合就可能走!` : ` => ⚠买后${wins.join('+')}获胜, 必须在此之前反超`;
    else if (royal) flag = ' => ⚠买后触发皇家卡';
    lines.push(`- 明留${i + 1}: ${plainCard(c)} — ${when}${flag}`);
  });
  return `\n【对手预留进度】(预留卡只有其本人能买, 无法买走拦截, 只能抢先冲线或拖慢其凑token)\n${lines.join('\n')}`;
}

/** 拿取行动是否送对手特权(引擎同款判定) */
function giftsPrivilege(board: GameState['board'], cells: number[]): boolean {
  const toks = cells.map((c) => board[c]!);
  return (toks.length === 3 && toks.every((t) => t === toks[0])) || toks.filter((t) => t === 'pearl').length >= 2;
}

const reserveKey = (a: Extract<LegalMoves['actions'][number], { kind: 'reserve' }>): string =>
  a.from.kind === 'pyramid' ? `p${a.from.slot}` : `d${a.from.level}`;

/** v2 行动列表: 预留按卡去重(不同黄金格完全等价), 送特权拿取内联标注 */
export function actionListV2(sim: GameState, seat: 0 | 1, lm: LegalMoves): string {
  const lines: string[] = [];
  const seenRes = new Set<string>();
  lm.actions.forEach((a, i) => {
    const s = stripAnsi(actionText(sim, seat, a));
    if (a.kind === 'take') {
      lines.push(`${i + 1}. ${s}${giftsPrivilege(sim.board, a.cells) ? '  ⚠送对手1特权' : ''}`);
    } else if (a.kind === 'reserve') {
      const key = reserveKey(a);
      if (seenRes.has(key)) return; // 黄金格等价, 每卡只列首个编号
      seenRes.add(key);
      lines.push(`${i + 1}. ${s}`);
    } else {
      lines.push(`${i + 1}. ${s}`);
    }
  });
  if (seenRes.size > 0) lines.push('(预留行动已按卡去重: 不同黄金格效果相同, 用所列编号即可)');
  return lines.join('\n');
}

/** v2 阶段2 摘要: 送特权警示 + 预留评估(确定性打分, 模型只需判断) */
export function digestV2(sim: GameState, seat: 0 | 1, lm: LegalMoves): string {
  const me = sim.players[seat]!;
  const lines: string[] = [];
  const giftIdx = lm.actions
    .map((a, i) => (a.kind === 'take' && giftsPrivilege(sim.board, a.cells) ? i + 1 : 0))
    .filter((i) => i > 0);
  if (giftIdx.length > 0) {
    lines.push(`⚠ 以下拿取编号会送对手1特权(3同色或含2珍珠): ${giftIdx.slice(0, 10).map((i) => `#${i}`).join(' ')}${giftIdx.length > 10 ? ' …' : ''}`);
  }

  const firstRes = new Map<string, number>();
  lm.actions.forEach((a, i) => {
    if (a.kind === 'reserve' && !firstRes.has(reserveKey(a))) firstRes.set(reserveKey(a), i + 1);
  });
  if (firstRes.size === 0) {
    lines.push(`(棋盘无黄金 → 本回合无法预留. 全局仅3枚黄金流转, 对手预留会抽干它们)`);
    return lines.join('\n');
  }
  const goldN = sim.board.filter((t) => t === 'gold').length;
  lines.push(`【预留评估】棋盘黄金×${goldN}, 你已预留${me.reserved.length}/3. 预留一次 = 拿1枚黄金(万能色, 买卡当任意色支付) + 锁走1张卡(对手不能再买). 候选(按价值排序, 取前6):`);
  const opp = sim.players[1 - seat]!;
  const scored = [...firstRes.entries()].map(([key, i]) => {
    const card = key[0] === 'p' ? sim.pyramid[Number(key.slice(1))]! : null;
    const src = key[0] === 'p' ? `金字塔${Number(key.slice(1)) + 1}号` : `L${key.slice(1)}牌库顶(盲留)`;
    let score = 0;
    const reasons: string[] = [];
    if (card) {
      const myNeed = Math.max(0, shortfall(me, card) - 1); // 预留入手 +1 金 => 缺口最多再减 1
      // 可负担性折价: 预留=手术刀, 只留 2-3 回合内买得起的卡(攻略网数据); 买不起的大分卡价值大减
      const afford = myNeed <= 1 ? 1 : myNeed <= 3 ? 0.7 : myNeed <= 5 ? 0.4 : 0.15;
      if (card.ability === 'turn') { score += 100; reasons.push('额外回合'); }
      if (card.crowns > 0) { score += card.crowns * 20 * afford; reasons.push(`皇冠${card.crowns}`); }
      if (card.points > 0) { score += card.points * 8 * afford; reasons.push(`${card.points}分`); }
      if (card.ability && card.ability !== 'turn') reasons.push(ABILITY_ZH[card.ability] ?? card.ability);
      const oppNeed = shortfall(opp, card);
      if (oppNeed === 0) { score += 60; reasons.push('对手现在就能买, 预留可锁走'); }
      else if (oppNeed <= 2) { score += 35; reasons.push(`对手还差${oppNeed}个就能买`); }
      reasons.push(myNeed === 0 ? '你拿金后即可买' : `你拿金后还差${myNeed}个`);
    } else {
      reasons.push('内容未知, 仅当缺金或想赌高级卡时考虑');
    }
    return { i, src, card, score, reasons };
  }).sort((a, b) => b.score - a.score);
  for (const s of scored.slice(0, 6)) {
    lines.push(`  #${s.i} 黄金+预留 ${s.src}${s.card ? ` ${plainCard(s.card)}` : ''} — ${s.reasons.join(', ')}`);
  }
  return lines.join('\n');
}

// v2 系统提示词 = v1 全文, 仅改: 预留规则措辞(防"手里要有金"误解) / 思考清单加黄金检查 / 战术加黄金经济
const SYSTEM_PROMPT_V2 = `你是 Splendor Duel(璀璨宝石对决)棋手, 目标是赢下双人对抗.
思考与回复一律用中文.

== 身份指代(重要) ==
局面报告里【我方】永远指你自己(当前行动方); 【对手】指与你对弈的另一个人.
其中的玩家名字只是界面标签(可能是 LLM/你/任意字符串), 与"你"的指代无关, 不要被名字干扰.

== 规则摘要 ==
- 棋盘 5x5 随机放 25 个 token: 白/蓝/绿/红/黑各4, 珍珠2, 黄金3. 花掉的 token 进袋, 补货时洗匀回填.
- 每回合分两步:
  [可选] 用特权(每枚从棋盘拿任意非金token) 和/或 补货(对手得1特权), 顺序任选;
  [必须] 三选一: 1) 拿1-3个横/竖/斜连续相邻的非金token(黄金和空格会阻断; 3个同色或含2珍珠 => 对手得1特权, 列表中已标 ⚠)
    2) 预留: 从棋盘拿1枚黄金入手 + 预留1张卡(金字塔任意张明留或牌库顶盲留, 最多3张). 注意: 黄金是【拿入手】的万能token(之后买卡时当任意色支付), 预留不花费任何东西; 前提是棋盘上还有黄金格.
    3) 购买1张卡(金字塔或自己预留的).
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
1. 威胁: 对手下回合能赢吗(看报告中【对手威胁】【对手预留进度】)? 能 => 一切让位于阻断(买走/预留其获胜卡/拿走其所需色).
2. 对手路线: 对手在冲哪条胜利路线(20分/10冠/同色10分)? 本步如何顺带干扰(拿其色/买走其目标卡/预留)?
3. 我的计划: 我的2-3回合目标(下两张买什么/冲哪条路线)? 对照上回合备忘, 计划变了就更新.
3.5 黄金检查: 棋盘有黄金且我预留未满3 => 认真读【预留评估】, 预留同时完成"拿1万能金推进买卡"+"锁走对手要的卡"; 若既补不了缺色也无封锁价值才放弃, 放弃要一句话说清为什么.
4. 选择: 选同时推进第3项和第2项的行动(双目的最优).
每次提交走法前, 用一行"备忘:"总结当前计划+对手最大威胁(下回合开头先读自己的备忘).

== 战术攻略(splendortactics.com 全部攻略 + 高分玩家数据提炼, 务必遵守) ==
[基本盘] 全局仅15-20回合, 浪费一回合≈输掉5-7%胜率; 胜率统计: 20分~65% / 同色10分~20% / 10冠~10%; 高手平均皇冠≈5.6, 皇家卡≈1.5 => 顺路凑3-6皇冠拿皇家是基线而非可选. 袋内容公开可算: 各色4+珍珠2+黄金3减去棋盘与双方持有即得.
[黄金经济] 全局仅3枚黄金在棋盘流转, 每枚=1次万能支付+1次锁卡; 对手连番预留会把黄金抽干, 之后所有人都无法预留. 拿金的两条硬理由: (a)你1-2回合内要用万能金补缺色买卡; (b)对手1-2回合内能买走的卡(尤其其明留目标/跨胜利线的卡)值得锁. 两条都不满足才考虑别的.
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
[token纪律] 宝石是燃料不是财富, 攒4-5个却无下回合购买计划=浪费; 拿3异色优先, 且尽量让3色同时服务两张卡(主目标+顺路L1). 黄金是过桥不是存款, 1-2回合内花掉. 预留=手术刀: 只预留2-3回合内买得起的卡; 手里始终留1张随时买得起的便宜卡当"安全阀"(让对手被迫补货而你吃特权). 拿3同色或2珍珠会送对手特权(列表已标⚠), 慎重. 超10弃置提前规划.
[防守时机] 前5回合几乎不阻断(自建引擎优先); 中局只做双目的阻断; 危局(对手15分/7冠/单色7分)阻断开为一等公民. 三个具体防守: 对手要拿偷取卡=>先花掉珍珠; 对手下一买触发皇家卡=>用黄金预留那张皇冠卡; 对手能先你买走目标卡=>立即转向别再攒那色.
[胜利路线] 10-12回合前保持至少两条胜利路径(分/皇冠/单色)形成压力迫使对手分散防守, 之后全速冲一条; 领先抢节奏结束, 落后用封锁拖慢. 同色胜利多在中局自然形成: 每次购买后统计自己单色分数, 6-7分时盯住该色高分卡和百搭卡(百搭能让颜色胜利从7跳到10).`;

export function llm2Agent(opts: LlmOptions = {}): Agent {
  return llmAgent({
    ...opts,
    name: opts.name ?? 'LLM2',
    systemPrompt: SYSTEM_PROMPT_V2,
    contextExtra: reserveThreats,
    actionList: actionListV2,
    digest: digestV2,
  });
}
