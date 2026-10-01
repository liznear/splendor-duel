// Web 服务: 静态页面 + 对局 REST API
import {
  applyMove, applyReplenish, isDeadState, legalMoves, playerView,
  type GameState, type Move,
} from '../engine/game.js';
import { randomAgent } from '../agents/random.js';
import { greedyAgent } from '../agents/greedy.js';
import { llmAgent } from '../agents/llm.js';
import type { Agent, TurnContext } from '../agents/agent.js';
import { actionText } from '../render.js';

interface Game {
  state: GameState;
  agents: [Agent, Agent];
  mode: 'human' | 'agents';
  humanSeat: 0 | 1;
  history: GameState[]; // 每步快照(观战回放)
}

const games = new Map<string, Game>();
let gameSeq = 0;

function makeBot(spec: string): Agent {
  const [kind, ...rest] = spec.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'random': return randomAgent();
    case 'greedy': return greedyAgent();
    case 'llm': return llmAgent({ model: arg || undefined, name: arg ? `LLM(${arg.split('/').pop()})` : 'LLM' });
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
  };
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
  let next: GameState;
  try {
    const move = await agent.chooseMove(ctx);
    next = applyMove(st, move);
  } catch (err) {
    st.log.push(`⚠ ${agent.name} 非法走法(${(err as Error).message}), 兜底随机`);
    const action = lm.actions[Math.floor(Math.random() * lm.actions.length)]!;
    next = applyMove(st, { action });
  }
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
        mode: 'human' | 'agents'; p1?: string; p2?: string; humanSeat?: 0 | 1;
      };
      const id = `g${++gameSeq}`;
      let g: Game;
      if (body.mode === 'human') {
        const humanSeat = body.humanSeat ?? 1;
        const botSpec = humanSeat === 0 ? (body.p2 ?? 'greedy') : (body.p1 ?? 'greedy');
        const bot = makeBot(botSpec);
        const agents: [Agent, Agent] = humanSeat === 0 ? [{ name: '你' } as Agent, bot] : [bot, { name: '你' } as Agent];
        g = { state: newGame({ names: humanSeat === 0 ? ['你', bot.name] : [bot.name, '你'] }), agents, mode: 'human', humanSeat, history: [] };
        // 若 bot 先手, 先跑
        await advanceUntilHumanOrOver(g);
      } else {
        const a1 = makeBot(body.p1 ?? 'greedy');
        const a2 = makeBot(body.p2 ?? 'random');
        g = { state: newGame({ names: [a1.name, a2.name] }), agents: [a1, a2], mode: 'agents', humanSeat: 0, history: [] };
      }
      games.set(id, g);
      return json({ id, mode: g.mode, humanSeat: g.humanSeat, ...statePayload(g, g.mode === 'human' ? g.humanSeat : 0) });
    }

    // 查询状态
    const mState = /^\/api\/state\/([\w-]+)$/.exec(path);
    if (req.method === 'GET' && mState) {
      const g = games.get(mState[1]!);
      if (!g) return json({ error: '对局不存在' }, 404);
      const seat = (Number(url.searchParams.get('seat') ?? 0) || 0) as 0 | 1;
      return json(statePayload(g, seat));
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
      let lm = legalMoves(g.state);
      if (lm.mustReplenish) {
        g.state = applyReplenish(g.state);
        lm = legalMoves(g.state);
      }
      try {
        g.state = applyMove(g.state, body.move);
      } catch (err) {
        return json({ error: `走法无效: ${(err as Error).message}` }, 400);
      }
      g.history.push(g.state);
      await advanceUntilHumanOrOver(g);
      return json({ ok: true, ...statePayload(g, g.humanSeat) });
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
