// 前端主逻辑 (DOM API 构建, 无 innerHTML)
const $ = (s) => document.querySelector(s);
const TZH = { white: '白', blue: '蓝', green: '绿', red: '红', black: '黑', pearl: '珠', gold: '金' };
const TCSS = { white: 't-white', blue: 't-blue', green: 't-green', red: 't-red', black: 't-black', pearl: 't-pearl', gold: 't-gold' };
const GEMZH = { white: '白', blue: '蓝', green: '绿', red: '红', black: '黑' };
const ABZH = { turn: '额外回合', takeSame: '拿同色', steal: '偷取', privilege: '特权' };
const PEARL_COLORS = ['white', 'blue', 'green', 'red', 'black', 'pearl'];
const ALL_COLORS = [...PEARL_COLORS, 'gold'];

let G = null; // {id, mode, seat, view, legal, over, winner, draw, ...}
let ui = { action: null, privileges: [], privMode: false, replenish: false, takeSamePick: null, extras: {} };
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
const cardColorName = (c) => c.isAssociate ? '百搭' : c.color ? `${GEMZH[c.color]}卡` : '分卡';

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

function startGame(payload) {
  G = payload;
  ui = { action: null, privileges: [], privMode: false, replenish: false, takeSamePick: null, extras: {} };
  $('#setup').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#agent-controls').classList.toggle('hidden', G.mode !== 'agents');
  $('#human-controls').classList.toggle('hidden', G.mode !== 'human');
  render();
}

// ---------------- 渲染 ----------------
function render() {
  renderBoard();
  renderPyramid();
  renderPlayers();
  renderLog();
  renderBanner();
  renderActionbar();
}

function renderBoard() {
  const b = $('#board');
  b.replaceChildren();
  b.appendChild(el('div', 'corner', ''));
  [...'ABCDE'].forEach((c) => b.appendChild(el('div', 'corner', c)));
  G.view.board.forEach((t, i) => {
    if (i % 5 === 0) b.appendChild(el('div', 'corner', String(Math.floor(i / 5) + 1)));
    const d = el('div', `cell${t == null ? ' empty' : ''}${t === 'gold' ? ' gold' : ''}`, t == null ? '·' : TZH[t]);
    if (t != null) d.classList.add(TCSS[t]);
    if (canPickCell(i)) {
      d.classList.add('clickable');
      d.addEventListener('click', () => pickCell(i));
    }
    if (ui.privileges.includes(i) || ui.takeSamePick === i) d.classList.add('picked');
    if (t != null) d.appendChild(el('span', 'tag', cellName(i)));
    b.appendChild(d);
  });
}

function canPickCell(i) {
  const t = G.view.board[i];
  if (t == null || t === 'gold') return false;
  const myTurn = G.legal != null;
  if (myTurn && ui.privMode && G.legal.privilegeCells.includes(i)) return true;
  if (myTurn && ui.action?.action?.kind === 'buy' && takeSameNeeded() && cellOfMyCardColor(i)) return true;
  return false;
}
function cellOfMyCardColor(i) {
  const card = actionCard();
  return card && card.color && G.view.board[i] === card.color;
}
function pickCell(i) {
  if (ui.privMode && G.legal.privilegeCells.includes(i)) {
    const me = G.view.players[G.seat];
    const k = ui.privileges.indexOf(i);
    if (k >= 0) ui.privileges.splice(k, 1);
    else if (ui.privileges.length < me.privileges) ui.privileges.push(i);
  } else if (takeSameNeeded() && cellOfMyCardColor(i)) {
    ui.takeSamePick = i;
  }
  render();
}

