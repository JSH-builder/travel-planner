/* 홈(개요) 탭 */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js";
import { icon } from "./icons.js";
import { isMaking, renderRecord } from "./record.js";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js";
import { youtubeSection } from "./trip-youtube.js";
import { $app, T, busy, jobBanner, schedule } from "./trip.js";
import { album } from "./trip-album.js";
import { budget } from "./trip-money.js";
import { prep } from "./trip-prep.js";
import { act, bgAttrs, coverOf, secHead, spots, thumbOf, trip, wikiAttrs } from "./trip-shared.js";

// ---------- 홈(개요) ----------
export function overview() {
  const t = trip();
  const s = t.summary || {};
  const ph = phase(t);
  const sp = spots();
  const visited = sp.filter((i) => i.done).length;
  const mediaN = T.data.media.length;
  const spent = T.data.expenses.reduce((a, e) => a + e.amount, 0);
  const prepItems = T.data.items.filter((i) => i.category === "todo" || i.category === "packing");
  const prepDone = prepItems.filter((i) => i.done).length;
  const cover = coverOf() || T.coverFallback || "";
  const eyebrow = (s.destination_en || t.destination || "").toUpperCase();

  const today = ph.kind === "during" ? todayISO() : null;
  const todaySpots = today ? sp.filter((i) => i.day_date === today) : [];
  const todaySched = today ? T.data.items.filter((i) => i.category === "schedule" && i.day_date === today) : [];
  const alerts = (s.alerts || []).map((a) => (typeof a === "string" ? { text: a } : a));

  const tile = (k) => {
    const list = sp.filter((i) => i.category === k);
    const pick = list.find((i) => thumbOf(i)) || list.find((i) => wikiAttrs(i));
    return `<button class="cat-tile" data-act="go-cat" data-cat="${k}" ${pick ? bgAttrs(pick) : `style="--cat:${CATS[k].color}"`}>
      <span class="cat-tile-icon">${icon(CATS[k].ic, 22)}</span>
      <span class="cat-tile-text"><small>${CATS[k].en}</small><b>${CATS[k].label}</b><em>${list.length ? `${list.filter((i) => i.done).length} / ${list.length}` : "비어 있음"}</em></span></button>`;
  };

  return `
    <section class="cover ${cover ? "has-img" : ""}" ${cover ? `style="background-image:url('${esc(cover)}')"`
      : `data-wiki="${esc(t.destination || t.title)}" data-wiki-en="${esc(s.destination_en || "")}"`}>
      <button class="cover-edit" data-act="cover-pick" aria-label="표지 사진 바꾸기">${icon("camera", 16)} 표지</button>
      <div class="cover-text">
        <span class="status">${esc(ph.en)}</span>
        ${eyebrow ? `<p class="eyebrow light">${esc(eyebrow)}</p>` : ""}
        <h1 data-act="edit-trip">${esc(t.title)}</h1>
        <p class="cover-meta">${esc(dateRange(t))}${t.companions ? ` &nbsp;·&nbsp; ${esc(t.companions)}` : ""}</p>
      </div>
    </section>

    <section class="numbers">
      <button data-tab="spots"><b>${visited}<i>/${sp.length}</i></b><span>방문</span></button>
      <button data-tab="album"><b>${mediaN}</b><span>사진·영상</span></button>
      <button data-tab="budget"><b>${won(spent)}</b><span>총 지출(원)</span></button>
      <button data-tab="prep"><b>${prepItems.length ? Math.round((prepDone / prepItems.length) * 100) : 0}<i>%</i></b><span>준비</span></button>
    </section>
    ${jobBanner()}

    ${today ? `<section class="sec">
      ${secHead("오늘의 여정", `DAY ${pad2(ph.index + 1)} · ${md(today)} ${wdEn(today)}`, `<button class="link" data-tab="schedule">전체 ${icon("next", 16)}</button>`)}
      ${todaySched.length ? `<ul class="today-times">${todaySched.map((i) => `<li data-act="sched-open" data-id="${i.id}"><b>${esc(i.time || "—")}</b>${esc(i.name)}</li>`).join("")}</ul>` : ""}
      ${todaySpots.length ? `<div class="rail">${todaySpots.map(railCard).join("")}</div>` : `<p class="muted">오늘 갈 곳이 아직 없어요.</p>`}
    </section>` : ""}

    ${!sp.length ? `<section class="sec cta-block">
      <p class="eyebrow">START</p><h2>어디부터 갈까요?</h2>
      <p class="muted">AI가 취향에 맞는 곳을 골라 주거나, 가고 싶은 곳을 직접 담을 수 있어요.</p>
      <div class="btn-row"><button class="btn btn-ink" data-act="ai-plan" ${busy() ? "disabled" : ""}>${icon("sparkles", 18)} AI 추천 받기</button>
        <button class="btn btn-line" data-act="add-spot" data-cat="">${icon("plus", 18)} 직접 담기</button></div></section>` : ""}

    <section class="sec">
      ${secHead("둘러보기", "EXPLORE")}
      <div class="cat-grid">${SPOT_KEYS.map(tile).join("")}</div>
    </section>

    ${youtubeSection(s)}

    ${(s.videos || []).length || (s.video_queries || []).length || t.destination ? `<section class="sec bleed">
      ${secHead("영상으로 미리 떠나기", "WATCH")}
      <div class="rail">${(s.videos || []).map((v) => `<button class="video-card" data-act="yt" data-vid="${esc(v.id)}">
          <span class="video-thumb" style="background-image:url('https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg')">${icon("play", 22, "play-ic")}</span>
          <b>${esc(v.title)}</b><small>${esc(v.author || "")}</small></button>`).join("")}
        ${videoQueries(s, t).map((q) => `<a class="video-card" href="${ytSearchUrl(q)}" target="_blank" rel="noopener">
          <span class="video-thumb query" data-wiki="${esc(t.destination || t.title)}" data-wiki-en="${esc(s.destination_en || "")}">
            ${icon("play", 22, "play-ic")}<em>${esc(q)}</em></span>
          <b>YouTube에서 보기</b><small>${esc(q)}</small></a>`).join("")}</div>
    </section>` : ""}

    <section class="sec">
      ${secHead("확정 예약", "BOOKED", `<button class="link" data-act="edit-bookings">${t.bookings ? "수정" : "추가"}</button>`)}
      ${t.bookings ? `<div class="ticket">${linkify(t.bookings)}</div>` : `<p class="muted">항공·숙소·공연 예약을 적어 두면 여기 그대로 보여요.</p>`}
    </section>

    ${alerts.length ? `<section class="sec">
      ${secHead("떠나기 전에 알아 둘 것", "NOTE")}
      <ol class="notes">${alerts.map((a) => `<li><p>${esc(a.text)}</p>${srcMark(a)}</li>`).join("")}</ol></section>` : ""}

    <section class="sec bleed">
      ${secHead("풍경", "SCENERY", `<a class="link" href="${imageSearchUrl(t.destination || t.title)}" target="_blank" rel="noopener">더 보기 ${icon("external", 14)}</a>`)}
      <div class="rail" data-commons="${esc(s.destination_en || (t.destination || t.title || "").split(/[·,/]/)[0].trim())}"><p class="muted px">불러오는 중</p></div>
    </section>

    ${(s.must_eat || []).length ? `<section class="sec">${secHead("꼭 먹어 볼 것", "MUST EAT")}
      <p class="must-eat">${s.must_eat.map(esc).join("<span>/</span>")}</p></section>` : ""}

    ${(s.basic_info || []).length ? `<details class="sec fold"><summary>${secHead("여행 기본 정보", "INFO")}</summary>
      <dl class="info">${s.basic_info.map((b) => {
        const [k, ...v] = String(b).split(":");
        return v.length ? `<dt>${esc(k.trim())}</dt><dd>${esc(v.join(":").trim())}</dd>` : `<dd class="full">${esc(b)}</dd>`;
      }).join("")}</dl></details>` : ""}

    <section class="record-block">
      <p class="eyebrow light">AFTER THE TRIP</p>
      <h2>여행을 기록으로</h2>
      <p>${ph.kind === "after" ? "다녀온 곳과 사진으로 블로그 글과 영상을 만들어 보세요." : "여행이 끝나면 방문 기록·사진으로 블로그 글과 영상을 만들 수 있어요."}</p>
      <button class="btn btn-white" data-tab="record">${icon("pen", 18)} 글 · ${icon("film", 18)} 영상 만들기</button>
    </section>

    ${s.researched_on || (s.sources || []).length ? `<details class="sec fold small-fold"><summary><span class="muted small">AI 조사 ${esc(s.researched_on || "")} · 출처 ${(s.sources || []).length}개</span></summary>
      <ul class="plain small">${(s.sources || []).filter((x) => safeUrl(x.url)).map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a></li>`).join("")}</ul></details>` : ""}
  `;
}

export function railCard(i) {
  return `<button class="rail-card" data-act="spot-open" data-id="${i.id}">
    <span class="rail-img" ${bgAttrs(i)}>${icon(CATS[i.category].ic, 26, "fallback-ic")}
      ${i.done ? `<span class="done-dot">${icon("check", 14)}</span>` : ""}</span>
    <small>${esc(i.time || CATS[i.category].label)}</small><b>${esc(i.name)}</b></button>`;
}

export function videoQueries(s, t) {
  const q = s.video_queries || [];
  const dest = (t.destination || t.title || "").split(/[·,]/)[0].trim();
  return q.length ? q : dest ? [`${dest} 여행 브이로그`, `${dest} 맛집`, `${dest} 가볼만한곳`] : [];
}

export async function fillCommons() {
  const box = $("[data-commons]", $app);
  if (!box) return;
  const list = await commonsImages(box.dataset.commons, 8);
  if (!$app.contains(box)) return;
  // 표지 사진이 없고 위키 대표 사진도 못 찾았으면 풍경 사진 첫 장을 표지로 (다시 그려도 유지되게 기억)
  const cover = $(".cover", $app);
  if (cover && !cover.classList.contains("has-img") && list[0]) {
    const wiki = await wikiThumb(cover.dataset.wiki || "", cover.dataset.wikiEn || "");
    if (!wiki && T) {
      T.coverFallback = list[0].thumb;
      if ($app.contains(cover)) {
        cover.style.backgroundImage = `url("${list[0].thumb}")`;
        cover.classList.add("has-img");
      }
    }
  }
  box.innerHTML = list.length
    ? list.map((p) => `<a class="scene" href="${esc(p.page)}" target="_blank" rel="noopener" style="background-image:url('${esc(p.thumb)}')">
        ${p.credit ? `<span>© ${esc(p.credit)}</span>` : ""}</a>`).join("")
    : `<p class="muted px">사진을 찾지 못했어요.</p>`;
}

export function srcMark(x) {
  if (x?.verified && safeUrl(x.source_url)) {
    return `<a class="src ok" href="${esc(x.source_url)}" target="_blank" rel="noopener">${icon("check", 12)} 확인됨</a>`;
  }
  return `<span class="src" title="AI의 기억·추측이에요. 직접 확인해 주세요">미확인</span>`;
}
