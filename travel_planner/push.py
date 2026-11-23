"""일정 알림 (웹 푸시).

휴대폰이 앱에서 '일정 알림'을 켜면 구독 정보가 Supabase(push_subs)에 저장된다.
작업기는 30초마다 일정을 보고, 알릴 시간이 된 것만 푸시로 보낸다 (무료: 브라우저 푸시 서버 사용).

- 일정 시각은 휴대폰 시간대로 해석 (앱을 열 때마다 시간대를 갱신 → 홍콩에 가면 홍콩 시간)
- 같은 알림은 한 번만 (data/push_sent.json). 시간을 바꾸면 새 알림으로 다시 계산
- 노트북이 잠깐 꺼졌다 켜져도 일정이 아직 시작 전이면 보냄, 이미 지난 일정은 건너뜀
- 알림 키(VAPID_PRIVATE_KEY)는 .env에만 있다
"""
from __future__ import annotations

import base64
import json
import re
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .cloud import Cloud, CloudError

STATE_PATH = Path(__file__).resolve().parents[1] / "data" / "push_sent.json"
SITE = "https://jsh-builder.github.io/travel-planner"
EVERY_SEC = 30
WEEK = "월화수목금토일"

FLIGHT = re.compile(r"\b[A-Z0-9]{2}\d{3,4}\b|탑승|비행기")
FERRY = re.compile(r"페리|ferry|터보젯|워터젯", re.I)
SHOW = re.compile(r"공연|쇼(?!핑)|\bshow\b|뮤지컬|콘서트|댄싱\s*워터", re.I)
ASIDE = re.compile(r"이동|수속|퇴장|대기|착석|입장\s*및|터미널|선착장|목표|준비|복귀|휴식")
HUB = re.compile(r"공항|페리|터미널|선착장")  # 준비 일정 중 놓치면 안 되는 것 (공항 이동, 페리 수속 등)
SPOTS = {"photo", "food", "cafe", "place", "landmark", "activity", "bar"}


def _minutes(t: str | None) -> int | None:
    m = re.match(r"^\s*(\d{1,2}):(\d{2})", t or "")
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def _short(name: str) -> str:
    return re.sub(r"\s*[(（].*$", "", name or "").strip()


def _ago(lead: int) -> str:
    if lead <= 0:
        return "지금"
    h, m = divmod(lead, 60)
    return f"{h}시간 {m}분 뒤" if h and m else f"{h}시간 뒤" if h else f"{m}분 뒤"


def lead_of(item: dict, earlier: list[dict]) -> int | None:
    """몇 분 전에 알릴지. None이면 알리지 않음."""
    name, note = item.get("name") or "", item.get("note") or ""
    if item.get("category") in SPOTS:
        return 30 if item.get("reservation_needed") else 15
    if item.get("category") != "schedule":
        return None
    if re.search(r"도착|arrival|입국|퇴장", name, re.I):
        return None
    if ASIDE.search(name):
        return 0 if HUB.search(name) else None  # 공항 이동·페리 수속은 그 시각에 '지금' 알림
    if FLIGHT.search(name):
        # 이미 공항에 가는 중이면(앞서 공항 일정이 있으면) 30분 전, 아니면 3시간 전
        at_airport = any(re.search(r"airport|공항", f"{e.get('place') or ''} {e.get('name') or ''}", re.I) for e in earlier)
        return 30 if at_airport else 180
    if FERRY.search(name) or SHOW.search(name):
        return 60
    return 30


def _body(item: dict, lead: int) -> str:
    name = item.get("name") or ""
    first = (item.get("note") or "").split("\n")[0].strip()
    extra = []
    main = not ASIDE.search(name)
    if main and (FLIGHT.search(name) or (FERRY.search(name) and "스타페리" not in name and "star ferry" not in name.lower())):
        extra.append("여권·티켓 챙기기")  # 국경을 넘는 비행기·페리만 (스타페리 제외)
    if main and SHOW.search(name):
        extra.append("바우처·회차 확인")
    text = " · ".join(x for x in [first[:80]] + extra if x)
    return f"{item.get('time')} {_short(name)}" + (f"\n{text}" if text else "")


