// Web 服务: 静态页面 + 对局 REST API
import {
  applyMove, applyOption, applyReplenish, isDeadState, legalMoves, playerView,
  type GameState, type Move, type TokenColor, type Gem, type CardDef, type RoyalDef,
} from '../engine/game.js';
import { randomAgent } from '../agents/random.js';
import { greedyAgent } from '../agents/greedy.js';
import { workerSearchAgent } from '../agents/search-agent.js';
import { llmAgent } from '../agents/llm.js';
import { llm2Agent } from '../agents/llm2.js';
import { llm3Agent } from '../agents/llm3.js';
import type { Agent, TurnContext } from '../agents/agent.js';
import { actionText } from '../render.js';
import { GameRecorder, readSession, replayGame } from '../recorder.js';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

/** 走法可视化快照: 应用前抓取卡面/颜色, 供前端图示 bot 操作 */
interface MoveVisual {
  action: Move['action'];
  takeGems?: (TokenColor | null)[];
  privGems?: (TokenColor | null)[];
  card?: CardDef | null; // 盲留时为 null
  royal?: RoyalDef | null;
  stealGem?: TokenColor;
  associateGem?: Gem;
  takeSameGem?: TokenColor | null;
  refill?: CardDef | null; // 金字塔补位新卡
  deltas?: { points: number; crowns: number; privileges: number; tokens: number; cards: number };
  replenished?: boolean;
}

interface Game {
  state: GameState;
  agents: [Agent, Agent];
  mode: 'human' | 'agents';
  humanSeat: 0 | 1;
  history: GameState[]; // 每步快照(观战回放)
  botPromise?: Promise<void>; // bot 推进中 (去重并发请求)
  botMessage?: { name: string; text: string } | null; // LLM bot 最近一次原始输出
  moveFeed: MoveVisual[]; // 自人类上次走法以来的 bot 操作快照
  recorder: GameRecorder; // 对局级会话记录(sessions/)
}

const games = new Map<string, Game>();
let gameSeq = 0;

function makeBot(spec: string, onThinking?: (name: string, text: string) => void): Agent {
  const [kind, ...rest] = spec.split('@');
  const arg = rest.join(':');
  switch (kind) {
    case 'random': return randomAgent();
    case 'ab':
    case 'mcts': {
      // 后缀 @ms 控制每步搜索时间上限: ab / ab@3000 / mcts / mcts@3000; 搜索在 worker 子线程
      return workerSearchAgent(spec, kind === 'ab' ? 'αβbot' : 'MCTSbot');
    }
    case 'greedy': return greedyAgent();
    case 'llm':
    case 'llm2':
    case 'llm3': {
      // 后缀 @off/@low/@medium/@high 控制思考预算: llm / llm:model / llm:model@low
      const at = arg.lastIndexOf('@');
      const lv = at > 0 ? arg.slice(at + 1) : '';
      const thinkingLevel = (['off', 'low', 'medium', 'high'] as const).find((x) => x === lv);
      const model = (at > 0 ? arg.slice(0, at) : arg).replace(/@+$/, '');
      const label = kind === 'llm' ? 'LLM' : kind === 'llm2' ? 'LLM2' : 'LLM3';
      const make = kind === 'llm' ? llmAgent : kind === 'llm2' ? llm2Agent : llm3Agent;
      const agent = make({
        model: model || undefined,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        name: arg ? `${label}(${arg.split('/').pop()})` : label,
        ...(onThinking ? { onThinking: (text: string) => onThinking(agent.name, text) } : {}),
      });
      return agent;
    }
    default: throw new Error(`未知 agent: ${kind}`);
  }
}

function enrichedLegal(state: GameState, seat: 0 | 1) {
  const lm = legalMoves(state);
  return {
    actions: lm.actions.map((action, i) => ({ i, action, desc: actionText(state, seat, action) })),
    canReplenish: lm.canReplenish,
    mustReplenish: lm.mustReplenish,
    privilegeCells: lm.privilegeCells,
  };
}

