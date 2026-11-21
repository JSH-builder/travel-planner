"""개발·테스트용 가짜 Supabase 서버.

supabase/schema.sql의 함수들과 사진 저장소를 메모리로 흉내 낸다.
실제 Supabase 없이 화면과 작업기를 내 PC에서 시험할 때 사용.

  python tools/mock_supabase.py            # http://127.0.0.1:54321
  → docs/config.js 의 url을 http://127.0.0.1:54321 로, key는 아무 값(예: "dev")
"""

import hashlib
import json
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 54321

lock = Lock()
db = {"owner_hash": None, "trips": {}, "checks": {}, "actuals": {}, "entries": []}
photos: dict[str, tuple[str, bytes]] = {}


class RpcError(Exception):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha(s: str) -> str:
    return hashlib.sha256((s or "").encode()).hexdigest()


def require_owner(k):
    if not db["owner_hash"] or sha(k) != db["owner_hash"]:
        raise RpcError("소유자 키가 올바르지 않습니다")


def require_trip(tid):
    if tid not in db["trips"]:
        raise RpcError("여행을 찾을 수 없습니다")


# ---------- RPC (schema.sql과 같은 동작) ----------
def init_owner(p_key):
    if len(p_key or "") < 24:
        raise RpcError("소유자 키가 너무 짧습니다")
    if db["owner_hash"]:
        return sha(p_key) == db["owner_hash"]
    db["owner_hash"] = sha(p_key)
    return True


def list_trips(p_owner_key):
    require_owner(p_owner_key)
    trips = sorted(db["trips"].values(), key=lambda t: t["input"].get("start_date") or "", reverse=True)
    return [{**{k: t[k] for k in ("id", "title", "input", "status", "error", "created_at")}, "has_plan": t["plan"] is not None}
            for t in trips]


def _clean_budget(b):
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
    out = {"total": round(total) if total is not None else None, "currency": (b.get("currency") or "").strip().upper()[:10] or None,
           "rate": rate}
    return {k: v for k, v in out.items() if v is not None}


def _new_trip(inp, status, plan=None):
    tid = str(uuid.uuid4())
    inp = dict(inp)
    budget = _clean_budget(inp.pop("budget_settings", None))
    db["trips"][tid] = {
        "id": tid, "title": (inp.get("title") or "새 여행")[:200], "input": inp, "status": status,
        "error": None, "plan": plan, "revision_note": None, "requested_at": now(), "created_at": now(), "updated_at": now(),
        "budget": budget, "bookings": (inp.get("bookings") or None), "progress": None,
    }
    return tid


def create_trip(p_owner_key, p_input):
    require_owner(p_owner_key)
    return _new_trip(p_input, "queued")


def import_trip(p_owner_key, p_input, p_plan):
    require_owner(p_owner_key)
    return _new_trip(p_input, "done", p_plan)


def delete_trip(p_owner_key, p_trip):
    require_owner(p_owner_key)
    db["trips"].pop(p_trip, None)
    db["entries"] = [e for e in db["entries"] if e["trip_id"] != p_trip]
    for store in (db["checks"], db["actuals"]):
        for k in [k for k in store if k[0] == p_trip]:
            del store[k]


def get_trip(p_trip):
    t = db["trips"].get(p_trip)
    if not t:
        return None
    return {
        "trip": {k: t[k] for k in ("id", "title", "input", "status", "error", "plan", "revision_note", "updated_at",
                                   "budget", "bookings", "progress")},
        "checks": {k[1]: v for k, v in db["checks"].items() if k[0] == p_trip},
        "actuals": {k[1]: v for k, v in db["actuals"].items() if k[0] == p_trip},
        "entries": [{k: e[k] for k in ("id", "section", "body", "photo_path", "by_name", "created_at")}
                    for e in db["entries"] if e["trip_id"] == p_trip],
    }


def set_check(p_trip, p_key, p_value, p_by=None):
    require_trip(p_trip)
    db["checks"][(p_trip, p_key)] = p_value


def set_actual(p_trip, p_item, p_value, p_by=None):
    require_trip(p_trip)
    if p_value is None:
        db["actuals"].pop((p_trip, p_item), None)
    else:
        db["actuals"][(p_trip, p_item)] = int(p_value)


def add_entry(p_trip, p_section, p_body, p_photo_path=None, p_by=None):
    require_trip(p_trip)
    if not p_body and not p_photo_path:
        raise RpcError("내용이나 사진을 넣어 주세요")
    if p_photo_path and not p_photo_path.startswith(p_trip + "/"):
        raise RpcError("잘못된 사진 경로")
    eid = str(uuid.uuid4())
    db["entries"].append({"id": eid, "trip_id": p_trip, "section": p_section, "body": p_body or None,
                          "photo_path": p_photo_path, "by_name": (p_by or "")[:40] or None, "created_at": now()})
    return eid


