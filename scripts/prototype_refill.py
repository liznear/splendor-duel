"""Generate the prototype refill guide directly from the Go game's Spiral."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / 'internal/game/setup.go').read_text()
match = re.search(r'var Spiral = \[\]int\{([^}]+)\}', source)
assert match is not None
order = [int(n) for n in match[1].split(',')]
assert sorted(order) == list(range(25))
points = [(cell % 5 * 100 + 50, cell // 5 * 100 + 50) for cell in order]
assert all(abs(x - u) + abs(y - v) == 100 for (x, y), (u, v) in zip(points[:-1], points[1:], strict=True))

parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500">',
         '<title>Refill: start at center, move left, then spiral outward; skip occupied cells.</title>']
coords = ' '.join(f'{x},{y}' for x, y in points)
parts.append(f'<polyline points="{coords}" fill="none" stroke="black" stroke-width="1.5"/>')
for (x, y), (u, v) in zip(points[:-1], points[1:], strict=True):
    dx, dy = (u - x) // 100, (v - y) // 100
    mx, my = (x + u) // 2, (y + v) // 2
    arrow = [(mx - 4 * dx + 3 * dy, my - 4 * dy - 3 * dx),
             (mx + 4 * dx, my + 4 * dy),
             (mx - 4 * dx - 3 * dy, my - 4 * dy + 3 * dx)]
    coords = ' '.join(f'{a},{b}' for a, b in arrow)
    parts.append(f'<polyline points="{coords}" fill="none" stroke="black" stroke-width="1.8"/>')
for step, (x, y) in enumerate(points, 1):
    parts.append(f'<text x="{x - 44}" y="{y - 35}" font-family="sans-serif" font-size="12" font-weight="600">{step}</text>')
parts.append('</svg>')
(ROOT / 'public/assets/refill-spiral.svg').write_text('\n'.join(parts) + '\n')
print('Generated 25-step refill guide from game.Spiral; uniqueness and adjacency checks passed.')
