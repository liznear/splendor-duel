// 前端主逻辑 (DOM API 构建, 无 innerHTML)
// 交互模型: 直接点击棋盘格/卡片构建走法, 与 legalMoves 匹配后提交
import { previewTokens, excessOf } from './preview.js';
import { api } from './api.js';
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
let botThinking = null;
let modalPosition = null;

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

function privilegeIcons(count) {
  const icons = el('span', `privilege-tokens${count === 0 ? ' empty' : ''}`);
  icons.setAttribute('aria-label', `特权 ${count} 枚`);
  icons.title = `特权 ${count} 枚`;
  for (let i = 0; i < Math.max(1, count); i++) {
    const image = el('img', 'privilege-img');
    image.src = '/assets/privilege.png';
    image.alt = '';
    icons.append(image);
  }
  return icons;
}

function tokenChip(color, count, title, depleted = false) {
  const tok = el('span', `pool-token ${TCSS[color]}${depleted ? ' depleted' : ''}`);
  const image = el('img');
  image.src = `/assets/token-${color}.png`;
  image.alt = '';
  tok.append(image, span('n', String(count)));
  tok.title = title;
  tok.setAttribute('aria-label', title);
  return tok;
}

function cardTitle(def, chosenColor) {
  const color = chosenColor ?? def.color;
  const parts = [];
  if (def.points) parts.push(`${def.points}分`);
  if (def.crowns) parts.push(`♛${def.crowns}`);
  if (def.isAssociate) {
    if (color) parts.push(`百搭→${GEMZH[color]}`);
    else parts.push('百搭卡');
  } else if (color) {
    parts.push(`${GEMZH[color]}卡`);
  } else {
    parts.push('分卡');
  }
  if (def.ability) parts.push(ABZH[def.ability]);
  if (def.cost) parts.push(`费用 ${COST_ORDER.filter((k) => def.cost[k] > 0).map((k) => `${GEMZH[k] ?? TZH[k]}×${def.cost[k]}`).join(' ')}`);
  return parts.join(' · ');
}

/** 折扣后各色实际费用; 珠宝色无折扣。 */
function effCost(p, def) {
  const eff = {};
  for (const g of COST_ORDER) {
    const n = Math.max(0, (def.cost?.[g] ?? 0) - (g === 'pearl' ? 0 : p.bonuses?.[g] ?? 0));
    if (n > 0) eff[g] = n;
  }
  return eff;
}

