// 前端主逻辑 (DOM API 构建, 无 innerHTML)
// 交互模型: 直接点击棋盘格/卡片构建走法, 与 legalMoves 匹配后提交
import { previewTokens, excessOf } from './preview.js';
const $ = (s) => document.querySelector(s);
const TZH = { white: '白', blue: '蓝', green: '绿', red: '红', black: '黑', pearl: '珠', gold: '金' };
const TCSS = { white: 't-white', blue: 't-blue', green: 't-green', red: 't-red', black: 't-black', pearl: 't-pearl', gold: 't-gold' };
const GEMZH = { white: '白', blue: '蓝', green: '绿', red: '红', black: '黑' };
const ABZH = { turn: '额外回合', takeSame: '拿同色', steal: '偷取', privilege: '特权' };
const COST_ORDER = ['white', 'blue', 'green', 'red', 'black', 'pearl'];
const PEARL_COLORS = ['white', 'blue', 'green', 'red', 'black', 'pearl'];
const ALL_COLORS = [...PEARL_COLORS, 'gold'];

let G = null; // {id, mode, seat, view, legal, over, winner, draw, ...}
// ui.pick: {t:'take',cells:[]} | {t:'card',slot,want} | {t:'deck',level,want} | {t:'buyRes',index} | null
let ui = { pick: null, action: null, privileges: [], phase: 'main', replenish: false, takeSamePick: null, extras: {} };
let autoTimer = null;

async function api(path, body) {
  const r = await fetch(path, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null && text !== '') d.textContent = text;
  return d;
}
function span(cls, text) { return el('span', cls, text); }

const cellName = (i) => `${'ABCDE'[i % 5]}${Math.floor(i / 5) + 1}`;

// ---------------- 宝石 / 卡片组件 ----------------
function gemEl(color) { return el('span', `gem ${TCSS[color]}`); }

function cardTitle(def, chosenColor) {
  const color = chosenColor ?? def.color;
  const parts = [];
  if (def.points) parts.push(`${def.points}分`);
  if (def.crowns) parts.push(`♛${def.crowns}`);
  parts.push(def.isAssociate ? (color ? `百搭→${GEMZH[color]}` : '百搭卡') : color ? `${GEMZH[color]}卡` : '分卡');
  if (def.ability) parts.push(ABZH[def.ability]);
  if (def.cost) parts.push(`费用 ${COST_ORDER.filter((k) => def.cost[k] > 0).map((k) => `${GEMZH[k] ?? TZH[k]}×${def.cost[k]}`).join(' ')}`);
  return parts.join(' · ');
}

/** 图片实体卡: /cards/{id}.png, 槽号 + 悬停/选中环 */
function cardEl(c, opts = {}) {
  const card = el('div', `card img-card${opts.clickable ? ' clickable' : ''}${opts.selected ? ' selected' : ''}${opts.affordable ? ' affordable' : ''}`);
  if (opts.slot != null) card.append(span('slot', String(opts.slot + 1)));
  const img = el('img');
  img.src = `/cards/${c.id}.png`;
  img.alt = cardTitle(c);
  img.loading = 'lazy';
  card.append(img);
  card.title = opts.affordable ? `${cardTitle(c)} · 本回合可购买` : cardTitle(c);
  return card;
}

/** 空槽卡背 */
function cardBack(slot) {
  const back = el('div', 'card back');
  back.append(span('slot', `[${slot + 1}]`), span('q', '?'));
  back.title = '空槽';
  return back;
}

/** 小卡: 图片缩略 (已购/预留), def.id 为 hidden 时显示卡背 */
function miniCard(def, chosenColor, showBig, opts = {}) {
  if (def.id === 'hidden') return miniBack();
  const m = el('div', `mini${showBig ? ' mc-cost' : ''}${opts.clickable ? ' clickable' : ''}${opts.selected ? ' selected' : ''}${opts.affordable ? ' affordable' : ''}`);
  const img = el('img');
  img.src = `/cards/${def.id}.png`;
  img.alt = cardTitle(def, chosenColor);
  img.loading = 'lazy';
  m.append(img);
  m.title = opts.affordable ? `${cardTitle(def, chosenColor)} · 本回合可购买` : cardTitle(def, chosenColor);
  return m;
}
/** 盲留卡背 */
function miniBack() {
  const m = el('div', 'mini back');
  m.append(span('q', '?'));
  m.title = '盲留卡(保密)';
  return m;
}
function miniRoyal(r) {
  const m = el('div', 'mini rroyal');
  const img = el('img');
  img.src = `/cards/${r.id}.png`;
  img.alt = `皇家卡 ${r.points}分`;
  img.loading = 'lazy';
  m.append(img);
  m.title = `皇家卡 ${r.points}分${r.ability ? ` · ${ABZH[r.ability]}` : ''}`;
  return m;
}
function royalBtn(r, picked, onPick) {
  const b = el('button', `royal${picked ? ' picked' : ''}`);
  const img = el('img');
  img.src = `/cards/${r.id}.png`;
  img.alt = `皇家卡 ${r.points}分`;
  b.append(img);
  b.title = `皇家卡 ${r.points}分${r.ability ? ` · ${ABZH[r.ability]}` : ''}`;
  b.addEventListener('click', () => { onPick(); render(); });
  return b;
}

// ---------------- 走法构建与匹配 ----------------
const myTurn = () => G.mode === 'human' && G.legal != null && !G.over;
const sortedCells = (cs) => [...cs].sort((a, b) => a - b);

/** 在合法行动表中找结构匹配项 */
function matchAction(candidate) {
  if (!candidate) return null;
  for (const a of G.legal.actions) {
    const m = a.action;
    if (candidate.kind === 'take' && m.kind === 'take') {
      if (sortedCells(m.cells).join() === sortedCells(candidate.cells).join()) return a;
    } else if (candidate.kind === 'buy' && m.kind === 'buy') {
      if (JSON.stringify(m.from) === JSON.stringify(candidate.from)) return a;
    } else if (candidate.kind === 'reserve' && m.kind === 'reserve') {
      if (m.goldCell === candidate.goldCell && JSON.stringify(m.from) === JSON.stringify(candidate.from)) return a;
    }
  }
  return null;
}

/** 一组格是否为合法直线相邻段(仅 UX 预判, 最终以 legalMoves 为准) */
function validTakeSet(cs) {
  if (cs.length < 1 || cs.length > 3) return false;
  const pts = cs.map((i) => ({ r: Math.floor(i / 5), c: i % 5, i })).sort((a, b) => a.r - b.r || a.c - b.c);
  const sameR = pts.every((p) => p.r === pts[0].r);
  const sameC = pts.every((p) => p.c === pts[0].c);
  const d1 = pts.every((p) => p.r - p.c === pts[0].r - pts[0].c);
  const d2 = pts.every((p) => p.r + p.c === pts[0].r + pts[0].c);
  if (!(sameR || sameC || d1 || d2)) return false;
  for (let k = 1; k < pts.length; k++) {
    const dr = pts[k].r - pts[k - 1].r;
    const dc = pts[k].c - pts[k - 1].c;
    if (!((dr === 0 && dc === 1) || dr === 1)) return false;
  }
  return true;
}

