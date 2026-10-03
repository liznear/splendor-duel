// αβ 搜索 bot: negamax 迭代加深 + greedy 估值 (方案: search_based_agent_plan.md 阶段 1)
//
// 公平性红线:
// - 搜索只用 ctx.view / ctx.legal。对手盲留已被 playerView 抹成 HIDDEN_CARD,
//   树内对手回合滤掉对 hidden 卡的购买(0 费假动作), 即对手盲留视为 0 战力。
// - 严禁直接读 state.rngState 预测未来补货/抽牌(=作弊)。树内 mustReplenish 由引擎按
//   rngState 确定性结算, 搜索"看见某个注定的未来"——双方信息面近似对称, 方案已接受。
// - 估值平分抖动用自带种子的 mulberry32 步进, 不用 Math.random(), 同种子同局可复现。
import {
  applyMove, applyReplenish, GEMS, legalMoves, mulberry32Step,
  type Gem, type GameState, type LegalMoves, type MandatoryAction, type Move, type NonGold, type PlayerState,
} from '../engine/game.js';
import type { Agent, TurnContext } from './agent.js';
import { evaluate } from './greedy.js';

const WIN = 1e9;
const MAX_DEPTH = 4; // 方案: αβ 深度 3-4
const NEXT_ITER_GROWTH = 3; // 迭代加深: 下一层耗时预估 = 上一层 × 此系数
// 着法排序类别: 买入 > 预留 > 拿取; 同类内按静态启发分降序
const CLASS_RANK: Record<MandatoryAction['kind'], number> = { buy: 0, reserve: 1, take: 2 };
// 能力排序加成: 额外回合 > 特权 > 偷取/拿同色
const ABILITY_RANK: Record<string, number> = { turn: 40, privilege: 20, steal: 10, takeSame: 10 };

/** 根节点一步预演: action + 子状态(跨迭代复用) + 行动方 1 层贪心分 */
interface Step {
  action: MandatoryAction;
  child: GameState;
  score: number;
  val?: number; // 迭代加深上一轮的搜索分(根排序用)
}
class Timeout extends Error {}

export interface AbStats {
  moves: number;
  totalMs: number;
  maxDepth: number;
  timeouts: number; // 搜索被时间上限打断的步数
}

