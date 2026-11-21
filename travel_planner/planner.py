"""Claude Code CLI(`claude -p`)로 여행 계획을 만든다.

API 키 없이 claude.ai 구독 로그인으로 실행된다. 추가 결제는 없지만 구독 사용량이 차감된다.
입력한 여행 정보(목적지·예약 메모 등)는 Claude(Anthropic)로 전송된다.

진행 상황(웹 검색 횟수·검색어)을 실시간으로 알려 주고, 중간에 취소할 수 있다.
"""

import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import date
from pathlib import Path
from typing import Callable

import yaml

from .models import TripPlan

PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "system.md"
TIMEOUT_SEC = 30 * 60
DEFAULT_MAX_SEARCHES = 15

# 이 값들이 있으면 claude CLI가 구독 대신 유료 API로 청구하므로 반드시 제거한다
BILLING_ENV_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


class PlannerError(RuntimeError):
    pass


class Cancelled(RuntimeError):
    pass


def _claude_path() -> str:
    path = shutil.which("claude")
    if not path:
        raise PlannerError("claude CLI를 찾을 수 없습니다. Claude Code를 설치하고 `claude` 로그인 후 다시 실행해 주세요.")
    return path


def _build_prompt(
    trip: dict, web_search: bool, max_searches: int, previous_plan: dict | None, revision_note: str | None
) -> str:
    trip_text = yaml.safe_dump(trip, allow_unicode=True, sort_keys=False)
    system = PROMPT_PATH.read_text(encoding="utf-8")
    today = f"오늘 날짜: {date.today().isoformat()}\n"

    if previous_plan and revision_note:
        search = (
            f"요청을 반영하는 데 최신 정보가 필요하면 WebSearch(최대 {max_searches}회)로 확인하세요.\n"
            if web_search else "웹 검색 없이 작성하세요. 새로 넣는 항목은 verified: false로 두세요.\n"
        )
        return (
            f"{system}\n\n{today}"
            "## 이번 작업: 기존 계획 수정\n"
            "아래 '기존 계획'을 '수정 요청'에 맞게 고치세요. 요청과 관계없는 부분은 그대로 두고, "
            "항목 이름도 바꾸지 마세요(이름이 바뀌면 사용자가 해 둔 체크가 사라집니다). 전체 계획을 같은 JSON 구조로 다시 출력하세요.\n"
            f"{search}\n"
            f"## 수정 요청\n{revision_note}\n\n"
            f"## 여행 정보\n```yaml\n{trip_text}```\n\n"
            f"## 기존 계획\n```json\n{json.dumps(previous_plan, ensure_ascii=False)}\n```\n"
        )

    if web_search:
        research = (
            f"먼저 WebSearch(최대 {max_searches}회)와 필요하면 WebFetch로 최신 정보를 조사하세요.\n"
            "- 여행 날짜에 열리는 행사·축제, 운영 종료되거나 휴무인 곳\n"
            "- 동행·취향에 맞는 사진 명소, 놀거리, 맛집 (지역별로)\n"
            "- 예약한 공연·시설의 운영 요일과 시간\n"
            "- 날씨, 해 지는 시간, 시차, 통화, 전압, 교통 팁\n"
            "확인한 항목에는 verified: true와 그 페이지 URL을 붙이세요.\n"
        )
    else:
        research = (
            "웹 검색 없이 알고 있는 정보로 작성하세요. 모든 항목은 verified: false, source_url: \"\"로 두고, "
            "researched_on과 sources는 비워 두세요.\n"
        )

    return (
        f"{system}\n\n{today}"
        "## 이번 작업\n"
        f"{research}\n"
        "그다음 아래 여행 정보를 바탕으로 여행 계획을 정해진 JSON 구조로 작성하세요.\n\n"
        f"## 여행 정보\n```yaml\n{trip_text}```\n"
    )


def _describe(event: dict, counts: dict) -> str | None:
    """stream-json 이벤트를 사람이 읽을 진행 상황으로 바꾼다."""
    if event.get("type") != "assistant":
        return None
    for block in event.get("message", {}).get("content", []):
        if block.get("type") != "tool_use":
            continue
        name, inp = block.get("name"), block.get("input") or {}
        if name == "WebSearch":
            counts["search"] += 1
            return f"🔎 웹 검색 {counts['search']}회째: {inp.get('query', '')}"[:200]
        if name == "WebFetch":
            counts["fetch"] += 1
            return f"📄 페이지 확인 중: {inp.get('url', '')}"[:200]
        if name == "StructuredOutput":
            return "📝 계획 정리 마무리 중"
    return None


def make_plan(
    trip: dict,
    *,
    web_search: bool = True,
    max_searches: int = DEFAULT_MAX_SEARCHES,
    model: str | None = None,
    previous_plan: dict | None = None,
    revision_note: str | None = None,
    on_progress: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> TripPlan:
    cmd = [
        _claude_path(), "-p",
        "--output-format", "stream-json", "--verbose",
        "--json-schema", json.dumps(TripPlan.model_json_schema(), ensure_ascii=False),
        "--strict-mcp-config",  # MCP 서버를 불러오지 않음 (빠르고, 외부 서비스에 임의로 쓰지 않게)
        "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit",
        "--max-turns", str(max_searches * 2 + 10),
    ]
    if web_search:
        cmd += ["--allowedTools", "WebSearch", "WebFetch"]
    if model:
        cmd += ["--model", model]

    env = {k: v for k, v in os.environ.items() if k not in BILLING_ENV_VARS}
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        cwd=tempfile.mkdtemp(prefix="travel_planner_"),  # 프로젝트 파일을 건드리지 않게 빈 폴더에서 실행
        env=env,
    )
    proc.stdin.write(_build_prompt(trip, web_search, max_searches, previous_plan, revision_note))
    proc.stdin.close()

    lines: queue.Queue = queue.Queue()
    stderr: list[str] = []
    threading.Thread(target=lambda: [lines.put(l) for l in proc.stdout] + [lines.put(None)], daemon=True).start()
    threading.Thread(target=lambda: stderr.extend(proc.stderr), daemon=True).start()

    started = time.monotonic()
    last_cancel_check = 0.0
    counts = {"search": 0, "fetch": 0}
    result = None
    if on_progress:
        on_progress("🧭 Claude가 작업을 시작했어요")

    try:
        while True:
            now = time.monotonic()
            if now - started > TIMEOUT_SEC:
                raise PlannerError(f"{TIMEOUT_SEC // 60}분 안에 끝나지 않았습니다. 웹 검색을 끄거나 '검색 깊이'를 낮춰 다시 시도해 주세요.")
            if should_cancel and now - last_cancel_check > 3:
                last_cancel_check = now
                if should_cancel():
                    raise Cancelled("사용자가 취소했습니다")
            try:
                line = lines.get(timeout=1)
            except queue.Empty:
                continue
            if line is None:
                break
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "result":
                result = event
            elif on_progress and (text := _describe(event, counts)):
                on_progress(text)
    except BaseException:
        proc.kill()
        raise
    proc.wait()

    if result is None:
        raise PlannerError(f"claude CLI 실행 실패 (코드 {proc.returncode}): {''.join(stderr)[:1000]}")
    if result.get("is_error") or result.get("subtype") != "success":
        raise PlannerError(
            f"Claude 실행 오류 ({result.get('subtype')}): {str(result.get('result'))[:1000]}\n"
            "구독 사용 한도에 걸렸다면 잠시 후 다시 시도해 주세요."
        )
    output = result.get("structured_output")
    if output is None:
        raise PlannerError("구조화된 결과를 받지 못했습니다.")
    return TripPlan.model_validate(output)
