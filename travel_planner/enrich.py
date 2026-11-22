"""스팟 사진·정보 모으기 (소유자 PC의 작업기에서 실행).

- AI 추천 스팟: 웹 이미지 검색(네이버 블로그·트리플·여행 사이트·SNS 등에 올라온 사진)으로 사진 여러 장 +
  Claude 웹 조사로 메뉴·가격·운영시간·비용·주의사항 정리
- 직접 찾은 스팟: 넣은 링크(여러 개)를 열어 사진을 뽑고, 본문을 Claude가 읽어 같은 형식으로 정리
- 사진은 내려받아 줄인 뒤 Supabase 저장소에 올린다 (원본 사이트 주소는 출처로 함께 저장)

개인 여행 계획용(비상업)으로만 쓰는 기능이다. 로그인이 필요한 페이지는 공개된 미리보기(대표 이미지·설명)까지만 읽는다.
"""

from __future__ import annotations

import io
import re
import time
import uuid
from datetime import datetime
from html.parser import HTMLParser
from typing import Callable
from urllib.parse import parse_qs, urljoin, urlparse

import requests

from .cloud import Cloud, CloudError
from .models import EnrichResult
from .planner import Cancelled, _head, _yaml, run_claude

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/131.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"}
PHOTOS_PER_SPOT = 8
PAGE_TEXT_LIMIT = 3500
BATCH = 3  # Claude 한 번에 정리할 스팟 수
SITE_NAMES = {
    "blog.naver.com": "네이버 블로그", "m.blog.naver.com": "네이버 블로그", "pstatic.net": "네이버",
    "map.naver.com": "네이버 지도", "place.naver.com": "네이버 플레이스", "naver.me": "네이버",
    "instagram.com": "인스타그램", "facebook.com": "페이스북", "tiktok.com": "틱톡", "youtube.com": "유튜브",
    "triple.guide": "트리플", "trip.com": "트립닷컴", "yanolja.com": "야놀자", "tripadvisor": "트립어드바이저",
    "google.": "구글", "goo.gl": "구글 지도", "tistory.com": "티스토리", "brunch.co.kr": "브런치",
    "klook.com": "클룩", "kkday.com": "KKday", "myrealtrip.com": "마이리얼트립", "agoda.com": "아고다",
    "tabelog.com": "타베로그", "openrice.com": "OpenRice", "wikipedia.org": "위키백과", "wikimedia.org": "위키미디어",
}
BAD_IMG = re.compile(r"(blogpfthumb|sprite|icon|logo|emoji|emoticon|sticker|blank|spacer|avatar|profile|favicon|banner|btn_|button|"
                     r"loading|placeholder|1x1|pixel|badge|static/www|\.svg|\.gif)", re.I)