const goldCells = () => G.view.board.map((t, i) => (t === 'gold' ? i : -1)).filter((i) => i >= 0);

/** 特权/补货是低频可选行动: 不自动弹窗, 由侧栏按钮按需打开 */
function freshUi() {
  return { pick: null, action: null, privileges: [], phase: 'main', takeSamePick: null, extras: {}, hint: '', extrasOpen: false, showBotMove: false, noticeSeen: null };
}
/** 被迫补货提示的去重键: 文本可能跨回合相同, 拼上回合号 */
const noticeKey = () => `${G.turn}:${G.notice}`;
/** 有未读的被迫补货提示 (仅自己被迫时弹 modal, bot 被迫只走提示条) */
const noticePending = () => G.mode === 'human' && !G.over && G.notice && ui.noticeSeen !== noticeKey();
/** bot 走完后展示其操作回顾 (需要关闭才回到棋盘) */
function revealBotMove() {
  ui = freshUi();
  ui.showBotMove = !G.over && (G.recentMoves?.length ?? 0) > 0;
  render();
}
function canReplenishNow() {
  return G.legal?.canReplenish && G.legal.actions.length > 0 && G.view.board.some((t) => t == null);
}

/** 点击棋盘格 */
function pickCell(i) {
  const t = G.view.board[i];
  if (ui.phase === 'priv' && G.legal.privilegeCells.includes(i)) {
    const me = G.view.players[G.seat];
    const k = ui.privileges.indexOf(i);
    if (k >= 0) ui.privileges.splice(k, 1);
    else if (ui.privileges.length < me.privileges) ui.privileges.push(i);
  } else if (myTurn() && ui.phase === 'main' && ui.action?.action.kind === 'buy' && takeSameNeeded() && cellOfMyCardColor(i)) {
    ui.takeSamePick = i;
  } else if (myTurn() && ui.phase === 'main' && ui.pick?.t === 'take') {
    const k = ui.pick.cells.indexOf(i);
    const isAdd = k < 0;
    if (k >= 0) ui.pick.cells.splice(k, 1); // 点击已选格 = 取消选择
    else ui.pick.cells.push(i);
    if (!validTakeSet(ui.pick.cells)) { ui.pick.cells = ui.pick.cells.slice(0, 1); } // 回退到单选
    if (ui.pick.cells.length === 0) ui.pick = null;
    tryMatchTake();
    // 仅新增时选满自动提交; 取消选择后停留等确认, 可继续加/减
    if (isAdd && ui.action && !takeExtendable()) { render(); afterActionChosen(); return; }
  } else if (myTurn() && ui.phase === 'main' && t != null && t !== 'gold') {
    ui.pick = { t: 'take', cells: [i] };
    tryMatchTake();
    if (ui.action && !takeExtendable()) { render(); afterActionChosen(); return; }
  }
  render();
}
function tryMatchTake() {
  if (!ui.pick) { ui.action = null; return; } // 全部取消选择时回到空状态
  ui.action = matchAction({ kind: 'take', cells: sortedCells(ui.pick.cells) });
}
/** 当前拿取选择是否还能延长 (存在包含它且更长的合法 take); 不能延长则自动提交 */
function takeExtendable() {
  if (ui.pick?.t !== 'take' || !ui.action) return false;
  const cur = sortedCells(ui.pick.cells).join();
  return G.legal.actions.some((a) => a.action.kind === 'take'
    && a.action.cells.length > ui.pick.cells.length
    && sortedCells(a.action.cells.filter((c) => ui.pick.cells.includes(c))).join() === cur);
}
function tryMatchReserve() {
  if (ui.pick.goldCell == null) return;
  const from = ui.pick.t === 'card' ? { kind: 'pyramid', slot: ui.pick.slot } : { kind: 'deck', level: ui.pick.level };
  ui.action = matchAction({ kind: 'reserve', goldCell: ui.pick.goldCell, from });
}

function cellOfMyCardColor(i) {
  const card = actionCard();
  return card && card.color && G.view.board[i] === card.color;
}

/** 点击金字塔卡 */
function pickPyramidCard(slot) {
  if (!myTurn()) return;
  ui.action = null;
  ui.extras = {}; ui.takeSamePick = null;
  ui.pick = { t: 'card', slot };
  render();
}
/** 点击自己预留卡: 打开放大详情再决定 */
function pickReservedCard(index) {
  if (!myTurn()) return;
  ui.action = null; ui.extras = {}; ui.takeSamePick = null; ui.hint = '';
  ui.pick = { t: 'buyRes', index };
  render();
}
/** 点击牌库(盲留): 打开放大详情 */
function pickDeck(level) {
  if (!myTurn()) return;
  ui.action = null;
  ui.extras = {}; ui.takeSamePick = null;
  ui.pick = { t: 'deck', level, want: null };
  render();
}

// ---------------- 设置面板 ----------------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#setup-human').classList.toggle('hidden', t.dataset.mode !== 'human');
  $('#setup-agents').classList.toggle('hidden', t.dataset.mode !== 'agents');
  $('#setup-resume').classList.toggle('hidden', t.dataset.mode !== 'resume');
  if (t.dataset.mode === 'resume') loadSessions();
}));

async function loadSessions() {
  const box = $('#r-list');
  box.textContent = '';
  try {
    const list = await api('/api/sessions'); // 服务端已按新到老排序
    if (!list.length) { box.appendChild(el('div', 'session-empty', '还没有会话记录 —— 先开一局吧'));
      return; }
    for (const s of list) {
      const row = el('div', 'session-row');
      // 左: 日期/时间
      const st = String(s.started ?? '');
      const time = el('div', 'session-time');
      time.appendChild(el('div', 'd', st.slice(5, 10).replace('-', '/')));
      time.appendChild(el('div', 't', st.slice(11, 16)));
      row.appendChild(time);
      // 中: 对阵 + 标签
      const main = el('div', 'session-main');
      const players = el('div', 'session-players');
      players.appendChild(span('', String(s.names?.[0] ?? '?')));
      players.appendChild(el('span', 'vs', 'vs'));
      players.appendChild(span('', String(s.names?.[1] ?? '?')));
      main.appendChild(players);
      const sub = el('div', 'session-sub');
      sub.appendChild(el('span', 'chip', s.mode === 'human' ? '人机' : 'Agent'));
      const botSpecs = (s.specs ?? []).filter((x) => x && x !== 'human');
      if (botSpecs.length) sub.appendChild(el('span', 'chip', botSpecs.join(' / ').slice(0, 40)));
      if (s.outcome !== '未完' && s.turns != null) sub.appendChild(el('span', 'chip', `${s.turns}回合`));
      main.appendChild(sub);
      row.appendChild(main);
      // 右: 状态徽章
      if (s.outcome === '未完') {
        const b = el('div', 'session-badge open');
        b.appendChild(span('', '未完'));
        b.appendChild(el('span', 'n', String(s.moves)));
        b.appendChild(span('', '步'));
        row.appendChild(b);
      }
      else if (s.outcome === 'draw') row.appendChild(el('div', 'session-badge draw', '和局'));
      else {
        const wi = Number(String(s.outcome)[1]) || 0;
        const wn = String(s.names?.[wi] ?? `P${wi + 1}`).slice(0, 12);
        const b = el('div', 'session-badge win');
        b.appendChild(span('', `${wn} 胜`));
        row.appendChild(b);
      }
      row.addEventListener('click', async () => {
        row.classList.add('busy');
        try { startGame(await api('/api/resume', { file: s.file })); }
        catch (e) { row.classList.remove('busy'); row.querySelector('.session-players').textContent = `续局失败: ${e.message}`; }
      });
      box.appendChild(row);
    }
  } catch (e) {
    box.appendChild(el('div', 'session-empty', `加载失败: ${e.message}`));
  }
}

