"""앱 아이콘(PNG) 만들기 — 외부 라이브러리 없이. 검은 바탕 + 주홍 해 + 흰 수평선.

  python tools/make_icons.py   → docs/icons/icon-192.png, icon-512.png, apple-touch-icon.png
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "docs" / "icons"
INK, SUN, WHITE = (17, 17, 17), (255, 77, 46), (255, 255, 255)


def render(size: int) -> bytes:
    cx, cy, r = size * 0.5, size * 0.45, size * 0.2
    bar_y0, bar_y1 = size * 0.66, size * 0.66 + max(2, size * 0.035)
    bar_x0, bar_x1 = size * 0.25, size * 0.75
    rows = []
    ss = 3  # 가장자리 부드럽게 (슈퍼샘플링)
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    px, py = x + (sx + 0.5) / ss, y + (sy + 0.5) / ss
                    if (px - cx) ** 2 + (py - cy) ** 2 <= r * r and py <= bar_y0:
                        c = SUN
                    elif bar_x0 <= px <= bar_x1 and bar_y0 <= py <= bar_y1:
                        c = WHITE
                    else:
                        c = INK
                    acc = [a + b for a, b in zip(acc, c)]
            row += bytes(v // (ss * ss) for v in acc)
        rows.append(bytes(row))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
        (OUT / name).write_bytes(render(size))
        print("✓", name)