/** 买卡支付/缺口: 买得起列支付清单 (含黄金), 买不起列缺口清单。 */
function paymentPlan(p, def) {
  if (!def?.cost) return null;
  const eff = effCost(p, def);
  const pay = [];
  const lack = [];
  let goldNeed = 0;
  for (const g of COST_ORDER) {
    const use = Math.min(eff[g] ?? 0, p.tokens[g] ?? 0);
    if (use > 0) pay.push([g, use]);
    const miss = (eff[g] ?? 0) - use;
    if (miss > 0) { lack.push([g, miss]); goldNeed += miss; }
  }
  if (goldNeed > (p.tokens.gold ?? 0)) return { ok: false, list: lack };
  if (goldNeed > 0) pay.push(['gold', goldNeed]);
  return { ok: true, list: pay };
}
const planVerb = (plan) => (plan.ok ? '支付' : '还差');
const planTitle = (plan) => plan.list.length === 0
  ? '折扣已覆盖, 无需支付'
  : `${planVerb(plan)}: ${plan.list.map(([g, n]) => `${GEMZH[g] ?? TZH[g]}×${n}`).join(' ')}`;

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
/** bot 走完后展示其操作回顾 (需要关闭才回到棋盘); 对局结束时同样弹出, 呈现制胜的最后操作 */
function revealBotMove() {
  ui = freshUi();
  ui.showBotMove = (G.recentMoves?.length ?? 0) > 0;
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
/** 主页 <-> 人机/续局 子视图切换 */
function showSetup(view) {
  $('#setup-home').classList.toggle('hidden', view !== 'home');
  $('#setup-human').classList.toggle('hidden', view !== 'human');
  $('#setup-resume').classList.toggle('hidden', view !== 'resume');
  if (view === 'resume') loadSessions();
}
$('#home-human').addEventListener('click', () => showSetup('human'));
$('#home-resume').addEventListener('click', () => showSetup('resume'));
document.querySelectorAll('.btn-back').forEach((b) => b.addEventListener('click', () => showSetup('home')));

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

let lastSpec = null; // 上局对手配置, 供 #btn-new 重开时复用
async function startHumanGame(spec) {
  // 对手固定并行 MCTS; 难度 = 每步搜索超时秒数; 先后手随机
  lastSpec = spec;
  const seat = Math.random() < 0.5 ? 0 : 1;
  const payload = await api('/api/new', {
    mode: 'human',
    p1: seat === 0 ? null : spec,
    p2: seat === 0 ? spec : null,
    humanSeat: seat,
  });
  startGame(payload);
}

// 点击难度直接开局 (不再有开始/返回按钮)
document.querySelectorAll('#setup-human .home-card').forEach((b) =>
  b.addEventListener('click', () => startHumanGame(`par-mcts2@${b.dataset.ms}`)));
$('#btn-new').addEventListener('click', () => {
  // 用当前游戏的难度重开一局 (续局进来时从快照恢复超时, 兜底困难 20s)
  if (G?.mode === 'human') startHumanGame(lastSpec || `par-mcts2@${G.botTimeoutMs?.[1 - (G.humanSeat ?? 0)] || 20000}`);
});
$('#logo').addEventListener('click', () => { location.hash = ''; location.reload(); }); // 回主页(丢掉 hash, 不自动续局)

/** 等对局首屏图片加载/失败完成(带超时兜底); 首屏渲染完成后再调 /api/bot */
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
  botThinking = null; // 旧局的思考状态作废, 避免新局复用旧请求
  if (payload.file) location.hash = payload.file; // 刷新可自动续局
  ui = freshUi();
  $('#setup').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#btn-new').classList.toggle('hidden', payload.mode !== 'human');
  $('#agent-controls').classList.toggle('hidden', G.mode !== 'agents');
  $('#human-controls').classList.toggle('hidden', G.mode !== 'human');
  render();
  if (payload.pending) {
    const id = payload.id;
    boardImagesSettled().then(() => {
      requestBot(`/api/bot/${id}`).then((r) => {
        if (G?.id !== id) return; // 期间重开了新局, 丢弃旧局响应
        Object.assign(G, r);
        revealBotMove();
      }).catch((err) => {
        if (G?.id !== id) return;
        $('#move-error').textContent = err.message;
        render();
      });
    });
  }
}

// ---------------- 渲染 ----------------
function requestBot(path) {
  if (botThinking) return botThinking.promise;
  const seat = G.view.current;
  const timeoutMs = G.botTimeoutMs?.[seat] ?? 20000;
  const thinking = { seat, startedAt: performance.now(), timeoutMs: Math.max(1, timeoutMs), timer: null, promise: null };
  botThinking = thinking;
  thinking.promise = api(path, {}).finally(() => {
    clearInterval(thinking.timer);
    if (botThinking === thinking) {
      botThinking = null;
      renderPlayers();
    }
  });
  renderPlayers();
  renderBotProgress();
  thinking.timer = setInterval(renderBotProgress, 100);
  return thinking.promise;
}

