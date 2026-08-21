#!/usr/bin/env python3
"""Generates the app icons.

Kept as a script so the icons can be regenerated rather than being opaque
binaries in the tree. Run from the repository root:

    python3 tools/make-icons.py
"""

import struct
import zlib
from pathlib import Path

SIZES = (180, 192, 512)
SUPERSAMPLE = 4  # rendered large, then box-filtered down for smooth edges

TOP = (0x4D, 0xA3, 0xFF)
BOTTOM = (0x0A, 0x6C, 0xF5)
INK = (0xFF, 0xFF, 0xFF)

# Three list rows: a bullet and a bar, the last bar shorter. Unit coordinates.
ROWS = ((0.300, 0.795), (0.500, 0.795), (0.700, 0.640))
BULLET_CX = 0.235
BULLET_R = 0.049
BAR_X0 = 0.355
BAR_H = 0.082


def blend(dst, src, alpha):
    return tuple(round(d + (s - d) * alpha) for d, s in zip(dst, src))


def render(size):
    """Returns a size x size list of rows of (r, g, b) tuples."""
    px = []
    for y in range(size):
        t = y / max(size - 1, 1)
        base = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
        px.append([base] * size)

    def unit(v):
        return v * size

    bar_r = unit(BAR_H) / 2
    for cy_u, x1_u in ROWS:
        cy = unit(cy_u)
        x0, x1 = unit(BAR_X0), unit(x1_u)
        bcx, br = unit(BULLET_CX), unit(BULLET_R)

        y_lo = max(0, int(cy - br - 2))
        y_hi = min(size, int(cy + br + 2) + 1)
        for y in range(y_lo, y_hi):
            row = px[y]
            dy = y + 0.5 - cy
            for x in range(size):
                cx = x + 0.5
                inside = False
                # Bullet.
                if (cx - bcx) ** 2 + dy**2 <= br * br:
                    inside = True
                # Bar with rounded caps.
                elif abs(dy) <= bar_r:
                    if x0 + bar_r <= cx <= x1 - bar_r:
                        inside = True
                    elif cx < x0 + bar_r and (cx - (x0 + bar_r)) ** 2 + dy**2 <= bar_r * bar_r:
                        inside = True
                    elif cx > x1 - bar_r and (cx - (x1 - bar_r)) ** 2 + dy**2 <= bar_r * bar_r:
                        inside = True
                if inside:
                    row[x] = INK
    return px


def downsample(px, factor):
    size = len(px) // factor
    out = []
    area = factor * factor
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = 0
            for dy in range(factor):
                src = px[y * factor + dy]
                for dx in range(factor):
                    p = src[x * factor + dx]
                    r += p[0]
                    g += p[1]
                    b += p[2]
            row.append((r // area, g // area, b // area))
        out.append(row)
    return out


def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for row in px:
        raw.append(0)  # filter type 0
        for r, g, b in row:
            raw += bytes((r, g, b))

    def chunk(tag, payload):
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    out_dir = Path(__file__).resolve().parent.parent / "icons"
    out_dir.mkdir(exist_ok=True)
    for size in SIZES:
        image = downsample(render(size * SUPERSAMPLE), SUPERSAMPLE)
        path = out_dir / f"icon-{size}.png"
        write_png(path, image)
        print(f"wrote {path.relative_to(out_dir.parent)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
