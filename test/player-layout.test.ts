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
  const functions = ['el', 'span', 'gemEl', 'cardTitle', 'cardBack', 'miniCard', 'miniBack', 'miniRoyal', 'renderPlayers', 'renderActionbar', 'gemsRow', 'botMoveRow', 'botTakeBoard', 'deltasRow', 'requestBot', 'renderBotProgress'].map((name) => {
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
      const cellName = i => String(i);
      const $ = s => document.querySelector(s);
      const ui = { privileges: [], extras: {}, phase: 'main' };
      const render = () => {};
      let botThinking = null;
      let finishBot, failBot;
      const api = () => new Promise((resolve, reject) => { finishBot = resolve; failBot = reject; });
      const myTurn = () => G.mode === 'human' && G.view.current === G.seat && !G.over;
      const empty = () => ({ name: 'MCTSbot(8 goroutines)', points: 0, crowns: 0, privileges: 1, tokens: {}, cards: [], reserved: [], royals: [], bonuses: {} });
      const G = { mode: 'human', seat: 1, names: ['Bot', 'You'], view: { current: 1, turnCount: 0, players: [empty(), empty()] }, legal: { privilegeCells: [0], actions: [] } };
      document.querySelector('#game').classList.remove('hidden');
      document.querySelector('#setup').classList.add('hidden');
      const results = [];
      const check = (ok, message) => { if (!ok) results.push(message); };
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
      check(!botThinking && !$('#players .bot-progress'), 'completed bot requests must clear the progress bar');
      const failedBot = requestBot('/api/bot/test');
      failBot(new Error('test error'));
      await failedBot.catch(() => {});
      check(!botThinking && !$('#players .bot-progress'), 'failed bot requests must clear the progress bar');
      G.view.current = 1;
      G.botSearch = [{simulations: 1234, moveSimulations: 500, winRate: 0.625, turn: 1}, null];
      renderPlayers();
      check($('#players .bot-search').textContent.includes('1,234') && $('#players .bot-search').textContent.includes('62.5%'), 'bot panel must show completed simulation count and estimated win rate');
      G.botSearch[0].winRate = 0;
      renderPlayers();
      check($('#players .bot-search').textContent.includes('0.0%'), 'zero win rate must not be treated as missing');
      G.botSearch[0].winRate = null;
      renderPlayers();
      check($('#players .bot-search').textContent.includes('胜率 —'), 'unavailable estimates must not invent a win rate');
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
        const initial = [...$('#players').children].map(e => e.getBoundingClientRect().height);
        const button = $('#players .active .p-stats button');
        check(button?.textContent.includes('特权×1'), 'privilege count must be part of its action button');
        button?.click();
        check(ui.phase === 'priv', 'privilege button must open privilege selection');
        for (const p of G.view.players) {
          p.reserved = Array.from({length: 3}, () => ({ id: 'hidden' }));
          p.royals = [{ id: 'r1', points: 3 }, { id: 'r2', points: 3 }];
          p.tokens = Object.fromEntries(ALL_COLORS.map(c => [c, 1]));
          p.cards = PEARL_COLORS.map(color => ({ color, def: { points: 1 } }));
        }
        renderPlayers();
        [...$('#players').children].forEach((e, i) => check(e.getBoundingClientRect().height === initial[i], 'panel height changed at width ' + width));
      }
      G.legal.privilegeCells = [];
      renderPlayers();
      check(!$('#players .active .p-stats button'), 'unavailable privileges must not be actionable');
      renderActionbar();
      check(getComputedStyle($('#actionbar')).display === 'none', 'human game must hide bottom action panel');
      check(getComputedStyle($('#pick-bar')).display === 'none', 'idle human game must omit selection instructions');
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
    const result = spawnSync(chrome!, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--window-size=1723,878', ...screenshot, `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', `file://${join(dir, 'test.html')}`], { encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stderr).toBe(0);
    const output = [...result.stdout.matchAll(/<pre id="results" class="hidden">(.*?)<\/pre>/g)].at(-1)?.[1];
    expect(output, result.stdout).toBeDefined();
    expect(JSON.parse(output!)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