function renderBotProgress() {
  if (!botThinking) return;
  const row = $(`#players .player[data-seat="${botThinking.seat}"] .bot-progress`);
  if (!row) return;
  const fraction = Math.min(1, Math.max(0, (performance.now() - botThinking.startedAt) / botThinking.timeoutMs));
  row.querySelector('progress').value = fraction;
  row.querySelector('span').textContent = fraction === 1 ? '等待结果…' : '思考中';
}

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
  } else if (ui.showBotMove && (G.recentMoves?.length ?? 0) > 0) {
    renderBotMoveModal(box);
    show = true;
  }
  root.classList.toggle('hidden', !show);
  if (!show) resetModalPosition(box);
  else if (modalPosition) positionModal(box, modalPosition.x, modalPosition.y);
}

function positionModal(box, x, y) {
  box.classList.add('moved');
  const bounds = box.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, innerWidth - bounds.width - 8));
  const top = Math.max(8, Math.min(y, innerHeight - bounds.height - 8));
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  modalPosition = { x: left, y: top };
}

function resetModalPosition(box) {
  modalPosition = null;
  box.classList.remove('moved', 'dragging');
  box.style.removeProperty('left');
  box.style.removeProperty('top');
}

function modalDragButton(box) {
  const handle = el('button', 'modal-drag', '✥');
  handle.title = '拖动弹窗（方向键移动，Home 居中）';
  handle.setAttribute('aria-label', '拖动弹窗');
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    handle.focus({ preventScroll: true });
    const bounds = box.getBoundingClientRect();
    drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, left: bounds.left, top: bounds.top };
    positionModal(box, bounds.left, bounds.top);
    box.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    positionModal(box, drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y);
  });
  const stop = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag = null;
    box.classList.remove('dragging');
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('lostpointercapture', stop);
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Home') { e.preventDefault(); resetModalPosition(box); return; }
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[e.key];
    if (!direction) return;
    e.preventDefault();
    const bounds = box.getBoundingClientRect();
    const distance = e.shiftKey ? 40 : 10;
    positionModal(box, bounds.left + direction[0] * distance, bounds.top + direction[1] * distance);
  });
  return handle;
}

function modalHead(box, title) {
  const head = el('div', 'modal-head');
  head.append(el('h3', '', title));
  const x = el('button', 'modal-x', '✕');
  x.title = '关闭 (Esc)';
  x.addEventListener('click', closeModal);
  const actions = el('div', 'modal-head-actions');
  actions.append(modalDragButton(box), x);
  head.append(actions);
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
  modalHead(box, '卡牌详情');
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
    const plan = paymentPlan(me, def);
    if (plan) {
      const costLine = el('div', 'cd-cost');
      costLine.append(span('lab', plan.ok ? '支付:' : '还差:'));
      if (plan.list.length === 0) costLine.append(span('hint', '折扣已覆盖, 无需支付'));
      for (const [g, n] of plan.list) costLine.append(tokenChip(g, n, `${GEMZH[g] ?? TZH[g]}×${n}`));
      side.append(costLine);
    }
    const buy = el('button', 'primary big', '买卡');
    buy.disabled = !buyMatch;
    buy.title = plan ? planTitle(plan) : '';
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
    if (i === 12) d.classList.add('start'); // 螺旋起点 (game.Spiral[0] = 中心格)
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
  // 主动补货固定在棋盘右上角; 不可补货时置灰禁用。
  const refill = el('button', 'opt-chip board-refill');
  refill.append(span('', '🔄'));
  const canRefill = myTurn() && canReplenishNow();
  refill.disabled = !canRefill;
  refill.title = canRefill ? '主动补货 · 随机回填空格，对手得 1 特权' : '当前不可主动补货';
  if (canRefill) refill.addEventListener('click', () => { ui.phase = 'replenish'; render(); });
  b.append(refill);
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

  renderPools();
}

