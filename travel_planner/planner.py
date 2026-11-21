"""Claude Code CLI(`claude -p`)로 AI 작업을 실행한다.

- API 키 없이 claude.ai 구독 로그인으로 실행된다. 추가 결제는 없지만 구독 사용량이 차감된다.
- 입력한 여행 정보는 Claude(Anthropic)로 전송된다.
- 진행 상황(웹 검색 횟수·검색어)을 실시간으로 알려 주고, 중간에 취소할 수 있다.

작업 종류
  plan       새 여행 자동 추천 (스팟·일정·준비물·예산·주의사항·추천 영상)
  recommend  카테고리별 추천 더 받기 (이미 있는 곳은 빼고)
  blog       여행이 끝난 뒤 기록(방문·메모·사진)으로 블로그 글 쓰기
  youtube    사용자가 넣은 YouTube 영상(제목·설명란·자막) 요약 + 나온 장소를 스팟으로
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
from typing import Callable, TypeVar

import yaml
from pydantic import BaseModel

from .models import CATEGORY_DESC, BlogResult, PlanResult, RecommendResult, YoutubeResult

PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "system.md"
TIMEOUT_SEC = 30 * 60
DEFAULT_MAX_SEARCHES = 15

# 이 값들이 있으면 claude CLI가 구독 대신 유료 API로 청구하므로 반드시 제거한다
BILLING_ENV_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")

CATEGORY_KO = {"photo": "사진 명소", "food": "먹거리", "cafe": "카페", "place": "가볼 곳", "landmark": "랜드마크", "activity": "즐길거리"}

T = TypeVar("T", bound=BaseModel)


class PlannerError(RuntimeError):
    pass


class Cancelled(RuntimeError):
    pass


def _claude_path() -> str:
    path = shutil.which("claude")
    if not path:
        raise PlannerError("claude CLI를 찾을 수 없습니다. Claude Code를 설치하고 `claude` 로그인 후 다시 실행해 주세요.")
    return path


def _yaml(data) -> str:
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False)


def _head() -> str:
    return f"{PROMPT_PATH.read_text(encoding='utf-8')}\n\n오늘 날짜: {date.today().isoformat()}\n"


def _search_rule(web_search: bool, max_searches: int) -> str:
    if web_search:
        return (
            f"WebSearch(최대 {max_searches}회)와 필요하면 WebFetch로 최신 정보를 확인하세요. "
            "확인한 항목에만 verified: true와 그 페이지 URL을 붙이세요.\n"
        )
    return "웹 검색 없이 알고 있는 정보로 작성하세요. 모든 항목은 verified: false, source_url: \"\", videos는 빈 배열로 두세요.\n"


# ---------- 작업별 프롬프트 ----------
def plan_prompt(trip: dict, web_search: bool, max_searches: int) -> str:
    return (
        f"{_head()}\n## 이번 작업: 새 여행 자동 추천\n"
        f"{_search_rule(web_search, max_searches)}"
        "조사할 것: 여행 날짜의 행사·축제·휴무·운영 종료, 동행·취향에 맞는 스팟(카테고리별), 예약한 시설의 운영 요일·시간, "
        "날씨·해 지는 시간·시차·통화·전압·교통, 이 여행지에 도움이 되는 YouTube 영상(브이로그·코스 소개·맛집 등).\n"
        f"스팟 카테고리: {CATEGORY_DESC}\n"
        "스팟은 하루 4~7곳 정도, 카테고리가 고르게 섞이게 하고, 같은 날은 같은 지역끼리 묶으세요. "
        "날짜에 넣기 애매한 후보도 date를 비워서 몇 개 더 넣어 주세요.\n\n"
        f"## 여행 정보\n```yaml\n{_yaml(trip)}```\n"
    )


def recommend_prompt(trip: dict, category: str, count: int, request: str, existing: list[str],
                     web_search: bool, max_searches: int) -> str:
    cat = f"'{CATEGORY_KO.get(category, category)}'({category})" if category != "any" else "모든 카테고리"
    return (
        f"{_head()}\n## 이번 작업: {cat} 추천 더 받기\n"
        f"{_search_rule(web_search, max_searches)}"
        f"{cat} 스팟을 {count}곳 추천하세요. "
        + (f"카테고리는 반드시 {category}로 하세요. " if category != "any" else f"카테고리: {CATEGORY_DESC}. ")
        + "이미 목록에 있는 곳은 빼고, 날짜는 여행 기간 안에서 어울리는 날로 넣거나 비워 두세요. "
        "관련 YouTube 영상이 있으면 1~3개 함께 주세요.\n"
        + (f"사용자 요청: {request}\n" if request else "")
        + f"\n## 이미 목록에 있는 곳 (중복 금지)\n{', '.join(existing) or '(없음)'}\n\n"
        f"## 여행 정보\n```yaml\n{_yaml(trip)}```\n"
    )


def blog_prompt(trip: dict, record: dict) -> str:
    return (
        f"{_head()}\n## 이번 작업: 여행 기록으로 블로그 글 쓰기\n"
        "아래 실제 여행 기록(방문한 곳, 일기, 사진·영상 설명, 지출)만 바탕으로 여행 후기 블로그 글을 쓰세요. "
        "기록에 없는 경험을 지어내지 마세요. 방문하지 않은 곳은 '가 보고 싶었던 곳' 정도로만 짧게 언급하세요. "
        "날짜 순서대로 단락을 나누고, 각 단락에 어울리는 사진·영상 id를 주어진 목록에서만 골라 넣으세요. "
        "말투는 친근한 블로그체, 웹 검색은 하지 마세요.\n\n"
        f"## 여행 정보\n```yaml\n{_yaml(trip)}```\n\n"
        f"## 여행 기록\n```yaml\n{_yaml(record)}```\n"
    )


def youtube_prompt(trip: dict, videos: list[dict], existing: list[str], web_search: bool, max_searches: int) -> str:
    return (
        f"{_head()}\n## 이번 작업: 사용자가 본 YouTube 영상 정리\n"
        f"{_search_rule(web_search, max_searches)}"
        "아래 영상의 제목·설명란·자막(스크립트)을 읽고 두 가지를 만드세요.\n"
        "1) videos: 영상마다 요약·핵심 정보·꿀팁. 여행 플랫폼 에디터가 정리한 것처럼 짧고 구체적으로 (AI 티 나는 표현 금지).\n"
        "2) spots: 영상에 나오거나 언급된 장소(식당·카페·명소·체험·쇼핑). 자동 자막은 받아쓰기 오류가 많으니 "
        "설명란·문맥과 웹 검색으로 실제 가게·장소 이름을 확인해 바로잡으세요 (예: 발음만 비슷한 엉뚱한 이름 금지). "
        "확인되지 않는 장소는 넣지 마세요. 이미 목록에 있는 곳은 빼세요. 날짜(date)는 비워 두세요.\n"
        f"스팟 카테고리: {CATEGORY_DESC}\n"
        "note에는 이 장소가 어떤 곳인지 한 문장, said에는 영상에서 말한 내용(메뉴·가격·팁)을 쓰세요.\n\n"
        f"## 이미 목록에 있는 곳 (중복 금지)\n{', '.join(existing) or '(없음)'}\n\n"
        f"## 여행 정보\n```yaml\n{_yaml(trip)}```\n\n"
        f"## 영상\n```yaml\n{_yaml(videos)}```\n"
    )


# ---------- 실행 ----------
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
            return f"📄 페이지 확인 중: {inp.get('url', '')}"[:200]
        if name == "StructuredOutput":
            return "📝 정리 마무리 중"
    return None


def run_claude(
    prompt: str,
    result_model: type[T],
    *,
    web_search: bool,
    max_searches: int = DEFAULT_MAX_SEARCHES,
    model: str | None = None,
    on_progress: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    files: dict[str, bytes] | None = None,
) -> T:
    """files: 작업 폴더에 둘 파일 {이름: 내용} — 있으면 Claude가 Read로 읽을 수 있음 (사진·PDF 바우처 등)."""
    cmd = [
        _claude_path(), "-p",
        "--output-format", "stream-json", "--verbose",
        "--json-schema", json.dumps(result_model.model_json_schema(), ensure_ascii=False),
        "--strict-mcp-config",  # MCP 서버를 불러오지 않음 (빠르고, 외부 서비스에 임의로 쓰지 않게)
        "--max-turns", str(max_searches * 2 + 10),
    ]
    blocked = ["Bash", "Edit", "Write", "NotebookEdit"]
    allowed = ["Read"] if files else []
    if web_search:
        allowed += ["WebSearch", "WebFetch"]
    else:
        blocked += ["WebSearch", "WebFetch"]
    if allowed:
        cmd += ["--allowedTools", *allowed]
    cmd += ["--disallowedTools", *blocked]
    if model:
        cmd += ["--model", model]

    env = {k: v for k, v in os.environ.items() if k not in BILLING_ENV_VARS}
    workdir = tempfile.mkdtemp(prefix="travel_planner_")  # 프로젝트 파일을 건드리지 않게 빈 폴더에서 실행
    for name, data in (files or {}).items():
        (Path(workdir) / name).write_bytes(data)
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8",
        cwd=workdir,
        env=env,
    )
    proc.stdin.write(prompt)
    proc.stdin.close()

    lines: queue.Queue = queue.Queue()
    stderr: list[str] = []
    threading.Thread(target=lambda: [lines.put(l) for l in proc.stdout] + [lines.put(None)], daemon=True).start()
    threading.Thread(target=lambda: stderr.extend(proc.stderr), daemon=True).start()

    started = time.monotonic()
    last_cancel_check = 0.0
    counts = {"search": 0}
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
    return result_model.model_validate(output)


__all__ = [
    "PlanResult", "RecommendResult", "BlogResult", "YoutubeResult", "run_claude", "plan_prompt", "recommend_prompt", "blog_prompt",
    "youtube_prompt",
    "PlannerError", "Cancelled", "DEFAULT_MAX_SEARCHES", "CATEGORY_KO",
]
