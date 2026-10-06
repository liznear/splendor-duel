import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const chrome = Bun.which(process.env.CHROME_BIN ?? 'google-chrome');

test.skipIf(!chrome)('resource pools: overlapping royal cards and image counters in every theme', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const functions = ['el', 'span', 'privilegeIcons', 'royalBtn', 'renderPools'].map(name => {
    const start = source.indexOf(`function ${name}(`);
    const firstLine = source.slice(start, source.indexOf('\n', start));
    return firstLine.endsWith('}') ? firstLine : source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');
  const constants = source.slice(source.indexOf('const TZH'), source.indexOf('let G'));
  const css = ['style.css', 'prototype-variants.css'].map(name =>
    readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8'),
  ).join('\n').replace(/@import[^;]+;/g, '');
  const dir = mkdtempSync(join(tmpdir(), 'splendor-resource-pools-'));
  try {
    writeFileSync(join(dir, 'test.html'), `<style>${css}</style><body>
      <div class="pools" id="pool-bag"></div>
      <span id="pool-priv" class="privilege-pool"></span>
      <div id="pool-royal"></div><pre id="result"></pre><script>
      ${constants}
      ${functions}
      const $ = s => document.querySelector(s);
      const ui = { extras: {}, phase: 'main' };
      let renders = 0;
      const render = () => { renders++; };
      const myTurn = () => true;
      const canReplenishNow = () => G.view.bag.length > 0;
      const G = { view: { bag: [], players: [{ privileges: 1 }, { privileges: 0 }],
        royals: [1,2,3,4].map(i => ({id: 'royal_' + i, points: i === 4 ? 3 : 2})) } };
      const errors = [];
      const check = (ok, message) => { if (!ok) errors.push(message); };
      for (const variant of ['', 'a-shadcn', 'b-splendor', 'c-hybrid']) {
        if (variant) document.body.dataset.variant = variant;
        else delete document.body.dataset.variant;
        ui.extras = {};
        renderPools();
        const cards = [...$('#pool-royal').querySelectorAll('button')];
        check(cards.length === 4, 'four royal cards');
        const rects = cards.map(c => c.getBoundingClientRect());
        check(rects.every(r => Math.abs(r.top - rects[0].top) < 1), 'royals share one row');
        check(rects[1].left > rects[0].left && rects[1].left < rects[0].right, 'royals overlap horizontally');
        cards.forEach((card, i) => {
          const r = rects[i];
          check(document.elementFromPoint(r.left + 8, r.top + 20)?.closest('.royal') === card, 'left strip accessible');
        });
        cards[2].click();
        check(ui.extras.royalPick === 2, 'royal click selects correct index');
        check($('#pool-priv img')?.getAttribute('src') === '/assets/privilege.png', 'privilege image');
        check($('#pool-priv').querySelectorAll('img').length === 2 && $('#pool-priv').textContent === '', 'privileges shown as two scrolls, not a number');
        check($('#pool-bag').querySelectorAll('.pool-token').length === 7, 'seven token counters even with empty bag');
        check([...document.querySelectorAll('#pool-bag .n')].every(n => n.textContent === '0'), 'empty bag has zero counters');
        check(!$('#pool-bag').textContent.includes('袋中:') && !$('#pool-bag').textContent.includes('空'), 'no redundant bag labels');
      }
      G.view.bag = ['blue', 'blue', 'red'];
      G.view.players[0].privileges = 3;
      renderPools();
      check($('#pool-bag .t-blue .n').textContent === '2', 'blue count');
      check($('#pool-bag .t-red .n').textContent === '1', 'red count');
      check($('#pool-priv').getAttribute('aria-label').includes('0') && $('#pool-priv').textContent === '', 'empty pool accessible without a numeric label');
      check(!!$('#pool-bag button'), 'refill control retained');
      G.view.royals = [];
      renderPools();
      check($('#pool-royal').textContent === '无', 'empty royal pool');
      document.querySelector('#result').textContent = errors.length ? errors.join(', ') : 'POOLS_CHECK_PASSED';
      </script>`);
    const result = spawnSync(chrome!, ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', `file://${join(dir, 'test.html')}`], { encoding: 'utf8', timeout: 15000 });
    expect(result.status).toBe(0);
    const outcome = result.stdout.match(/<pre id="result">([^<]*)<\/pre>/)?.[1];
    expect(outcome).toBe('POOLS_CHECK_PASSED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