// 刷新自动续局: URL #会话文件名 -> 按原配置重建
const hashFile = decodeURIComponent(location.hash.slice(1)).trim();
if (hashFile) {
  api('/api/resume', { file: hashFile }).then(startGame).catch(() => { /* 文件不存在则留在设置页 */ });
}

function llmSpec(sel, modelInput) {
  const v = $(sel).value;
  if (v !== 'llm' && v !== 'llm2' && v !== 'llm3') return v;
  const m = $(modelInput).value.trim();
  return m ? `${v}:${m}` : v;
}

/** 搜索型 bot 的 spec: 拼上界面里配置的每步超时秒数 (默认 10s) */
function searchSpec(sel, msInput) {
  const v = $(sel).value;
  if (v !== 'ab' && v !== 'mcts') return v;
  const ms = Math.max(1, Number($(msInput).value) || 10) * 1000;
  return `${v}@${ms}`;
}

$('#btn-start').addEventListener('click', async () => {
  const spec = searchSpec('#h-bot', '#h-search-ms') || llmSpec('#h-bot', '#h-model');
  const seat = Number($('#h-seat').value);
  const payload = await api('/api/new', {
    mode: 'human',
    p1: seat === 0 ? null : spec,
    p2: seat === 0 ? spec : null,
    humanSeat: seat,
  });
  startGame(payload);
});

$('#btn-start-agents').addEventListener('click', async () => {
  const spec = (sel) => searchSpec(sel, '#a-search-ms') || llmSpec(sel, '#a-model');
  const payload = await api('/api/new', { mode: 'agents', p1: spec('#a-p1'), p2: spec('#a-p2') });
  startGame(payload);
});

$('#btn-new').addEventListener('click', () => { location.hash = ''; location.reload(); });
$('#logo').addEventListener('click', () => { location.hash = ''; location.reload(); }); // 回主页(丢掉 hash, 不自动续局)

/** 等 bot 走完期间轮询 /api/state, 实时刷新 LLM 思考流 */
async function awaitBot(request) {
  const poll = setInterval(async () => {
    try {
      const s = await api(`/api/state/${G.id}?seat=${G.seat}`);
      if (s.botMessage && s.botMessage.text !== G.botMessage?.text) {
        G.botMessage = s.botMessage;
        renderActionbar();
      }
    } catch { /* 轮询失败忽略, 等 bot 请求返回 */ }
  }, 800);
  try {
    return await request;
  } finally {
    clearInterval(poll);
  }
}

/** 等对局首屏图片加载/失败完成(带超时兜底); ab 同步搜索会堵死服务器, 须先取图再调 /api/bot */
function boardImagesSettled(timeoutMs = 2000) {
  const pending = [...document.querySelectorAll('#game img')].filter((i) => !i.complete);
  if (!pending.length) return Promise.resolve();
  let left = pending.length;
  const done = new Promise((res) => {
    for (const i of pending) {
      i.addEventListener('load', () => { if (--left === 0) res(); }, { once: true });
      i.addEventListener('error', () => { if (--left === 0) res(); }, { once: true });
    }
  });
  return Promise.race([done, new Promise((res) => setTimeout(res, timeoutMs))]);
}

function startGame(payload) {
  G = payload;
  if (payload.file) location.hash = payload.file; // 刷新可自动续局
  ui = freshUi();
  $('#setup').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#agent-controls').classList.toggle('hidden', G.mode !== 'agents');
  $('#human-controls').classList.toggle('hidden', G.mode !== 'human');
  render();
  if (payload.pending) {
    boardImagesSettled().then(() => {
      awaitBot(api(`/api/bot/${G.id}`, {})).then((r) => {
        Object.assign(G, r);
        revealBotMove();
      });
    });
  }
}

// ---------------- 渲染 ----------------
function render() {
  renderBoard();
  renderPyramid();
  renderPlayers();
  renderBanner();
  renderActionbar();
  renderModals();
}

/** 弹窗体系: ①特权/补货 (侧栏按钮手动打开) ②卡片放大详情(含黄金选取) ③附加选择 ④bot 操作回顾 */
function renderModals() {
  const root = $('#modal-root'), box = $('#modal-box');
  let show = false;
  box.replaceChildren();
  if (noticePending() && G.noticeSeat === G.seat) {
    renderNoticeModal(box);
    show = true;
  } else if (myTurn() && (ui.phase === 'priv' || ui.phase === 'replenish')) {
    renderPhaseModal(box);
    show = true;
  } else if (myTurn() && ui.pick && ui.pick.t !== 'take') {
    renderCardDialog(box);
    show = true;
  } else if (myTurn() && ui.action && ui.extrasOpen) {
    renderExtrasModal(box);
    show = true;
  } else if (myTurn() && ui.showBotMove && (G.recentMoves?.length ?? 0) > 0) {
    renderBotMoveModal(box);
    show = true;
  }
  root.classList.toggle('hidden', !show);
}

function modalHead(box, title) {
  const head = el('div', 'modal-head');
  head.append(el('h3', '', title));
  const x = el('button', 'modal-x', '✕');
  x.title = '关闭 (Esc)';
  x.addEventListener('click', closeModal);
  head.append(x);
  box.append(head);
}

function closeModal() {
  if (noticePending()) ui.noticeSeen = noticeKey();
  else if (ui.phase === 'priv') { ui.privileges = []; ui.phase = 'main'; }
  else if (ui.phase === 'replenish') ui.phase = 'main';
  else if (ui.showBotMove) ui.showBotMove = false;
  else if (ui.pick) { ui.pick = null; ui.hint = ''; }
  else if (ui.action) { ui.action = null; ui.extras = {}; ui.takeSamePick = null; ui.extrasOpen = false; }
  render();
}

