"""예약·바우처 읽기 (소유자 PC의 작업기).

항공권·숙소 예약 메일·입장 바우처·QR 스크린샷·PDF, 또는 붙여 넣은 메일 글을 Claude가 읽어서
일정에 넣을 단위(편·체크인/아웃·회차)와 예약번호·금액·현장 정보를 정리한다.
정리 결과는 화면에서 사용자가 확인한 뒤에만 일정·지출에 반영된다 (자동으로 덮어쓰지 않음).
"""

from __future__ import annotations

import urllib.request
from datetime import datetime
from pathlib import PurePosixPath

from .cloud import Cloud, CloudError
from .models import VoucherResult
from .planner import _head, _yaml, run_claude

EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "application/pdf": ".pdf"}


def _log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def _prompt(v: dict, filename: str | None) -> str:
    trip = {k: x for k, x in (v.get("trip") or {}).items() if x and k != "model"}
    src = (f"작업 폴더의 파일 `{filename}`을 Read 도구로 열어 읽으세요 (사진·스크린샷·PDF)."
           if filename else "아래 '붙여 넣은 글'을 읽으세요 (예약 확인 메일·문자 등).")
    return (
        f"{_head()}\n## 이번 작업: 예약 확인서·바우처 읽기\n{src}\n"
        "항공권·숙소 예약·입장권·투어·식당 예약·교통편 확인서에서 일정과 현장에서 필요한 정보를 뽑아 정리하세요.\n"
        "- 문서에 적힌 값만 쓰세요. 보이지 않거나 확실하지 않은 값은 빈 문자열로 두고 unclear에 적으세요. 지어내지 마세요.\n"
        "- 날짜에 연도가 없으면 여행 기간을 보고 정하세요. 시간은 그 장소의 현지 시각 그대로 (변환하지 말 것).\n"
        "- 예약번호·이름·금액은 글자 하나도 바꾸지 말고 그대로 옮기세요.\n"
        "- 여권 번호·카드 번호 같은 민감한 번호는 key_info에 쓰지 마세요.\n\n"
        f"## 여행 정보\n```yaml\n{_yaml(trip)}```\n"
        + (f"\n## 붙여 넣은 글\n```\n{v['body'][:20000]}\n```\n" if v.get("body") else "")
    )


def run_once(cloud: Cloud) -> bool:
    """대기 중인 바우처 하나를 읽는다. 처리했으면 True."""
    v = cloud.owner_rpc("claim_voucher")
    if not v:
        return False
    _log("🎫 예약·바우처 읽기 시작")
    files, name = {}, None
    try:
        if v.get("file_path"):
            url = f"{cloud.url}/storage/v1/object/public/photos/{v['file_path']}"
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            ext = EXT.get(v.get("mime") or "", PurePosixPath(v["file_path"]).suffix or ".jpg")
            name = f"voucher{ext}"
            files[name] = data
        res = run_claude(_prompt(v, name), VoucherResult, web_search=False, max_searches=3,
                         model=(v.get("trip") or {}).get("model") or None, files=files or None,
                         on_progress=lambda t: _log(f"   {t}"))
        parsed = res.model_dump()
        parsed["read_at"] = datetime.now().isoformat(timespec="seconds")
        cloud.owner_rpc("finish_voucher", p_id=v["id"], p_parsed=parsed, p_error=None)
        _log(f"   ✅ {res.title} · 일정 {len(res.segments)}개" + (" · QR 있음" if res.has_qr else ""))
    except CloudError:
        raise
    except Exception as e:
        _log(f"   ✗ 바우처를 읽지 못했어요: {e}")
        cloud.owner_rpc("finish_voucher", p_id=v["id"], p_parsed=None, p_error=f"읽지 못했어요: {str(e)[:300]}")
    return True
