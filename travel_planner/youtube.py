"""YouTube 영상 읽기: 제목·채널(oEmbed) + 설명란 + 자막(스크립트). 모두 무료, API 키 불필요.

- 자막: youtube-transcript-api (사람이 단 자막 > 자동 자막, 한국어 우선)
- 설명란: 영상 페이지의 공개 정보 (장소 목록·타임스탬프가 여기에 많음)
- 자막이 꺼진 영상은 제목·설명란만으로 정리한다
"""

from __future__ import annotations

import json
import re

import requests

YT_ID = re.compile(r"(?:youtu\.be/|youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/))([A-Za-z0-9_-]{11})")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
}
TRANSCRIPT_LIMIT = 14000
LANGS = ["ko", "ja", "zh-Hant", "zh-Hans", "zh-TW", "zh-HK", "zh", "en"]


def video_id(url: str) -> str | None:
    m = YT_ID.search(url or "")
    return m.group(1) if m else None


def _oembed(vid: str) -> dict:
    try:
        r = requests.get("https://www.youtube.com/oembed", params={"format": "json", "url": f"https://www.youtube.com/watch?v={vid}"},
                         headers=HEADERS, timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception:
        return {}


def _description(vid: str) -> str:
    try:
        html = requests.get(f"https://www.youtube.com/watch?v={vid}&hl=ko", headers=HEADERS, timeout=20).text
    except Exception:
        return ""
    m = re.search(r'"shortDescription":"((?:[^"\\]|\\.)*)"', html)
    if not m:
        return ""
    try:
        return json.loads(f'"{m.group(1)}"')[:4000]
    except json.JSONDecodeError:
        return ""


def _transcript(vid: str) -> tuple[str, str]:
    """(자막 글, 언어 설명). 없으면 ("", 이유)."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        return "", "자막 도구 없음 (pip install -r requirements.txt)"
    try:
        listing = YouTubeTranscriptApi().list(vid)
        tracks = list(listing)
    except Exception as e:
        return "", f"자막 없음 ({e.__class__.__name__})"
    # 사람이 단 자막 > 자동 자막, 언어는 LANGS 순서
    def rank(t):
        lang = t.language_code
        li = next((k for k, l in enumerate(LANGS) if lang == l or lang.startswith(l + "-")), len(LANGS))
        return (t.is_generated, li)
    for t in sorted(tracks, key=rank):
        try:
            parts = t.fetch()
        except Exception:
            continue
        lines, last = [], -999
        for s in parts:
            # 1분마다 [mm:ss] 표시 → 어느 장면인지 남기기
            stamp = ""
            if s.start - last >= 60:
                last = s.start
                stamp = f"[{int(s.start // 60):02d}:{int(s.start % 60):02d}] "
            lines.append(stamp + s.text.replace("\n", " "))
        text = " ".join(lines)
        return text[:TRANSCRIPT_LIMIT], f"{t.language} ({'자동 자막' if t.is_generated else '자막'})"
    return "", "자막 없음"


def fetch_material(url: str) -> dict:
    """{id, url, title, author, description, transcript, transcript_info} 또는 {url, error}."""
    vid = video_id(url)
    if not vid:
        return {"url": url, "error": "YouTube 주소가 아니에요"}
    meta = _oembed(vid)
    if not meta:
        return {"url": url, "id": vid, "error": "영상을 열 수 없어요 (비공개·삭제됐거나 주소가 틀림)"}
    transcript, info = _transcript(vid)
    return {
        "id": vid, "url": f"https://www.youtube.com/watch?v={vid}", "title": meta.get("title", ""), "author": meta.get("author_name", ""),
        "description": _description(vid), "transcript": transcript, "transcript_info": info,
    }
