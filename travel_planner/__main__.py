"""여행 계획 앱 명령.

  python -m travel_planner setup --url <Supabase URL> --key <publishable/anon 키>   # 처음 한 번
  python -m travel_planner connect       # 위와 같지만 값을 물어봄 ('연결 설정.bat')
  python -m travel_planner worker        # 작업기 실행 (AI 추천·블로그 글 처리, v1 데이터 자동 변환, 백업)
  python -m travel_planner serve         # 웹 화면을 내 PC에서 열기 (GitHub Pages 올리기 전 확인용)
"""

import argparse
import base64
import functools
import http.server
import json
import os
import secrets
import sys
import threading
import webbrowser
from pathlib import Path

from dotenv import dotenv_values

from .cloud import Cloud, CloudError

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
DOCS_DIR = ROOT / "docs"


def load_env() -> dict:
    keys = ("SUPABASE_URL", "SUPABASE_KEY", "OWNER_KEY", "YOUTUBE_API_KEY")
    return {**dotenv_values(ENV_PATH), **{k: v for k, v in os.environ.items() if k in keys}}


def cloud_from_env() -> Cloud:
    env = load_env()
    missing = [k for k in ("SUPABASE_URL", "SUPABASE_KEY", "OWNER_KEY") if not env.get(k)]
    if missing:
        sys.exit(f"❌ .env에 {', '.join(missing)} 값이 없습니다. 먼저 `setup`을 실행해 주세요 (README 참고).")
    return Cloud(env["SUPABASE_URL"], env["SUPABASE_KEY"], env["OWNER_KEY"])


def is_secret_key(key: str) -> bool:
    """secret / service_role 키면 True (웹 공개용 config.js에 들어가면 안 되는 키)."""
    if key.startswith("sb_secret_"):
        return True
    parts = key.split(".")
    if len(parts) == 3:  # 예전 형식 JWT 키: payload의 role 확인
        try:
            payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
            return payload.get("role") == "service_role"
        except (ValueError, json.JSONDecodeError):
            return False
    return False


def write_env(values: dict) -> None:
    lines = [
        "# 여행 계획 앱 설정 (Git에 올리지 마세요)",
        "# OWNER_KEY는 소유자 비밀번호입니다. 웹 화면의 '소유자 로그인'에 넣으면 여행 만들기·삭제가 가능합니다.",
    ] + [f"{k}={v}" for k, v in values.items()]
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_web_config(url: str, key: str) -> None:
    config = {"url": url.rstrip("/"), "key": key}
    (DOCS_DIR / "config.js").write_text(
        "// Supabase 연결 정보. publishable(anon) 키는 공개용이라 웹에 올려도 안전합니다.\n"
        "// (테이블은 잠겨 있고, 정해진 함수로만 접근할 수 있습니다)\n"
        f"window.TRAVEL_CONFIG = {json.dumps(config, ensure_ascii=False)};\n",
        encoding="utf-8",
    )


def cmd_connect(_args) -> None:
    """'연결 설정.bat'용: 값을 대화형으로 입력받아 setup 실행."""
    print(
        "\n 여행 계획 앱 - Supabase 연결 설정\n"
        " ------------------------------------------------------------\n"
        " Supabase 대시보드에서 복사해 붙여 넣으세요 (검은 창에서 마우스 오른쪽 클릭 = 붙여넣기)\n"
        "  * Project URL    : 프로젝트 첫 화면의 https://....supabase.co (Copy 버튼)\n"
        "  * publishable 키 : Project Settings → API Keys 의 sb_publishable_... (secret 키 아님!)\n"
        " 입력한 값은 이 PC의 .env / docs\\config.js 에만 저장됩니다.\n"
    )
    url = input(" Project URL    : ").strip()
    key = input(" publishable 키 : ").strip()
    print()
    cmd_setup(argparse.Namespace(url=url, key=key))