def delete_entry(p_trip, p_entry):
    for e in db["entries"]:
        if e["id"] == p_entry and e["trip_id"] == p_trip:
            db["entries"].remove(e)
            return e["photo_path"]
    return None


def request_revision(p_trip, p_note=None):
    require_trip(p_trip)
    t = db["trips"][p_trip]
    if t["status"] not in ("done", "error"):
        raise RpcError("이미 AI가 작업 중입니다")
    t.update(status="queued", revision_note=p_note or None, error=None, progress=None, requested_at=now(), updated_at=now())


def cancel_job(p_trip):
    t = db["trips"].get(p_trip)
    if not t or t["status"] not in ("queued", "generating"):
        raise RpcError("진행 중인 AI 작업이 없습니다")
    has_plan = t["plan"] is not None
    t.update(status="done" if has_plan else "error",
             error=None if has_plan else "취소했습니다. 다시 시도를 누르면 새로 만들어요.",
             revision_note=None, progress=None, updated_at=now())


def set_bookings(p_trip, p_text):
    require_trip(p_trip)
    db["trips"][p_trip].update(bookings=p_text or None, updated_at=now())


def set_budget(p_trip, p_budget):
    require_trip(p_trip)
    db["trips"][p_trip].update(budget=_clean_budget(p_budget), updated_at=now())


def trip_status(p_trip):
    t = db["trips"].get(p_trip)
    return t["status"] if t else None


def reset_stuck(p_owner_key):
    require_owner(p_owner_key)
    n = 0
    for t in db["trips"].values():
        if t["status"] == "generating":
            t.update(status="queued", progress=None, updated_at=now())
            n += 1
    return n


def claim_job(p_owner_key):
    require_owner(p_owner_key)
    queued = sorted((t for t in db["trips"].values() if t["status"] == "queued"), key=lambda t: t["requested_at"])
    if not queued:
        return None
    t = queued[0]
    t.update(status="generating", progress=None, updated_at=now())
    return {k: t[k] for k in ("id", "input", "plan", "revision_note", "budget", "bookings")}


def set_progress(p_owner_key, p_trip, p_text):
    require_owner(p_owner_key)
    t = db["trips"].get(p_trip)
    if t and t["status"] == "generating":
        t["progress"] = p_text[:300]


def complete_job(p_owner_key, p_trip, p_plan):
    require_owner(p_owner_key)
    t = db["trips"].get(p_trip)
    if not t or t["status"] != "generating":
        return False
    t.update(status="done", plan=p_plan, error=None, revision_note=None, progress=None, updated_at=now())
    return True


def fail_job(p_owner_key, p_trip, p_error):
    require_owner(p_owner_key)
    t = db["trips"].get(p_trip)
    if not t or t["status"] != "generating":
        return False
    t.update(status="error", error=p_error[:2000], progress=None, updated_at=now())
    return True


def export_all(p_owner_key):
    require_owner(p_owner_key)
    return [get_trip(tid) for tid in db["trips"]]


RPCS = {f.__name__: f for f in (
    init_owner, list_trips, create_trip, import_trip, delete_trip, get_trip, set_check, set_actual,
    add_entry, delete_entry, request_revision, cancel_job, set_bookings, set_budget, trip_status,
    reset_stuck, claim_job, set_progress, complete_job, fail_job, export_all)}


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

    def _body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_OPTIONS(self):
        self._send(204)

    def do_POST(self):
        if self.path.startswith("/rest/v1/rpc/"):
            fn = RPCS.get(self.path.rsplit("/", 1)[1])
            if not fn:
                return self._json(404, {"message": "unknown function"})
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
            if ctype not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
                return self._json(400, {"message": "mime type not supported"})
            photos[path] = (ctype, self._body())
            return self._json(200, {"Key": f"photos/{path}"})
        self._json(404, {"message": "not found"})

    def do_GET(self):
        prefix = "/storage/v1/object/public/photos/"
        if self.path.startswith(prefix):
            item = photos.get(self.path[len(prefix):])
            return self._send(200, item[1], item[0]) if item else self._json(404, {"message": "not found"})
        self._json(404, {"message": "not found"})

    def do_DELETE(self):
        if self.path == "/storage/v1/object/photos":
            for p in json.loads(self._body() or b"{}").get("prefixes", []):
                photos.pop(p, None)
            return self._json(200, [])
        self._json(404, {"message": "not found"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"mock supabase: http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