export function abAgent(opts: { name?: string; timeMs?: number; seed?: number } = {}): Agent & { stats: AbStats } {
  const timeMs = opts.timeMs ?? 4000; // 每步时间上限(spec 可调 ab@ms)
  const rngState = { rngState: opts.seed ?? 0x6d2b79f5 };
  // 所有叶估值共用同一条种子随机流(平分抖动), 同种子同局可复现
  // 估值修正(阶段 2 手调, 只作用于 ab; 基础分仍是 greedy.evaluate):
  // ① 对手盲留折算: 每张按等级折成兑现威胁(风险表缓解项; 源自 vs LLM3 败局: 终局盲留 L3 两次 +4 跳分冲线)
  // ② 皇冠里程碑急迫: 距 3/6 冠皇家卡 1-2 冠时计入威胁(败局: 对手 6 冠皇家 +3 分冲线)
  // ③ 终局冲刺: ≥14 分后接近 20 分超线性增值(竞速博弈的到达时间; 败局: 全程领先却被冲线反超)
  const HIDDEN_VALUE: Record<1 | 2 | 3, number> = { 1: 40, 2: 90, 3: 150 };
  const crownThreat = (p: PlayerState): number => {
    const dist = (p.royalsTaken === 0 ? 3 : 6) - p.crowns;
    return dist === 1 ? 80 : dist === 2 ? 30 : 0;
  };
  const sprint = (p: PlayerState): number => (p.points >= 14 ? (p.points - 13) ** 2 * 6 : 0);
  const evalLeaf = (s: GameState, seat: 0 | 1): number => {
    const opp = s.players[1 - seat]!;
    let hidden = 0;
    for (const c of opp.reserved) if (c.id === 'hidden') hidden += HIDDEN_VALUE[c.level];
    const me = s.players[seat]!;
    return evaluate(s, seat, () => mulberry32Step(rngState))
      - 0.75 * (hidden + crownThreat(opp) + sprint(opp))
      + crownThreat(me) + sprint(me);
  };
  const stats: AbStats = { moves: 0, totalMs: 0, maxDepth: 0, timeouts: 0 };

  // ---------------------------------------------------------------- 搜索树

  /** 处理 mustReplenish(与 arena 主循环一致); 返回 null = 死局和棋 */
  function expand(state: GameState): { state: GameState; lm: LegalMoves } | null {
    let lm = legalMoves(state);
    while (lm.actions.length === 0) {
      if (!lm.canReplenish) return null;
      state = applyReplenish(state);
      lm = legalMoves(state);
    }
    return { state, lm };
  }

  /** 树内行动过滤: 对手盲留(id='hidden', 0 费恒可买)不进树, 视为 0 战力 */
  function treeActions(state: GameState, lm: LegalMoves): MandatoryAction[] {
    const p = state.players[state.current]!;
    return lm.actions.filter((a) =>
      !(a.kind === 'buy' && a.from.kind === 'reserved' && p.reserved[a.from.index!]!.id === 'hidden'));
  }

  /** 不 applyMove 的静态着法分(仅排序用): 买入按分/冠/折扣/能力, 拿取按 token 价值 */
  function staticScore(state: GameState, a: MandatoryAction): number {
    if (a.kind === 'buy') {
      const p = state.players[state.current]!;
      const card = a.from.kind === 'pyramid' ? state.pyramid[a.from.slot]! : p.reserved[a.from.index]!;
      return card.points * 100 + card.crowns * 35 + card.bonus * 14 + (card.ability ? ABILITY_RANK[card.ability] ?? 0 : 0);
    }
    if (a.kind === 'reserve') return 0;
    return a.cells.reduce((s, cell) => s + (state.board[cell] === 'pearl' ? 8 : state.board[cell] ? 1.5 : 0), 0);
  }

  /**
   * negamax: 返回 state.current 视角分值。
   * 惰性展开: 逐个 applyMove+立即递归, cutoff 后不再生成剩余子节点
   * (applyMove=structuredClone 是最大开销, 全量展开会吞掉剪枝收益)。
   * 本引擎有两种"行动方不切换"的情况, 取负号前必须判明:
   * ① 行动触发胜利(applyMove 提前 return, current 不变);
   * ② 'turn' 能力/皇家卡的额外回合(current 不变, 同一方连走)。
   */
  function negamax(state: GameState, depth: number, alpha: number, beta: number, ply: number, deadline: number): number {
    if (state.winner !== null) return state.winner === state.current ? WIN - ply : -WIN + ply;
    const ex = expand(state);
    if (!ex) return 0; // 双方均无法行动: 和棋
    const { state: st, lm } = ex;
    const who = st.current;
    if (depth <= 0) return evalLeaf(st, who);
    const actions = treeActions(st, lm);
    if (actions.length === 0) return evalLeaf(st, who); // 只剩对手盲留假购买: 按现状估值
    actions.sort((x, y) => CLASS_RANK[x.kind] - CLASS_RANK[y.kind] || staticScore(st, y) - staticScore(st, x));
    let best = -Infinity;
    for (const action of actions) {
      if (Date.now() > deadline) throw new Timeout();
      const child = applyMove(st, { action });
      const v = child.winner === who ? WIN - ply - 1
        : child.current === who
          ? negamax(child, depth - 1, alpha, beta, ply + 1, deadline) // 额外回合: 同视角不取负
          : -negamax(child, depth - 1, -beta, -alpha, ply + 1, deadline);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  // ---------------------------------------------------------------- 根节点 1 层修正 (v1 刻意简化: 特权/补货不进树)

  function trySim(view: GameState, seat: 0 | 1, move: Move): number {
    try {
      return evalLeaf(applyMove(view, move), seat);
    } catch {
      return -Infinity;
    }
  }

  /** 条件参数枚举修正: stealPick / takeSameCell / associateColor / royalPick 引擎缺省有默认, root 逐项试最优 */
  function refineConditional(view: GameState, seat: 0 | 1, move: Move): Move {
    let best = move;
    let bestScore = trySim(view, seat, move);
    const cands: Move[] = [];
    if (move.action.kind === 'buy') {
      const p = view.players[seat]!;
      const card = move.action.from.kind === 'pyramid'
        ? view.pyramid[move.action.from.slot]!
        : p.reserved[move.action.from.index]!;
      if (card.ability === 'steal') {
        for (const c of [...GEMS, 'pearl'] as NonGold[]) cands.push({ ...move, stealPick: c });
      }
      if (card.ability === 'takeSame' && card.color) {
        view.board.forEach((t, i) => { if (t === card.color) cands.push({ ...move, takeSameCell: i }); });
      }
      if (card.isAssociate) {
        for (const c of new Set(p.cards.map((oc) => oc.color).filter((c): c is Gem => c != null))) {
          cands.push({ ...move, associateColor: c });
        }
      }
      // 跨 3/6 冠里程碑会领皇家卡: 逐张试
      const crownsAfter = p.crowns + card.crowns;
      if ((crownsAfter >= 3 && p.royalsTaken === 0) || (crownsAfter >= 6 && p.royalsTaken <= 1)) {
        for (let i = 0; i < view.royals.length; i++) cands.push({ ...move, royalPick: i });
      }
    }
    for (const m of cands) {
      const s = trySim(view, seat, m);
      if (s > bestScore) { bestScore = s; best = m; }
    }
    return best;
  }

  /** 特权: 对已选行动逐枚贪心补最优格(特权在 action 前结算, 用行动前的棋盘格; 同 greedy.ts) */
  function refinePrivileges(ctx: TurnContext, move: Move): Move {
    const p = ctx.view.players[ctx.seat]!;
    let cur = move;
    let curScore = trySim(ctx.view, ctx.seat, cur);
    for (let k = 0; k < p.privileges; k++) {
      let bestCell: number | null = null;
      for (const cell of ctx.legal.privilegeCells) {
        if ((cur.privileges ?? []).includes(cell)) continue;
        const s = trySim(ctx.view, ctx.seat, { ...cur, privileges: [...(cur.privileges ?? []), cell] });
        if (s > curScore) { curScore = s; bestCell = cell; }
      }
      if (bestCell == null) break;
      cur = { ...cur, privileges: [...(cur.privileges ?? []), bestCell] };
    }
    return cur;
  }

  /** 自愿补货只在明显有利时(补货给对手 1 特权 ≈ -6.75 估值, 阈值 5) */
  function refineReplenish(view: GameState, seat: 0 | 1, move: Move): Move {
    const r = trySim(view, seat, { ...move, replenish: true });
    return r > trySim(view, seat, move) + 5 ? { ...move, replenish: true } : move;
  }

  // ---------------------------------------------------------------- 主入口

  const agent: Agent & { stats: AbStats } = {
    name: opts.name ?? `αβbot(${Math.round(timeMs / 1000)}s)`,
    stats,
    async chooseMove(ctx: TurnContext) {
      const t0 = Date.now();
      const deadline = t0 + timeMs;
      stats.moves++;
      const me = ctx.seat;

      // 根全量展开一次(跨迭代复用子状态) + 一步胜线: 存在买了即赢直接返回, 不进搜索
      const rootSteps: Step[] = ctx.legal.actions.map((action) => {
        const child = applyMove(ctx.view, { action });
        return { action, child, score: child.winner === me ? WIN : evalLeaf(child, me) };
      });
      rootSteps.sort((x, y) =>
        CLASS_RANK[x.action.kind] - CLASS_RANK[y.action.kind] || y.score - x.score);
      for (const s of rootSteps) {
        if (s.child.winner === me) {
          stats.totalMs += Date.now() - t0;
          return { action: s.action };
        }
      }

      // 迭代加深 d1→4: 根按上轮搜索分降序; 下一层预估超时就不再启动(结果仍是上一层完整值)
      let best = rootSteps[0]!; // 兜底 = 1 层贪心最优
      let lastIterMs = 0;
      for (let d = 1; d <= MAX_DEPTH; d++) {
        if (lastIterMs > 0 && Date.now() + lastIterMs * NEXT_ITER_GROWTH > deadline) break;
        const iterStart = Date.now();
        try {
          let alpha = -Infinity;
          for (const s of rootSteps) {
            const v = s.child.current === me
              ? negamax(s.child, d - 1, alpha, Infinity, 1, deadline) // 额外回合: 同视角
              : -negamax(s.child, d - 1, -Infinity, -alpha, 1, deadline);
            s.val = v;
            if (v > alpha) { alpha = v; best = s; }
          }
          rootSteps.sort((a, b) => (b.val ?? -Infinity) - (a.val ?? -Infinity));
          stats.maxDepth = Math.max(stats.maxDepth, d);
          lastIterMs = Date.now() - iterStart;
          if (alpha >= WIN / 2) break; // 已见必胜线, 无需加深
        } catch (Timeout) {
          if (d > 1) stats.timeouts++;
          break;
        }
      }

      const move = refineReplenish(
        ctx.view, me,
        refinePrivileges(ctx, refineConditional(ctx.view, me, { action: best.action })),
      );
      stats.totalMs += Date.now() - t0;
      return move;
    },
  };
  return agent;
}