function statePayload(g: Game, seat: 0 | 1) {
  const st = g.state;
  if (st.winner !== null || st.draw) g.recorder.result(st.winner, st.turnCount);
  return {
    view: playerView(st, seat),
    seat,
    current: st.current,
    turn: st.turnCount,
    over: st.winner !== null || st.draw,
    winner: st.winner,
    draw: st.draw,
    winReason: st.winner !== null ? (st.players[st.winner]!.points >= 20 ? '20分' : st.players[st.winner]!.crowns >= 10 ? '10皇冠' : '同色10分') : null,
    legal: st.winner === null && !st.draw && st.current === seat ? enrichedLegal(st, seat) : null,
    names: [st.players[0].name, st.players[1].name],
    recentMoves: g.moveFeed,
    botMessage: g.botMessage ?? null,
    pending: g.mode === 'human' && st.winner === null && !st.draw && st.current !== g.humanSeat, // bot 待行动, 前端需调 /api/bot
  };
}

/** 人机模式: 跑 bot 直到轮到人类或结束 (并发调用共享同一次执行) */
async function runBots(g: Game): Promise<void> {
  g.botPromise ??= (async () => {
    await advanceUntilHumanOrOver(g);
    ensurePlayable(g);
  })().finally(() => { g.botPromise = undefined; });
  await g.botPromise;
}

/** 跑一个 bot 回合(含被迫补货); 返回是否继续 */
async function runBotTurn(g: Game): Promise<boolean> {
  let st = g.state;
  if (st.winner !== null || st.draw) return false;
  if (isDeadState(st)) {
    st = { ...st, draw: true };
    st.log.push('双方均无法行动, 判和局');
    g.state = st;
    return false;
  }
  let lm = legalMoves(st);
  if (lm.mustReplenish) {
    g.recorder.replenish();
    st = applyReplenish(st);
    lm = legalMoves(st);
    if (lm.actions.length === 0) {
      g.state = st;
      return false;
    }
  }
  const seat = st.current;
  const agent = g.agents[seat]!;
  const ctx: TurnContext = { seat, view: playerView(st, seat), legal: lm, turn: st.turnCount };
  let move: Move;
  try {
    move = await agent.chooseMove(ctx);
    if (agent.lastRaw) g.botMessage = { name: agent.name, text: agent.lastRaw };
    g.recorder.move(seat, st.turnCount, move, undefined, agent.lastRaw || undefined);
  } catch (err) {
    st.log.push(`⚠ ${agent.name} 非法走法(${(err as Error).message}), 兜底随机`);
    move = { action: lm.actions[Math.floor(Math.random() * lm.actions.length)]! };
    g.recorder.move(seat, st.turnCount, move);
  }
  const next = applyMove(st, move);
  g.moveFeed.push(botVisual(st, next, seat, move));
  if (g.moveFeed.length > 20) g.moveFeed.splice(0, g.moveFeed.length - 20); // ponytail: 环形上限, agents 模式防无限增长
  g.state = next;
  g.history.push(next);
  return g.state.winner === null && !g.state.draw;
}

async function advanceUntilHumanOrOver(g: Game): Promise<void> {
  let guard = 0;
  while (g.state.winner === null && !g.state.draw && g.state.current !== g.humanSeat) {
    if (g.mode !== 'human') break; // agents 模式由前端 step 驱动
    const more = await runBotTurn(g);
    if (!more) break;
    if (++guard > 200) break;
  }
}

/** 在应用走法前抓取可视化数据 (卡面/宝石颜色), 之后棋盘状态就变了 */
/** 应用前抓卡面/颜色, 应用后抓补位与数值变化; 供前端图示 bot 操作 */
function botVisual(before: GameState, after: GameState, seat: 0 | 1, move: Move): MoveVisual {
  const v = snapshotMove(before, seat, move);
  const a = move.action;
  if ((a.kind === 'buy' || a.kind === 'reserve') && a.from.kind === 'pyramid') {
    v.refill = after.pyramid[a.from.slot] ?? null; // 购买/预留后补位的新卡
  }
  const b = before.players[seat]!, n = after.players[seat]!;
  const sum = (p: typeof b) => (Object.values(p.tokens) as number[]).reduce((s, x) => s + x, 0);
  v.deltas = {
    points: n.points - b.points,
    crowns: n.crowns - b.crowns,
    privileges: n.privileges - b.privileges,
    tokens: sum(n) - sum(b),
    cards: n.cards.length - b.cards.length,
  };
  return v;
}