/** 特权 / 补货弹窗 (确认后即时执行) */
function renderPhaseModal(box) {
  const me = G.view.players[G.seat];
  const row = el('div', 'modal-actions');
  if (ui.phase === 'priv') {
    modalHead(box, '💎 使用特权');
    box.append(el('div', 'hint', `持有 ${me.privileges} 枚 · 每枚从棋盘拿 1 个非金 token · 已选 ${ui.privileges.length}/${me.privileges}`));
    const grid = el('div', 'modal-board');
    G.view.board.forEach((t, i) => {
      const ok = G.legal.privilegeCells.includes(i);
      const c = el('div', `mcell${t == null ? ' empty' : ''}${ok ? ' clickable' : ' dead'}${ui.privileges.includes(i) ? ' picked' : ''}`);
      if (t != null) c.append(gemEl(t));
      else c.textContent = '·';
      if (ok) c.addEventListener('click', () => pickCell(i));
      grid.append(c);
    });
    box.append(grid);
    const okBtn = el('button', 'primary', ui.privileges.length ? `确认拿取 ${ui.privileges.length} 枚 ✓` : '先点选格子');
    okBtn.disabled = !ui.privileges.length;
    okBtn.addEventListener('click', async () => {
      try {
        Object.assign(G, await api(`/api/option/${G.id}`, { seat: G.seat, privileges: [...ui.privileges] }));
      } catch (err) { ui.hint = err.message; }
      ui.privileges = [];
      ui.phase = 'main';
      render();
    });
    row.append(okBtn);
  } else {
    const empties = G.view.board.filter((t) => t == null).length;
    modalHead(box, '🔄 主动补货');
    box.append(el('div', 'hint', `棋盘 ${empties} 个空格 · 从袋中随机回填 · 对手获得 1 特权`));
    const yes = el('button', 'primary', '补货 (对手得 1 特权)');
    yes.addEventListener('click', async () => {
      try {
        Object.assign(G, await api(`/api/option/${G.id}`, { seat: G.seat, replenish: true }));
      } catch (err) { ui.hint = err.message; }
      ui.phase = 'main';
      render();
    });
    row.append(yes);
  }
  const no = el('button', 'ghost', '取消');
  no.addEventListener('click', closeModal);
  row.append(no);
  box.append(row);
}

/** 卡片放大详情: 左侧大图, 右侧操作按钮 */
function renderCardDialog(box) {
  const me = G.view.players[G.seat];
  const wrap = el('div', 'card-dialog');
  const imgBox = el('div', 'cd-img');
  let def = null;
  let from = null;
  if (ui.pick.t === 'card') {
    def = G.view.pyramid[ui.pick.slot];
    from = { kind: 'pyramid', slot: ui.pick.slot };
  } else if (ui.pick.t === 'deck') {
    from = { kind: 'deck', level: ui.pick.level };
  } else {
    def = me.reserved[ui.pick.index];
    from = { kind: 'reserved', index: ui.pick.index };
  }
  if (def) {
    const img = el('img');
    img.src = `/cards/${def.id}.png`;
    img.alt = cardTitle(def);
    imgBox.append(img);
  } else {
    const back = el('div', 'cd-back');
    back.append(span('q', '?'));
    imgBox.append(back);
  }
  wrap.append(imgBox);

  const side = el('div', 'cd-side');
  if (ui.pick.t === 'deck') {
    side.append(el('h4', '', `盲留 ${'一二三'[ui.pick.level - 1]}级牌库顶`));
    side.append(el('div', 'cd-meta', `牌库剩 ${G.view.decks[ui.pick.level - 1].length} 张 · 卡面保密 · 预留后随时可购买`));
  } else {
    const label = ui.pick.t === 'card' ? `金字塔 #${ui.pick.slot + 1}` : '我的预留卡';
    side.append(el('h4', '', label));
    side.append(el('div', 'cd-meta', cardTitle(def)));
  }

  if (ui.pick.want === 'reserve') {
    // 多枚黄金: 弹窗内嵌棋盘直接选, 不用再点后面的大棋盘
    side.append(el('div', 'hint', `场上有 ${goldCells().length} 枚黄金, 点击要拿的那枚:`));
    const picker = el('div', 'modal-board cd-board');
    G.view.board.forEach((t, i) => {
      const isGold = t === 'gold';
      const c = el('div', `mcell${t == null ? ' empty' : ''}${isGold ? ' clickable' : ' dead'}`);
      if (t != null) c.append(gemEl(t));
      else c.textContent = '·';
      if (isGold) c.addEventListener('click', () => pickDialogGold(i));
      picker.append(c);
    });
    side.append(picker);
    const cancel = el('button', 'ghost', '取消');
    cancel.addEventListener('click', closeModal);
    side.append(cancel);
    wrap.append(side);
    box.append(wrap);
    return;
  }

  const row = el('div', 'cd-actions');
  if (ui.pick.t !== 'deck') {
    const buyMatch = matchAction({ kind: 'buy', from });
    const buy = el('button', 'primary big', '买卡');
    buy.disabled = !buyMatch;
    buy.title = buyMatch ? '' : 'token/折扣不足 · 可先用特权拿 token 再来';
    buy.addEventListener('click', () => {
      ui.action = buyMatch;
      const cc = actionCard();
      if (takeSameNeeded() && cc) ui.takeSamePick = null; // 强制在弹窗内选格, 不预选
      ui.pick = null;
      ui.hint = '';
      afterActionChosen();
    });
    row.append(buy);
  }
  if (ui.pick.t !== 'buyRes') {
    const canRes = me.reserved.length < 3 && goldCells().length > 0;
    const res = el('button', 'big', '预留 + 拿黄金');
    res.disabled = !canRes;
    res.title = canRes ? '' : '场上无黄金或预留已满 (最多 3 张)';
    res.addEventListener('click', () => {
      ui.action = null;
      ui.pick.want = 'reserve';
      const golds = goldCells();
      if (golds.length === 1) {
        ui.pick.goldCell = golds[0];
        tryMatchReserve();
        if (ui.action) { ui.pick = null; afterActionChosen(); return; }
      }
      render(); // 弹窗内切换为黄金选取
    });
    row.append(res);
  }
  const cancel = el('button', 'ghost', '取消');
  cancel.addEventListener('click', closeModal);
  row.append(cancel);
  side.append(row);
  wrap.append(side);
  box.append(wrap);
}

/** 弹窗内选黄金: 选定即提交 */
function pickDialogGold(i) {
  if (!myTurn() || ui.pick?.want !== 'reserve') return;
  ui.pick.goldCell = i;
  tryMatchReserve();
  if (ui.action) { ui.pick = null; afterActionChosen(); return; }
  render();
}

/** 主行动已定: 还有待选项则弹选择框等确认, 否则直接提交 */
function afterActionChosen() {
  if (extrasPending().length > 0) {
    ui.extrasOpen = true;
    render();
  } else {
    submitMove();
  }
}

function canPickCell(i) {
  const t = G.view.board[i];
  if (t == null) return false;
  if (!myTurn() || ui.phase !== 'main' && ui.phase !== 'priv') return false;
  if (ui.phase === 'priv') return G.legal.privilegeCells.includes(i);
  if (ui.action?.action.kind === 'buy' && takeSameNeeded() && cellOfMyCardColor(i)) return true;
  if (ui.pick?.want === 'reserve') return t === 'gold';
  if (ui.pick?.t === 'take') return ui.pick.cells.includes(i) || (t !== 'gold' && validTakeSet([...ui.pick.cells, i]));
  return t !== 'gold'; // 无选择时: 任意非金 token 可作为起点
}