def cmd_setup(args) -> None:
    url, key = args.url.strip().strip('"').rstrip("/"), args.key.strip().strip('"')
    local_dev = url.startswith(("http://127.0.0.1", "http://localhost"))  # tools/mock_supabase.py
    if not (url.startswith("https://") or local_dev) or not key:
        sys.exit("❌ --url은 https://로 시작하는 Supabase Project URL, --key는 publishable(또는 anon) 키를 넣어 주세요.")
    if is_secret_key(key):
        sys.exit(
            "❌ 이건 secret(service_role) 키입니다. 웹에 올라가면 DB 전체가 노출되므로 사용하지 않습니다.\n"
            "   Supabase의 API Keys 화면에서 'publishable'(또는 'anon') 키를 복사해 주세요."
        )

    env = load_env()
    owner_key = env.get("OWNER_KEY") or secrets.token_urlsafe(24)
    cloud = Cloud(url, key, owner_key)
    try:
        ok = cloud.rpc("init_owner", p_key=owner_key)
    except CloudError as e:
        msg = str(e)
        if "연결할 수 없습니다" in msg:
            hint = "Project URL이 맞는지 확인해 주세요 (프로젝트 첫 화면의 Copy 버튼으로 복사)."
        elif "401" in msg or "Invalid API key" in msg or "apikey" in msg.lower():
            hint = "publishable 키가 맞는지 확인해 주세요 (Project Settings → API Keys)."
        elif "init_owner" in msg and ("404" in msg or "Could not find" in msg):
            hint = "DB가 아직 준비되지 않았습니다. supabase/schema.sql을 SQL Editor에서 실행해 주세요."
        else:
            hint = "URL·키, 그리고 schema.sql 실행 여부를 확인해 주세요."
        sys.exit(f"❌ {msg}\n   → {hint}")
    if not ok:
        sys.exit("❌ 이 Supabase 프로젝트에는 다른 소유자 키가 이미 등록돼 있습니다. .env의 OWNER_KEY를 확인해 주세요.")

    values = {"SUPABASE_URL": url, "SUPABASE_KEY": key, "OWNER_KEY": owner_key}
    if env.get("YOUTUBE_API_KEY"):
        values["YOUTUBE_API_KEY"] = env["YOUTUBE_API_KEY"]  # 이미 넣어 둔 키는 유지
    write_env(values)
    write_web_config(url, key)
    print("✅ Supabase 연결 완료 (.env, docs/config.js 저장)")
    print(
        "\n🔑 소유자 키 (웹 화면의 '소유자 로그인'에 붙여 넣으세요. 다른 사람에게 알려주지 마세요):\n"
        f"   {owner_key}\n"
        "\n다음 단계: '여행계획 작업기 실행.bat'을 켜 두고, 웹 화면에서 여행을 만들어 보세요."
    )


def cmd_copy_key(_args) -> None:
    """소유자 키를 화면에 보여 주지 않고 클립보드에만 복사 ('소유자 키 복사.bat')."""
    import subprocess

    key = load_env().get("OWNER_KEY")
    if not key:
        sys.exit("❌ 소유자 키가 없습니다. 먼저 '연결 설정.bat'을 실행해 주세요.")
    subprocess.run(["clip"], input=key.encode("utf-16-le"), check=True)
    print(
        "✅ 소유자 키를 클립보드에 복사했어요 (화면에는 보여 주지 않아요).\n"
        "   웹 화면 오른쪽 위 '소유자' → 붙여넣기(Ctrl+V) → 로그인\n"
        "   비밀번호 관리 앱에도 붙여 넣어 보관해 두세요."
    )


def cmd_serve(args) -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DOCS_DIR))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    url = f"http://127.0.0.1:{args.port}"
    print(f"🌐 웹 화면: {url}  (종료: Ctrl+C)")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(prog="travel_planner", description="여행 계획 앱")
    sub = parser.add_subparsers(dest="cmd")

    p = sub.add_parser("setup", help="Supabase 연결 (처음 한 번)")
    p.add_argument("--url", required=True)
    p.add_argument("--key", required=True)

    sub.add_parser("connect", help="Supabase 연결 (대화형 입력)")
    sub.add_parser("copy-key", help="소유자 키를 클립보드에 복사")
    sub.add_parser("worker", help="작업기 실행")

    p = sub.add_parser("serve", help="웹 화면을 내 PC에서 열기")
    p.add_argument("--port", type=int, default=8765)

    args = parser.parse_args()
    if args.cmd == "setup":
        cmd_setup(args)
    elif args.cmd == "connect":
        cmd_connect(args)
    elif args.cmd == "copy-key":
        cmd_copy_key(args)
    elif args.cmd == "serve":
        cmd_serve(args)
    elif args.cmd in (None, "worker"):
        from .worker import run

        try:
            run(cloud_from_env(), load_env().get("YOUTUBE_API_KEY", ""))
        except KeyboardInterrupt:
            print("\n작업기를 종료했습니다.")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