def _log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def site_name(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    for k, v in SITE_NAMES.items():
        if k in host:
            return v
    return host.removeprefix("www.").removeprefix("m.")


# ---------- 링크 읽기 ----------
def normalize(url: str) -> str:
    """본문이 iframe 안에 있는 사이트는 바로 읽을 수 있는 주소로 바꾼다."""
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if host in ("blog.naver.com", "www.blog.naver.com"):
        q = parse_qs(u.query)
        if "blogId" in q and "logNo" in q:
            return f"https://m.blog.naver.com/{q['blogId'][0]}/{q['logNo'][0]}"
        parts = [p for p in u.path.split("/") if p]
        if len(parts) >= 2 and parts[1].isdigit():
            return f"https://m.blog.naver.com/{parts[0]}/{parts[1]}"
    return url


class _Page(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "header", "footer", "nav", "form", "button"}

    def __init__(self, base: str):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.meta: dict[str, str] = {}
        self.title = ""
        self.images: list[str] = []
        self.text: list[str] = []
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"]
        elif tag in ("img", "source"):
            for k in ("data-lazy-src", "data-src", "data-original", "data-url", "src"):
                v = a.get(k)
                if v and not v.startswith("data:"):
                    self.images.append(urljoin(self.base, v.strip()))
                    break
            else:
                srcset = a.get("srcset") or a.get("data-srcset")
                if srcset:
                    self.images.append(urljoin(self.base, srcset.split(",")[-1].strip().split(" ")[0]))

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            t = data.strip()
            if len(t) > 1:
                self.text.append(t)


def _fix_img(url: str) -> str:
    """네이버 사진은 큰 크기로 (type=w80_blur → w966)."""
    if "pstatic.net" in url:
        url = re.sub(r"([?&])type=[^&]*", r"\1type=w966", url)
    return url


def read_page(url: str) -> dict:
    """{url, site, title, description, text, images[]}. 실패하면 error 키."""
    target = normalize(url)
    try:
        r = requests.get(target, headers=HEADERS, timeout=20, allow_redirects=True)
        r.raise_for_status()
    except requests.RequestException as e:
        return {"url": url, "site": site_name(url), "error": f"열 수 없음 ({e.__class__.__name__})", "images": [], "text": ""}
    if "html" not in r.headers.get("content-type", "html"):
        return {"url": url, "site": site_name(url), "error": "웹페이지가 아님", "images": [], "text": ""}
    r.encoding = r.apparent_encoding if not r.encoding or r.encoding.lower() == "iso-8859-1" else r.encoding
    p = _Page(r.url)
    try:
        p.feed(r.text)
    except Exception:  # 깨진 HTML도 읽은 데까지는 쓴다
        pass
    m = p.meta
    og = [m.get(k) for k in ("og:image", "og:image:url", "twitter:image", "twitter:image:src") if m.get(k)]
    images, seen = [], set()
    for src in [urljoin(r.url, x) for x in og] + p.images:
        src = _fix_img(src)
        if src.startswith("http") and src not in seen and not BAD_IMG.search(src):
            seen.add(src)
            images.append(src)
    text = re.sub(r"\s+", " ", " ".join(p.text))
    desc = m.get("og:description") or m.get("description") or m.get("twitter:description") or ""
    return {
        "url": url, "final_url": r.url, "site": site_name(r.url),
        "title": (m.get("og:title") or p.title).strip()[:200], "description": desc.strip()[:600],
        "text": text[:PAGE_TEXT_LIMIT], "images": images[:40],
    }


# ---------- 이미지 검색 ----------
def search_images(query: str, limit: int = 12) -> list[dict]:
    """웹 이미지 검색 (DuckDuckGo, 키 불필요). [{image, page, site}]"""
    try:
        from ddgs import DDGS
    except ImportError:
        _log("   ⚠️ 사진 검색 도구(ddgs)가 없어요 — pip install -r requirements.txt")
        return []
    for attempt in range(2):
        try:
            res = DDGS().images(query, region="kr-kr", safesearch="moderate", max_results=limit * 2)
            break
        except Exception as e:  # 검색 서버가 잠깐 막으면 한 번 더
            if attempt:
                _log(f"   ✗ 사진 검색 실패: {query} ({e.__class__.__name__})")
                return []
            time.sleep(3)
    out = []
    for x in res:
        w, h = int(x.get("width") or 0), int(x.get("height") or 0)
        if (w and w < 400) or (h and h < 300) or BAD_IMG.search(x.get("image", "")):
            continue
        out.append({"image": x["image"], "page": x.get("url") or "", "site": site_name(x.get("url") or x["image"])})
    return out[:limit]


# ---------- 좌표 (일정 짜기의 이동 시간 계산용) ----------
_last_geo = [0.0]


def geocode(queries: list[str]) -> tuple[float, float] | None:
    """OpenStreetMap Nominatim(무료)으로 좌표 찾기. 이용 규칙: 1초에 1번, 앱 이름 표시."""
    for q in [x for x in dict.fromkeys(queries) if x and x.strip()]:
        wait = 1.1 - (time.monotonic() - _last_geo[0])
        if wait > 0:
            time.sleep(wait)
        _last_geo[0] = time.monotonic()
        try:
            r = requests.get("https://nominatim.openstreetmap.org/search",
                             params={"q": q, "format": "json", "limit": 1, "accept-language": "ko"},
                             headers={"User-Agent": "travel-planner-personal/1.0"}, timeout=15)
            hit = r.json()
        except Exception:
            continue
        if hit:
            return float(hit[0]["lat"]), float(hit[0]["lon"])
    return None


def ko_wiki_coords(q: str) -> tuple[float, float] | None:
    """한국어 위키백과 좌표 (한국어 이름이 OpenStreetMap에서 안 찾아질 때)."""
    try:
        r = requests.get("https://ko.wikipedia.org/w/api.php", params={
            "action": "query", "generator": "search", "gsrsearch": q, "gsrlimit": 1, "prop": "coordinates", "format": "json"},
            headers={"User-Agent": "travel-planner-personal/1.0"}, timeout=15).json()
        page = next(iter((r.get("query") or {}).get("pages", {}).values()), {})
        c = (page.get("coordinates") or [None])[0]
        return (c["lat"], c["lon"]) if c else None
    except Exception:
        return None


def _km(a, b) -> float:
    from math import asin, cos, radians, sin, sqrt
    x = sin(radians(b[0] - a[0]) / 2) ** 2 + cos(radians(a[0])) * cos(radians(b[0])) * sin(radians(b[1] - a[1]) / 2) ** 2
    return 2 * 6371 * asin(sqrt(x))


_centers: dict[str, tuple | None] = {}


def spot_coords(it: dict, address: str = "") -> tuple[float, float] | None:
    """영문 검색어·주소 먼저(OpenStreetMap이 잘 찾음) → 한국어 이름 → 위키백과. 여행지에서 300km 넘게 먼 결과는 버림."""
    city = _city(it)
    city_en = it.get("destination_en") or ""
    plain = re.sub(r"[(（].*?[)）]", "", it["name"]).strip()
    en = (re.search(r"\(([^)]+)\)", it["name"]) or [None, None])[1]
    key = city_en or city
    if key not in _centers:
        _centers[key] = geocode([key]) if key else None
    center = _centers[key]
    for q in [address, it.get("search_query") or "", f"{en} {city_en}" if en else "", plain, f"{plain} {city}"]:
        c = geocode([q]) if q.strip() else None
        if c and (not center or _km(center, c) < 300):
            return c
    c = ko_wiki_coords(plain)
    if c and (not center or _km(center, c) < 300):
        return c
    # 마지막: Photon(OpenStreetMap 기반, 이름이 조금 달라도 찾음) — 여행지 근처 결과만
    for q in [address, it.get("search_query") or "", f"{en} {city_en}" if en else "", plain]:
        c = photon(q, center) if q and q.strip() else None
        if c and center and _km(center, c) < 80:
            return c
    return None


def photon(q: str, near: tuple | None) -> tuple[float, float] | None:
    try:
        params = {"q": q, "limit": 1}
        if near:
            params.update(lat=near[0], lon=near[1])
        r = requests.get("https://photon.komoot.io/api/", params=params, headers={"User-Agent": "travel-planner-personal/1.0"}, timeout=15).json()
        f = (r.get("features") or [None])[0]
        return (f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) if f else None
    except Exception:
        return None


# ---------- 사진 내려받기 → 저장소 ----------
def _ahash(img) -> int:
    small = img.convert("L").resize((8, 8))
    px = list(small.getdata())
    avg = sum(px) / 64
    return sum(1 << i for i, v in enumerate(px) if v > avg)


def store_photos(cloud: Cloud, trip_id: str, item_id: str, candidates: list[dict], limit: int = PHOTOS_PER_SPOT) -> list[dict]:
    """후보 사진을 내려받아(겹치는 사진·작은 사진 제외) 줄여서 올린다. [{path, page, site}]"""
    from PIL import Image

    saved, hashes, tried = [], [], set()
    per_site: dict[str, int] = {}
    for c in candidates:
        if len(saved) >= limit:
            break
        src = c["image"]
        if src in tried:
            continue
        tried.add(src)
        if not c.get("own") and per_site.get(c["page"] or src, 0) >= 3:  # 검색 결과는 한 글에서 3장까지 (내가 넣은 링크는 제한 없음)
            continue
        try:
            r = requests.get(src, headers={**HEADERS, "Referer": c.get("page") or src}, timeout=15, stream=True)
            r.raise_for_status()
            data = r.raw.read(15 * 1024 * 1024 + 1, decode_content=True)
            if len(data) > 15 * 1024 * 1024:
                continue
            img = Image.open(io.BytesIO(data))
            img.load()
        except Exception:
            continue
        w, h = img.size
        if min(w, h) < 320 or max(w, h) / max(1, min(w, h)) > 2.6:
            continue
        hsh = _ahash(img)
        if any(bin(hsh ^ o).count("1") <= 6 for o in hashes):  # 거의 같은 사진
            continue
        img = img.convert("RGB")
        img.thumbnail((1280, 1280))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=82, optimize=True, progressive=True)
        path = f"{trip_id}/ext/{item_id}/{uuid.uuid4().hex[:10]}.jpg"
        try:
            cloud.upload(path, buf.getvalue(), "image/jpeg")
        except CloudError as e:
            _log(f"   ✗ 사진 올리기 실패: {e}")
            break
        hashes.append(hsh)
        per_site[c["page"] or src] = per_site.get(c["page"] or src, 0) + 1
        saved.append({"path": path, "page": c.get("page") or "", "site": c.get("site") or site_name(c.get("page") or src)})
    return saved