function renderBoard() {
  const b = $('#board');
  b.replaceChildren();
  b.append(el('div', 'coord'));
  for (const ch of 'ABCDE') b.append(el('div', 'coord', ch));
  G.view.board.forEach((t, i) => {
    if (i % 5 === 0) b.append(el('div', 'coord', String(Math.floor(i / 5) + 1)));
    const d = el('div', `cell${t == null ? ' empty' : ''}`);
    if (t == null) {
      d.textContent = '·';
    } else {
      d.append(gemEl(t));
      d.title = `${TZH[t]} ${cellName(i)}`;
    }
    if (canPickCell(i)) {
      d.classList.add('clickable');
      d.addEventListener('click', () => pickCell(i));
    }
    if (ui.privileges.includes(i) || ui.takeSamePick === i || ui.pick?.goldCell === i || (ui.pick?.t === 'take' && ui.pick.cells.includes(i))) d.classList.add('picked');
    b.append(d);
  });
}

function renderPyramid() {
  const pyr = $('#pyramid');
  pyr.replaceChildren();

  // 牌库 (盲留入口)
  const deckRow = el('div', 'deck-row');
  const canReserve = myTurn() && G.view.players[G.seat].reserved.length < 3 && goldCells().length > 0;
  [[1, '一级'], [2, '二级'], [3, '三级']].forEach(([lvl, lab]) => {
    const n = G.view.decks[lvl - 1].length;
    const chip = el('button', `deck-chip${canReserve ? ' clickable' : ''}`);
    chip.append(span('dl', `${lab}牌库`), span('dn', String(n)));
    chip.title = canReserve ? `盲留 ${lab}牌库顶(需黄金)` : '无黄金/预留满时不可盲留';
    chip.disabled = !canReserve || n === 0;
    if (canReserve) chip.addEventListener('click', () => pickDeck(lvl));
    deckRow.append(chip);
  });
  pyr.append(deckRow);

  // 本回合买得起的金字塔卡 (legal 表中的 buy 来源) 标绿框
  const afford = new Set((G.legal?.actions ?? [])
    .filter((a) => a.action.kind === 'buy' && a.action.from.kind === 'pyramid')
    .map((a) => a.action.from.slot));
  const rows = [[0, 1, 2], [3, 4, 5, 6], [7, 8, 9, 10, 11]];
  for (const row of rows) {
    const r = el('div', 'pyr-row');
    for (const s of row) {
      const c = G.view.pyramid[s];
      if (!c) { r.append(cardBack(s)); continue; }
      const selected = ui.pick?.t === 'card' && ui.pick.slot === s;
      const card = cardEl(c, { slot: s, clickable: myTurn(), selected, affordable: afford.has(s) });
      if (myTurn()) card.addEventListener('click', () => pickPyramidCard(s));
      r.append(card);
    }
    pyr.append(r);
  }

  const pool = $('#pool-royal');
  pool.replaceChildren();
  if (G.view.royals.length === 0) pool.append(el('span', 'royal none', '无'));
  G.view.royals.forEach((r, i) => {
    pool.append(royalBtn(r, ui.extras.royalPick === i, () => { ui.extras.royalPick = i; }));
  });
  $('#pool-priv').textContent = String(3 - G.view.players[0].privileges - G.view.players[1].privileges);
  const bag = $('#pool-bag');
  bag.replaceChildren(el('span', '', '袋中:'));
  const cnt = {};
  for (const t of G.view.bag) cnt[t] = (cnt[t] ?? 0) + 1;
  const colors = ALL_COLORS.filter((c) => cnt[c]);
  if (colors.length === 0) bag.append(el('span', 'hint', '空'));
  for (const c of colors) {
    const tok = el('span', 'tok');
    tok.append(gemEl(c), span('n', String(cnt[c])));
    tok.title = `补货时可回填 ${TZH[c]}`;
    bag.append(tok);
  }
  // 主动补货按钮就在袋况旁
  if (myTurn() && canReplenishNow()) {
    const b = el('button', 'opt-chip');
    b.append(span('', '🔄 主动补货'));
    b.title = '随机回填空格 · 对手得 1 特权';
    b.addEventListener('click', () => { ui.phase = 'replenish'; render(); });
    bag.append(b);
  }
}

function renderPlayers() {
  const box = $('#players');
  box.replaceChildren();
  const seats = G.mode === 'human' ? [1 - G.seat, G.seat] : [0, 1];
  for (const s of seats) {
    const p = G.view.players[s];
    const mine = G.mode === 'human' && s === G.seat;
    const card = el('div', 'player');
    if (G.view.current === s && !G.over) card.classList.add('active');

    const head = el('div', 'p-head');
    head.append(span('name', `${p.name}`));
    const stats = el('div', 'p-stats');
    stats.append(el('span', '', '积分'), span('pts', String(p.points)));
    stats.append(el('span', '', '皇冠'), span('cr', `♛${p.crowns}`));
    stats.append(el('span', '', `特权×${p.privileges}`));
    if (p.royals.length) stats.append(el('span', '', `皇家×${p.royals.length}`));
    head.append(stats);
    // 使用特权按钮就在特权数量旁 (右侧玩家栏)
    if (mine && myTurn() && p.privileges > 0 && G.legal.privilegeCells.length > 0) {
      const b = el('button', 'opt-chip');
      b.append(span('', `💎 使用特权`));
      b.title = '每枚特权可从棋盘拿 1 个非金 token';
      b.addEventListener('click', () => { ui.privileges = []; ui.phase = 'priv'; render(); });
      head.append(b);
    }
    card.append(head);

    const tokens = el('div', 'tokens');
    const colors = ALL_COLORS.filter((c) => p.tokens[c] > 0);
    if (colors.length === 0) tokens.append(el('span', 'hint', '无 token'));
    for (const c of colors) {
      const tok = el('span', 'tok');
      tok.append(gemEl(c), span('n', String(p.tokens[c])));
      tok.title = TZH[c];
      tokens.append(tok);
    }
    card.append(tokens);

    if (p.royals.length) {
      const royals = el('div', 'cards-line');
      royals.append(el('span', 'lab', '皇家卡:'));
      const minis = el('div', 'minicards');
      p.royals.forEach((r) => minis.append(miniRoyal(r)));
      royals.append(minis);
      card.append(royals);
    }

    // 每色已购卡: 折扣 + 累计分 (同色 10 分即胜)
    const cardsLine = el('div', 'cards-line');
    cardsLine.append(el('span', 'lab', '宝石卡:'));
    if (p.cards.length === 0) cardsLine.append(el('span', 'hint', '无'));
    else {
      const byColor = {};
      let nonePts = 0;
      for (const c of p.cards) {
        if (!c.color) { nonePts += c.def.points; continue; }
        const e = byColor[c.color] ?? (byColor[c.color] = { n: 0, pts: 0 });
        e.n += 1; e.pts += c.def.points;
      }
      for (const g of PEARL_COLORS) {
        const e = byColor[g];
        if (!e) continue;
        const chip = el('span', 'tok cchip');
        chip.append(gemEl(g));
        chip.append(span('n', `${p.bonuses[g] ?? 0} - ${e.pts}`));
        chip.title = `${GEMZH[g]}卡 ×${e.n} · 折扣${p.bonuses[g] ?? 0} · 累计${e.pts}分 (同色10分获胜)`;
        cardsLine.append(chip);
      }
      if (nonePts > 0) {
        const chip = el('span', 'tok cchip');
        chip.append(span('n', `分卡·${nonePts}分`));
        chip.title = `无色分卡 · 累计${nonePts}分`;
        cardsLine.append(chip);
      }
    }
    card.append(cardsLine);

    const reserved = el('div', 'cards-line');
    reserved.append(el('span', 'lab', '预留:'));
    if (p.reserved.length === 0) reserved.append(el('span', 'hint', '无'));
    else if (mine || G.mode === 'agents') {
      // 本回合买得起的预留卡标绿框 (与金字塔一致)
      const affordRes = mine && myTurn()
        ? new Set((G.legal?.actions ?? []).filter((a) => a.action.kind === 'buy' && a.action.from.kind === 'reserved').map((a) => a.action.from.index))
        : new Set();
      const minis = el('div', 'minicards');
      p.reserved.forEach((c, index) => {
        if (c.id === 'hidden') { minis.append(miniBack()); return; }
        const selected = ui.pick?.t === 'buyRes' && ui.pick.index === index;
        const m = miniCard(c, null, true, { clickable: mine && myTurn(), selected, affordable: affordRes.has(index) });
        if (mine && myTurn()) m.addEventListener('click', () => pickReservedCard(index));
        minis.append(m);
      });
      reserved.append(minis);
    } else {
      const minis = el('div', 'minicards');
      for (let i = 0; i < p.reserved.length; i++) minis.append(miniBack());
      reserved.append(minis);
    }
    card.append(reserved);
    box.append(card);
  }
}