def due(trip: dict, items: list[dict], todos: list[dict], tz: ZoneInfo, now: datetime) -> list[tuple[str, dict]]:
    """지금 보낼 알림 [(중복 방지 키, 내용)]."""
    out = []
    tid = trip["id"]
    url = f"{SITE}/#/trip/{tid}/schedule"
    timed = sorted([i for i in items if i.get("day_date") and _minutes(i.get("time")) is not None and not i.get("done")
                    and (i.get("category") == "schedule" or i.get("category") in SPOTS)],
                   key=lambda i: (i["day_date"], _minutes(i["time"])))
    for k, i in enumerate(timed):
        earlier = [e for e in timed[:k] if e["day_date"] == i["day_date"]]
        lead = lead_of(i, earlier)
        if lead is None:
            continue
        d = date.fromisoformat(i["day_date"])
        start = datetime(d.year, d.month, d.day, tzinfo=tz) + timedelta(minutes=_minutes(i["time"]))
        fire = start - timedelta(minutes=lead)
        if fire <= now < start + timedelta(minutes=1 if lead == 0 else 0) and now - fire < timedelta(hours=3):
            key = f"{i['id']}|{i['day_date']}|{i['time']}|{lead}"
            left = 0 if lead == 0 else max(1, round((start - now).total_seconds() / 60))  # 실제 남은 시간
            out.append((key, {"title": f"{_ago(left)} · {_short(i['name'])}", "body": _body(i, lead),
                              "url": url, "tag": f"item-{i['id']}"}))

    # 전날 밤 21시: 내일 일정 요약 + 아직 안 한 할 일
    days = sorted({i["day_date"] for i in timed})
    for ds in days:
        d = date.fromisoformat(ds)
        fire = datetime(d.year, d.month, d.day, tzinfo=tz) - timedelta(hours=3)  # 전날 21:00
        if not (fire <= now < fire + timedelta(hours=3)):
            continue
        day_items = [i for i in timed if i["day_date"] == ds]
        first = next((i for i in day_items if not ASIDE.search(i.get("name") or "") or HUB.search(i.get("name") or "")), day_items[0])
        md = f"{d.month}/{d.day}"
        left = [t["name"] for t in todos if not t.get("done") and f"({md}" in (t.get("name") or "")]
        body = f"첫 일정 {first['time']} {_short(first['name'])} · 일정 {len(day_items)}개"
        if left:
            body += "\n할 일: " + " / ".join(re.sub(r"\s*\(\d+/\d+.*?\)", "", n)[:40] for n in left[:3])
        out.append((f"eve|{ds}", {"title": f"내일 {md} ({WEEK[d.weekday()]}) 일정", "body": body, "url": url, "tag": f"eve-{ds}"}))
    return out


