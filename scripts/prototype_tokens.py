"""Throwaway original token art. 纯标准库实现 (zlib 生成 PNG), 无第三方依赖。"""
import math
import random
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'public' / 'assets'
COLORS = {
    'white': (231, 228, 215), 'blue': (43, 107, 164),
    'green': (72, 139, 68), 'red': (178, 62, 53),
    'black': (53, 53, 56), 'pearl': (220, 178, 189),
    'gold': (207, 160, 52),
}
SIZE = 256


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def write_png(path: Path, width: int, height: int, rows: list[bytearray]) -> None:
    raw = b''.join(b'\x00' + bytes(row) for row in rows)
    png = (b'\x89PNG\r\n\x1a\n'
           + _chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
           + _chunk(b'IDAT', zlib.compress(raw, 9))
           + _chunk(b'IEND', b''))
    path.write_bytes(png)


def render(color, socket=False):
    rng = random.Random(107)
    rows = [bytearray(SIZE * 4) for _ in range(SIZE)]
    for y in range(SIZE):
        row = rows[y]
        dy = y - 127.5
        for x in range(SIZE):
            dx = x - 127.5
            radius = math.hypot(dx, dy)
            if radius > 120:
                continue
            alpha = round(255 * min(1, 120 - radius))
            # Mottled pigment rather than a reflective sphere or gemstone.
            mottling = 2.8 * math.sin(x / 11 + math.sin(y / 17))
            mottling += 2.0 * math.sin(y / 7 + math.sin(x / 23))
            grain = rng.gauss(0, 2.2)
            if radius < 97:
                if socket:
                    continue
                shade = mottling + grain
                base = color
            else:
                base = (224, 220, 206)
                shade = mottling + rng.gauss(0, 5)
                # Thin engraved edges; the broad rim remains matte and textured.
                if radius < 100:
                    base = (146, 141, 127)
                elif radius < 102:
                    base = (251, 248, 238)
                elif radius > 117:
                    base = (132, 128, 117)
                elif radius > 115:
                    base = (246, 243, 231)
                if rng.random() < 0.06:
                    shade -= 17
            off = x * 4
            row[off:off + 3] = bytes(max(0, min(255, round(c + shade))) for c in base)
            row[off + 3] = alpha
    return rows


def main():
    OUT.mkdir(exist_ok=True)
    # 预览: 4 列 × 2 行, 底色 #eee9dd, 与 token 一同重建 (无文字标注)。
    preview_w, preview_h, pad = 4 * SIZE, 2 * (SIZE + 28), (238, 233, 221)
    prows = [bytearray(bytes(pad) * preview_w) for _ in range(preview_h)]
    images = {}
    for index, (name, color) in enumerate(COLORS.items()):
        rows = render(color)
        images[name] = rows
        if rows[0][3] != 0:
            raise ValueError(f'{name}: 角落应为透明')
        if images[name][128][128 * 4 + 3] != 255:
            raise ValueError(f'{name}: 中心应为不透明')
        center = tuple(images[name][128][128 * 4:128 * 4 + 3])
        if not all(abs(a - b) < 20 for a, b in zip(center, color, strict=True)):
            raise ValueError(f'{name}: 中心色 {center} 偏离 {color}')
        write_png(OUT / f'token-{name}.png', SIZE, SIZE, rows)
        px, py = (index % 4) * SIZE, (index // 4) * (SIZE + 28)
        for yy in range(SIZE):
            prow = prows[py + yy]
            prow[px * 4:(px + SIZE) * 4] = images[name][yy]
    socket = render(COLORS['black'], socket=True)
    if socket[128][128 * 4 + 3] != 0:
        raise ValueError('socket: 中心应为透明')
    write_png(OUT / 'socket.png', SIZE, SIZE, socket)
    px, py = 3 * SIZE, SIZE + 28
    for yy in range(SIZE):
        prows[py + yy][px * 4:(px + SIZE) * 4] = socket[yy]
    write_png(OUT / 'token-preview.png', preview_w, preview_h, prows)
    print('Generated 7 original tokens and socket: 256x256 RGBA. Checks passed.')


if __name__ == '__main__':
    main()