# ---------- Claude 정리 ----------
STYLE = """
## 문체 (가장 중요)
트리플·트립닷컴·야놀자 같은 여행 플랫폼의 에디터가 현장 취재 후 정리한 상세 페이지처럼 씁니다.
- 짧고 단정하게. 소개(intro)는 '~해요'체, 소제목·한 줄 소개는 명사형으로 끝맺습니다.
- 구체적인 사실(메뉴 이름, 금액, 시간, 위치, 수치)로 말합니다. 꾸밈말로 채우지 않습니다.
- 다음 표현은 쓰지 않습니다: AI, 인공지능, 추천드립니다, ~인 것 같아요, 다양한, 완벽한, 필수 코스, 꼭 가봐야 할,
  놓치지 마세요, 매력적인, 이색적인, 환상적인, 느낌표, 이모지, '~하는 것을 추천합니다'.
- 같은 문장 구조를 반복하지 않습니다. 목록 항목은 서로 다른 정보를 담습니다.
- 가격은 현지 통화로 적고, 원화 대략값은 괄호에 씁니다. 확인하지 못한 값은 지어내지 말고 빈 문자열로 둡니다.
"""


def enrich_prompt(spots: list[dict], web: bool, max_searches: int) -> str:
    rule = (f"WebSearch(최대 {max_searches}회)와 WebFetch로 최신 정보(현재 메뉴·가격·운영시간·휴무·입장료)를 확인하세요. "
            "네이버 블로그·플레이스, 구글 지도 리뷰, 트리플, 공식 사이트, 최근 1년 안의 후기를 우선합니다.\n"
            if web else "웹 검색 없이 주어진 내용과 알고 있는 정보로만 정리하세요.\n")
    return (
        f"{_head()}\n## 이번 작업: 스팟 상세 정보 정리\n{rule}{STYLE}\n"
        "각 스팟마다 SpotDetail 하나를 만드세요. id는 입력 그대로 씁니다.\n"
        "'링크_내용'이 있는 스팟은 사용자가 직접 찾은 페이지입니다. 그 내용을 1순위로 요약하고(사람들이 주로 시키는 메뉴, "
        "주로 즐기는 것, 왜 가 볼 만한지, 운영시간), 비어 있는 정보만 웹에서 보충하세요.\n"
        "먹거리·카페는 menu를 꼭 채우고 price_range는 '실제로 많이 쓰는 1인 금액' 기준으로 적으세요.\n"
        "즐길거리·랜드마크는 costs와 cautions를 자세히, 랜드마크는 highlights에 '왜 랜드마크인지·왜 가 봐야 하는지'를 담으세요.\n\n"
        f"## 스팟\n```yaml\n{_yaml(spots)}```\n"
    )


