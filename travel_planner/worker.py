"""소유자 PC에서 도는 작업기.

- Supabase에 쌓인 '계획 만들기 / AI 수정 요청'을 하나씩 가져와 내 Claude 구독(claude -p)으로 처리
- 진행 상황(검색 횟수·검색어)을 화면에 실시간으로 올리고, 화면에서 취소하면 즉시 중단
- 6시간마다 전체 여행을 backups/ 폴더에 JSON으로 백업 (최근 30개 보관)
"""

import json
import time
from datetime import datetime
from pathlib import Path

from .cloud import Cloud, CloudError
from .planner import DEFAULT_MAX_SEARCHES, Cancelled, make_plan

POLL_SEC = 10
BACKUP_EVERY_SEC = 6 * 3600
BACKUP_KEEP = 30
BACKUP_DIR = Path(__file__).resolve().parent.parent / "backups"


def prompt_input(inp: dict, budget: dict, bookings: str | None) -> dict:
    """Claude에게 넘길 여행 정보 (한국어 키). 예약·총예산은 사용자가 저장한 별도 데이터를 쓴다."""
    total = budget.get("total")
    currency = budget.get("currency")
    fields = {
        "여행_이름": inp.get("title"),
        "목적지": inp.get("destination"),
        "기간": f'{inp.get("start_date", "")} ~ {inp.get("end_date", "")}',
        "동행": inp.get("companions"),
        "총예산": f"{int(total):,}원 (전체 인원)" if total else None,
        "예산_메모": inp.get("budget"),
        "현지_통화": currency,
        "여행_스타일": inp.get("style"),
        "꼭_하고_싶은_것": inp.get("must_do"),
        "확정된_예약_원문": bookings,
        "메모": inp.get("memo"),
    }
    return {k: v for k, v in fields.items() if v}


def _log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def backup(cloud: Cloud) -> None:
    BACKUP_DIR.mkdir(exist_ok=True)
    data = cloud.owner_rpc("export_all")
    path = BACKUP_DIR / f"trips-{datetime.now():%Y%m%d-%H%M}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    for old in sorted(BACKUP_DIR.glob("trips-*.json"))[:-BACKUP_KEEP]:
        old.unlink()
    _log(f"💾 백업 완료: {path.name} (여행 {len(data or [])}개)")


def process(cloud: Cloud, job: dict) -> None:
    trip_id = job["id"]
    inp = job["input"]
    note = job.get("revision_note")
    revising = bool(note and job.get("plan"))
    _log(f"{'✏️ 수정' if revising else '🧭 생성'} 시작: {inp.get('title')}" + (f" — {note}" if note else ""))

    last_sent = [0.0]

    def on_progress(text: str) -> None:
        _log(f"   {text}")
        if time.monotonic() - last_sent[0] < 3:
            return
        last_sent[0] = time.monotonic()
        try:
            cloud.owner_rpc("set_progress", p_trip=trip_id, p_text=text)
        except CloudError:
            pass

    def should_cancel() -> bool:
        try:
            return cloud.rpc("trip_status", p_trip=trip_id) != "generating"
        except CloudError:
            return False  # 연결 문제로 확인 못 하면 계속 진행

    try:
        plan = make_plan(
            prompt_input(inp, job.get("budget") or {}, job.get("bookings")),
            web_search=inp.get("web_search", True),
            max_searches=int(inp.get("max_searches") or DEFAULT_MAX_SEARCHES),
            model=inp.get("model") or None,
            previous_plan=job["plan"] if revising else None,
            revision_note=note if revising else None,
            on_progress=on_progress,
            should_cancel=should_cancel,
        )
    except Cancelled:
        _log(f"⏹️ 취소됨: {inp.get('title')}")
        return
    except CloudError:
        raise
    except Exception as e:  # Claude 실행 실패 등은 화면에 보여 주도록 기록
        _log(f"❌ 실패: {e}")
        cloud.owner_rpc("fail_job", p_trip=trip_id, p_error=str(e))
        return

    if cloud.owner_rpc("complete_job", p_trip=trip_id, p_plan=plan.model_dump()):
        _log(f"✅ 완료: {inp.get('title')}")
    else:
        _log(f"⏹️ 결과 버림 (그사이 취소·삭제됨): {inp.get('title')}")


def run(cloud: Cloud) -> None:
    reset = cloud.owner_rpc("reset_stuck")
    if reset:
        _log(f"중단됐던 작업 {reset}건을 다시 대기열에 넣었습니다")
    _log("🟢 작업기 실행 중 — 새 여행·수정 요청을 기다립니다 (종료: Ctrl+C 또는 창 닫기)")

    last_backup = 0.0
    while True:
        try:
            if time.monotonic() - last_backup > BACKUP_EVERY_SEC:
                backup(cloud)
                last_backup = time.monotonic()
            job = cloud.owner_rpc("claim_job")
            if job:
                process(cloud, job)
                continue
        except CloudError as e:
            _log(f"⚠️ {e} — 잠시 후 다시 시도합니다")
        time.sleep(POLL_SEC)