function renderBanner() {
  const b = $('#banner');
  if (G.over) {
    b.classList.remove('hidden');
    b.textContent = G.draw ? '🤝 和局' : `🏆 ${G.names[G.winner]} 获胜! (条件: ${G.winReason})`;
  } else b.classList.add('hidden');
}

// ---------------- 行动区 ----------------
function actionCard() {
  if (!ui.action || ui.action.action.kind !== 'buy') return null;
  const from = ui.action.action.from;
  const me = G.view.players[G.seat];
  return from.kind === 'pyramid' ? G.view.pyramid[from.slot] : me.reserved[from.index];
}
function takeSameNeeded() {
  const c = actionCard();
  if (!c || c.ability !== 'takeSame' || !c.color) return false;
  return G.view.board.filter((t) => t === c.color).length > 1;
}
function associateNeeded() {
  const c = actionCard();
  return !!(c && c.isAssociate);
}
function stealNeeded() {
  const c = actionCard();
  if (!c || c.ability !== 'steal') return false;
  const opp = G.view.players[1 - G.seat];
  return PEARL_COLORS.some((t) => opp.tokens[t] > 0);
}
// 皇家卡偷取: 领的皇家卡若是偷取能力, 也需选颜色 (与卡牌偷取共用 move.stealPick)
function royalStealNeeded() {
  if (!royalNeeded() || stealNeeded()) return false;
  const royals = G.view.royals;
  if (royals.length === 0) return false;
  const idx = Number.isInteger(ui.extras.royalPick) ? ui.extras.royalPick
    : (['turn', 'privilege', 'steal'].map((a) => royals.findIndex((r) => r.ability === a)).find((i) => i >= 0) ?? 0);
  if (royals[idx]?.ability !== 'steal') return false;
  const opp = G.view.players[1 - G.seat];
  return PEARL_COLORS.some((t) => opp.tokens[t] > 0);
}
function royalNeeded() {
  const c = actionCard();
  if (!c) return false;
  const me = G.view.players[G.seat];
  const cross = (me.crowns < 3 && me.crowns + c.crowns >= 3) || (me.crowns < 6 && me.crowns + c.crowns >= 6);
  return cross && G.view.royals.length > 0;
}
// 结算后手牌预演: 判超 10 发生在支付/拿取之后, 弃置选项含刚拿到的 token
function myPreviewTokens() {
  return previewTokens(G.view.players[G.seat], G.view.players[1 - G.seat], G.view.board, ui.action?.action, actionCard(), ui.extras);
}
function discardExcess() {
  return excessOf(myPreviewTokens());
}

function renderActionbar() {
  const turn = myTurn();
  // 被迫补货提示: 展示至人类提交走法 (服务端清空)
  const notice = $('#notice');
  notice.classList.toggle('hidden', !G.notice);
  notice.textContent = G.notice ?? '';
  $('#human-turn').classList.toggle('hidden', !turn);
  // LLM bot 原始输出: 有则显示 toggle (思考中/回合中均可展开)
  const bm = $('#bot-msg');
  bm.classList.toggle('hidden', !G.botMessage);
  if (G.botMessage) {
    const body = $('#bot-msg-body');
    // 流式自动滚底: 仅当用户没有上翻(离底部近)时跟随, 不打断回看
    const stick = botMsgOpen && body.scrollHeight - body.scrollTop - body.clientHeight < 30;
    $('#bot-msg-toggle').textContent = `🤖 ${G.botMessage.name} 输出 ${botMsgOpen ? '▾' : '▸'}`;
    body.textContent = G.botMessage.text;
    body.classList.toggle('hidden', !botMsgOpen);
    if (stick) body.scrollTop = body.scrollHeight;
  }
  if (G.mode === 'agents') {
    $('#turn-indicator').textContent = G.over ? '对局结束' : `第 ${G.view.turnCount + 1} 回合 · 轮到 ${G.names[G.view.current]}`;
  }
  if (!turn) return;

  const pick = $('#pick-bar');
  pick.replaceChildren();

  // 当前选择进度
  if (ui.pick?.t === 'take') {
    pick.append(el('b', '', `拿 ${ui.pick.cells.length} 枚:`));
    for (const i of ui.pick.cells) {
      const tok = el('span', 'tok');
      tok.append(gemEl(G.view.board[i]), span('n', cellName(i)));
      pick.append(tok);
    }
    if (!ui.action) {
      pick.append(el('span', 'error-inline', '组合不可行'));
    } else {
      // 匹配即可提交 (新增选满会自动提交, 此处覆盖取消选择后的停留状态)
      const go = el('button', 'primary', `拿 ${ui.pick.cells.length} 枚 ✓`);
      go.title = 'Enter 也可提交 · 点已选格可取消';
      go.addEventListener('click', () => afterActionChosen());
      if (takeExtendable()) pick.append(go, el('span', 'hint', '可继续加点 / 点已选取消'));
      else pick.append(go);
    }
  } else if (ui.pick?.want === 'reserve') {
    pick.append(el('span', 'error-inline', '← 点击棋盘上要拿的黄金 token'));
  } else if (ui.action) {
    pick.append(el('span', 'ok-inline', '✓ 提交中…'));
  } else {
    pick.append(el('span', 'hint', '💡 点棋盘格拿 token (直线相邻, 选满自动提交) · 点卡片买/留 · 点牌库盲留'));
  }
  if (ui.hint) { pick.append(el('span', 'error-inline', ui.hint)); ui.hint = ''; }

  const clear = el('button', 'ghost', '清除');
  clear.hidden = !(ui.pick || ui.action);
  clear.addEventListener('click', () => {
    ui.pick = null; ui.action = null; ui.extras = {}; ui.takeSamePick = null;
    render();
  });
  pick.append(clear);
}