def _spot_input(it: dict, pages: list[dict]) -> dict:
    cat = {"photo": "사진 명소", "food": "먹거리", "cafe": "카페", "place": "가볼 곳", "landmark": "랜드마크", "activity": "즐길거리", "bar": "술집"}
    d = {"id": it["id"], "카테고리": cat.get(it["category"], it["category"]), "이름": it["name"],
         "도시": it.get("destination") or "", "지역": it.get("area") or "", "메모": it.get("note") or ""}
    ok = [p for p in pages if not p.get("error")]
    if ok:
        d["링크_내용"] = [{"주소": p["url"], "사이트": p["site"], "제목": p.get("title"), "설명": p.get("description"),
                       "본문": p.get("text")} for p in ok]
    bad = [p["url"] for p in pages if p.get("error")]
    if bad:
        d["열지_못한_링크(WebFetch로 직접 확인)"] = bad
    return d


def _city(it: dict) -> str:
    return re.split(r"[·,/]", it.get("destination") or "")[0].strip()


def _candidates(it: dict, detail, pages: list[dict]) -> list[dict]:
    """사진 후보: 링크 속 사진 → 정리된 검색어로 찾은 사진 → 이름 검색."""
    out = []
    for p in pages:
        for img in p.get("images", []):
            out.append({"image": img, "page": p.get("final_url") or p["url"], "site": p["site"], "own": True})
    queries = list(detail.image_queries if detail else [])
    base = f"{it['name']} {_city(it)}".strip()
    if it["category"] in ("food", "cafe") and detail and detail.menu:
        sig = [m.name for m in detail.menu if m.signature][:2] or [detail.menu[0].name]
        queries += [f"{it['name']} {s}" for s in sig]
    queries += [base] if base not in queries else []
    if not pages:  # AI 추천 스팟: 검색 사진이 중심
        for q in dict.fromkeys(queries[:4]):
            out += search_images(q, limit=8)
    elif len(out) < 4:
        out += search_images(base, limit=8)
    return out