function renderPyramid() {
  const rows = [[0, 1, 2], [3, 4, 5, 6], [7, 8, 9, 10, 11]];
  const pyr = $('#pyramid');
  pyr.replaceChildren();
  for (const row of rows) {
    const r = el('div', 'pyr-row');
    for (const s of row) {
      const c = G.view.pyramid[s];
      const card = el('div', 'card');
      card.appendChild(span('slot', `[${s + 1}]`));
      if (c) {
        card.appendChild(document.createTextNode(`L${c.level} ${cardColorName(c)} `));
        if (c.points > 0) card.appendChild(span('pts', `${c.points}分 `));
        if (c.crowns) card.appendChild(span('crown', `♛${c.crowns} `));
        if (c.bonus) card.appendChild(document.createTextNode(`折${c.bonus}`));
        const cost = el('div', 'cost');
        cost.appendChild(document.createTextNode('费用 '));
        for (const [k, n] of Object.entries(c.cost)) {
          if (n > 0) cost.appendChild(span(TCSS[k], `${TZH[k]}${n}`)).after(' ');
        }
        if (c.ability) cost.appendChild(span('ab', `【${ABZH[c.ability]}】`));
        card.appendChild(cost);
      } else {
        card.appendChild(document.createTextNode('空'));
      }
      r.appendChild(card);
    }
    pyr.appendChild(r);
  }

  const pool = $('#pool-royal');
  pool.replaceChildren();
  if (G.view.royals.length === 0) pool.appendChild(document.createTextNode('无'));
  G.view.royals.forEach((r, i) => {
    const btn = el('button', '', `${r.points}分${r.ability ? ABZH[r.ability] : ''}`);
    btn.style.cssText = 'font-size:12px;padding:2px 8px;margin-left:4px';
    if (ui.extras.royalPick === i) btn.style.outline = '2px solid var(--accent)';
    btn.addEventListener('click', () => { ui.extras.royalPick = i; render(); });
    pool.appendChild(btn);
  });
  $('#pool-priv').textContent = String(3 - G.view.players[0].privileges - G.view.players[1].privileges);
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
    card.appendChild(span('name', p.name));
    if (mine) card.appendChild(document.createTextNode(' (我)'));
    card.appendChild(span('stat', '积分'));
    card.appendChild(span('', String(p.points)));
    for (const t of [['皇冠', `♛${p.crowns}`, 't-gold'], [`特权×${p.privileges}`, '', ''], [`皇家卡×${p.royals.length}`, '', '']]) {
      card.appendChild(span('stat', t[0]));
      if (t[1]) card.appendChild(span(t[2], t[1]));
    }
    const tokens = el('div', 'tokens');
    const colors = ALL_COLORS.filter((c) => p.tokens[c] > 0);
    if (colors.length === 0) tokens.appendChild(el('span', 'chip', '无token'));
    for (const c of colors) tokens.appendChild(el('span', `chip ${TCSS[c]}`, `${TZH[c]}×${p.tokens[c]}`));
    for (const [g, n] of Object.entries(p.bonuses)) {
      if (n > 0) tokens.appendChild(el('span', `chip ${TCSS[g]}`, `${GEMZH[g]}折${n}`));
    }
    card.appendChild(tokens);
    const cardsLine = el('div', 'cards-line');
    cardsLine.appendChild(document.createTextNode('已购卡: '));
    if (p.cards.length === 0) cardsLine.appendChild(document.createTextNode('无'));
    p.cards.forEach((c) => {
      cardsLine.appendChild(span(TCSS[c.color ?? 'black'], `${c.color ? GEMZH[c.color] : '分'}${c.def.points}${c.def.crowns ? `♛${c.def.crowns}` : ''}${c.def.ability ? `(${ABZH[c.def.ability]})` : ''}`)).after(' ');
    });
    card.appendChild(cardsLine);
    const reserved = el('div', 'cards-line');
    reserved.appendChild(document.createTextNode('预留: '));
    if (p.reserved.length === 0) reserved.appendChild(document.createTextNode('无'));
    else if (mine || G.mode === 'agents') {
      p.reserved.forEach((c) => {
        const label = c.id === 'hidden' ? '?' : `L${c.level}${c.isAssociate ? '百搭' : c.color ? GEMZH[c.color] : '分'}卡${c.points ? c.points + '分' : ''}`;
        reserved.appendChild(document.createTextNode(label + ' '));
      });
    } else reserved.appendChild(document.createTextNode(`${p.reserved.length}张(保密)`));
    card.appendChild(reserved);
    box.appendChild(card);
  }
}

