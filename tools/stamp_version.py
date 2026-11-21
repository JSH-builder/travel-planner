"""배포 전에 실행: 화면 파일 주소에 버전 표시(?v=...)를 붙인다.

GitHub Pages(CDN)는 파일을 10분까지 캐시해서, 배포 직후 새 파일과 옛 파일이 섞이면 화면이 깨질 수 있다.
모든 JS import·index.html·서비스 워커의 주소에 같은 버전을 붙이면 배포하자마자 새 주소로 받아 온다.

  python tools/stamp_version.py        → 버전 = 현재 시각 (예: 2611221530)
"""

import re
import sys
from datetime import datetime
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"
V = sys.argv[1] if len(sys.argv) > 1 else datetime.now().strftime("%y%m%d%H%M")

IMPORT = re.compile(r'''((?:from|import)\s*\(?\s*["'])(\./[\w.-]+\.js)(?:\?v=\w+)?(["'])''')
n = 0
for f in sorted((DOCS / "js").glob("*.js")):
    s = f.read_text(encoding="utf-8")
    t = IMPORT.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={V}{m.group(3)}", s)
    if t != s:
        f.write_text(t, encoding="utf-8")
        n += 1

idx = DOCS / "index.html"
s = idx.read_text(encoding="utf-8")
s = re.sub(r'(src|href)="(js/main\.js|app\.css|config\.js)(?:\?v=\w+)?"', lambda m: f'{m.group(1)}="{m.group(2)}?v={V}"', s)
s = re.sub(r'register\("sw\.js(?:\?v=\w+)?"\)', f'register("sw.js?v={V}")', s)
idx.write_text(s, encoding="utf-8")

sw = DOCS / "sw.js"
s = sw.read_text(encoding="utf-8")
s = re.sub(r'const SHELL = "shell-[\w-]+";', f'const SHELL = "shell-{V}";', s)
sw.write_text(s, encoding="utf-8")
print(f"버전 {V}: JS {n}개 + index.html + sw.js")
