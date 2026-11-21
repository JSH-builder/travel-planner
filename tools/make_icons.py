"""앱 아이콘·파비콘(PNG) 만들기 — 원본은 docs/icons/favicon.svg 하나.

설치된 Microsoft Edge(헤드리스)로 SVG를 그대로 찍어서 PNG를 만든다. 추가 설치 없음.
  python tools/make_icons.py
  → docs/icons/icon-192.png, icon-512.png        (홈 화면 앱 아이콘, 꽉 찬 사각)
    docs/icons/maskable-512.png                   (안드로이드 모양 마스크용, 여백 넉넉)
    docs/icons/apple-touch-icon.png               (아이폰 홈 화면 180px)
    docs/icons/favicon-32.png                     (SVG 못 읽는 브라우저용 탭 아이콘)
"""

import os
import re
import subprocess
import tempfile
from pathlib import Path

ICONS = Path(__file__).resolve().parent.parent / "docs" / "icons"
SRC = (ICONS / "favicon.svg").read_text(encoding="utf-8")


def variant(kind: str) -> str:
    svg = SRC
    if kind in ("full", "maskable"):  # OS가 모서리를 깎으니 바탕은 꽉 채운다
        svg = svg.replace('rx="22"', 'rx="0"')
    if kind == "maskable":  # 안전 영역(가운데 80%) 안으로 그림을 줄인다
        svg = re.sub(r'(<rect width="100" height="100" rx="0" fill="#ff4d2e"/>)(.*)(</svg>)',
                     r'\1<g transform="translate(10 10) scale(.8)">\2</g>\3', svg, flags=re.S)
    return svg


def edge() -> str:
    for base in (os.environ.get("ProgramFiles(x86)", ""), os.environ.get("ProgramFiles", "")):
        p = Path(base) / "Microsoft/Edge/Application/msedge.exe"
        if p.exists():
            return str(p)
    raise SystemExit("Microsoft Edge를 찾지 못했어요.")


def render(svg: str, size: int, out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        html = Path(tmp) / "icon.html"
        html.write_text(f"<!doctype html><style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{size}px;height:{size}px}}</style>{svg}",
                        encoding="utf-8")
        subprocess.run([edge(), "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                        "--default-background-color=00000000", f"--window-size={size},{size}",
                        f"--user-data-dir={Path(tmp) / 'profile'}", f"--screenshot={out}", html.as_uri()],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    print("✓", out.name)


if __name__ == "__main__":
    for name, size, kind in (("icon-192.png", 192, "full"), ("icon-512.png", 512, "full"),
                             ("maskable-512.png", 512, "maskable"), ("apple-touch-icon.png", 180, "full"),
                             ("favicon-32.png", 32, "rounded")):
        render(variant(kind), size, ICONS / name)