def process_batch(cloud: Cloud, batch: list[dict], should_stop: Callable[[], bool] = lambda: False) -> None:
    names = ", ".join(i["name"] for i in batch)
    _log(f"🖼️ 사진·정보 모으기: {names}")
    pages = {i["id"]: [read_page(l["url"]) for l in (i.get("links") or [])] for i in batch}
    for iid, ps in pages.items():
        for p in ps:
            _log(f"   📄 {p['site']}: " + (p.get("error") or f"사진 {len(p['images'])}장, 글 {len(p.get('text') or '')}자"))

    details = {}
    try:
        res = run_claude(enrich_prompt([_spot_input(i, pages[i["id"]]) for i in batch], True, 4 * len(batch)),
                         EnrichResult, web_search=True, max_searches=4 * len(batch), model=batch[0].get("model") or None,
                         on_progress=lambda t: _log(f"   {t}"), should_cancel=should_stop)
        details = {d.id: d for d in res.spots}
    except Cancelled:
        raise
    except Exception as e:
        _log(f"   ✗ 정보 정리 실패: {e}")
        for it in batch:
            cloud.owner_rpc("finish_enrich", p_item=it["id"], p_details=None, p_photos=None, p_error=f"정보를 정리하지 못했어요: {str(e)[:200]}")
        return

    for it in batch:
        d = details.get(it["id"])
        photos = store_photos(cloud, it["trip_id"], it["id"], _candidates(it, d, pages[it["id"]]))
        info = d.model_dump(exclude={"id", "image_queries"}) if d else {}
        info["links"] = [{"url": p["url"], "site": p["site"], "title": p.get("title") or ""} for p in pages[it["id"]]]
        info["updated_on"] = datetime.now().date().isoformat()
        geo = spot_coords(it, d.address if d else "")
        if geo:
            info["lat"], info["lng"] = geo
        ok = cloud.owner_rpc("finish_enrich", p_item=it["id"], p_details=info, p_photos=photos or it.get("photos") or [], p_error=None)
        old = [p["path"] for p in it.get("photos") or []]
        if ok:
            if photos and old:
                cloud.delete_files(old)  # 예전에 모은 사진은 새 사진으로 바꿈
            _log(f"   ✅ {it['name']}: 사진 {len(photos)}장, 메뉴 {len(d.menu) if d else 0}개")
        else:
            cloud.delete_files([p["path"] for p in photos])  # 그사이 지워졌거나 다시 요청됨
            _log(f"   ⏹️ {it['name']}: 결과 버림 (그사이 바뀜)")


def run_once(cloud: Cloud, has_job: Callable[[], bool] = lambda: False) -> bool:
    """대기 중인 스팟을 한 묶음 처리. 처리했으면 True."""
    claimed = cloud.owner_rpc("claim_enrich", p_limit=BATCH * 2) or []
    if not claimed:
        return False
    by_trip: dict[str, list[dict]] = {}
    for it in claimed:
        by_trip.setdefault(it["trip_id"], []).append(it)
    for items in by_trip.values():
        # 링크가 있는 스팟은 글이 길어서 하나씩, 나머지는 BATCH개씩
        with_links = [[i] for i in items if i.get("links")]
        plain = [i for i in items if not i.get("links")]
        for batch in with_links + [plain[k:k + BATCH] for k in range(0, len(plain), BATCH)]:
            try:
                process_batch(cloud, batch)
            except Exception as e:  # 한 묶음이 실패해도 다음 묶음은 계속
                _log(f"   ✗ 실패: {e}")
                for it in batch:
                    try:
                        cloud.owner_rpc("finish_enrich", p_item=it["id"], p_details=None, p_photos=None, p_error=str(e)[:300])
                    except CloudError:
                        pass
    return True
