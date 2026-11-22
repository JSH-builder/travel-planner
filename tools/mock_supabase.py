"""개발·테스트용 가짜 Supabase 서버 (schema.sql v2와 같은 동작을 메모리로 흉내 냄).

  python tools/mock_supabase.py            # http://127.0.0.1:54321
  python -m travel_planner setup --url http://127.0.0.1:54321 --key dev
테스트가 끝나면 진짜 Supabase 주소로 setup을 다시 실행하세요.
"""

import hashlib
import json
import sys
import time
import uuid
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 54321
CATS = ("photo", "food", "cafe", "place", "landmark", "activity", "bar", "schedule", "todo", "packing")
SPOTS = CATS[:6]
MIMES = ("image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime", "video/webm", "application/pdf")

lock = Lock()
db = {"owner_hash": None, "trips": {}, "items": {}, "media": {}, "expenses": {}, "days": {}, "vouchers": {}}
files: dict[str, tuple[str, bytes]] = {}


class RpcError(Exception):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha(s):
    return hashlib.sha256((s or "").encode()).hexdigest()


def d(s):
    s = (s or "").strip() if isinstance(s, str) else s
    if not s:
        return None
    try:
        return date.fromisoformat(s).isoformat()
    except ValueError:
        raise RpcError("날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)")


def owner(k):
    if not db["owner_hash"] or sha(k) != db["owner_hash"]:
        raise RpcError("소유자 키가 올바르지 않습니다")


def trip(tid):
    t = db["trips"].get(tid)
    if not t:
        raise RpcError("여행을 찾을 수 없습니다")
    return t


def clean_budget(b):
    b = b or {}
    try:
        total = float(b["total"]) if b.get("total") not in (None, "") else None
        rate = float(b["rate"]) if b.get("rate") not in (None, "") else None
    except (TypeError, ValueError):
        raise RpcError("숫자를 확인해 주세요")
    if total is not None and total < 0:
        raise RpcError("총예산 값이 올바르지 않습니다")
    if rate is not None and rate <= 0:
        raise RpcError("환율 값이 올바르지 않습니다")
    out = {"total": round(total) if total is not None else None, "currency": (b.get("currency") or "").strip().upper()[:10] or None, "rate": rate}
    return {k: v for k, v in out.items() if v is not None}


def of_trip(table, tid):
    return [r for r in db[table].values() if r["trip_id"] == tid]


def strip(r):
    return {k: v for k, v in r.items() if k != "trip_id"}


# ---------- RPC ----------
def init_owner(p_key):
    if len(p_key or "") < 24:
        raise RpcError("소유자 키가 너무 짧습니다")
    if db["owner_hash"]:
        return sha(p_key) == db["owner_hash"]
    db["owner_hash"] = sha(p_key)
    return True


def list_trips(p_owner_key):
    owner(p_owner_key)
    out = []
    for t in db["trips"].values():
        its = [i for i in of_trip("items", t["id"]) if i["category"] in SPOTS]
        first = next((m["path"] for m in sorted(of_trip("media", t["id"]), key=lambda m: m["created_at"]) if m["kind"] == "photo"), None)
        out.append({**{k: t[k] for k in ("id", "title", "destination", "start_date", "end_date", "status")},
                    "cover_path": t["cover_path"] or first, "destination_en": (t["summary"] or {}).get("destination_en"),
                    "spots": len(its), "visited": sum(i["done"] for i in its), "media": len(of_trip("media", t["id"]))})
    return sorted(out, key=lambda t: t["start_date"] or "", reverse=True)


def create_trip(p_owner_key, p_trip, p_ai):
    owner(p_owner_key)
    start, end = d(p_trip.get("start_date")), d(p_trip.get("end_date")) or d(p_trip.get("start_date"))
    if start and end and end < start:
        raise RpcError("도착일이 출발일보다 빠릅니다")
    tid = str(uuid.uuid4())
    db["trips"][tid] = {
        "id": tid, "title": (p_trip.get("title") or "새 여행").strip()[:120], "destination": p_trip.get("destination"),
        "start_date": start, "end_date": end, "companions": p_trip.get("companions"), "bookings": p_trip.get("bookings") or None,
        "budget": clean_budget(p_trip.get("budget")), "input": p_trip.get("input") or {}, "cover_path": None,
        "summary": {}, "blog": None, "status": "queued" if p_ai else "done",
        "job": {"type": "plan", "params": {}} if p_ai else None, "progress": None, "error": None,
        "requested_at": time.time(), "updated_at": now(), "plan": None,
    }
    return tid