class Pusher:
    def __init__(self, cloud: Cloud, private_key: str, log):
        self.cloud, self.key, self.log = cloud, private_key, log
        self.sent = self._load()

    def _load(self) -> dict:
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _save(self) -> None:
        cutoff = time.time() - 4 * 86400
        self.sent = {k: v for k, v in self.sent.items() if v > cutoff}
        STATE_PATH.parent.mkdir(exist_ok=True)
        STATE_PATH.write_text(json.dumps(self.sent), encoding="utf-8")

    def send(self, sub: dict, payload: dict) -> bool:
        from pywebpush import WebPushException, webpush
        try:
            webpush(
                subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                data=json.dumps(payload, ensure_ascii=False),
                vapid_private_key=self.key,
                vapid_claims={"sub": "https://jsh-builder.github.io"},  # 연락처: 앱 주소 (개인 이메일은 넣지 않음)
                ttl=3600,
                timeout=15,
            )
            return True
        except WebPushException as e:
            code = getattr(e.response, "status_code", None)
            if code in (404, 410):  # 휴대폰에서 알림을 끄거나 앱을 지움 → 구독 정리
                self.cloud.owner_rpc("drop_push_sub", p_endpoint=sub["endpoint"])
                self.log("🔕 만료된 알림 구독을 정리했어요")
            else:
                self.log(f"⚠️ 알림 보내기 실패 ({code}): {str(e)[:120]}")
            return False

    def run_once(self) -> int:
        subs = self.cloud.owner_rpc("list_push_subs") or []
        if not subs:
            return 0
        trips: dict[str, dict] = {}
        n = 0
        changed = False
        for sub in subs:
            tid = sub["trip_id"]
            if tid not in trips:
                trips[tid] = self.cloud.rpc("get_trip", p_trip=tid) or {}
            data = trips[tid]
            if not data.get("trip"):
                continue
            try:
                tz = ZoneInfo(sub.get("tz") or "Asia/Seoul")
            except Exception:
                tz = ZoneInfo("Asia/Seoul")
            now = datetime.now(tz)
            ep = sub["endpoint"]
            hello = f"{ep}|hello"
            jobs = [] if hello in self.sent else [(None, {"title": "🔔 일정 알림이 켜졌어요",
                                                          "body": f"{data['trip'].get('title') or '여행'} 일정 시간에 맞춰 알려 드릴게요",
                                                          "url": f"{SITE}/#/trip/{tid}/schedule", "tag": "hello"})]
            todos = [i for i in data.get("items", []) if i.get("category") == "todo"]
            jobs += due(data["trip"], data.get("items", []), todos, tz, now)
            for key, payload in jobs:
                k = hello if key is None else f"{ep}|{key}"
                if k in self.sent:
                    continue
                if self.send(sub, payload):
                    n += 1
                    self.log(f"🔔 알림: {payload['title']}")
                self.sent[k] = time.time()  # 실패해도 같은 알림을 계속 보내지 않게
                changed = True
        if changed:
            self._save()
        return n


def vapid_public_key(private_key: str) -> str:
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid
    v = Vapid.from_raw(private_key.encode())
    raw = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def start(cloud: Cloud, private_key: str, log) -> None:
    """작업기와 따로 도는 스레드: 일정 알림 + 1분마다 '작업기 살아 있음' 신호 (AI 작업이 몇 분 걸려도 밀리지 않게)."""
    pusher = Pusher(cloud, private_key, log) if private_key else None
    if pusher:
        log("🔔 일정 알림: 켜짐 — 앱에서 알림을 켠 휴대폰으로 일정 시간에 맞춰 보내요")
    else:
        log("🔕 일정 알림: 꺼짐 (.env에 VAPID_PRIVATE_KEY 없음)")

    def loop():
        last = ""
        last_ping = 0.0
        while True:
            msg = ""
            try:
                if time.monotonic() - last_ping > 60:
                    try:
                        cloud.owner_rpc("worker_ping")  # 휴대폰 앱의 '작업기 상태' 표시용
                    except CloudError:
                        pass
                    last_ping = time.monotonic()
                if pusher:
                    pusher.run_once()
            except CloudError as e:
                msg = f"⚠️ 알림 확인 실패: {e}"
                if "push_subs" in str(e) and ("404" in str(e) or "Could not find" in str(e)):
                    msg = "⚠️ 일정 알림: DB에 알림 기능이 아직 없어요 (supabase/patch_push.sql을 SQL Editor에서 실행)"
            except Exception as e:  # 알림 문제로 작업기가 멈추지 않게
                msg = f"⚠️ 알림 오류: {str(e)[:150]}"
            if msg and msg != last:  # 같은 오류는 한 번만
                log(msg)
            last = msg
            time.sleep(EVERY_SEC)

    threading.Thread(target=loop, name="push", daemon=True).start()
