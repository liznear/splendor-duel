// 前端主逻辑 (DOM API 构建, 无 innerHTML)
// 交互模型: 直接点击棋盘格/卡片构建走法, 与 legalMoves 匹配后提交
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
  const card = el('div', `card img-card${opts.clickable ? ' clickable' : ''}${opts.selected ? ' selected' : ''}`);
  const img = el('img');
  img.src = `/cards/${c.id}.png`;
  img.alt = cardTitle(c);
  img.loading = 'lazy';
  card.append(img);
  card.title = cardTitle(c);
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
  const m = el('div', `mini${showBig ? ' mc-cost' : ''}${opts.clickable ? ' clickable' : ''}${opts.selected ? ' selected' : ''}`);
  const img = el('img');
  img.src = `/cards/${def.id}.png`;
  img.alt = cardTitle(def, chosenColor);
  img.loading = 'lazy';
  m.append(img);
  m.title = cardTitle(def, chosenColor);
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

/** 回合内可分步执行: 特权 → 补货 → 主行动 */
function freshUi() {
  const base = { pick: null, action: null, privileges: [], phase: startPhase(), takeSamePick: null, extras: {}, hint: '', optDone: { priv: false, rep: false }, asked: { priv: false, rep: false }, discardExcess: -1 };
  return base;
}
function startPhase() {
  const me = G.view.players[G.seat];
  if (myTurn() && me.privileges > 0 && G.legal.privilegeCells.length > 0) return 'priv';
  if (myTurn() && canReplenishNow()) return 'replenish';
  return 'main';
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
  } else if (myTurn() && ui.phase === 'main' && ui.pick?.want === 'reserve' && t === 'gold') {
    ui.pick.goldCell = i;
    tryMatchReserve();
  } else if (myTurn() && ui.phase === 'main' && ui.pick?.t === 'take') {
    const k = ui.pick.cells.indexOf(i);
    if (k >= 0) ui.pick.cells.splice(k, 1);
    else ui.pick.cells.push(i);
    if (!validTakeSet(ui.pick.cells)) { ui.pick.cells = ui.pick.cells.slice(0, 1); } // 回退到单选
    if (ui.pick.cells.length === 0) ui.pick = null;
    tryMatchTake();
  } else if (myTurn() && ui.phase === 'main' && t != null && t !== 'gold') {
    ui.pick = { t: 'take', cells: [i] };
    tryMatchTake();
  }
  render();
}
function tryMatchTake() {
  ui.action = matchAction({ kind: 'take', cells: sortedCells(ui.pick.cells) });
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
/** 点击自己预留卡 */
function pickReservedCard(index) {
  if (!myTurn()) return;
  const from = { kind: 'reserved', index };
  const matched = matchAction({ kind: 'buy', from });
  if (!matched && ui.privileges.length === 0) { ui.hint = '这张预留卡当前买不起 (可先用特权拿 token 再点)'; render(); return; }
  ui.pick = { t: 'buyRes', index };
  ui.extras = {}; ui.takeSamePick = null;
  ui.action = matched ?? { i: -1, action: { kind: 'buy', from } };
  ui.hint = '';
  render();
}
/** 点击牌库(盲留) */
function pickDeck(level) {
  if (!myTurn()) return;
  ui.action = null;
  ui.extras = {}; ui.takeSamePick = null;
  ui.pick = { t: 'deck', level, want: 'reserve' };
  render();
}

// ---------------- 设置面板 ----------------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#setup-human').classList.toggle('hidden', t.dataset.mode !== 'human');
  $('#setup-agents').classList.toggle('hidden', t.dataset.mode !== 'agents');
}));

function llmSpec(sel, modelInput) {
  const v = $(sel).value;
  if (v !== 'llm') return v;
  const m = $(modelInput).value.trim();
  return m ? `llm:${m}` : 'llm';
}

$('#btn-start').addEventListener('click', async () => {
  const spec = llmSpec('#h-bot', '#h-model');
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
  const payload = await api('/api/new', { mode: 'agents', p1: llmSpec('#a-p1', '#a-model'), p2: llmSpec('#a-p2', '#a-model') });
  startGame(payload);
});

$('#btn-new').addEventListener('click', () => location.reload());

let modalWasShown = false;

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

function startGame(payload) {
  G = payload;
  ui = freshUi();
  $('#setup').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#agent-controls').classList.toggle('hidden', G.mode !== 'agents');
  $('#human-controls').classList.toggle('hidden', G.mode !== 'human');
  render();
  if (payload.pending) {
    awaitBot(api(`/api/bot/${G.id}`, {})).then((r) => {
      Object.assign(G, r);
      ui = freshUi();
      render();
    });
  }
}