def delete_trip(p_owner_key, p_trip):
    owner(p_owner_key)
    db["trips"].pop(p_trip, None)
    for table in ("items", "media", "expenses", "days"):
        for k in [k for k, r in db[table].items() if r["trip_id"] == p_trip]:
            del db[table][k]


def get_trip(p_trip):
    t = db["trips"].get(p_trip)
    if not t:
        return None
    keys = ("id", "title", "destination", "start_date", "end_date", "companions", "bookings", "budget", "input",
            "cover_path", "summary", "blog", "status", "job", "progress", "error", "updated_at")
    items = sorted(of_trip("items", p_trip), key=lambda i: (i["day_date"] is None, i["day_date"] or "", i["sort"]))
    return {
        "trip": {k: t[k] for k in keys},
        "items": [strip(i) for i in items],
        "media": [strip(m) for m in sorted(of_trip("media", p_trip), key=lambda m: m["created_at"])],
        "expenses": [strip(e) for e in sorted(of_trip("expenses", p_trip), key=lambda e: e["created_at"])],
        "days": [strip(x) for x in sorted(of_trip("days", p_trip), key=lambda x: x["day_date"])],
        "vouchers": [strip(v) for v in sorted(of_trip("vouchers", p_trip), key=lambda v: v["created_at"])],
    }


def update_trip(p_trip, p_patch):
    t = dict(trip(p_trip))
    if "title" in p_patch:
        if not (p_patch["title"] or "").strip():
            raise RpcError("제목을 입력해 주세요")
        t["title"] = p_patch["title"].strip()[:120]
    for k in ("destination", "companions"):
        if k in p_patch:
            t[k] = p_patch[k]
    for k in ("start_date", "end_date"):
        if k in p_patch:
            t[k] = d(p_patch[k])
    if t["start_date"] and t["end_date"] and t["end_date"] < t["start_date"]:
        raise RpcError("도착일이 출발일보다 빠릅니다")
    if isinstance(p_patch.get("input"), dict):
        t["input"] = {**(t.get("input") or {}), **{k: str(v)[:200] for k, v in p_patch["input"].items() if k in ("age", "party", "style", "pace")}}
    if "bookings" in p_patch:
        t["bookings"] = p_patch["bookings"] or None
    if "budget" in p_patch:
        t["budget"] = clean_budget(p_patch["budget"])
    if "cover_path" in p_patch:
        if p_patch["cover_path"] and not p_patch["cover_path"].startswith(p_trip + "/"):
            raise RpcError("잘못된 사진 경로")
        t["cover_path"] = p_patch["cover_path"]
    t["updated_at"] = now()
    db["trips"][p_trip] = t


ITEM_FIELDS = ("category", "name", "area", "day_date", "time", "note", "price", "reservation_needed", "search_query", "sort", "thumb_path",
               "end_time", "place", "lat", "lng", "stay_min")


def clean_links(v):
    out = []
    for x in v or []:
        u = (x if isinstance(x, str) else (x or {}).get("url") or "").strip()
        if u.lower().startswith(("http://", "https://")) and " " not in u and len(u) <= 600 and u not in out:
            out.append(u)
    return [{"url": u} for u in out[:10]]


def enrich_fields():
    return {"links": [], "photos": [], "details": {}, "enrich": None, "enrich_error": None,
            "end_time": None, "place": None, "lat": None, "lng": None, "stay_min": None}


