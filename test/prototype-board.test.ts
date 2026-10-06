import { expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const chrome = Bun.which(process.env.CHROME_BIN ?? 'google-chrome');

test.skipIf(!chrome)('prototype boards: theme-aware 5x5 grid, refill guide and matching sockets', () => {
  const css = ['style.css', 'prototype-variants.css'].map(name =>
    readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8'),
  ).join('\n').replace(/@import[^;]+;/g, '');
  let cells = '<div class="coord"></div>' + '<div class="coord">A</div>'.repeat(5);
  for (let row = 0; row < 5; row++) {
    cells += '<div class="coord">1</div>';
    cells += '<div class="cell"><span class="gem t-green"></span></div>'.repeat(5);
  }
  const dir = mkdtempSync(join(tmpdir(), 'splendor-prototype-board-'));
  try {
    writeFileSync(join(dir, 'test.html'), `<style>${css}</style>
      <body><div id="wrap"><div class="board">${cells}</div></div>
      <pre id="result"></pre><script>
      const errors = [];
      const check = (condition, message) => { if (!condition) errors.push(message); };
      for (const width of [280, 360, 420]) {
        document.querySelector('#wrap').style.width = width + 'px';
        const board = document.querySelector('.board');
        const cells = [...board.querySelectorAll('.cell')];
        check(cells.length === 25, '25 cells');
        check([...board.querySelectorAll('.coord')].every(c => getComputedStyle(c).display === 'none'), 'coordinates hidden');
        const rects = cells.map(c => c.getBoundingClientRect());
        const first = rects[0];
        check(Math.abs(first.width - first.height) < 1, 'square cells');
        check(Math.abs(rects[4].top - first.top) < 1, '5 columns');
        check(Math.abs(rects[5].left - first.left) < 1 && rects[5].top > first.top, 'row wrapping');
        check(Math.abs(rects[24].right - rects[4].right) < 1, 'last column aligned');
        check(Math.abs(board.getBoundingClientRect().width - Math.min(width, 360)) < 1, 'responsive board width');
        const guide = getComputedStyle(board, '::after');
        check(guide.maskImage.includes('refill-spiral.svg'), 'refill spiral visible');
        check(guide.pointerEvents === 'none', 'refill guide does not intercept clicks');
        const gem = cells[0].querySelector('.gem').getBoundingClientRect();
        const slot = getComputedStyle(cells[0], '::before');
        check(Math.abs(parseFloat(slot.width) - gem.width) < 1, 'slot/token width');
        check(Math.abs(parseFloat(slot.height) - gem.height) < 1, 'slot/token height');
        check(getComputedStyle(cells[0]).outlineStyle === 'solid', 'visible grid lines');
      }
      document.querySelector('#result').textContent = errors.length ? errors.join(', ') : 'BOARD_CHECK_PASSED';
      </script>`);
    const result = spawnSync(chrome!, ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', `file://${join(dir, 'test.html')}`], { encoding: 'utf8', timeout: 15000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('<pre id="result">BOARD_CHECK_PASSED</pre>');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refill guide matches the engine Spiral', () => {
  const source = readFileSync(new URL('../internal/game/setup.go', import.meta.url), 'utf8');
  const match = source.match(/var Spiral = \[\]int\{([^}]+)\}/)?.[1];
  if (!match) throw new Error('game.Spiral declaration not found');
  const order = match.split(',').map(Number);
  const svg = readFileSync(new URL('../public/assets/refill-spiral.svg', import.meta.url), 'utf8');
  const points = order.map(cell => `${cell % 5 * 100 + 50},${Math.floor(cell / 5) * 100 + 50}`).join(' ');
  expect(svg).toContain(`points="${points}"`);
  const labels = [...svg.matchAll(/<text[^>]*>(\d+)<\/text>/g)].map(match => Number(match[1]));
  expect(labels).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
});