/** 待补充的选择 (阻塞提交, 由弹窗收集) */
function extrasPending() {
  if (!ui.action) return [];
  const need = [];
  if (associateNeeded() && !ui.extras.associateColor) need.push('associate');
  if ((stealNeeded() || royalStealNeeded()) && !ui.extras.stealPick) need.push('steal');
  if (royalNeeded() && !Number.isInteger(ui.extras.royalPick)) need.push('royal');
  if (takeSameNeeded() && ui.takeSamePick == null) need.push('takeSame');
  const excess = discardExcess();
  if (excess > 0 && Object.values(ui.extras.discard ?? {}).reduce((s, n) => s + n, 0) !== excess) need.push('discard');
  return need;
}

/** 附加选择弹窗: 买卡触发的叠色/偷取/皇家卡/拿同色/弃置 */
function renderExtrasModal(box) {
  const me = G.view.players[G.seat];
  const c = actionCard();
  modalHead(box, '补充选择');
  const body = el('div', 'extras-modal');
  if (c && ui.action.action.kind === 'buy') {
    body.append(exRow('购买:', [miniCard(c, null, true, { selected: true })]));
  }
  if (associateNeeded()) {
    const colors = [...new Set(me.cards.map((x) => x.color).filter(Boolean))];
    body.append(exRow('百搭卡叠放颜色:', colors.map((g) => colorBtn(g, () => { ui.extras.associateColor = g; }, ui.extras.associateColor === g))));
  }
  if (stealNeeded()) {
    const opp = G.view.players[1 - G.seat];
    const opts = PEARL_COLORS.filter((t) => opp.tokens[t] > 0);
    body.append(exRow('「偷取」选对手 token:', opts.map((t) => colorBtn(t, () => { ui.extras.stealPick = t; }, ui.extras.stealPick === t))));
  }
  if (royalStealNeeded()) {
    const opp = G.view.players[1 - G.seat];
    const opts = PEARL_COLORS.filter((t) => opp.tokens[t] > 0);
    body.append(exRow('皇家卡「偷取」选对手 token:', opts.map((t) => colorBtn(t, () => { ui.extras.stealPick = t; }, ui.extras.stealPick === t))));
  }
  if (takeSameNeeded() && c) {
    // 内嵌棋盘选同色格, 选完才能提交
    const cells = G.view.board.map((t, i) => (t === c.color ? i : -1)).filter((i) => i >= 0);
    const grid = el('div', 'modal-board bm-board');
    G.view.board.forEach((t, i) => {
      const ok = cells.includes(i);
      const cell = el('div', `mcell${t == null ? ' empty' : ''}${ok ? ' clickable' : ' dead'}${ui.takeSamePick === i ? ' picked' : ''}`);
      if (t != null) cell.append(gemEl(t));
      else cell.textContent = '·';
      if (ok) cell.addEventListener('click', () => { ui.takeSamePick = i; render(); });
      grid.append(cell);
    });
    body.append(exRow(`「拿同色」选${GEMZH[c.color]} token 格:`, [grid]));
  }
  if (royalNeeded()) {
    body.append(exRow('皇冠里程碑 → 选皇家卡:', G.view.royals.map((r, i) => royalBtn(r, ui.extras.royalPick === i, () => { ui.extras.royalPick = i; }))));
  }
  const excess = discardExcess();
  if (excess > 0) {
    const after = myPreviewTokens(); // 结算后持有, 输入上限按它算
    const div = el('div', 'row');
    div.append(el('b', '', `token 将超 10, 弃置 ${excess} 枚:`));
    ALL_COLORS.filter((t) => after[t] > 0).forEach((t) => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0'; inp.max = String(after[t]);
      inp.value = ui.extras.discard?.[t] ?? 0;
      inp.addEventListener('input', () => {
        (ui.extras.discard ??= {})[t] = Number(inp.value || 0);
        refreshExtrasConfirm(excess); // 不整页重渲染, 保住输入焦点
      });
      const tok = el('span', 'tok');
      tok.append(gemEl(t), inp);
      div.append(tok);
    });
    div.append(el('span', 'error-inline discard-hint', ''));
    body.append(div);
    refreshExtrasConfirm(excess);
  }
  box.append(body);

  const pending = extrasPending();
  const row = el('div', 'modal-actions');
  const ok = el('button', 'primary big', pending.length > 0 ? `还差 ${pending.length} 项…` : '确认提交 ✓');
  ok.disabled = pending.length > 0; // 有未完成的额外选择时禁止提交
  ok.addEventListener('click', () => submitMove());
  const back = el('button', 'ghost', '取消行动');
  back.addEventListener('click', () => { ui.action = null; ui.extras = {}; ui.takeSamePick = null; ui.extrasOpen = false; render(); });
  row.append(ok, back);
  box.append(row);
}

/** 弃置输入变化时即时刷新确认按钮/提示 */
function refreshExtrasConfirm(excess) {
  const dsum = Object.values(ui.extras.discard ?? {}).reduce((s, n) => s + n, 0);
  const hint = document.querySelector('.discard-hint');
  if (hint) hint.textContent = dsum === excess ? '' : dsum < excess ? `还需弃 ${excess - dsum} 枚` : '弃多了';
  const pending = extrasPending();
  const ok = [...document.querySelectorAll('.modal-actions button.primary')].find((b) => b.textContent.includes('确认提交') || b.textContent.includes('还差'));
  if (ok) {
    ok.disabled = pending.length > 0;
    ok.textContent = pending.length > 0 ? `还差 ${pending.length} 项…` : '确认提交 ✓';
  }
}

/** 被迫补货弹窗: 解释引擎自动补货与特权归属 (避免误以为 bot 补货/特权丢失) */
function renderNoticeModal(box) {
  modalHead(box, '🔄 被迫补货');
  const body = el('div', 'notice-body');
  body.append(el('p', 'notice-text', G.notice.replace(/^🔄 /, '')));
  body.append(el('p', 'hint', '规则: 无强制行动可走时自动补充棋盘, 对手获得 1 特权。'));
  box.append(body);
  const row = el('div', 'modal-actions');
  const ok = el('button', 'primary big', '知道了 ▸');
  ok.addEventListener('click', () => { ui.noticeSeen = noticeKey(); render(); });
  row.append(ok);
  box.append(row);
}