def upsert_item(p_trip, p_item, p_by=None):
    trip(p_trip)
    iid = p_item.get("id")
    if not iid:
        if not (p_item.get("name") or "").strip():
            raise RpcError("이름을 입력해 주세요")
        if p_item.get("category") not in CATS:
            raise RpcError("잘못된 카테고리")
        iid = str(uuid.uuid4())
        db["items"][iid] = {
            "id": iid, "trip_id": p_trip, "category": p_item["category"], "name": p_item["name"].strip()[:200],
            "area": p_item.get("area"), "day_date": d(p_item.get("day_date")), "time": p_item.get("time"),
            "note": p_item.get("note"), "price": p_item.get("price"), "reservation_needed": bool(p_item.get("reservation_needed")),
            "search_query": p_item.get("search_query"), "source_url": None, "verified": False, "origin": "user",
            "done": False, "done_at": None, "done_by": None, "sort": time.time(), "created_by": p_by,
            "created_at": now(), "updated_at": now(), "thumb_path": None, **enrich_fields(),
        }
        links = clean_links(p_item.get("links"))
        db["items"][iid].update(links=links, enrich="pending" if links else None, end_time=p_item.get("end_time"), place=p_item.get("place"))
        return iid
    r = db["items"].get(iid)
    if not r or r["trip_id"] != p_trip:
        raise RpcError("항목을 찾을 수 없습니다")
    if p_item.get("thumb_path") and not p_item["thumb_path"].startswith(p_trip + "/"):
        raise RpcError("잘못된 사진 경로")
    if "place" in p_item and p_item["place"] != r.get("place"):
        r["lat"] = r["lng"] = None
    for k in ITEM_FIELDS:
        if k in p_item:
            if k == "name" and not (p_item[k] or "").strip():
                raise RpcError("이름을 입력해 주세요")
            r[k] = d(p_item[k]) if k == "day_date" else p_item[k]
    if "links" in p_item:
        links = clean_links(p_item["links"])
        if links != r["links"] and links:
            r["enrich"] = "pending"
        r["links"] = links
    if "photos" in p_item:
        r["photos"] = [x for x in p_item["photos"] or [] if x in r["photos"]]
    if p_item.get("enrich") == "pending":
        r["enrich"] = "pending"
    r["updated_at"] = now()
    return iid


def delete_item(p_trip, p_item):
    r = db["items"].get(p_item)
    if r and r["trip_id"] == p_trip:
        del db["items"][p_item]
        for eid in [k for k, e in db["expenses"].items() if e.get("item_id") == p_item]:
            del db["expenses"][eid]
        for v in db["vouchers"].values():
            if v.get("item_id") == p_item:
                v["item_id"] = None
        for m in db["media"].values():
            if m["item_id"] == p_item:
                m["item_id"] = None


def set_done(p_trip, p_item, p_done, p_by=None):
    r = db["items"].get(p_item)
    if not r or r["trip_id"] != p_trip:
        raise RpcError("항목을 찾을 수 없습니다")
    r.update(done=p_done, done_at=now() if p_done else None, done_by=p_by if p_done else None, updated_at=now())


def add_media(p_trip, p_item, p_kind, p_path, p_caption=None, p_by=None, p_day=None):
    trip(p_trip)
    if not p_path.startswith(p_trip + "/"):
        raise RpcError("잘못된 파일 경로")
    day = d(p_day)
    if p_item:
        it = db["items"].get(p_item)
        if not it or it["trip_id"] != p_trip:
            raise RpcError("항목을 찾을 수 없습니다")
        day = day or it["day_date"]
    mid = str(uuid.uuid4())
    db["media"][mid] = {"id": mid, "trip_id": p_trip, "item_id": p_item, "day_date": day, "kind": p_kind, "path": p_path,
                        "caption": p_caption or None, "by_name": p_by, "created_at": now()}
    return mid


def update_media(p_trip, p_media, p_caption):
    m = db["media"].get(p_media)
    if m and m["trip_id"] == p_trip:
        m["caption"] = p_caption or None


def delete_media(p_trip, p_media):
    m = db["media"].get(p_media)
    if not m or m["trip_id"] != p_trip:
        return None
    del db["media"][p_media]
    t = db["trips"][p_trip]
    if t["cover_path"] == m["path"]:
        t["cover_path"] = None
    for it in db["items"].values():
        if it["trip_id"] == p_trip and it.get("thumb_path") == m["path"]:
            it["thumb_path"] = None
    return m["path"]


def upsert_expense(p_trip, p_exp, p_by=None):
    trip(p_trip)
    if not (p_exp.get("title") or "").strip():
        raise RpcError("지출 항목을 입력해 주세요")
    try:
        amount = round(float(p_exp.get("amount")))
    except (TypeError, ValueError):
        raise RpcError("금액을 확인해 주세요")
    if amount < 0:
        raise RpcError("금액을 확인해 주세요")
    eid = p_exp.get("id") or str(uuid.uuid4())
    db["expenses"][eid] = {"id": eid, "trip_id": p_trip, "title": p_exp["title"].strip(), "amount": amount,
                           "category": p_exp.get("category"), "day_date": d(p_exp.get("day_date")), "by_name": p_by,
                           "created_at": db["expenses"].get(eid, {}).get("created_at", now())}
    return eid


