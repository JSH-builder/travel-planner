/* 유튜브로 담기: 영상 링크 → (작업기) 자막·설명란 요약 + 나온 장소를 스팟으로 → 사진·지도 정보 자동 모으기 */
import { rpc } from "./api.js?v=2611240302";
import { icon } from "./icons.js?v=2611240302";
import { openSheet } from "./ui.js?v=2611240302";
import { $, esc, toast } from "./util.js?v=2611240302";
import { T, busy, reload } from "./trip.js?v=2611240302";
import { closed, trip } from "./trip-shared.js?v=2611240302";

const YT = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([A-Za-z0-9_-]{11})/;

export function openYoutubeImport() {
  const notes = trip().summary?.youtube_notes || [];
  const s = openSheet(`
    <p class="eyebrow">${icon("play", 14)} FROM YOUTUBE</p>
    <h2 class="sheet-title">유튜브에서 본 곳 담기</h2>
    <p class="muted">여행 브이로그·맛집 영상 링크를 넣으면 자막(스크립트)과 설명란을 읽어 요약하고,
      영상에 나온 장소를 스팟으로 담아요. 담긴 스팟은 사진·메뉴·가격·지도 위치까지 자동으로 채워져요.</p>
    <form class="stack" data-yt-import>
      <textarea class="input" name="urls" rows="4" required placeholder="https://youtu.be/...&#10;https://www.youtube.com/watch?v=...&#10;(한 줄에 하나, 최대 5개)"></textarea>
      <label class="check-line"><input type="checkbox" name="web" checked> 장소 이름을 웹에서 확인 (자동 자막 받아쓰기 오류 바로잡기)</label>
      <button class="btn btn-ink btn-block" type="submit" ${busy() ? "disabled" : ""}>${icon("sparkles", 18)} 정리해서 담기</button>
      <p class="hint center">${busy() ? "다른 AI 작업이 끝나면 요청할 수 있어요" : "소유자 PC의 작업기가 처리해요 · 영상 1개당 보통 1~3분"}</p>
    </form>
    ${notes.length ? `<p class="sub-label">지금까지 정리한 영상 ${notes.length}개</p>
      <ul class="yt-mini">${notes.slice().reverse().map((n) => `<li><img src="https://i.ytimg.com/vi/${esc(n.id)}/mqdefault.jpg" alt="" loading="lazy">
        <span><b>${esc(n.title)}</b><small>${esc(n.author || "")} · 장소 ${(n.spots || []).length}곳</small></span></li>`).join("")}</ul>` : ""}`,
  { onClose: closed });

  $("[data-yt-import]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const lines = e.target.urls.value.split(/\s+/).filter(Boolean);
    const urls = [...new Set(lines.filter((u) => YT.test(u)))].slice(0, 5);
    if (!urls.length) return toast("YouTube 링크를 넣어 주세요");
    if (lines.length > urls.length) toast("YouTube가 아닌 링크는 뺐어요");
    try {
      await rpc("request_job", { p_trip: T.id, p_type: "youtube", p_params: { urls, web_search: e.target.web.checked } });
      s.close(true);
      toast(`영상 ${urls.length}개를 정리해 올게요`);
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

/** 개요(홈): 유튜브에서 본 것 */
export function youtubeSection(s) {
  const notes = s.youtube_notes || [];
  if (!notes.length) return "";
  // 홈에는 짧게: 가로로 넘기는 작은 카드만. 요약·꿀팁·장소는 카드를 누르면 시트로
  return `<section class="sec bleed">
    <header class="sec-head"><div><p class="eyebrow">FROM YOUTUBE</p><h2>유튜브에서 본 것</h2></div>
      <button class="link" data-act="yt-import">${icon("plus", 16)} 영상</button></header>
    <div class="rail">${notes.slice().reverse().map((n) => `<button class="yt-mini-card" data-act="yt-note" data-vid="${esc(n.id)}">
      <span class="yt-mini-thumb" style="background-image:url('https://i.ytimg.com/vi/${esc(n.id)}/mqdefault.jpg')">${icon("play", 16, "play-ic")}</span>
      <b>${esc(n.title)}</b>
      <small>${(n.spots || []).length ? `장소 ${n.spots.length}곳` : ""}${(n.spots || []).length && (n.tips || []).length ? " · " : ""}${(n.tips || []).length ? `꿀팁 ${n.tips.length}` : ""}</small>
    </button>`).join("")}</div>
  </section>`;
}

/** 영상 하나 자세히: 요약 · 핵심 정보 · 꿀팁 · 나온 곳 */
export function openYoutubeNote(vid) {
  const n = (trip().summary?.youtube_notes || []).find((x) => x.id === vid);
  if (!n) return;
  const spotId = (name) => T.data.items.find((i) => i.name === name)?.id;
  openSheet(`
    <button class="yt-cover" data-act="yt" data-vid="${esc(n.id)}" style="background-image:url('https://i.ytimg.com/vi/${esc(n.id)}/hqdefault.jpg')"
      aria-label="영상 보기">${icon("play", 26, "play-ic")}</button>
    <p class="eyebrow">${esc(n.author || "YOUTUBE")}</p>
    <h2 class="sheet-title">${esc(n.title)}</h2>
    <p class="intro">${esc(n.summary)}</p>
    ${(n.points || []).length ? `<section class="d-sec"><h3>핵심 정보</h3><ul class="yt-points">${n.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></section>` : ""}
    ${(n.tips || []).length ? `<div class="note-box"><h3>${icon("info", 15)} 영상 속 꿀팁</h3><ul>${n.tips.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
    ${(n.spots || []).length ? `<section class="d-sec"><h3>영상에 나온 곳</h3><div class="yt-spots">${n.spots.map((name) => {
      const id = spotId(name);
      return id ? `<button class="chip-btn sm" data-act="spot-open" data-id="${id}" title="${esc(name)}">${icon("pin", 13)} ${esc(name.replace(/\s*[(（].*$/, ""))}</button>` : "";
    }).join("")}</div></section>` : ""}
    ${(n.spots || []).length ? `<button class="btn btn-ink btn-block" data-act="go-cat" data-cat="youtube">${icon("pin", 18)} 유튜브에 나온 곳 스팟에서 보기</button>` : ""}
    <p class="hint">${esc(n.transcript || "")} 기준으로 정리 · ${esc((n.added_on || "").replaceAll("-", "."))} · 영상에 나온 곳은 스팟에 자동으로 담겨요</p>`, { onClose: closed });
}
