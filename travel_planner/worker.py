"""소유자 PC에서 도는 작업기.

- Supabase에 쌓인 AI 요청(plan / recommend / blog)을 하나씩 가져와 내 Claude 구독(claude -p)으로 처리
- AI 결과는 항목으로 '추가'만 한다 (사용자가 고친 내용은 덮어쓰지 않음)
- 추천 YouTube 영상은 실제로 존재·재생 가능한지 확인한 것만 저장 (YouTube oEmbed, API 키 불필요)
- 진행 상황을 화면에 실시간으로 올리고, 화면에서 취소하면 즉시 중단
- 예약·바우처 읽기: 항공권·숙소 메일·입장권 사진·PDF·붙여 넣은 글 → 일정 단위로 정리 (vouchers.py)
- 스팟 사진·정보 모으기: 웹 사진 검색·링크 읽기 + Claude 정리 (enrich.py)
- 6시간마다 전체 여행을 backups/ 폴더에 JSON으로 백업 (최근 30개 보관)
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

from . import enrich, vouchers, youtube
from .cloud import Cloud, CloudError
from .planner import (
    DEFAULT_MAX_SEARCHES, BlogResult, Cancelled, PlanResult, RecommendResult, YoutubeResult,
    blog_prompt, plan_prompt, recommend_prompt, run_claude, youtube_prompt,
)

POLL_SEC = 10
BACKUP_EVERY_SEC = 6 * 3600
BACKUP_KEEP = 30
BACKUP_DIR = Path(__file__).resolve().parent.parent / "backups"
SPOT_CATEGORIES = ("photo", "food", "cafe", "place", "landmark", "activity", "bar")


def _log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


# ---------- 여행 정보 → 프롬프트 ----------
def trip_context(trip: dict) -> dict:
    inp = trip.get("input") or {}
    budget = trip.get("budget") or {}
    fields = {
        "여행_이름": trip.get("title"),
        "목적지": trip.get("destination"),
        "기간": f'{trip.get("start_date") or ""} ~ {trip.get("end_date") or ""}',
        "동행": trip.get("companions"),
        "총예산": f"{int(budget['total']):,}원 (전체 인원)" if budget.get("total") else None,
        "현지_통화": budget.get("currency"),
        "연령대": inp.get("age"),
        "여행_유형": inp.get("party"),
        "여행_스타일": inp.get("style"),
        "꼭_하고_싶은_것": inp.get("must_do"),
        "확정된_예약_원문": trip.get("bookings"),
        "메모": inp.get("memo"),
    }
    return {k: v for k, v in fields.items() if v}


def _in_range(d: str, trip: dict) -> str:
    """여행 기간 안의 YYYY-MM-DD만 남긴다."""
    try:
        day = date.fromisoformat((d or "").strip())
    except ValueError:
        return ""
    start, end = trip.get("start_date"), trip.get("end_date")
    if start and day < date.fromisoformat(start):
        return ""
    if end and day > date.fromisoformat(end):
        return ""
    return day.isoformat()


# ---------- YouTube 확인 ----------
YT_ID = re.compile(r"(?:youtu\.be/|youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/))([A-Za-z0-9_-]{11})")


YOUTUBE_API_KEY = ""  # run()에서 .env의 YOUTUBE_API_KEY로 채움 (선택)


def youtube_search(queries: list[str], per_query: int = 2) -> list[dict]:
    """YouTube Data API로 실제 영상 찾기 (키가 있을 때만). 검색 1번 = 일일 무료 한도 10,000 중 100."""
    if not YOUTUBE_API_KEY:
        return []
    out = []
    for q in queries[:5]:
        params = urllib.parse.urlencode({
            "part": "snippet", "type": "video", "maxResults": per_query, "q": q, "key": YOUTUBE_API_KEY,
            "relevanceLanguage": "ko", "regionCode": "KR", "videoEmbeddable": "true", "safeSearch": "moderate",
        })
        try:
            with urllib.request.urlopen(f"https://www.googleapis.com/youtube/v3/search?{params}", timeout=15) as r:
                data = json.loads(r.read())
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
            _log(f"   ✗ YouTube 검색 실패: {e}")
            break
        for it in data.get("items", []):
            vid = it.get("id", {}).get("videoId")
            if vid:
                sn = it.get("snippet", {})
                out.append({"id": vid, "title": sn.get("title", ""), "author": sn.get("channelTitle", ""), "why": f"'{q}' 검색 결과"})
    return out


def merge_videos(*lists: list) -> list[dict]:
    seen, out = set(), []
    for lst in lists:
        for v in lst or []:
            if v["id"] not in seen:
                seen.add(v["id"])
                out.append(v)
    return out[:12]


def verify_videos(videos: list, keep: list | None = None) -> list[dict]:
    """실제로 열리는 YouTube 영상만 {id, title, author, why}로 돌려준다."""
    out = list(keep or [])
    seen = {v["id"] for v in out}
    for v in videos:
        m = YT_ID.search(v.url)
        if not m or m.group(1) in seen:
            continue
        vid = m.group(1)
        url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(f"https://www.youtube.com/watch?v={vid}")
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                meta = json.loads(r.read())
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            _log(f"   ✗ 영상 확인 실패(건너뜀): {v.url}")
            continue
        out.append({"id": vid, "title": meta.get("title", ""), "author": meta.get("author_name", ""), "why": v.why})
        seen.add(vid)
    return out


# ---------- AI 결과 → 저장할 형태 ----------
def spot_rows(spots, trip: dict) -> list[dict]:
    return [{
        "category": s.category, "name": s.name, "area": s.area, "day_date": _in_range(s.date, trip),
        "time": s.time, "note": s.note, "price": s.price, "reservation_needed": s.reservation_needed,
        "search_query": s.search_query_en, "source_url": s.source_url if s.verified else "", "verified": s.verified,
    } for s in spots]


def plan_result(p: PlanResult, trip: dict) -> dict:
    items = spot_rows(p.spots, trip)
    items += [{"category": "schedule", "name": s.text, "day_date": _in_range(s.date, trip), "time": s.time} for s in p.schedule]
    items += [{"category": "todo", "name": t} for t in p.todos]
    items += [{"category": "packing", "name": t} for t in p.packing]
    summary = {
        "researched_on": p.researched_on,
        "destination_en": p.destination_en,
        "alerts": [a.model_dump() for a in p.alerts],
        "basic_info": p.basic_info,
        "must_eat": p.must_eat,
        "budget_estimate": [b.model_dump() for b in p.budget_estimate],
        "emergency": p.emergency,
        "sources": [s.model_dump() for s in p.sources if s.url.startswith("http")],
        "videos": merge_videos(verify_videos(p.videos), youtube_search(p.video_queries)),
        "video_queries": p.video_queries[:5],
    }
    days = [{"date": _in_range(d.date, trip), "title": d.title} for d in p.day_titles]
    return {"items": items, "summary": summary, "days": [d for d in days if d["date"]]}


def blog_record(data: dict) -> tuple[dict, set[str]]:
    """블로그용 실제 기록. (기록, 고를 수 있는 사진 id 집합)"""
    items = {i["id"]: i for i in data["items"]}
    days = {d["day_date"]: d for d in data["days"]}
    trip = data["trip"]
    record_days = []
    start, end = trip.get("start_date"), trip.get("end_date")
    if start and end:
        d = date.fromisoformat(start)
        while d <= date.fromisoformat(end):
            key = d.isoformat()
            record_days.append({
                "날짜": key,
                "제목": (days.get(key) or {}).get("title"),
                "일기": (days.get(key) or {}).get("diary"),
                "방문한_곳": [f"{i['name']} ({i['area'] or ''}) - {i['note'] or ''}" for i in data["items"]
                           if i["done"] and i["category"] in SPOT_CATEGORIES and (i["day_date"] == key or (i["done_at"] or "")[:10] == key)],
                "고정_일정": [f"{i['time'] or ''} {i['name']}" for i in data["items"] if i["category"] == "schedule" and i["day_date"] == key],
            })
            d += timedelta(days=1)
    media = [{
        "id": m["id"], "종류": "영상" if m["kind"] == "video" else "사진", "설명": m.get("caption"), "날짜": m.get("day_date"),
        "장소": (items.get(m.get("item_id")) or {}).get("name"),
    } for m in data["media"]]
    record = {
        "날짜별": record_days,
        "방문한_곳_전체": [i["name"] for i in data["items"] if i["done"] and i["category"] in SPOT_CATEGORIES],
        "가보지_못한_곳": [i["name"] for i in data["items"] if not i["done"] and i["category"] in SPOT_CATEGORIES][:15],
        "사진_영상": media,
        "총지출": f"{sum(e['amount'] for e in data['expenses']):,}원",
    }
    return record, {m["id"] for m in data["media"]}


def youtube_result(data: dict, trip: dict, ctx: dict, params: dict, web: bool, common: dict, on_progress) -> dict:
    """사용자가 넣은 YouTube 영상들 → 영상 요약(개요에 쌓임) + 나온 장소는 스팟으로 (스팟은 이어서 사진·정보 자동 모으기)."""
    urls = [u for u in params.get("urls") or [] if isinstance(u, str)][:5]
    mats = []
    for u in urls:
        on_progress(f"📺 영상 읽는 중: {u}")
        mats.append(youtube.fetch_material(u))
    ok = [m for m in mats if not m.get("error")]
    if not ok:
        raise ValueError("영상을 읽지 못했어요: " + " / ".join(f"{m['url']} ({m['error']})" for m in mats))
    for m in ok:
        on_progress(f"📺 {m['title'][:40]} · {m['transcript_info']}")
    existing = [i["name"] for i in data["items"] if i["category"] in SPOT_CATEGORIES]
    material = [{"id": m["id"], "제목": m["title"], "채널": m["author"], "설명란": m["description"],
                 "자막": m["transcript"] or "(자막 없음 — 제목·설명란으로만 정리)"} for m in ok]
    common = {**common, "max_searches": min(common["max_searches"], 10)}
    r = run_claude(youtube_prompt(ctx, material, existing, web, common["max_searches"]), YoutubeResult, web_search=web, **common)
    by_id = {m["id"]: m for m in ok}
    names = {n.strip().lower() for n in existing}
    spots = [s for s in r.spots if s.name.strip().lower() not in names]
    rows = spot_rows(spots, trip)
    for row, s in zip(rows, spots):
        v = by_id.get(s.video_id) or ok[0]
        row["note"] = f"{s.note}\n▶ 영상: {s.said}".strip() if s.said else s.note
        row["source_url"] = v["url"]
        row["day_date"] = ""
    summary = trip.get("summary") or {}
    old = [n for n in summary.get("youtube_notes") or [] if n.get("id") not in by_id]
    notes = old + [{
        "id": n.id, "url": by_id[n.id]["url"], "title": by_id[n.id]["title"], "author": by_id[n.id]["author"],
        "summary": n.summary, "points": n.points, "tips": n.tips,
        "spots": [s.name for s in spots if s.video_id == n.id], "transcript": by_id[n.id]["transcript_info"],
        "added_on": date.today().isoformat(),
    } for n in r.videos if n.id in by_id]
    videos = merge_videos([{"id": m["id"], "title": m["title"], "author": m["author"], "why": "직접 넣은 영상"} for m in ok],
                          summary.get("videos"))
    return {"items": rows, "summary": {"youtube_notes": notes[-30:], "videos": videos}}


# ---------- 작업 처리 ----------
def process(cloud: Cloud, claimed: dict) -> None:
    trip_id = claimed["id"]
    job = claimed.get("job") or {"type": "plan", "params": {}}
    kind, params = job.get("type", "plan"), job.get("params") or {}
    data = cloud.rpc("get_trip", p_trip=trip_id)
    trip = data["trip"]
    inp = trip.get("input") or {}
    label = {"plan": "🧭 새 여행 추천", "recommend": "✨ 추천 더 받기", "blog": "✍️ 블로그 글", "youtube": "📺 유튜브 정리"}.get(kind, kind)
    _log(f"{label} 시작: {trip['title']}" + (f" ({params})" if params else ""))

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

    common = {
        "model": inp.get("model") or None,
        "max_searches": int(params.get("max_searches") or inp.get("max_searches") or DEFAULT_MAX_SEARCHES),
        "on_progress": on_progress,
        "should_cancel": should_cancel,
    }
    web = params.get("web_search", inp.get("web_search", True))

    try:
        ctx = trip_context(trip)
        if kind == "plan":
            p = run_claude(plan_prompt(ctx, web, common["max_searches"]), PlanResult, web_search=web, **common)
            result = plan_result(p, trip)
        elif kind == "recommend":
            category = params.get("category") or "any"
            # 추천 화면에서 고른 연령대·여행 유형이 있으면 그걸 우선
            ctx = {**ctx, **{k: v for k, v in (("연령대", params.get("age")), ("여행_유형", params.get("party"))) if v}}
            existing = [i["name"] for i in data["items"] if i["category"] in SPOT_CATEGORIES]
            count = max(1, min(12, int(params.get("count") or 5)))
            common["max_searches"] = min(common["max_searches"], 8)
            r = run_claude(recommend_prompt(ctx, category, count, params.get("request", ""), existing, web, common["max_searches"]),
                           RecommendResult, web_search=web, **common)
            spots = [s for s in r.spots if category == "any" or s.category == category]
            names = {n.strip().lower() for n in existing}
            spots = [s for s in spots if s.name.strip().lower() not in names]
            summary = trip.get("summary") or {}
            videos = merge_videos(summary.get("videos"), verify_videos(r.videos), youtube_search(r.video_queries, per_query=1))
            queries = list(dict.fromkeys((summary.get("video_queries") or []) + r.video_queries))[:8]
            result = {"items": spot_rows(spots, trip), "summary": {"videos": videos, "video_queries": queries}}
        elif kind == "youtube":
            result = youtube_result(data, trip, ctx, params, web, common, on_progress)
        elif kind == "blog":
            record, media_ids = blog_record(data)
            b = run_claude(blog_prompt(ctx, record), BlogResult, web_search=False, **{**common, "max_searches": 3})
            blog = b.model_dump()
            for s in blog["sections"]:
                s["photo_ids"] = [pid for pid in s["photo_ids"] if pid in media_ids]
            blog["generated_at"] = datetime.now().isoformat(timespec="seconds")
            result = {"blog": blog}
        else:
            raise ValueError(f"알 수 없는 작업: {kind}")
    except Cancelled:
        _log(f"⏹️ 취소됨: {trip['title']}")
        return
    except CloudError:
        raise
    except Exception as e:  # Claude 실행 실패 등은 화면에 보여 주도록 기록
        _log(f"❌ 실패: {e}")
        cloud.owner_rpc("fail_job", p_trip=trip_id, p_error=str(e))
        return

    if cloud.owner_rpc("complete_job", p_trip=trip_id, p_result=result):
        _log(f"✅ 완료: {trip['title']} (항목 {len(result.get('items', []))}개 추가)")
    else:
        _log(f"⏹️ 결과 버림 (그사이 취소·삭제됨): {trip['title']}")


# ---------- v1 → v2 옮기기 ----------
def legacy_result(plan: dict, trip: dict) -> dict:
    """v1 TripPlan JSON을 v2 항목으로 바꾼다."""
    start = date.fromisoformat(trip["start_date"]) if trip.get("start_date") else None

    def day_of(i: int) -> str:
        return (start + timedelta(days=i)).isoformat() if start else ""

    def split(text: str) -> tuple[str, str]:
        name, _, note = str(text).partition(" — ")
        return name.strip(), note.strip()

    items, days = [], []
    for di, d in enumerate(plan.get("days") or []):
        day = day_of(di)
        if day:
            title = re.sub(r"^Day\s*\d+\s*-\s*", "", d.get("title", ""))
            title = re.sub(r"^\d{1,2}/\d{1,2}\s*\([^)]*\)\s*", "", title)  # 앞의 날짜 표기는 화면이 따로 보여 줌
            days.append({"date": day, "title": title})
        for s in d.get("fixed_schedule") or []:
            m = re.match(r"^\s*(\d{1,2}:\d{2})\s*(.*)$", s)
            items.append({"category": "schedule", "name": (m.group(2) if m else s).strip(), "time": m.group(1) if m else "", "day_date": day})
        for p in d.get("places") or []:
            n, note = split(p)
            items.append({"category": "place", "name": n, "note": note, "day_date": day})
        for f in d.get("foods") or []:
            n, note = split(f)
            items.append({"category": "food", "name": n, "note": note, "day_date": day})
    for s in plan.get("photo_spots") or []:
        items.append({"category": "photo", "name": s["name"], "area": s.get("area"), "time": s.get("best_time"), "note": s.get("point"),
                      "search_query": s.get("search_query_en"), "source_url": s.get("source_url", ""), "verified": s.get("verified", False)})
    for a in plan.get("activities") or []:
        items.append({"category": "activity", "name": a["name"], "area": a.get("area"), "note": a.get("note"), "price": a.get("price"),
                      "reservation_needed": a.get("reservation_needed", False), "source_url": a.get("source_url", ""), "verified": a.get("verified", False)})
    for r in plan.get("restaurants") or []:
        cat = "cafe" if any(k in (r.get("meal_type") or "") for k in ("카페", "디저트")) else "food"
        items.append({"category": cat, "name": r["name"], "area": r.get("area"), "note": " · ".join(x for x in (r.get("menu"), r.get("feature")) if x),
                      "price": r.get("price_range"), "reservation_needed": r.get("reservation_needed", False),
                      "search_query": r.get("search_query_en"), "source_url": r.get("source_url", ""), "verified": r.get("verified", False)})
    items += [{"category": "todo", "name": t["text"] if isinstance(t, dict) else t} for t in plan.get("todos") or []]
    items += [{"category": "todo", "name": t} for t in plan.get("checklist_before") or []]
    items += [{"category": "packing", "name": t} for t in plan.get("packing") or []]
    alerts = [a if isinstance(a, dict) else {"text": a, "source_url": "", "verified": False} for a in plan.get("alerts") or []]
    summary = {
        "researched_on": plan.get("researched_on", ""), "alerts": alerts, "basic_info": plan.get("basic_info") or [],
        "must_eat": plan.get("must_eat") or [], "emergency": plan.get("emergency") or [], "sources": plan.get("sources") or [],
        "budget_estimate": plan.get("budget") or [], "videos": [],
    }
    return {"items": _dedupe([i for i in items if i.get("name")]), "summary": summary, "days": days}


def _dedupe(items: list[dict]) -> list[dict]:
    """같은 이름이 날짜별 목록과 카테고리 목록에 둘 다 있으면 하나로 합친다 (빈 칸은 서로 채움)."""
    def key(i: dict) -> tuple:
        name = re.sub(r"[(（].*?[)）]", "", i["name"])  # 괄호 속 영문·현지어 표기 무시
        return (i["category"] in SPOT_CATEGORIES, re.sub(r"[\s·,./]", "", name).lower())
    merged: dict = {}
    for i in items:
        k = key(i)
        if k not in merged:
            merged[k] = dict(i)
            continue
        base = merged[k]
        for f, v in i.items():
            if v and not base.get(f):
                base[f] = v
        if base["category"] in ("place", "food") and i["category"] not in ("place", "food"):
            base["category"] = i["category"]  # 더 구체적인 카테고리 (카페·사진 명소 등) 우선
    return list(merged.values())


def migrate_legacy(cloud: Cloud) -> None:
    for t in cloud.owner_rpc("legacy_plans") or []:
        cloud.owner_rpc("migrate_trip", p_trip=t["id"], p_result=legacy_result(t["plan"], t))
        _log(f"📦 v1 → v2 변환: {t['title']}")


# ---------- 백업·실행 ----------
def backup(cloud: Cloud) -> None:
    BACKUP_DIR.mkdir(exist_ok=True)
    data = cloud.owner_rpc("export_all")
    path = BACKUP_DIR / f"trips-{datetime.now():%Y%m%d-%H%M}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    for old in sorted(BACKUP_DIR.glob("trips-*.json"))[:-BACKUP_KEEP]:
        old.unlink()
    _log(f"💾 백업 완료: {path.name} (여행 {len(data or [])}개)")


def run(cloud: Cloud, youtube_api_key: str = "") -> None:
    global YOUTUBE_API_KEY
    YOUTUBE_API_KEY = youtube_api_key or ""
    _log("▶️ YouTube 영상 검색: " + ("켜짐 (API 키 있음)" if YOUTUBE_API_KEY else "꺼짐 — 검색어 카드로만 보여 줘요 (README 'YouTube 영상' 참고)"))
    migrate_legacy(cloud)
    reset = cloud.owner_rpc("reset_stuck")
    if reset:
        _log(f"중단됐던 작업 {reset}건을 다시 대기열에 넣었습니다")
    _log("🟢 작업기 실행 중 — AI 요청을 기다립니다 (종료: Ctrl+C 또는 창 닫기)")

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
            if vouchers.run_once(cloud):  # 예약·바우처 읽기 (사용자가 기다리는 중이라 먼저)
                continue
            if enrich.run_once(cloud):  # 스팟 사진·정보 모으기 (AI 작업이 없을 때)
                continue
        except CloudError as e:
            _log(f"⚠️ {e} — 잠시 후 다시 시도합니다")
        time.sleep(POLL_SEC)
