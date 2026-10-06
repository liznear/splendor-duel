import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const chrome = Bun.which(process.env.CHROME_BIN ?? 'google-chrome');

test.skipIf(!chrome)('viewport layout, player statistics, selection controls and bot recap', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const reservedCardImage = readFileSync(new URL('../public/cards/1-25.png', import.meta.url)).toString('base64');
  const functions = [
    'el', 'span', 'gemEl', 'privilegeIcons', 'tokenChip', 'cardTitle', 'cardBack', 'miniCard', 'miniBack', 'miniRoyal',
    'renderPlayers', 'renderActionbar', 'gemsRow', 'tokenCountsRow', 'tokenDeltaRow', 'botMoveRow',
    'botTakeBoard', 'deltasRow', 'requestBot', 'renderBotProgress', 'modalHead',
    'modalDragButton', 'positionModal', 'resetModalPosition',
  ].map((name) => {
    const start = source.indexOf(`function ${name}(`);
    const firstLine = source.slice(start, source.indexOf('\n', start));
    if (firstLine.endsWith('}')) return firstLine;
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');
  const constants = source.slice(source.indexOf('const TZH'), source.indexOf('let G'));
  const dir = mkdtempSync(join(tmpdir(), 'splendor-layout-'));
  try {
    writeFileSync(join(dir, 'test.html'), html.replace(/<script type="module"[^>]*><\/script>/, '').replace('</head>', `<style>${css}</style></head>`).replace('</body>', `<script>
      (async () => {
      ${constants}
      ${functions}
      const DELTA_LABEL = { points: '分', crowns: '皇冠', privileges: '特权', tokens: 'token', cards: '卡' };
      window.__reservedCardImage = '${reservedCardImage}';
      const cellName = i => String(i);
      const $ = s => document.querySelector(s);
      const ui = { privileges: [], extras: {}, phase: 'main' };
      const render = () => {};
      let botThinking = null;
      let modalPosition = null;
      const closeModal = () => {};
      let finishBot, failBot;
      const api = () => new Promise((resolve, reject) => { finishBot = resolve; failBot = reject; });
      const myTurn = () => G.mode === 'human' && G.view.current === G.seat && !G.over;
      const empty = () => ({ name: 'MCTSbot(8 goroutines)', points: 0, crowns: 0, privileges: 1, tokens: {}, cards: [], reserved: [], royals: [], bonuses: {} });
      const G = { mode: 'human', seat: 1, names: ['Bot', 'You'], view: { current: 1, turnCount: 0, players: [empty(), empty()] }, legal: { privilegeCells: [0], actions: [] } };
      document.querySelector('#game').classList.remove('hidden');
      document.querySelector('#setup').classList.add('hidden');
      const results = [];
      const check = (ok, message) => { if (!ok) results.push(message); };
      const modal = $('#modal-box');
      modal.style.animation = 'none';
      modalHead(modal, '拖动测试');
      modal.append(el('p', '', '查看弹窗后的棋盘信息'));
      $('#modal-root').classList.remove('hidden');
      const handle = modal.querySelector('.modal-drag');
      check(!!handle && !!modal.querySelector('.modal-x'), 'modal header must offer drag and close buttons');
      // Synthetic pointer events have no browser-managed capture; stub capture only.
      handle.setPointerCapture = () => {};
      const initialModal = modal.getBoundingClientRect();
      handle.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 100}));
      handle.dispatchEvent(new PointerEvent('pointermove', {pointerId: 1, clientX: 125, clientY: 135}));
      check(Math.abs(modal.getBoundingClientRect().left - initialModal.left - 25) < 1 && Math.abs(modal.getBoundingClientRect().top - initialModal.top - 35) < 1, 'drag handle must move the modal by the pointer distance');
      handle.dispatchEvent(new PointerEvent('pointermove', {pointerId: 1, clientX: 10000, clientY: 10000}));
      check(modal.getBoundingClientRect().right <= innerWidth - 7 && modal.getBoundingClientRect().bottom <= innerHeight - 7, 'modal drag must keep the dialog within the viewport');
      handle.dispatchEvent(new PointerEvent('pointerup', {pointerId: 1}));
      check(!modal.classList.contains('dragging'), 'releasing the pointer must end dragging');
      handle.dispatchEvent(new KeyboardEvent('keydown', {key: 'Home'}));
      check(!modalPosition && !modal.classList.contains('moved'), 'Home must return the modal to its centered position');
      handle.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft'}));
      check(modalPosition && Math.abs(modal.getBoundingClientRect().left - initialModal.left + 10) < 1, 'keyboard arrow keys must move the modal');
      resetModalPosition(modal);
      $('#modal-root').classList.add('hidden');
      G.botTimeoutMs = [1000, 1000];
      G.view.current = 0;
      const pendingBot = requestBot('/api/bot/test');
      check(!!$('#players .bot-progress'), 'pending bot request must show a progress bar');
      check(requestBot('/api/bot/test') === pendingBot, 'duplicate bot requests must share the pending operation');
      botThinking.startedAt = performance.now() - 500;
      renderBotProgress();
      check($('#players .bot-progress progress').value >= .5 && $('#players .bot-progress progress').value < .6, 'bot progress must be calculated from elapsed time and timeout');
      botThinking.startedAt = performance.now() - 2000;
      renderBotProgress();
      check($('#players .bot-progress progress').value === 1 && $('#players .bot-progress').textContent.includes('等待结果'), 'elapsed timeout must wait for the actual result');
      finishBot({});
      await pendingBot;
      check(!botThinking && $('#players .bot-progress progress').value === 0, 'completed bot requests must reset the persistent progress bar');
      const failedBot = requestBot('/api/bot/test');
      failBot(new Error('test error'));
      await failedBot.catch(() => {});
      check(!botThinking && $('#players .bot-progress progress').value === 0, 'failed bot requests must reset the persistent progress bar');
      G.view.current = 1;
      G.botSearch = [{simulations: 1234, moveSimulations: 500, winRate: 0.625, turn: 1}, null];
      renderPlayers();
      check($('#players .winrate')?.textContent.includes('62.5%') && $('#players .winrate').title.includes('1,234'), 'bot head must show estimated win rate with simulation count on hover');
      G.botSearch[0].winRate = 0;
      renderPlayers();
      check($('#players .winrate')?.textContent.includes('0.0%'), 'zero win rate must not be treated as missing');
      G.botSearch[0].winRate = null;
      renderPlayers();
      check(!$('#players .winrate'), 'unavailable estimates must not invent a win rate');
      G.view.players[1].name = '你';
      renderPlayers();
      check(!document.querySelector('#players .player[data-seat="1"] .bot-search'), 'human panel must omit the bot search line');
      check($('#players .player[data-seat="0"] .bot-progress progress') != null, 'bot progress bar must be persistent');
      G.view.board = Array(25).fill(null);
      const recap = botMoveRow({ action: {kind: 'take', cells: [0]}, privGems: ['blue'], replenished: true, takeGems: ['red'] });
      check([...recap.querySelectorAll('.bm-step .bm-lab')].map(e => e.textContent).join('|') === '使用特权|补充棋盘|拿取宝石', 'bot recap must show privileges, replenishment, then the main move');
      for (const [ability, label] of [['turn', '额外回合'], ['privilege', '获得特权'], ['steal', '偷取'], ['takeSame', '拿同色']]) {
        const move = { action: {kind: 'buy'}, card: {id: 'test', color: 'blue', ability}, stealGem: 'red', takeSameGem: 'blue' };
        check(botMoveRow(move).textContent.includes('卡牌能力 · ' + label), 'bot recap must identify card ability ' + ability);
        if (ability !== 'takeSame') {
          check(botMoveRow({action: {kind: 'take', cells: []}, royal: {id: 'royal', points: 2, ability}}).textContent.includes('皇家能力 · ' + label), 'bot recap must identify royal ability ' + ability);
        }
      }
      check(!botMoveRow({action: {kind: 'reserve'}, card: {id: 'test', ability: 'turn'}}).textContent.includes('卡牌能力'), 'reserving a card must not show its ability as activated');
      const purchase = botMoveRow({action: {kind: 'buy'}, card: {id: 'test'}, payment: {blue: 2, white: 1, gold: 1}, tokenChanges: {blue: 0, white: -1, gold: -1, pearl: 1}, deltas: {tokens: -1}});
      const paidLabels = [...purchase.querySelector('.bm-counts').querySelectorAll('.pool-token')].map(t => t.getAttribute('aria-label'));
      check(paidLabels.includes('蓝 ×2') && paidLabels.includes('金 ×1'), 'purchase recap must identify each paid gem color and count');
      const tokenChanges = purchase.querySelector('.bm-token-changes');
      const changeLabels = [...tokenChanges.querySelectorAll('.pool-token')].map(t => t.getAttribute('aria-label'));
      check(changeLabels.includes('白 −1') && changeLabels.includes('金 −1') && changeLabels.includes('珠 +1'), 'recap must show color-specific positive and negative token changes');
      check(!changeLabels.some(label => label.startsWith('蓝')), 'unchanged token colors must be omitted from net changes');
      check(botMoveRow({action: {kind: 'buy'}, card: {id: 'free'}, payment: {}}).textContent.includes('无需支付宝石'), 'free purchases must show that no gems were paid');
      const reverseRecap = botMoveRow({action: {kind: 'take', cells: []}, privGems: ['blue'], replenished: true, replenishFirst: true});
      check([...reverseRecap.querySelectorAll('.bm-step .bm-lab')].map(e => e.textContent).join('|') === '补充棋盘|使用特权|拿取宝石', 'recap must respect replenish-first moves');
      for (const count of [3, 4, 5]) {
        const row = el('div', 'pyr-row');
        for (let i = 0; i < count; i++) row.append(cardBack(i));
        $('#pyramid').append(row);
      }
      const marketCards = [...document.querySelectorAll('.pyr-row .card')];
      const marketWidth = marketCards[0].getBoundingClientRect().width;
      check(marketWidth > 106, 'desktop market cards must use the wider middle column within the viewport height');
      marketCards.forEach(card => check(card.getBoundingClientRect().width === marketWidth, 'market cards must have consistent sizes across rows'));
      $('#pyramid').style.width = '340px';
      marketCards.forEach(card => check(card.getBoundingClientRect().right <= card.parentElement.getBoundingClientRect().right, 'market cards must fit narrower columns'));
      $('#pyramid').style.width = '';
      renderPlayers();
      $('#pyramid').style.height = '860px';
      const columns = [...document.querySelectorAll('.layout > .col')];
      const columnHeight = columns[1].getBoundingClientRect().height;
      columns.forEach(col => check(col.getBoundingClientRect().height === columnHeight, 'all three columns must share the same height'));
      $('#pyramid').style.height = '';
      const viewportFit = () => {
        const headerBottom = document.querySelector('header').getBoundingClientRect().bottom;
        const layout = $('.layout').getBoundingClientRect();
        check(layout.top >= headerBottom && layout.bottom <= innerHeight, 'columns must fit below the header inside the viewport');
        check(document.documentElement.scrollHeight <= innerHeight, 'game must not create page scrolling');
        columns.forEach(col => check(Math.abs(col.getBoundingClientRect().height - layout.height) < 1, 'columns must fill the available layout height'));
      };
      viewportFit();
      for (const width of [340, 700, 280]) {
        $('#players').style.width = width + 'px';
        G.view.players = [empty(), empty()];
        renderPlayers();
        const button = $('#players .active .tokens button');
        check(button?.querySelectorAll('.privilege-img').length === 1 && button.textContent === '', 'privilege button must show a scroll image, not text');
        check($('#players .player:not(.active) .tokens .privilege-img') != null, 'opponent privileges must also show images');
        button?.click();
        check(ui.phase === 'priv', 'privilege button must open privilege selection');
        G.view.players.forEach(p => { p.reserved = [{id: 'single', color: 'white', cost: {blue: 3}}]; });
        renderPlayers();
        const reservedImages = [...$('#players').querySelectorAll('.minicards img')];
        await Promise.all(reservedImages.map(img => {
          img.loading = 'eager';
          img.src = 'data:image/png;base64,' + window.__reservedCardImage;
          return img.decode();
        }));
        $('#players').querySelectorAll('.minicards').forEach(minis => {
          check(minis.scrollWidth <= minis.clientWidth, 'single reserved card must not create horizontal scrolling at width ' + width);
          const availableWidth = minis.parentElement.clientWidth - minis.parentElement.querySelector('.lab').getBoundingClientRect().width - 5;
          check(minis.clientWidth >= Math.floor(availableWidth) - 1, 'reserved card container must use the available row width rather than shrink to the image at width ' + width);
        });
        for (const p of G.view.players) {
          p.reserved = Array.from({length: 3}, () => ({ id: 'hidden' }));
          p.royals = [{ id: 'r1', points: 3 }, { id: 'r2', points: 3 }];
          p.tokens = Object.fromEntries(ALL_COLORS.map(c => [c, 1]));
          p.cards = PEARL_COLORS.map(color => ({ color, def: { points: 1 } }));
        }
        renderPlayers();
        const heights = [...$('#players').children].map(e => e.getBoundingClientRect().height);
        check(Math.abs(heights[0] - heights[2]) < 1, 'both player panels must share the same height at width ' + width);
      }
      G.legal.privilegeCells = [];
      renderPlayers();
      check(!$('#players .active .tokens button'), 'unavailable privileges must not be actionable');
      renderActionbar();
      check(getComputedStyle($('#actionbar')).display === 'none', 'human game must hide bottom action panel');
      check(getComputedStyle($('#pick-bar')).display !== 'none', 'idle human game must still reserve the pick bar');
      check(!$('#actionbar').contains($('#move-error')), 'move errors must remain outside the hidden panel');
      check(!$('#human-turn').contains($('#move-error')), 'bot request errors must remain visible outside human-turn controls');
      check(!$('#pick-bar').textContent.includes('点棋盘格拿 token'), 'idle instructions must be removed from the DOM');
      ui.pick = {t: 'take', cells: [0]};
      ui.action = {action: {kind: 'take', cells: [0]}};
      renderActionbar();
      check(!$('#pick-bar').querySelector('b') && !$('#pick-bar').textContent.includes('可继续加点'), 'selection bar must omit redundant prefix and hint');
      check($('#pick-bar').querySelector('button.primary')?.textContent === '拿 1 枚 ✓', 'selection confirmation must remain available');
      ui.action = null;
      ui.pick = { want: 'reserve' };
      renderActionbar();
      check(getComputedStyle($('#pick-bar')).display !== 'none', 'pending selections must retain contextual controls');
      G.mode = 'agents';
      renderActionbar();
      check(getComputedStyle($('#actionbar')).display !== 'none', 'agent games must retain bottom controls');
      $('#players').style.width = '';
      renderPlayers();
      viewportFit();
      G.mode = 'human';
      ui.pick = null;
      renderActionbar();
      viewportFit();
      marketCards.forEach(card => check(card.getBoundingClientRect().bottom <= columns[1].getBoundingClientRect().bottom, 'all market rows must remain visible within their column'));
      document.body.insertAdjacentHTML('beforeend', '<pre id="results" class="hidden">' + JSON.stringify(results) + '</pre>');
      })();
    </script></body>`));
    const screenshot = process.env.LAYOUT_SCREENSHOT ? ['--screenshot=' + process.env.LAYOUT_SCREENSHOT] : [];
    const result = spawnSync(chrome!, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--window-size=1723,878', '--virtual-time-budget=5000', ...screenshot, `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `file://${join(dir, 'test.html')}`], { encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stderr).toBe(0);
    const output = [...result.stdout.matchAll(/<pre id="results" class="hidden">(.*?)<\/pre>/g)].at(-1)?.[1];
    expect(output, result.stdout).toBeDefined();
    expect(JSON.parse(output!)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