// ---------------- 渲染 ----------------
function render() {
  renderBoard();
  renderPyramid();
  renderPlayers();
  renderLog();
  renderBanner();
  renderActionbar();
  renderModals();
}

/** 回合开始弹窗: ①特权 ②补货 (顺序固定, 先补货时可从特权弹窗切换) */
function renderModals() {
  const root = $('#modal-root'), box = $('#modal-box');
  const show = myTurn() && (ui.phase === 'priv' || ui.phase === 'replenish');
  root.classList.toggle('hidden', !show);
  if (show && !modalWasShown) { // 每次重新打开默认归位左上角, 不挡棋盘
    box.style.position = 'fixed';
    box.style.left = '16px';
    box.style.top = '16px';
    box.style.width = '';
  }
  modalWasShown = show;
  if (!show) return;
  box.replaceChildren();
  const me = G.view.players[G.seat];
  const canRep = canReplenishNow();
  const privAvail = me.privileges > 0 && G.legal.privilegeCells.length > 0;
  const nextOf = (ph) => {
    if (ph === 'priv') return canRep && !ui.optDone.rep && !ui.asked.rep ? 'replenish' : 'main';
    return privAvail && !ui.optDone.priv && !ui.asked.priv ? 'priv' : 'main';
  };
  // 即时执行可选行动: 确认后立刻向服务端应用, 棋盘/面板实时更新
  const execOption = async (opts) => {
    try {
      const res = await api(`/api/option/${G.id}`, { seat: G.seat, ...opts });
      Object.assign(G, res);
      return true;
    } catch (err) {
      ui.hint = err.message;
      return false;
    }
  };
  if (ui.phase === 'priv') {
    modalHead(box, '💎 使用特权?');
    box.append(el('div', 'hint', `持有 ${me.privileges} 枚 · 每枚可从棋盘拿 1 个非金 token · 已选 ${ui.privileges.length}/${me.privileges} · 点下方棋盘选取`));
    const gridB = el('div', 'modal-board');
    G.view.board.forEach((t, i) => {
      const sel = G.legal.privilegeCells.includes(i);
      const c = el('div', `mcell${t == null ? ' empty' : ''}${sel ? ' clickable' : ' dead'}${ui.privileges.includes(i) ? ' picked' : ''}`);
      if (t != null) c.append(gemEl(t));
      else c.textContent = '·';
      if (sel) c.addEventListener('click', () => pickCell(i));
      gridB.append(c);
    });
    box.append(gridB);
    const row = el('div', 'modal-actions');
    const ok = el('button', 'primary', ui.privileges.length ? '确认拿取 ✓' : '不用特权 ▸');
    ok.addEventListener('click', async () => {
      if (ui.privileges.length) {
        const cells = [...ui.privileges];
        if (!(await execOption({ privileges: cells }))) return; // 服务端已应用, 失败则留在本弹窗
        ui.privileges = [];
        ui.optDone.priv = true; // 已真实执行, 不可反悔
      }
      ui.asked.priv = true; // 跳过仅是本地决定, 随时可反悔重开
      ui.phase = nextOf('priv');
      render();
    });
    const swap = el('button', 'ghost', '先补货 ▸');
    swap.addEventListener('click', () => { ui.phase = 'replenish'; render(); });
    swap.hidden = !canRep || ui.optDone.rep;
    row.append(ok, swap);
    box.append(row);
  } else {
    const empties = G.view.board.filter((t) => t == null).length;
    modalHead(box, '🔄 主动补货?');
    box.append(el('div', 'hint', `棋盘 ${empties} 个空格 · 从袋中随机回填 · 对手获得 1 特权`));
    const row = el('div', 'modal-actions');
    const yes = el('button', 'primary', '补货 (对手得1特权)');
    yes.addEventListener('click', async () => {
      if (!(await execOption({ replenish: true }))) return;
      ui.optDone.rep = true; // 已真实执行, 不可反悔
      ui.asked.rep = true;
      ui.phase = nextOf('replenish');
      render();
    });
    const no = el('button', '', '跳过 ▸');
    no.addEventListener('click', () => { ui.asked.rep = true; ui.phase = nextOf('replenish'); render(); }); // 跳过可反悔
    const swap = el('button', 'ghost', '先特权 ▸');
    swap.addEventListener('click', () => { ui.phase = 'priv'; render(); });
    swap.hidden = !privAvail || ui.optDone.priv;
    row.append(yes, no, swap);
    box.append(row);
  }
  makeModalDraggable(box);
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
  G.view.board.forEach((t, i) => {
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

  const rows = [[0, 1, 2], [3, 4, 5, 6], [7, 8, 9, 10, 11]];
  for (const row of rows) {
    const r = el('div', 'pyr-row');
    for (const s of row) {
      const c = G.view.pyramid[s];
      if (!c) { r.append(cardBack(s)); continue; }
      const selected = ui.pick?.t === 'card' && ui.pick.slot === s;
      const card = cardEl(c, { slot: s, clickable: myTurn(), selected });
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
    head.append(span('name', `${p.name}${mine ? ' (我)' : ''}`));
    const stats = el('div', 'p-stats');
    stats.append(el('span', '', '积分'), span('pts', String(p.points)));
    stats.append(el('span', '', '皇冠'), span('cr', `♛${p.crowns}`));
    stats.append(el('span', '', `特权×${p.privileges}`));
    if (p.royals.length) stats.append(el('span', '', `皇家×${p.royals.length}`));
    head.append(stats);
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
      const minis = el('div', 'minicards');
      p.reserved.forEach((c, index) => {
        if (c.id === 'hidden') { minis.append(miniBack()); return; }
        const selected = ui.pick?.t === 'buyRes' && ui.pick.index === index;
        const m = miniCard(c, null, true, { clickable: mine && myTurn(), selected });
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

function renderLog() {
  const lg = $('#log');
  lg.replaceChildren();
  for (const line of G.view.log.slice(-40)) lg.append(el('div', '', line));
  lg.scrollTop = lg.scrollHeight;
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
function discardExcess() {
  const me = G.view.players[G.seat];
  const held = Object.values(me.tokens).reduce((s, n) => s + n, 0); // 特权 token 已即时入账
  const a = ui.action?.action;
  // ponytail: 购买(支付+拿同色/偷取)后仍超 10 的罕见组合不预测, 交引擎默认贪心弃置
  const gain = a?.kind === 'take' ? a.cells.length : a?.kind === 'reserve' ? 1 : 0;
  return Math.max(0, held + gain - 10);
}
// 预填与引擎一致的默认弃置方案: 先宝石, 再珍珠, 最后黄金
function defaultDiscard(excess) {
  const me = G.view.players[G.seat];
  const d = {};
  let left = excess;
  for (const t of ['black', 'red', 'green', 'blue', 'white', 'pearl', 'gold']) {
    const n = Math.min(left, me.tokens[t]);
    if (n > 0) d[t] = n;
    left -= n;
  }
  return d;
}

function renderActionbar() {
  const turn = myTurn();
  $('#human-turn').classList.toggle('hidden', !turn);
  $('#thinking').classList.toggle('hidden', !(G.mode === 'human' && !turn && !G.over));
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

  const me = G.view.players[G.seat];

  // ---- 当前选择区 ----
  const pick = $('#pick-bar');
  pick.replaceChildren();
  ui.hint = ui.hint ?? '';
  // 特权/补货: 随时重开 modal (未用时可反悔跳过; 已即时执行过的不再展示)
  const privAvail2 = !ui.optDone.priv && me.privileges > 0 && G.legal.privilegeCells.length > 0;
  if (privAvail2) {
    const chip = el('button', 'tok bonus');
    chip.append(span('n', '💎 使用特权'));
    chip.title = '打开特权选择弹窗';
    chip.addEventListener('click', () => { ui.phase = 'priv'; render(); });
    pick.append(chip);
  }
  if (canReplenishNow() && !ui.optDone.rep) {
    const chip = el('button', 'tok bonus');
    chip.append(span('n', '🔄 主动补货'));
    chip.title = '随机回填空格 · 对手得1特权';
    chip.addEventListener('click', () => { ui.phase = 'replenish'; render(); });
    pick.append(chip);
  }
  if (!ui.pick) {
    pick.append(el('span', 'hint', '💡 点击棋盘格拿 token (横竖斜直线) · 点击卡片买卡 / 预留 · 点牌库盲留'));
  } else if (ui.pick.t === 'take') {
    pick.append(el('b', '', `拿取 ${ui.pick.cells.length}/3:`));
    for (const i of ui.pick.cells) {
      const tok = el('span', 'tok');
      tok.append(gemEl(G.view.board[i]), span('n', cellName(i)));
      pick.append(tok);
    }
    if (!ui.action) pick.append(el('span', 'error-inline', '当前组合不可行'));
    else pick.append(el('span', 'hint', '可继续加点 / 直接提交'));
  } else if (ui.pick.t === 'card') {
    const c = G.view.pyramid[ui.pick.slot];
    pick.append(el('b', '', '目标卡:'));
    pick.append(miniCard(c, null, true, { selected: true }));
    const buyFrom = { kind: 'pyramid', slot: ui.pick.slot };
    const buyMatch = matchAction({ kind: 'buy', from: buyFrom });
    // 特权拿的 token 可以同回合支付, 故选了特权时放行 (服务端权威校验)
    const buyOk = !!buyMatch || ui.privileges.length > 0;
    const canRes = me.reserved.length < 3 && goldCells().length > 0;
    const buyBtn = el('button', `primary${ui.action?.action.kind === 'buy' ? ' sel' : ''}`, '买卡');
    buyBtn.disabled = !buyOk;
    buyBtn.title = buyOk ? '' : 'token/折扣不足 (可先用特权拿 token)';
    buyBtn.addEventListener('click', () => {
      ui.action = buyMatch ?? { i: -1, action: { kind: 'buy', from: buyFrom } };
      ui.pick.want = null; ui.pick.goldCell = null;
      render();
    });
    const resBtn = el('button', '', '预留 + 拿黄金');
    resBtn.disabled = !canRes;
    resBtn.title = canRes ? '' : '场上无黄金或预留已满';
    resBtn.addEventListener('click', () => {
      ui.action = null;
      const golds = goldCells();
      if (golds.length === 1) { ui.pick.goldCell = golds[0]; tryMatchReserve(); }
      else ui.pick.want = 'reserve';
      render();
    });
    pick.append(buyBtn, resBtn);
    if (ui.pick.want === 'reserve') pick.append(el('span', 'error-inline', '← 点击棋盘上的黄金 token'));
  } else if (ui.pick.t === 'deck') {
    pick.append(el('b', '', `盲留 ${['一', '二', '三'][ui.pick.level - 1]}级牌库顶:`));
    if (ui.pick.want === 'reserve') pick.append(el('span', 'error-inline', '点击棋盘上的黄金 token'));
    else if (ui.action) pick.append(el('span', 'hint', '就绪'));
  } else if (ui.pick.t === 'buyRes') {
    pick.append(el('b', '', '购买预留卡:'));
    pick.append(miniCard(me.reserved[ui.pick.index], null, true, { selected: true }));
  }
  if (ui.hint) { pick.append(el('span', 'error-inline', ui.hint)); ui.hint = ''; }
  const cancel = el('button', 'ghost', '取消');
  cancel.addEventListener('click', () => {
    ui.pick = null; ui.action = null; ui.extras = {}; ui.takeSamePick = null;
    render();
  });
  if (ui.pick) pick.append(cancel);

  // ---- 附加选择 ----
  const excess = discardExcess();
  const ex = $('#extras');
  ex.replaceChildren();
  if (ui.action) {
    const c = actionCard();
    if (c && ui.action.action.kind === 'buy') {
      const row = el('div', 'row');
      row.append(el('b', '', '购买:'));
      row.append(miniCard(c, null, true, { selected: true }));
      ex.append(row);
    }
    if (associateNeeded()) {
      const colors = [...new Set(me.cards.map((x) => x.color).filter(Boolean))];
      ex.append(exRow('百搭卡叠放颜色:', colors.map((g) => colorBtn(g, () => { ui.extras.associateColor = g; }, ui.extras.associateColor === g))));
    }
    if (stealNeeded()) {
      const opp = G.view.players[1 - G.seat];
      const opts = PEARL_COLORS.filter((t) => opp.tokens[t] > 0);
      ex.append(exRow('偷取对手 token:', opts.map((t) => colorBtn(t, () => { ui.extras.stealPick = t; }, ui.extras.stealPick === t))));
    }
    if (royalStealNeeded()) {
      const opp = G.view.players[1 - G.seat];
      const opts = PEARL_COLORS.filter((t) => opp.tokens[t] > 0);
      ex.append(exRow('皇家卡偷取对手 token:', opts.map((t) => colorBtn(t, () => { ui.extras.stealPick = t; }, ui.extras.stealPick === t))));
    }
    if (takeSameNeeded() && c) {
      const cells = G.view.board.map((t, i) => (t === c.color ? i : -1)).filter((i) => i >= 0);
      ex.append(exRow(`「拿同色」选择${GEMZH[c.color]} token 格 (或点棋盘):`, cells.map((i) => cellBtn(i, () => { ui.takeSamePick = i; }, ui.takeSamePick === i))));
    }
    if (royalNeeded()) {
      ex.append(exRow('皇冠里程碑 → 选皇家卡:', G.view.royals.map((r, i) => royalBtn(r, ui.extras.royalPick === i, () => { ui.extras.royalPick = i; }))));
    }
    if (excess > 0) {
      if (ui.discardExcess !== excess) {
        ui.extras.discard = defaultDiscard(excess);
        ui.discardExcess = excess;
      }
      const div = el('div', 'row');
      div.append(el('b', '', `token 将超 10, 弃置 ${excess} 枚:`));
      ALL_COLORS.filter((t) => me.tokens[t] > 0).forEach((t) => {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; inp.max = String(me.tokens[t]);
        inp.value = ui.extras.discard[t] ?? 0;
        inp.addEventListener('input', () => {
          ui.extras.discard[t] = Number(inp.value || 0);
        });
        const tok = el('span', 'tok');
        tok.append(gemEl(t), inp);
        div.append(tok);
      });
      const dsum = Object.values(ui.extras.discard).reduce((s, n) => s + n, 0);
      if (dsum !== excess) div.append(el('span', 'error-inline', dsum < excess ? `还需弃 ${excess - dsum} 枚` : '弃多了'));
      ex.append(div);
    }
  }

  const ready = !!ui.action
    && (!associateNeeded() || ui.extras.associateColor)
    && (!royalNeeded() || Number.isInteger(ui.extras.royalPick))
    && ((!stealNeeded() && !royalStealNeeded()) || !!ui.extras.stealPick)
    && (excess <= 0 || Object.values(ui.extras.discard ?? {}).reduce((s, n) => s + n, 0) === excess);
  $('#btn-submit').disabled = !ready;
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
function cellBtn(i, onPick, picked) {
  const b = el('button', `tc-btn${picked ? ' picked' : ''}`);
  b.append(gemEl(G.view.board[i]), span('', cellName(i)));
  b.addEventListener('click', () => { onPick(); render(); });
  return b;
}

let botMsgOpen = false;
$('#bot-msg-toggle').addEventListener('click', () => { botMsgOpen = !botMsgOpen; render(); });

$('#btn-submit').addEventListener('click', async () => {
  if (!ui.action) return;
  const move = { action: ui.action.action };
  if (ui.privileges.length) move.privileges = ui.privileges; // 弹窗内临时选择走 applyMove; 已即时执行过则此处为空
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
      ui = freshUi();
      render();
    }
  } catch (err) {
    $('#move-error').textContent = err.message;
    render();
  }
});

/** 拖动 modal (按住标题栏或 ✥ 按钮) */
function modalHead(box, title) {
  const head = el('div', 'modal-head');
  head.append(el('h3', '', title));
  const drag = el('button', 'drag-btn', '✥ 拖动');
  drag.title = '按住拖动弹窗';
  head.append(drag);
  box.append(head);
}
function makeModalDraggable(box) {
  const start = (e) => {
    e.preventDefault();
    const r = box.getBoundingClientRect();
    box.style.position = 'fixed';
    box.style.width = `${r.width}px`;
    box.style.left = `${r.x}px`;
    box.style.top = `${r.y}px`;
    const dx = e.clientX - r.x, dy = e.clientY - r.y;
    const move = (ev) => {
      box.style.left = `${Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx))}px`;
      box.style.top = `${Math.max(0, Math.min(innerHeight - 48, ev.clientY - dy))}px`;
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  for (const h of box.querySelectorAll('.drag-btn, h3')) h.addEventListener('pointerdown', start);
}

// ---------------- 文字指挥 (LLM 解析自然语言 → 走法) ----------------
async function submitSay() {
  const text = $('#say-input').value.trim();
  if (!text || !myTurn()) return;
  const btn = $('#btn-say');
  btn.disabled = true;
  $('#say-status').textContent = '🤖 解析中…';
  $('#say-status').className = 'hint';
  try {
    const res = await api(`/api/say/${G.id}`, { seat: G.seat, text });
    if (!res.ok) { // 解析器向玩家澄清/说明, 局面不变
      $('#say-status').textContent = `🤖 ${res.reply}`;
      return;
    }
    Object.assign(G, res);
    ui = freshUi();
    $('#say-input').value = '';
    $('#say-status').textContent = `✅ ${res.say ?? '已执行'}`;
    render();
    if (res.pending) {
      $('#say-status').textContent = '';
      const r2 = await awaitBot(api(`/api/bot/${G.id}`, {}));
      Object.assign(G, r2);
      ui = freshUi();
      render();
    }
  } catch (err) {
    $('#say-status').textContent = `⚠ ${err.message}`;
    $('#say-status').className = 'error-inline';
  } finally {
    btn.disabled = false;
  }
}
$('#btn-say').addEventListener('click', submitSay);
$('#say-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitSay();
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