def add_voucher(p_trip, p_v, p_by=None):
    trip(p_trip)
    path, body = (p_v.get("file_path") or None), (p_v.get("body") or "").strip() or None
    if not path and not body:
        raise RpcError("사진·PDF를 올리거나 내용을 붙여 넣어 주세요")
    if path and not path.startswith(p_trip + "/"):
        raise RpcError("잘못된 파일 경로")
    vid = str(uuid.uuid4())
    db["vouchers"][vid] = {"id": vid, "trip_id": p_trip, "item_id": p_v.get("item_id") or None, "kind": p_v.get("kind") or "other",
                           "title": p_v.get("title"), "file_path": path, "mime": p_v.get("mime"), "body": body, "parsed": {},
                           "status": "pending" if p_v.get("ai", True) else "manual", "error": None, "created_by": p_by,
                           "created_at": now(), "updated_at": now()}
    return vid


def update_voucher(p_trip, p_id, p_patch):
    v = db["vouchers"].get(p_id)
    if not v or v["trip_id"] != p_trip:
        return None
    if p_patch.get("item_id") and (p_patch["item_id"] not in db["items"] or db["items"][p_patch["item_id"]]["trip_id"] != p_trip):
        raise RpcError("항목을 찾을 수 없습니다")
    for k in ("item_id", "kind", "title"):
        if k in p_patch:
            v[k] = p_patch[k] or (v[k] if k == "kind" else None)
    if p_patch.get("status") == "pending" and v["status"] in ("done", "error", "manual"):
        v["status"] = "pending"
    v["updated_at"] = now()


def delete_voucher(p_trip, p_id):
    v = db["vouchers"].get(p_id)
    if v and v["trip_id"] == p_trip:
        del db["vouchers"][p_id]
        return v["file_path"]
    return None


def claim_voucher(p_owner_key):
    owner(p_owner_key)
    rows = sorted((v for v in db["vouchers"].values() if v["status"] == "pending"), key=lambda v: v["created_at"])
    if not rows:
        return None
    v = rows[0]
    v.update(status="working", error=None)
    t = db["trips"][v["trip_id"]]
    return {**{k: v[k] for k in ("id", "trip_id", "kind", "file_path", "mime", "body")},
            "trip": {k: t.get(k) for k in ("title", "destination", "start_date", "end_date", "companions")}}


def finish_voucher(p_owner_key, p_id, p_parsed, p_error=None):
    owner(p_owner_key)
    v = db["vouchers"].get(p_id)
    if not v or v["status"] != "working":
        return False
    if p_error is not None:
        v.update(status="error", error=p_error[:500])
    else:
        v.update(parsed=p_parsed or {}, kind=(p_parsed or {}).get("kind") or v["kind"], title=v["title"] or (p_parsed or {}).get("title"),
                 status="done", error=None)
    v["updated_at"] = now()
    return True


def set_item_cost(p_trip, p_item, p_amount, p_category=None, p_by=None):
    trip(p_trip)
    it = db["items"].get(p_item)
    if not it or it["trip_id"] != p_trip:
        raise RpcError("항목을 찾을 수 없습니다")
    cur = next((e for e in db["expenses"].values() if e.get("item_id") == p_item), None)
    if not p_amount or float(p_amount) <= 0:
        if cur:
            del db["expenses"][cur["id"]]
        return None
    if cur is None:
        eid = str(uuid.uuid4())
        cur = db["expenses"][eid] = {"id": eid, "trip_id": p_trip, "item_id": p_item, "by_name": p_by, "created_at": now(), "category": p_category or "etc"}
    cur.update(title=it["name"][:100], amount=round(float(p_amount)), day_date=it["day_date"], category=p_category or cur["category"])
    return cur["id"]


def delete_expense(p_trip, p_exp):
    e = db["expenses"].get(p_exp)
    if e and e["trip_id"] == p_trip:
        del db["expenses"][p_exp]


def set_day(p_trip, p_date, p_patch):
    trip(p_trip)
    day = d(p_date)
    if not day:
        raise RpcError("날짜가 필요합니다")
    key = f"{p_trip}:{day}"
    row = db["days"].setdefault(key, {"trip_id": p_trip, "day_date": day, "title": None, "diary": None})
    for k in ("title", "diary"):
        if k in p_patch:
            row[k] = p_patch[k]
    row["updated_at"] = now()