/** bot 操作回顾: 图示对手最近一轮做了什么 */
function renderBotMoveModal(box) {
  modalHead(box, `🤖 ${G.names[1 - G.seat]} 的操作`);
  const list = el('div', 'bot-move-list');
  for (const v of G.recentMoves ?? []) list.append(botMoveRow(v));
  box.append(list);
  const row = el('div', 'modal-actions');
  const ok = el('button', 'primary big', '知道了 ▸');
  ok.addEventListener('click', () => { ui.showBotMove = false; render(); });
  row.append(ok);
  box.append(row);
}

function gemsRow(gems) {
  const row = el('span', 'bm-gems');
  for (const g of gems ?? []) if (g) row.append(gemEl(g));
  return row;
}

function botMoveRow(v) {
  const r = el('div', 'bot-move');
  const a = v.action;
  if (a.kind === 'take') {
    r.append(el('span', 'bm-lab', '拿取'), gemsRow(v.takeGems));
    r.append(botTakeBoard(v)); // 高亮显示拿取位置
  } else if (a.kind === 'reserve') {
    r.append(el('span', 'bm-lab', '预留'));
    r.append(v.card ? miniCard(v.card, null, true) : miniBack(), gemEl('gold'));
  } else if (v.card) {
    r.append(el('span', 'bm-lab', '购买'), miniCard(v.card, null, true));
  }
  if (v.refill) r.append(el('span', 'bm-extra', '补位 →'), miniCard(v.refill, null, true));
  if (v.privGems?.length) r.append(el('span', 'bm-lab', '特权'), gemsRow(v.privGems));
  if (v.replenished) r.append(el('span', 'bm-extra', '🔄 补货'));
  if (v.stealGem) r.append(el('span', 'bm-extra', '偷取'), gemEl(v.stealGem));
  if (v.takeSameGem) r.append(el('span', 'bm-extra', '拿同色'), gemEl(v.takeSameGem));
  if (v.associateGem) r.append(el('span', 'bm-extra', '叠色'), gemEl(v.associateGem));
  if (v.royal) r.append(el('span', 'bm-extra', '领皇家卡'), miniRoyal(v.royal));
  if (v.deltas) r.append(deltasRow(v.deltas));
  return r;
}

/** 迷你棋盘: 高亮 bot 拿取的位置 (颜色用快照, 不依赖已变化的棋盘) */
function botTakeBoard(v) {
  const grid = el('div', 'modal-board bm-board');
  const taken = new Map(v.action.cells.map((c, k) => [c, v.takeGems?.[k] ?? null]));
  G.view.board.forEach((t, i) => {
    const hit = taken.has(i);
    const cell = el('div', `mcell${t == null && !hit ? ' empty' : ''}${hit ? ' taken' : ' dead'}`);
    if (hit) cell.append(gemEl(taken.get(i)));
    else if (t != null) cell.append(gemEl(t));
    else cell.textContent = '·';
    cell.title = hit ? `拿了 ${cellName(i)}` : cellName(i);
    grid.append(cell);
  });
  return grid;
}

const DELTA_LABEL = { points: '分', crowns: '皇冠', privileges: '特权', tokens: 'token', cards: '卡' };
function deltasRow(d) {
  const row = el('span', 'bm-deltas');
  for (const [k, lab] of Object.entries(DELTA_LABEL)) {
    const n = d[k];
    if (n) row.append(el('span', `bm-delta ${n > 0 ? 'up' : 'down'}`, `${n > 0 ? '+' : ''}${n} ${lab}`));
  }
  return row;
}

function exRow(label, btns) {
  const row = el('div', 'row');
  row.append(el('b', '', label));
  btns.forEach((b) => row.append(b));
  return row;
}
function colorBtn(code, onPick, picked) {
  const b = el('button', `tc-btn${picked ? ' picked' : ''}`);
  b.append(gemEl(code), span('', code === 'pearl' ? '珍珠' : GEMZH[code]));
  b.addEventListener('click', () => { onPick(); render(); });
  return b;
}

let botMsgOpen = false;
$('#bot-msg-toggle').addEventListener('click', () => { botMsgOpen = !botMsgOpen; render(); });

/** 提交走法: 附加字段已在新弹窗中选好 */
async function submitMove() {
  if (!ui.action) return;
  const move = { action: ui.action.action };
  if (associateNeeded() && ui.extras.associateColor) move.associateColor = ui.extras.associateColor;
  if ((stealNeeded() || royalStealNeeded()) && ui.extras.stealPick) move.stealPick = ui.extras.stealPick;
  if (takeSameNeeded() && ui.takeSamePick != null) move.takeSameCell = ui.takeSamePick;
  if (royalNeeded() && Number.isInteger(ui.extras.royalPick)) move.royalPick = ui.extras.royalPick;
  const excess = discardExcess();
  if (excess > 0 && ui.extras.discard) {
    const d = Object.fromEntries(Object.entries(ui.extras.discard).filter(([, n]) => n > 0));
    if (Object.values(d).reduce((s, n) => s + n, 0) === excess) move.discard = d;
  }
  $('#move-error').textContent = '';
  $('#human-turn').classList.add('hidden');
  try {
    const res = await api(`/api/move/${G.id}`, { seat: G.seat, move });
    Object.assign(G, res);
    ui = freshUi();
    render(); // 先立刻展示己方操作结果
    if (res.pending) {
      const r2 = await awaitBot(api(`/api/bot/${G.id}`, {}));
      Object.assign(G, r2);
      revealBotMove();
    }
  } catch (err) {
    $('#move-error').textContent = err.message;
    render();
  }
}
// Enter 提交 (输入框内除外): 拿 token / 附加选择弹窗确认共用
addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!myTurn() || !ui.action || extrasPending().length > 0) return;
  e.preventDefault();
  submitMove();
});

// 弹窗关闭: 点遮罩 / Esc
$('#modal-root').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal-root').classList.contains('hidden')) closeModal();
});

// ---------------- Agent 对战控制 ----------------
$('#btn-step').addEventListener('click', async () => {
  if (G.over) return;
  const res = await api(`/api/step/${G.id}`, {});
  Object.assign(G, res);
  render();
});

$('#btn-auto').addEventListener('click', () => {
  if (autoTimer) { stopAuto(); return; }
  $('#btn-auto').textContent = '停止 ⏹';
  autoTimer = setInterval(async () => {
    if (G.over) { stopAuto(); return; }
    try {
      const res = await api(`/api/step/${G.id}`, {});
      Object.assign(G, res);
      render();
      if (G.over) stopAuto();
    } catch { stopAuto(); }
  }, Number($('#speed').value));
});

function stopAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  $('#btn-auto').textContent = '自动播放 ⏩';
}