function renderLog() {
  const lg = $('#log');
  lg.replaceChildren();
  for (const line of G.view.log.slice(-40)) lg.appendChild(el('div', '', line));
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
function royalNeeded() {
  const c = actionCard();
  if (!c) return false;
  const me = G.view.players[G.seat];
  const cross = (me.crowns < 3 && me.crowns + c.crowns >= 3) || (me.crowns < 6 && me.crowns + c.crowns >= 6);
  return cross && G.view.royals.length > 0;
}
function discardNeeded() {
  const me = G.view.players[G.seat];
  const held = Object.values(me.tokens).reduce((s, n) => s + n, 0);
  const gained = ui.privileges.length + (ui.action?.action.kind === 'reserve' ? 1 : 0);
  return held + gained > 10;
}

function renderActionbar() {
  const myTurn = G.mode === 'human' && G.legal != null && !G.over;
  $('#human-turn').classList.toggle('hidden', !myTurn);
  $('#thinking').classList.toggle('hidden', !(G.mode === 'human' && !myTurn && !G.over));
  if (G.mode === 'agents') {
    $('#turn-indicator').textContent = G.over ? '对局结束' : `第 ${G.view.turnCount + 1} 回合 · 轮到 ${G.names[G.view.current]}`;
  }
  if (!myTurn) return;

  const me = G.view.players[G.seat];
  $('#priv-toggle-line').classList.toggle('hidden', me.privileges <= 0);
  $('#priv-mode').checked = ui.privMode;
  $('#replenish-line').classList.toggle('hidden', !(G.legal.canReplenish && G.legal.actions.length > 0));
  $('#replenish').checked = ui.replenish;

  const privCells = $('#priv-cells');
  privCells.replaceChildren();
  if (ui.privileges.length) {
    privCells.appendChild(document.createTextNode('特权拿取: '));
    privCells.appendChild(el('b', '', ui.privileges.map((i) => `${cellName(i)}(${TZH[G.view.board[i]]})`).join(' ')));
    privCells.appendChild(document.createTextNode(` (${ui.privileges.length}/${me.privileges})`));
  }

  const actions = $('#actions');
  actions.replaceChildren();
  G.legal.actions.forEach((a) => {
    const btn = el('button', '', a.desc);
    if (ui.action && ui.action.i === a.i) btn.classList.add('sel');
    btn.addEventListener('click', () => {
      ui.action = a; ui.extras = {}; ui.takeSamePick = null;
      render();
    });
    actions.appendChild(btn);
  });

  const ex = $('#extras');
  ex.replaceChildren();
  if (!ui.action) {
    ex.appendChild(el('div', 'row hint', '先选择一个行动'));
  } else {
    const c = actionCard();
    if (associateNeeded()) {
      const colors = [...new Set(me.cards.map((x) => x.color).filter(Boolean))];
      ex.appendChild(exRow('百搭卡叠放颜色:', colors.map((g) => colorBtn(g, () => { ui.extras.associateColor = g; }, ui.extras.associateColor === g))));
    }
    if (stealNeeded()) {
      const opp = G.view.players[1 - G.seat];
      const opts = PEARL_COLORS.filter((t) => opp.tokens[t] > 0);
      ex.appendChild(exRow('偷取对手 token:', opts.map((t) => colorBtn(t, () => { ui.extras.stealPick = t; }, ui.extras.stealPick === t))));
    }
    if (takeSameNeeded() && c) {
      const cells = G.view.board.map((t, i) => (t === c.color ? i : -1)).filter((i) => i >= 0);
      ex.appendChild(exRow(`「拿同色」选择${GEMZH[c.color]} token 格:`, cells.map((i) => cellBtn(i, () => { ui.takeSamePick = i; }, ui.takeSamePick === i))));
    }
    if (royalNeeded()) {
      ex.appendChild(exRow('皇冠里程碑 → 选皇家卡:', G.view.royals.map((r, i) => royalBtn(i, `${r.points}分${r.ability ? ABZH[r.ability] : ''}`, ui.extras.royalPick === i))));
    }
    if (discardNeeded()) {
      const div = el('div', 'row');
      div.appendChild(document.createTextNode('token 将超 10, 弃置: '));
      ALL_COLORS.filter((t) => me.tokens[t] > 0).forEach((t) => {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; inp.max = String(me.tokens[t]);
        inp.style.minWidth = '60px';
        inp.value = ui.extras.discard?.[t] ?? '';
        inp.addEventListener('input', () => {
          ui.extras.discard = ui.extras.discard ?? {};
          ui.extras.discard[t] = Number(inp.value || 0);
        });
        div.appendChild(span(TCSS[t], TZH[t]));
        div.appendChild(inp);
      });
      ex.appendChild(div);
    }
  }

  const ready = !!ui.action
    && (!associateNeeded() || ui.extras.associateColor)
    && (!royalNeeded() || Number.isInteger(ui.extras.royalPick));
  $('#btn-submit').disabled = !ready;
}

function exRow(label, btns) {
  const row = el('div', 'row');
  row.appendChild(el('b', '', label));
  btns.forEach((b) => row.appendChild(b));
  return row;
}
function pickedStyle(b, picked) {
  if (picked) b.style.cssText = 'background:var(--accent);color:#fff';
  return b;
}
function colorBtn(code, onPick, picked) {
  const b = el('button', TCSS[code], code === 'pearl' ? '珍珠' : GEMZH[code]);
  pickedStyle(b, picked);
  b.addEventListener('click', () => { onPick(); render(); });
  return b;
}
function cellBtn(i, onPick, picked) {
  const b = pickedStyle(el('button', '', cellName(i)), picked);
  b.addEventListener('click', () => { onPick(); render(); });
  return b;
}
function royalBtn(i, label, picked) {
  const b = pickedStyle(el('button', '', label), picked);
  b.addEventListener('click', () => { ui.extras.royalPick = i; render(); });
  return b;
}

$('#priv-mode').addEventListener('change', (e) => { ui.privMode = e.target.checked; render(); });
$('#replenish').addEventListener('change', (e) => { ui.replenish = e.target.checked; render(); });

$('#btn-submit').addEventListener('click', async () => {
  if (!ui.action) return;
  const move = { action: ui.action.action };
  if (ui.privileges.length) move.privileges = ui.privileges;
  if (ui.replenish) move.replenish = true;
  if (associateNeeded() && ui.extras.associateColor) move.associateColor = ui.extras.associateColor;
  if (stealNeeded() && ui.extras.stealPick) move.stealPick = ui.extras.stealPick;
  if (takeSameNeeded() && ui.takeSamePick != null) move.takeSameCell = ui.takeSamePick;
  if (royalNeeded() && Number.isInteger(ui.extras.royalPick)) move.royalPick = ui.extras.royalPick;
  if (discardNeeded() && ui.extras.discard) {
    const d = Object.fromEntries(Object.entries(ui.extras.discard).filter(([, n]) => n > 0));
    if (Object.keys(d).length) move.discard = d;
  }
  $('#move-error').textContent = '';
  $('#human-turn').classList.add('hidden');
  $('#thinking').classList.remove('hidden');
  try {
    const res = await api(`/api/move/${G.id}`, { seat: G.seat, move });
    ui = { action: null, privileges: [], privMode: false, replenish: false, takeSamePick: null, extras: {} };
    Object.assign(G, res);
    render();
  } catch (err) {
    $('#move-error').textContent = err.message;
    render();
  }
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