def request_job(p_trip, p_type, p_params=None):
    t = trip(p_trip)
    if p_type not in ("plan", "recommend", "blog", "youtube"):
        raise RpcError("알 수 없는 작업입니다")
    if t["status"] not in ("done", "error"):
        raise RpcError("이미 AI가 작업 중입니다. 끝난 뒤 다시 요청해 주세요")
    t.update(status="queued", job={"type": p_type, "params": p_params or {}}, error=None, progress=None,
             requested_at=time.time(), updated_at=now())


def cancel_job(p_trip):
    t = db["trips"].get(p_trip)
    if not t or t["status"] not in ("queued", "generating"):
        raise RpcError("진행 중인 AI 작업이 없습니다")
    t.update(status="done", job=None, progress=None, error=None, updated_at=now())


def trip_status(p_trip):
    t = db["trips"].get(p_trip)
    return t["status"] if t else None


def reset_stuck(p_owner_key):
    owner(p_owner_key)
    n = 0
    for t in db["trips"].values():
        if t["status"] == "generating":
            t.update(status="queued", progress=None)
            n += 1
    for i in db["items"].values():
        if i.get("enrich") == "working":
            i["enrich"] = "pending"
    return n


def request_enrich(p_trip, p_item=None):
    trip(p_trip)
    n = 0
    for i in of_trip("items", p_trip):
        if i["category"] not in SPOTS or i.get("enrich") == "working":
            continue
        ok = i["id"] == p_item if p_item else (i.get("enrich") != "pending" and (not i.get("details") or i.get("enrich") == "error"))
        if ok:
            i.update(enrich="pending", enrich_error=None, updated_at=now())
            n += 1
    return n


def claim_enrich(p_owner_key, p_limit=4):
    owner(p_owner_key)
    rows = sorted((i for i in db["items"].values() if i.get("enrich") == "pending"), key=lambda i: i["updated_at"])[:max(1, min(p_limit or 4, 10))]
    out = []
    for i in rows:
        i.update(enrich="working", enrich_error=None)
        t = db["trips"][i["trip_id"]]
        out.append({**{k: i[k] for k in ("id", "trip_id", "category", "name", "area", "note", "price", "search_query", "origin", "links", "photos")},
                    "destination": t.get("destination"), "destination_en": (t.get("summary") or {}).get("destination_en"),
                    "model": (t.get("input") or {}).get("model")})
    return out


def finish_enrich(p_owner_key, p_item, p_details, p_photos, p_error=None):
    owner(p_owner_key)
    i = db["items"].get(p_item)
    if not i or i.get("enrich") != "working":
        return False
    if p_error is not None:
        i.update(enrich="error", enrich_error=p_error[:500], updated_at=now())
        return True
    p_details = p_details or {}
    i.update(details=p_details, photos=p_photos or [], enrich="done", enrich_error=None, updated_at=now(),
             area=i.get("area") or (p_details.get("area") or "")[:100] or None,
             lat=i.get("lat") if i.get("lat") is not None else p_details.get("lat"),
             lng=i.get("lng") if i.get("lng") is not None else p_details.get("lng"),
             price=i.get("price") or (p_details.get("price_range") or "")[:100] or None)
    return True


def claim_job(p_owner_key):
    owner(p_owner_key)
    queued = sorted((t for t in db["trips"].values() if t["status"] == "queued"), key=lambda t: t["requested_at"])
    if not queued:
        return None
    t = queued[0]
    t.update(status="generating", progress=None, updated_at=now())
    return {"id": t["id"], "job": t["job"] or {"type": "plan", "params": {}}}


def set_progress(p_owner_key, p_trip, p_text):
    owner(p_owner_key)
    t = db["trips"].get(p_trip)
    if t and t["status"] == "generating":
        t["progress"] = p_text[:300]


def complete_job(p_owner_key, p_trip, p_result):
    owner(p_owner_key)
    t = db["trips"].get(p_trip)
    if not t or t["status"] != "generating":
        return False
    for ord_, x in enumerate(p_result.get("items") or []):
        if x.get("category") not in CATS or not (x.get("name") or "").strip():
            continue
        iid = str(uuid.uuid4())
        db["items"][iid] = {
            "id": iid, "trip_id": p_trip, "category": x["category"], "name": x["name"][:200], "area": x.get("area"),
            "day_date": d(x.get("day_date")), "time": x.get("time"), "note": x.get("note"), "price": x.get("price"),
            "reservation_needed": bool(x.get("reservation_needed")), "search_query": x.get("search_query"),
            "source_url": x.get("source_url"), "verified": bool(x.get("verified")), "origin": "ai",
            "done": False, "done_at": None, "done_by": None, "sort": time.time() + ord_, "created_by": "AI",
            "created_at": now(), "updated_at": now(), "thumb_path": None, **enrich_fields(),
            "enrich": "pending" if x["category"] in SPOTS else None,
        }
    for x in p_result.get("days") or []:
        if x.get("date"):
            key = f"{p_trip}:{d(x['date'])}"
            row = db["days"].setdefault(key, {"trip_id": p_trip, "day_date": d(x["date"]), "title": None, "diary": None})
            row["title"] = row["title"] or x.get("title")
    t["summary"] = {**t["summary"], **(p_result.get("summary") or {})}
    if p_result.get("blog") is not None:
        t["blog"] = p_result["blog"]
    t.update(status="done", job=None, error=None, progress=None, updated_at=now())
    return True