function renderPools() {
  const pool = $('#pool-royal');
  pool.replaceChildren();
  if (G.view.royals.length === 0) pool.append(el('span', 'royal none', '无'));
  G.view.royals.forEach((r, i) => {
    pool.append(royalBtn(r, ui.extras.royalPick === i, () => { ui.extras.royalPick = i; }));
  });
  const privileges = 3 - G.view.players[0].privileges - G.view.players[1].privileges;
  const privilegePool = $('#pool-priv');
  privilegePool.replaceChildren(privilegeIcons(privileges));
  privilegePool.setAttribute('aria-label', `特权池剩余 ${privileges} 枚`);
  privilegePool.title = `特权池剩余 ${privileges} 枚`;
  const bag = $('#pool-bag');
  bag.replaceChildren();
  bag.setAttribute('aria-label', '袋中宝石');
  const cnt = {};
  for (const t of G.view.bag) cnt[t] = (cnt[t] ?? 0) + 1;
  const gemBox = el('span', 'res-box gem-box');
  for (const c of ALL_COLORS) {
    const count = cnt[c] ?? 0;
    gemBox.append(tokenChip(c, count, `袋中${TZH[c]}宝石 ${count} 枚`, count === 0));
  }
  bag.append(gemBox, privilegePool);
}

function renderPlayers() {
  const box = $('#players');
  box.replaceChildren();
  const seats = G.mode === 'human' ? [1 - G.seat, G.seat] : [0, 1];
  for (const s of seats) {
    const p = G.view.players[s];
    const mine = G.mode === 'human' && s === G.seat;
    const card = el('div', 'player');
    card.dataset.seat = String(s);
    if (G.view.current === s && !G.over) card.classList.add('active');

    const head = el('div', 'p-head');
    const bot = /bot/i.test(p.name);
    let label = p.name;
    if (bot) label = '🤖';
    const name = span('name', label);
    if (G.view.current === s && !G.over) name.append(' 👈');
    if (bot) { name.title = p.name; name.setAttribute('aria-label', p.name); }
    head.append(name);
    // 估计胜率紧跟 bot emoji; hover 显示模拟次数。
    if (bot && G.botSearch?.[s]?.winRate != null) {
      const metrics = G.botSearch[s];
      const wr = span('winrate', `胜率 ${(metrics.winRate * 100).toFixed(1)}%`);
      wr.title = `第 ${metrics.turn} 回合的搜索；胜率为本方所选走法的模拟估计 · 模拟 ${metrics.simulations.toLocaleString()} 次，单步 ${metrics.moveSimulations} 次`;
      head.append(wr);
    }
    const stats = el('div', 'p-stats');
    stats.append(span('pts', `${p.points} 分`), span('sep', '·'), span('cr', `${p.crowns} 👑`));
    head.append(stats);
    card.append(head);

    if (bot) {
      // 进度条常驻: 思考时显示耗时, 空闲时归零。
      const search = el('div', 'bot-search');
      const progress = el('div', 'bot-progress');
      const bar = el('progress');
      bar.max = 1;
      bar.value = 0;
      bar.setAttribute('aria-label', 'Bot 思考耗时进度');
      const idle = botThinking?.seat !== s;
      progress.append(span('', idle ? '空闲' : '思考中'), bar);
      search.append(progress);
      search.title = botThinking?.seat === s ? '根据本次请求的耗时与搜索 timeout 计算' : '等待 bot 行动';
      card.append(search);
    }

    const tokens = el('div', 'tokens');
    tokens.setAttribute('aria-label', '持有宝石');
    const gems = el('span', 'res-box gem-box');
    for (const c of [...PEARL_COLORS, 'gold']) gems.append(tokenChip(c, p.tokens[c] ?? 0, `${p.name}的${TZH[c]}宝石`));
    tokens.append(gems);
    if (p.privileges > 0) {
      const usable = mine && myTurn() && G.legal.privilegeCells.length > 0;
      let tag = 'span';
      if (usable) tag = 'button';
      const privs = el(tag, 'res-box priv-box');
      privs.append(privilegeIcons(p.privileges));
      // 数量本身就是使用特权的入口。
      if (usable) {
        privs.title = '使用特权 · 每枚特权可从棋盘拿 1 个非金 token';
        privs.setAttribute('aria-label', `使用特权，剩余 ${p.privileges} 枚`);
        privs.addEventListener('click', () => { ui.privileges = []; ui.phase = 'priv'; render(); });
      }
      tokens.append(privs);
    }
    card.append(tokens);

    // 每色已购卡: 折扣 + 累计分 (同色 10 分即胜); 皇家卡放在其下。
    const cardsCard = el('div', 'panel-card owned');
    cardsCard.append(el('span', 'lab', '已购买的宝石:'));
    const chips = el('div', 'cards-line');
    if (p.cards.length > 0) {
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
        const badge = el('span', `pool-token ${TCSS[g]}`);
        badge.append(gemEl(g), span('n', String(p.bonuses[g] ?? 0)));
        chip.append(badge, span('n', `${e.pts} 分`));
        chip.title = `${GEMZH[g]}卡 ×${e.n} · 折扣${p.bonuses[g] ?? 0} · 累计${e.pts}分 (同色10分获胜)`;
        chips.append(chip);
      }
      if (nonePts > 0) {
        const chip = el('span', 'tok cchip');
        chip.append(span('n', `分卡·${nonePts}分`));
        chip.title = `无色分卡 · 累计${nonePts}分`;
        chips.append(chip);
      }
    }
    cardsCard.append(chips);
    card.append(cardsCard);

    const reserved = el('div', 'panel-card reserved');
    reserved.append(el('span', 'lab', '预留:'));
    if (p.reserved.length > 0 && (mine || G.mode === 'agents')) {
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
    } else if (p.reserved.length > 0) {
      const minis = el('div', 'minicards');
      for (let i = 0; i < p.reserved.length; i++) minis.append(miniBack());
      reserved.append(minis);
    }
    card.append(reserved);
    if (box.children.length) box.append(el('div', 'player-sep'));
    box.append(card);
  }
  renderBotProgress();
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
  $('#actionbar').classList.toggle('hidden', G.mode !== 'agents');
  // 被迫补货提示: 展示至人类提交走法 (服务端清空)
  const notice = $('#notice');
  notice.classList.toggle('hidden', !G.notice);
  notice.textContent = G.notice ?? '';
  $('#human-turn').classList.toggle('hidden', G.mode !== 'human');
  if (G.mode === 'agents') {
    $('#turn-indicator').textContent = G.over ? '对局结束' : `第 ${G.view.turnCount + 1} 回合 · 轮到 ${G.names[G.view.current]}`;
  }
  if (G.mode !== 'human') return;

  const pick = $('#pick-bar');
  pick.replaceChildren();

  if (!turn) {
    pick.append(el('span', 'hint', '等待对手行动…'));
    return;
  }

  // 当前选择进度: 按颜色聚合, 数字写在 token 中间 (不显示坐标)
  if (ui.pick?.t === 'take') {
    const counts = {};
    for (const i of ui.pick.cells) {
      const c = G.view.board[i];
      if (c) counts[c] = (counts[c] ?? 0) + 1;
    }
    for (const c of ALL_COLORS) {
      if (!counts[c]) continue;
      pick.append(tokenChip(c, counts[c], `已选 ${TZH[c]}宝石 ×${counts[c]}`));
    }
    if (!ui.action) {
      pick.append(el('span', 'error-inline', '组合不可行'));
    } else {
      // 匹配即可提交 (新增选满会自动提交, 此处覆盖取消选择后的停留状态)
      const go = el('button', 'primary', `拿 ${ui.pick.cells.length} 枚 ✓`);
      go.title = 'Enter 也可提交 · 点已选格可取消';
      go.addEventListener('click', () => afterActionChosen());
      pick.append(go);
    }
  } else if (ui.pick?.want === 'reserve') {
    pick.append(el('span', 'error-inline', '← 点击棋盘上要拿的黄金 token'));
  } else if (ui.action) {
    pick.append(el('span', 'ok-inline', '✓ 提交中…'));
  }
  if (!ui.pick && !ui.action && !ui.hint) pick.append(el('span', 'hint', '点击棋盘上的宝石进行选择'));
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
    const head = el('div', 'row');
    head.append(el('b', '', `token 将超 10, 弃置 ${excess} 枚:`));
    body.append(head);
    const list = el('div', 'discard-list');
    ALL_COLORS.filter((t) => after[t] > 0).forEach((t) => {
      const item = el('div', 'discard-item');
      const num = el('span', 'n', String(ui.extras.discard?.[t] ?? 0));
      const bump = (d) => {
        const v = Math.max(0, Math.min(after[t], (ui.extras.discard?.[t] ?? 0) + d));
        (ui.extras.discard ??= {})[t] = v;
        num.textContent = String(v); // 局部刷新, 不整页重渲染
        refreshExtrasConfirm(excess);
      };
      const minus = el('button', 'step', '−');
      minus.type = 'button';
      minus.addEventListener('click', () => bump(-1));
      const plus = el('button', 'step', '+');
      plus.type = 'button';
      plus.addEventListener('click', () => bump(1));
      const tok = el('span', `pool-token ${TCSS[t]}`); // 数字叠在 token 上
      tok.append(gemEl(t), num);
      item.append(minus, tok, plus);
      list.append(item);
    });
    body.append(list, el('span', 'error-inline discard-hint', ''));
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
  let discardHint = '';
  if (dsum < excess) discardHint = `还需弃 ${excess - dsum} 枚`;
  else if (dsum > excess) discardHint = '弃多了';
  if (hint) hint.textContent = discardHint;
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
  let head;
  if (G.over) head = `${G.draw ? '🤝 和局' : `🏆 ${G.names[G.winner]} 获胜!`} · ${G.names[1 - G.seat]} 的最后操作`;
  else head = `🤖 ${G.names[1 - G.seat]} 的操作`;
  modalHead(box, head);
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