function snapshotMove(st: GameState, seat: 0 | 1, move: Move): MoveVisual {
  const a = move.action;
  const v: MoveVisual = { action: a };
  if (a.kind === 'take') v.takeGems = a.cells.map((c) => st.board[c] ?? null);
  if (a.kind === 'buy' || a.kind === 'reserve') {
    const from = a.from;
    v.card = from.kind === 'pyramid' ? st.pyramid[from.slot] ?? null
      : from.kind === 'deck' ? null // 盲留卡面保密
        : st.players[seat].reserved[from.index] ?? null;
  }
  if (move.privileges?.length) v.privGems = move.privileges.map((c) => st.board[c] ?? null);
  if (move.replenish) v.replenished = true;
  if (move.stealPick) v.stealGem = move.stealPick;
  if (move.associateColor) v.associateGem = move.associateColor;
  if (move.takeSameCell != null) v.takeSameGem = st.board[move.takeSameCell] ?? null;
  if (move.royalPick != null) v.royal = st.royals[move.royalPick] ?? null;
  return v;
}

/** 轮到方无任何强制行动时: 自动补货(对手得1特权); 双方都无路可走则判和 */
function ensurePlayable(g: Game): void {
  let guard = 0;
  while (g.state.winner === null && !g.state.draw) {
    if (isDeadState(g.state)) {
      g.state = { ...g.state, draw: true };
      g.state.log.push('双方均无法行动, 判和局');
      return;
    }
    if (!legalMoves(g.state).mustReplenish) return;
    g.recorder.replenish();
    g.state = applyReplenish(g.state);
    g.history.push(g.state);
    if (++guard > 100) return;
  }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

function safeUrl(req: Request): URL {
  try {
    return new URL(req.url);
  } catch {
    return new URL('http://localhost/'); // Bun 的 req.url 实际总是合法, 兜底
  }
}

const PORT = Number(process.env.PORT ?? 3000);

Bun.serve({
  port: PORT,
  async fetch(req) {
    try {
      return await handle(req);
    } catch (err) {
      return json({ error: `服务器错误: ${(err as Error).message}` }, 500);
    }
  },
});

async function handle(req: Request): Promise<Response> {
  const url = safeUrl(req);
  const path = url.pathname;

    // 静态文件
    if (req.method === 'GET' && !path.startsWith('/api/')) {
      const file = path === '/' ? '/index.html' : path;
      const f = Bun.file(`public${file}`);
      if (await f.exists()) return new Response(f);
      return new Response('not found', { status: 404 });
    }

    // 新对局
    if (req.method === 'POST' && path === '/api/new') {
      const body = (await req.json()) as {
        mode: 'human' | 'agents'; p1?: string; p2?: string; humanSeat?: 0 | 1; seed?: number;
      };
      const id = `g${++gameSeq}`;
      // 流式展示: LLM 思考过程中实时写入 botMessage, 前端轮询 /api/state 拉取
      const onBotThinking = (name: string, text: string) => {
        const gg = games.get(id);
        if (gg) gg.botMessage = { name, text };
      };
      let g: Game;
      const seed = body.seed ?? Math.floor(Math.random() * 2 ** 31);
      if (body.mode === 'human') {
        const humanSeat = body.humanSeat ?? 1;
        const botSpec = humanSeat === 0 ? (body.p2 ?? 'greedy') : (body.p1 ?? 'greedy');
        const bot = makeBot(botSpec, onBotThinking);
        const agents: [Agent, Agent] = humanSeat === 0 ? [{ name: '你' } as Agent, bot] : [bot, { name: '你' } as Agent];
        const names: [string, string] = humanSeat === 0 ? ['你', bot.name] : [bot.name, '你'];
        const specs: [string, string] = humanSeat === 0 ? ['human', botSpec] : [botSpec, 'human'];
        g = {
          state: newGame({ names, firstSeat: 0, seed }), agents, mode: 'human', humanSeat, history: [], moveFeed: [],
          recorder: new GameRecorder({ seed, names, specs, mode: 'human', firstSeat: 0, humanSeat }),
        };
        // bot 先手时立即返回 (pending=true), 前端调 /api/bot 等待, 避免长时间无反馈
      } else {
        const a1 = makeBot(body.p1 ?? 'greedy', onBotThinking);
        const a2 = makeBot(body.p2 ?? 'random', onBotThinking);
        const names: [string, string] = [a1.name, a2.name];
        const specs: [string, string] = [body.p1 ?? 'greedy', body.p2 ?? 'random'];
        g = {
          state: newGame({ names, firstSeat: 0, seed }), agents: [a1, a2], mode: 'agents', humanSeat: 0, history: [], moveFeed: [],
          recorder: new GameRecorder({ seed, names, specs, mode: 'agents', firstSeat: 0 }),
        };
      }
      games.set(id, g);
      return json({ id, mode: g.mode, humanSeat: g.humanSeat, file: basename(g.recorder.path), ...statePayload(g, g.mode === 'human' ? g.humanSeat : 0) });
    }

    // 会话列表(供 resume 选择, 新到老)
    if (req.method === 'GET' && path === '/api/sessions') {
      const dir = join(process.cwd(), 'sessions');
      let files: string[] = [];
      try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).reverse(); } catch { /* 目录不存在 */ }
      const out = [];
      for (const f of files.slice(0, 50)) {
        try {
          const { meta, events } = readSession(f);
          const res = events.filter((e) => e.t === 'result').pop();
          out.push({
            file: f, started: meta.started, names: meta.names, specs: meta.specs ?? null,
            mode: meta.mode ?? 'agents', moves: events.filter((e) => e.t === 'move').length,
            ...(res ? { outcome: res.outcome as string, turns: res.turns as number } : { outcome: '未完' }),
          });
        } catch { /* 坏文件跳过 */ }
      }
      return json(out);
    }

    // 从会话文件续局: 重放到末尾, 未结束则接着下.
    // 只给 file 时按 meta 原配置(模式/人类座位/双方 spec)重建, 供刷新页面自动续局; 显式字段可覆盖.
    if (req.method === 'POST' && path === '/api/resume') {
      const body = (await req.json()) as { file: string; mode?: 'human' | 'agents'; p1?: string; p2?: string; humanSeat?: 0 | 1 };
      const s = readSession(body.file);
      const events = s.events.filter((e) => e.t !== 'result');
      const state = replayGame(s.meta, events);
      const id = `g${++gameSeq}`;
      const onBotThinking = (name: string, text: string) => {
        const gg = games.get(id);
        if (gg) gg.botMessage = { name, text };
      };
      const metaSpec = (i: 0 | 1, fb: string) => {
        const sp = s.meta.specs?.[i];
        return sp && sp !== 'human' ? sp : fb;
      };
      const mode = body.mode ?? (s.meta.mode === 'human' ? 'human' : 'agents');
      let g: Game;
      if (mode === 'human') {
        const humanSeat = body.humanSeat ?? s.meta.humanSeat ?? 1;
        const botSeat = (1 - humanSeat) as 0 | 1;
        const botSpec = (botSeat === 0 ? body.p1 : body.p2) ?? metaSpec(botSeat, 'greedy');
        const bot = makeBot(botSpec, onBotThinking);
        const agents: [Agent, Agent] = humanSeat === 0 ? [{ name: '你' } as Agent, bot] : [bot, { name: '你' } as Agent];
        const specs: [string, string] = humanSeat === 0 ? ['human', botSpec] : [botSpec, 'human'];
        g = {
          state, agents, mode, humanSeat, history: [state], moveFeed: [],
          recorder: new GameRecorder({ seed: s.meta.seed, names: state.players.map((p) => p.name) as [string, string], specs, mode, firstSeat: s.meta.firstSeat, humanSeat, resumedFrom: basename(s.path), resume: { seed: s.meta.seed, firstSeat: s.meta.firstSeat, events } }),
        };
      } else {
        const a1 = makeBot(body.p1 ?? metaSpec(0, 'greedy'), onBotThinking);
        const a2 = makeBot(body.p2 ?? metaSpec(1, 'random'), onBotThinking);
        const specs: [string, string] = [body.p1 ?? metaSpec(0, 'greedy'), body.p2 ?? metaSpec(1, 'random')];
        g = {
          state, agents: [a1, a2], mode, humanSeat: 0, history: [state], moveFeed: [],
          recorder: new GameRecorder({ seed: s.meta.seed, names: state.players.map((p) => p.name) as [string, string], specs, mode, firstSeat: s.meta.firstSeat, resumedFrom: basename(s.path), resume: { seed: s.meta.seed, firstSeat: s.meta.firstSeat, events } }),
        };
      }
      games.set(id, g);
      return json({ id, mode: g.mode, humanSeat: g.humanSeat, resumedFile: basename(s.path), file: basename(g.recorder.path), ...statePayload(g, g.mode === 'human' ? g.humanSeat : 0) });
    }

    // 查询状态
    const mState = /^\/api\/state\/([\w-]+)$/.exec(path);
    if (req.method === 'GET' && mState) {
      const g = games.get(mState[1]!);
      if (!g) return json({ error: '对局不存在' }, 404);
      const seat = (Number(url.searchParams.get('seat') ?? 0) || 0) as 0 | 1;
      return json(statePayload(g, seat));
    }

    // 人机模式: 回合内可选行动即时执行 (特权拿 token / 主动补货), 确认后立刻生效
    const mOpt = /^\/api\/option\/([\w-]+)$/.exec(path);
    if (req.method === 'POST' && mOpt) {
      const g = games.get(mOpt[1]!);
      if (!g) return json({ error: '对局不存在' }, 404);
      if (g.mode !== 'human') return json({ error: '该对局不是人机模式' }, 400);
      const body = (await req.json()) as { seat: 0 | 1; privileges?: number[]; replenish?: boolean };
      if (g.state.current !== body.seat || g.state.winner !== null || g.state.draw) {
        return json({ error: '当前不是你的回合' }, 400);
      }
      if (!body.privileges?.length && !body.replenish) return json({ error: '无可执行的可选行动' }, 400);
      try {
        g.state = applyOption(g.state, { privileges: body.privileges, replenish: body.replenish });
        g.recorder.option(body.seat, body.privileges, body.replenish);
      } catch (err) {
        return json({ error: `操作无效: ${(err as Error).message}` }, 400);
      }
      g.history.push(g.state);
      return json(statePayload(g, g.humanSeat));
    }

    // 人类走法(人机模式)
    const mMove = /^\/api\/move\/([\w-]+)$/.exec(path);
    if (req.method === 'POST' && mMove) {
      const g = games.get(mMove[1]!);
      if (!g) return json({ error: '对局不存在' }, 404);
      if (g.mode !== 'human') return json({ error: '该对局不是人机模式' }, 400);
      const body = (await req.json()) as { seat: 0 | 1; move: Move };
      if (g.state.current !== body.seat || g.state.winner !== null || g.state.draw) {
        return json({ error: '当前不是你的回合' }, 400);
      }
      ensurePlayable(g); // 若人类无强制行动可走, 先自动补货
      try {
        g.state = applyMove(g.state, body.move);
        g.recorder.move(body.seat, g.state.turnCount, body.move);
      } catch (err) {
        return json({ error: `走法无效: ${(err as Error).message}` }, 400);
      }
      g.moveFeed = []; // 清空 bot 操作回顾, 下次轮到人类时重新收集
      g.history.push(g.state);
      // 立即返回: 人类操作已生效, bot 由前端调 /api/bot 推进
      return json({ ok: true, ...statePayload(g, g.humanSeat) });
    }

    // 人机模式: 推进 bot 直到轮到人类或结束
    const mBot = /^\/api\/bot\/([\w-]+)$/.exec(path);
    if (req.method === 'POST' && mBot) {
      const g = games.get(mBot[1]!);
      if (!g) return json({ error: '对局不存在' }, 404);
      if (g.mode !== 'human') return json({ error: '该对局不是人机模式' }, 400);
      const st = g.state;
      if (st.winner === null && !st.draw && st.current !== g.humanSeat) await runBots(g);
      return json(statePayload(g, g.humanSeat));
    }

    // agent 对战推进一步
    const mStep = /^\/api\/step\/([\w-]+)$/.exec(path);
    if (req.method === 'POST' && mStep) {
      const g = games.get(mStep[1]!);
      if (!g) return json({ error: '对局不存在' }, 404);
      if (g.mode !== 'agents') return json({ error: '该对局不是 agent 模式' }, 400);
      const ok = await runBotTurn(g);
      return json({ ok, ...statePayload(g, 0) });
    }

    return json({ error: '未知接口' }, 404);
}

import { createGame as newGame } from '../engine/game.js';

console.log(`✨ Splendor Duel Arena 已启动: http://localhost:${PORT}`);