def fail_job(p_owner_key, p_trip, p_error):
    owner(p_owner_key)
    t = db["trips"].get(p_trip)
    if not t or t["status"] != "generating":
        return False
    t.update(status="error", error=p_error[:2000], progress=None, updated_at=now())
    return True


def export_all(p_owner_key):
    owner(p_owner_key)
    return [{**get_trip(tid), "legacy_plan": t["plan"]} for tid, t in db["trips"].items()]


def legacy_plans(p_owner_key):
    owner(p_owner_key)
    return [{"id": t["id"], "title": t["title"], "start_date": t["start_date"], "end_date": t["end_date"], "plan": t["plan"]}
            for t in db["trips"].values() if t["plan"] and not of_trip("items", t["id"])]


def migrate_trip(p_owner_key, p_trip, p_result):
    owner(p_owner_key)
    db["trips"][p_trip]["status"] = "generating"
    complete_job(p_owner_key, p_trip, p_result)
    db["trips"][p_trip]["plan"] = None


def _dev_add_legacy(p_owner_key, p_title, p_start, p_end, p_plan):
    """테스트 전용: v1 plan을 가진 여행 만들기."""
    tid = create_trip(p_owner_key, {"title": p_title, "start_date": p_start, "end_date": p_end}, False)
    db["trips"][tid]["plan"] = p_plan
    return tid


RPCS = {f.__name__: f for f in (
    init_owner, list_trips, create_trip, delete_trip, get_trip, update_trip, upsert_item, delete_item, set_done,
    add_media, update_media, delete_media, upsert_expense, delete_expense, set_day, request_job, cancel_job,
    trip_status, reset_stuck, claim_job, set_progress, complete_job, fail_job, export_all, legacy_plans,
    migrate_trip, _dev_add_legacy, request_enrich, claim_enrich, finish_enrich, set_item_cost,
    add_voucher, update_voucher, delete_voucher, claim_voucher, finish_voucher)}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode())

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_OPTIONS(self):
        self._send(204)

    def do_POST(self):
        if self.path.startswith("/rest/v1/rpc/"):
            fn = RPCS.get(self.path.rsplit("/", 1)[1])
            if not fn:
                return self._json(404, {"message": "Could not find the function"})
            params = json.loads(self._body() or b"{}")
            try:
                with lock:
                    result = fn(**params)
            except RpcError as e:
                return self._json(400, {"message": str(e)})
            except TypeError as e:
                return self._json(400, {"message": f"bad params: {e}"})
            return self._json(200, result)
        if self.path.startswith("/storage/v1/object/photos/"):
            path = self.path.split("/storage/v1/object/photos/", 1)[1]
            if path.split("/")[0] not in db["trips"]:
                return self._json(403, {"message": "new row violates row-level security policy"})
            ctype = self.headers.get("Content-Type", "")
            if ctype not in MIMES:
                return self._json(400, {"message": "mime type not supported"})
            files[path] = (ctype, self._body())
            return self._json(200, {"Key": f"photos/{path}"})
        self._json(404, {"message": "not found"})

    def do_GET(self):
        prefix = "/storage/v1/object/public/photos/"
        if self.path.startswith(prefix):
            item = files.get(self.path[len(prefix):])
            return self._send(200, item[1], item[0]) if item else self._json(404, {"message": "not found"})
        self._json(404, {"message": "not found"})

    def do_DELETE(self):
        if self.path == "/storage/v1/object/photos":
            for p in json.loads(self._body() or b"{}").get("prefixes", []):
                files.pop(p, None)
            return self._json(200, [])
        self._json(404, {"message": "not found"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"mock supabase v2: http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