function tokenCountsRow(counts) {
  const row = el('span', 'bm-gems bm-counts');
  for (const color of ALL_COLORS) {
    const n = counts?.[color] ?? 0;
    if (!n) continue;
    row.append(tokenChip(color, `×${n}`, `${TZH[color]} ×${n}`));
  }
  return row;
}

function tokenDeltaRow(counts) {
  const row = el('span', 'bm-gems bm-counts');
  for (const color of ALL_COLORS) {
    const n = counts?.[color] ?? 0;
    if (!n) continue;
    let count = `−${Math.abs(n)}`;
    if (n > 0) count = `+${n}`;
    row.append(tokenChip(color, count, `${TZH[color]} ${count}`));
  }
  return row;
}

function botMoveRow(v) {
  const r = el('div', 'bot-move');
  const step = (label, ...content) => {
    const row = el('div', 'bm-step');
    row.append(span('bm-number', String(r.children.length + 1)));
    const body = el('div', 'bm-step-body');
    body.append(span('bm-lab', label), ...content);
    row.append(body);
    r.append(row);
    return body;
  };
  const privilege = () => {
    if (v.privGems?.length) step('使用特权', span('bm-extra', `消耗 ${v.privGems.length} 枚特权`), gemsRow(v.privGems));
  };
  const replenish = () => {
    if (v.replenished) step('补充棋盘', span('bm-extra', '从袋中回填空格 · 你获得 1 枚特权'));
  };
  if (v.replenishFirst) { replenish(); privilege(); }
  else { privilege(); replenish(); }
  const a = v.action ?? {};
  let main;
  if (a.kind === 'take') {
    main = step('拿取宝石', gemsRow(v.takeGems), botTakeBoard(v));
  } else if (a.kind === 'reserve') {
    main = step('预留卡牌', v.card ? miniCard(v.card, null, true) : miniBack(), span('bm-extra', '获得黄金'), gemsRow(['gold']));
  } else if (a.kind === 'buy' && v.card) {
    main = step('购买卡牌', miniCard(v.card, v.associateGem, true));
    if (v.payment) {
      const counts = tokenCountsRow(v.payment);
      if (counts.childElementCount) main.append(span('bm-extra', '支付'), counts);
      else main.append(span('bm-extra', '无需支付宝石'));
    }
  }
  if (v.refill && main) {
    const refill = el('div', 'bm-refill');
    refill.append(span('bm-extra', '市场空位补入'), miniCard(v.refill, null, true));
    main.append(refill);
  }
  if (v.associateGem) step('百搭叠色', span('bm-extra', '叠放到已有折扣颜色'), gemsRow([v.associateGem]));
  const royals = v.royals ?? (v.royal ? [v.royal] : []);
  const stealSources = Number(a.kind === 'buy' && v.card?.ability === 'steal') + royals.filter(royal => royal.ability === 'steal').length;
  const combinedSteal = stealSources > 1;
  const ability = (source, kind) => {
    if (!kind) return;
    const labels = { turn: '额外回合', privilege: '获得特权', steal: '偷取', takeSame: '拿同色' };
    const descriptions = {
      turn: '接下来继续行动一回合',
      privilege: '触发获得 1 枚特权的效果（上限 3 枚）',
    };
    if (kind === 'steal') {
      if (combinedSteal) descriptions.steal = '尝试从你手中偷取 1 枚非黄金宝石（合计结果见下方）';
      else if (v.stealGem) descriptions.steal = '从你手中偷取 1 枚宝石';
      else descriptions.steal = '你没有可偷取的非黄金宝石';
    } else if (kind === 'takeSame') {
      descriptions.takeSame = v.takeSameGem ? '从棋盘额外拿取 1 枚同色宝石' : '棋盘没有可拿取的同色宝石';
    }
    const body = step(`${source} · ${labels[kind] ?? ABZH[kind] ?? kind}`, span('bm-extra', descriptions[kind] ?? ''));
    let gem = null;
    if (kind === 'steal' && !combinedSteal) gem = v.stealGem;
    else if (kind === 'takeSame') gem = v.takeSameGem;
    if (gem) body.append(gemsRow([gem]));
  };
  if (a.kind === 'buy') ability('卡牌能力', v.card?.ability);
  for (const royal of royals) {
    step('领取皇家卡', miniRoyal(royal));
    ability('皇家能力', royal.ability);
  }
  if (combinedSteal) {
    const stolen = v.stealGems ?? (v.stealGem ? [v.stealGem] : []);
    step('偷取结果', span('bm-extra', stolen.length ? `共偷取 ${stolen.length} 枚宝石` : '你没有可偷取的非黄金宝石'), gemsRow(stolen));
  }
  if (v.deltas) {
    const summary = el('div', 'bm-summary');
    summary.append(span('bm-extra', '本次变化'), deltasRow(v.deltas));
    const changes = tokenDeltaRow(v.tokenChanges);
    if (changes.childElementCount) {
      const tokens = el('div', 'bm-token-changes');
      tokens.append(span('bm-extra', '宝石净变化'), changes);
      summary.append(tokens);
    }
    r.append(summary);
  }
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
      const r2 = await requestBot(`/api/bot/${G.id}`);
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
addEventListener('resize', () => {
  if (modalPosition) positionModal($('#modal-box'), modalPosition.x, modalPosition.y);
});

// ---------------- Agent 对战控制 ----------------
$('#btn-step').addEventListener('click', async () => {
  if (G.over) return;
  const res = await requestBot(`/api/step/${G.id}`);
  Object.assign(G, res);
  render();
});

$('#btn-auto').addEventListener('click', () => {
  if (autoTimer) { stopAuto(); return; }
  $('#btn-auto').textContent = '停止 ⏹';
  autoTimer = setInterval(async () => {
    if (G.over) { stopAuto(); return; }
    if (botThinking) return;
    try {
      const res = await requestBot(`/api/step/${G.id}`);
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
