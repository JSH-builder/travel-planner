/* 스팟 탭 + 스팟 상세(사진·정보)·추가·추천 */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js?v=2611221104";
import { icon } from "./icons.js?v=2611221104";
import { isMaking, renderRecord } from "./record.js?v=2611221104";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js?v=2611221104";
import {
  $, $$, CATS, SPOT_KEYS, bindProfile, dateRange, dayLabel, profileFields, readProfile, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js?v=2611221104";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js?v=2611221104";
import { afterScheduleChange, costChip } from "./trip-cost.js?v=2611221104";
import { T, busy, reload } from "./trip.js?v=2611221104";
import { checkBtn } from "./trip-schedule.js?v=2611221104";
import { act, bgAttrs, bindAutosave, closed, dayOptions, enriching, galleryOf, itemById, mediaOf, spots, thumbPathOf, trip, wikiAttrs } from "./trip-shared.js?v=2611221104";

// ---------- 스팟 ----------
export function spotsTab() {
  const cat = SPOT_KEYS.includes(T.sub) ? T.sub : "";
  const undatedOnly = T.sub === "undated";
  const ytOnly = T.sub === "youtube";
  const all = spots();
  const ytN = all.filter(fromYoutube).length;
  let list = cat ? all.filter((i) => i.category === cat) : all;
  if (undatedOnly) list = all.filter((i) => !i.day_date);
  if (ytOnly) list = all.filter(fromYoutube);
  if (T.filter === "todo") list = list.filter((i) => !i.done);
  if (T.filter === "done") list = list.filter((i) => i.done);
  const label = cat ? CATS[cat].label : "스팟";

  return `
    <div class="spots-hd">
      <p class="eyebrow">${cat ? CATS[cat].en : undatedOnly ? "UNDATED" : ytOnly ? "FROM YOUTUBE" : "ALL SPOTS"}</p>
      <h1>${undatedOnly ? "날짜 미정" : ytOnly ? "유튜브에 나온 곳" : esc(label)} <span class="count">${list.length}</span></h1>
    </div>
    <label class="spot-search">${icon("search", 18)}
      <input type="search" data-spot-search value="${esc(T.q || "")}" placeholder="스팟 검색 (이름·지역·메뉴·메모)" aria-label="스팟 검색" enterkeyhint="search">
      <button type="button" class="icon-btn sm" data-spot-search-clear aria-label="검색어 지우기" ${T.q ? "" : "hidden"}>${icon("x", 16)}</button></label>
    <div class="chip-scroll">
      <button class="chip-btn ${!cat && !undatedOnly && !ytOnly ? "on" : ""}" data-act="go-cat" data-cat="">전체</button>
      ${ytN ? `<button class="chip-btn yt-chip ${ytOnly ? "on" : ""}" data-act="go-cat" data-cat="youtube">${icon("play", 15)} 유튜브 ${ytN}</button>` : ""}
      ${SPOT_KEYS.map((k) => `<button class="chip-btn ${cat === k ? "on" : ""}" data-act="go-cat" data-cat="${k}" style="--cat:${CATS[k].color}">
        ${icon(CATS[k].ic, 16)} ${CATS[k].label}</button>`).join("")}
      ${all.some((i) => !i.day_date) ? `<button class="chip-btn ${undatedOnly ? "on" : ""}" data-act="go-cat" data-cat="undated">날짜 미정</button>` : ""}
    </div>
    <div class="toolbar">
      <div class="seg">${[["all", "전체"], ["todo", "가 볼 곳"], ["done", "다녀온 곳"]].map(([k, l]) =>
        `<button class="${T.filter === k ? "on" : ""}" data-act="vis-filter" data-v="${k}">${l}</button>`).join("")}</div>
      <span class="tool-links"><button class="link" data-act="yt-import">${icon("play", 16)} 유튜브</button>
      <button class="link" data-act="recommend" data-cat="${cat}" ${busy() ? "disabled" : ""}>${icon("sparkles", 16)} AI 추천</button></span>
    </div>
    ${(() => {
      const bare = all.filter((i) => !enriching(i) && (!i.details || !Object.keys(i.details).length || i.enrich === "error"));
      const working = all.filter(enriching).length;
      if (working) return `<p class="enrich-bar"><span class="mini-spin"></span> ${working}곳의 사진·정보를 정리하고 있어요</p>`;
      return bare.length ? `<button class="enrich-bar btn-like" data-act="enrich">${icon("image", 16)} 사진·정보가 없는 ${bare.length}곳 채우기 <span>${icon("next", 16)}</span></button>` : "";
    })()}
    <p class="search-empty" data-search-empty hidden>검색 결과가 없어요. 다른 카테고리('전체')에서도 찾아보세요.</p>
    ${list.length ? `<div class="spot-grid">${list.map(spotCard).join("")}</div>`
      : `<div class="empty"><p class="eyebrow">EMPTY</p><h2>${T.filter === "done" ? "아직 다녀온 곳이 없어요" : `${esc(label)}가 비어 있어요`}</h2>
        <div class="btn-row"><button class="btn btn-ink" data-act="add-spot" data-cat="${cat}">${icon("plus", 18)} 직접 담기</button>
        <button class="btn btn-line" data-act="recommend" data-cat="${cat}" ${busy() ? "disabled" : ""}>${icon("sparkles", 18)} AI 추천</button></div></div>`}`;
}

export function spotCard(i) {
  const n = mediaOf(i.id).length + (i.photos || []).length;
  const d = i.details || {};
  const line = d.headline || (i.note || "").split("▶")[0].trim(); // 영상에서 본 내용은 상세에서
  const price = d.price_range || i.price;
  return `<article class="spot ${i.done ? "done" : ""}" style="--cat:${CATS[i.category].color}" data-search="${esc(searchText(i))}">
    <button class="spot-img" data-act="spot-open" data-id="${i.id}" ${bgAttrs(i)} aria-label="${esc(i.name)} 자세히">
      ${icon(CATS[i.category].ic, 30, "fallback-ic")}
      ${n > 1 ? `<span class="spot-media">${icon("image", 13)} ${n}</span>` : ""}
      ${fromYoutube(i) ? `<span class="spot-yt">${icon("play", 11)} 영상</span>` : ""}
      ${enriching(i) ? `<span class="spot-busy"><span class="mini-spin"></span>사진·정보 정리 중</span>` : ""}
      ${i.done ? `<span class="stamp">VISITED<br><small>${esc(md((i.done_at || "").slice(0, 10)))}</small></span>` : ""}
    </button>
    ${checkBtn(i)}
    <button class="spot-text" data-act="spot-open" data-id="${i.id}">
      <small style="color:var(--cat)">${CATS[i.category].label}${i.area ? ` · ${esc(i.area)}` : ""}</small>
      <b>${esc(i.name)}</b>
      ${line ? `<span class="clamp">${esc(line)}</span>` : ""}
      ${price ? `<span class="spot-price">${esc(price)}</span>` : ""}
      <small class="muted">${esc([i.day_date ? `${md(i.day_date)} ${wdEn(i.day_date)}` : "", i.time].filter(Boolean).join(" · "))}</small>
    </button>
  </article>`;
}

/** 검색 대상 글: 이름·지역·카테고리·한 줄 소개·메모·메뉴·장소 (소문자, 공백 제거 버전도) */
function searchText(i) {
  const d = i.details || {};
  const t = [i.name, i.area, CATS[i.category]?.label, d.headline, d.intro, i.note, d.address, i.place,
    ...(d.menu || []).map((m) => m.name), fromYoutube(i) ? "유튜브 영상" : ""].filter(Boolean).join(" ").toLowerCase();
  return `${t} ${t.replace(/\s+/g, "")}`;
}

/** 검색: 화면을 다시 그리지 않고 카드만 숨김 (입력하는 동안 키보드가 내려가지 않게) */
export function bindSpotSearch(root) {
  const input = root.querySelector("[data-spot-search]");
  if (!input) return;
  const clear = root.querySelector("[data-spot-search-clear]");
  const apply = () => {
    const q = input.value.trim().toLowerCase();
    T.q = input.value;
    const words = q.split(/\s+/).filter(Boolean);
    let n = 0;
    root.querySelectorAll(".spot[data-search]").forEach((el) => {
      const ok = words.every((w) => el.dataset.search.includes(w));
      el.hidden = !ok;
      if (ok) n++;
    });
    const count = root.querySelector(".spots-hd .count");
    if (count) count.textContent = n;
    root.querySelector("[data-search-empty]").hidden = !(q && n === 0);
    clear.hidden = !q;
  };
  input.addEventListener("input", apply);
  clear.addEventListener("click", () => {
    input.value = "";
    apply();
    input.focus();
  });
  if (input.value) apply();
}

/** 유튜브 영상에서 담긴 스팟인지 (작업기가 source_url에 영상 주소를 넣음) */
export const fromYoutube = (i) => /youtube\.com|youtu\.be/.test(i.source_url || "");
const ytId = (url) => /(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(url || "")?.[1];

/** 상세: 영상에서 본 내용 (메모의 '▶ 영상:' 뒷부분) + 영상 제목·보기 */
function ytBlock(i) {
  if (!fromYoutube(i)) return "";
  const vid = ytId(i.source_url);
  const note = (T.data.trip.summary?.youtube_notes || []).find((n) => n.id === vid);
  const said = /▶\s*영상:\s*([\s\S]+)$/.exec(i.note || "")?.[1]?.trim();
  return `<div class="yt-said">
    <button class="yt-said-thumb" data-act="yt" data-vid="${esc(vid || "")}" style="background-image:url('https://i.ytimg.com/vi/${esc(vid || "")}/mqdefault.jpg')" aria-label="영상 보기">${icon("play", 14)}</button>
    <div><p class="eyebrow">영상에서 본 곳</p>
      ${said ? `<p>${esc(said)}</p>` : ""}
      ${note ? `<button class="link" data-act="yt-note" data-vid="${esc(vid)}">${esc(note.title.slice(0, 40))}${note.title.length > 40 ? "…" : ""}</button>` : ""}</div>
  </div>`;
}

// ---------- 스팟 상세: 여행 플랫폼 상세 페이지처럼 ----------
export const SECTION = { photo: "촬영 포인트", food: "이 집의 특징", cafe: "이 집의 특징", place: "둘러볼 것", landmark: "가 봐야 하는 이유", activity: "이렇게 즐겨요", bar: "이 집의 특징" };

export function galleryHtml(i, list) {
  if (!list.length) {
    return `<div class="detail-img" style="--cat:${CATS[i.category].color}" ${wikiAttrs(i)}>${icon(CATS[i.category].ic, 40, "fallback-ic")}</div>`;
  }
  return `<div class="gallery" data-gallery>
    <div class="gal-track">${list.map((p, k) => `<button class="gal-slide" data-act="gal-open" data-id="${i.id}" data-idx="${k}" aria-label="사진 ${k + 1} 크게 보기">
      ${p.kind === "video" ? `<video src="${esc(p.src)}#t=0.1" preload="metadata" muted playsinline></video><span class="play">${icon("play", 18)}</span>`
        : `<img src="${esc(p.src)}" alt="" loading="${k < 2 ? "eager" : "lazy"}">`}
      ${p.site ? `<span class="gal-src">${esc(p.site)}</span>` : ""}</button>`).join("")}</div>
    ${list.length > 1 ? `<span class="gal-count"><b data-gal-now>1</b> / ${list.length}</span>` : ""}
  </div>`;
}

export function enrichNote(i) {
  if (enriching(i)) {
    return `<div class="enrich-state"><span class="mini-spin"></span><div><b>사진과 정보를 모으고 있어요</b>
      <small>${i.enrich === "pending" ? "작업기가 켜져 있으면 곧 시작해요" : "보통 1~3분 걸려요. 다 되면 자동으로 채워져요"}</small></div></div>`;
  }
  if (i.enrich === "error") {
    return `<div class="enrich-state err">${icon("alert", 18)}<div><b>정보를 가져오지 못했어요</b><small>${esc(i.enrich_error || "")}</small></div>
      <button class="btn btn-sm btn-line" data-act="enrich" data-id="${i.id}">다시 시도</button></div>`;
  }
  return "";
}

export function detailBody(i) {
  const d = i.details || {};
  const facts = [
    ["clock", "영업시간", d.hours], ["calendar", "휴무", d.closed], ["wallet", "가격대", d.price_range],
    ["pin", "주소", d.address], ["bus", "가는 법", d.how_to_get], ["ticket", "예약", d.reservation], ["sun", "추천 시간", d.best_time],
  ].filter((f) => f[2]);
  const menu = d.menu || [];
  const sources = [...new Map([...(d.links || []), ...(d.sources || [])].filter((s) => safeUrl(s.url)).map((s) => [s.url, s])).values()];
  return `
    ${d.intro ? `<p class="intro">${esc(d.intro)}</p>` : ""}
    ${facts.length ? `<dl class="facts">${facts.map(([ic, k, v]) => `<div>${icon(ic, 17)}<dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
    ${menu.length ? `<section class="d-sec"><h3>대표 메뉴</h3><ul class="menu-board">${menu.map((m) => `<li>
        <div class="mb-name"><b>${esc(m.name)}</b>${m.signature ? `<span class="tag">대표</span>` : ""}${m.desc ? `<small>${esc(m.desc)}</small>` : ""}</div>
        <span class="mb-dots"></span><span class="mb-price">${esc(m.price || "—")}</span></li>`).join("")}</ul></section>` : ""}
    ${(d.highlights || []).length ? `<section class="d-sec"><h3>${SECTION[i.category] || "포인트"}</h3><ol class="points">${d.highlights.map((p) =>
        `<li><b>${esc(p.title)}</b><p>${esc(p.body)}</p></li>`).join("")}</ol></section>` : ""}
    ${(d.costs || []).length ? `<section class="d-sec"><h3>비용</h3><ul class="cost-list">${d.costs.map((c) =>
        `<li><span>${esc(c.item)}</span><b>${esc(c.price || "—")}</b></li>`).join("")}</ul></section>` : ""}
    ${(d.tips || []).length ? `<section class="d-sec note-box"><h3>${icon("info", 16)} 알아 두면 좋아요</h3><ul>${d.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>` : ""}
    ${(d.cautions || []).length ? `<section class="d-sec note-box warn"><h3>${icon("alert", 16)} 주의할 점</h3><ul>${d.cautions.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></section>` : ""}
    ${sources.length ? `<div class="sources"><span>정보 출처</span>${sources.slice(0, 8).map((s) =>
        `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.site || s.title || new URL(s.url).hostname)}</a>`).join("")}</div>` : ""}
    ${d.updated_on ? `<p class="hint">${esc(d.updated_on.replaceAll("-", "."))} 기준 정보예요. 현지 사정에 따라 달라질 수 있어요.</p>` : ""}`;
}

export function linksEditor(i) {
  const links = i.links || [];
  return `<section class="d-sec links-box"><h3>${icon("link", 16)} 내가 찾은 링크</h3>
    <p class="muted small">블로그·인스타·네이버 지도·구글 지도 링크를 넣으면 사진을 뽑고 내용을 정리해 위에 채워 넣어요. 여러 개 넣을 수 있어요.</p>
    ${links.length ? `<ul class="link-list">${links.map((l, k) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${icon("external", 14)}
      <span>${esc(l.url.replace(/^https?:\/\/(www\.)?/, ""))}</span></a>
      <button class="icon-btn sm" data-act="link-del" data-id="${i.id}" data-idx="${k}" aria-label="링크 빼기">${icon("x", 16)}</button></li>`).join("")}</ul>` : ""}
    <form class="link-add" data-link-add="${i.id}">
      <input class="input" name="url" type="url" inputmode="url" placeholder="https:// 링크 붙여넣기" required>
      <button class="btn btn-ink" type="submit">추가</button>
    </form>
    ${!enriching(i) ? `<button class="btn btn-line btn-block" data-act="enrich" data-id="${i.id}">${icon("refresh", 16)}
      ${i.details && Object.keys(i.details).length ? "사진·정보 다시 모으기" : links.length ? "링크로 사진·정보 정리하기" : "사진·정보 찾아오기"}</button>` : ""}
  </section>`;
}

export function bindGallery(root) {
  const g = $("[data-gallery] .gal-track", root);
  const now = $("[data-gal-now]", root);
  if (!g || !now) return;
  g.addEventListener("scroll", () => (now.textContent = Math.round(g.scrollLeft / g.clientWidth) + 1), { passive: true });
}

export function openGallery(id, idx) {
  const i = itemById(id);
  const list = galleryOf(i);
  openViewer(list.map((p) => ({ ...p })), idx, {
    onDelete: async (k) => {
      const p = list[k];
      if (p.type === "media") {
        const path = await rpc("delete_media", { p_trip: T.id, p_media: p.id });
        await deleteFiles([path]);
      } else {
        const cur = itemById(id);
        await rpc("upsert_item", { p_trip: T.id, p_item: { id, photos: (cur.photos || []).filter((x) => x.path !== p.path) } });
        await deleteFiles([p.path]);
        cur.photos = (cur.photos || []).filter((x) => x.path !== p.path);
      }
      list.splice(k, 1);
    },
    onCover: (k) => list[k].kind === "photo"
      ? rpc("upsert_item", { p_trip: T.id, p_item: { id, thumb_path: list[k].path } }).then(() => toast("대표 사진으로 정했어요"))
      : toast("대표 사진은 사진만 가능해요"),
    coverLabel: "대표 사진으로",
    onClose: () => reload(),
  });
}

/** 스팟 상세 (바텀시트). 모든 칸은 자동 저장 */
export function openSpot(id) {
  const draw = () => {
    const i = itemById(id);
    if (!i) return closeSheet();
    const t = trip();
    const q = spotQuery(i, t);
    const d = i.details || {};
    const list = galleryOf(i);
    const photos = list.filter((p) => p.kind === "photo");
    const openEdit = sheet.el.querySelector("details.edit-box")?.open;
    const scroll = sheet.el.closest(".sheet")?.scrollTop;
    sheet.el.innerHTML = `
      ${galleryHtml(i, list)}
      <div class="detail-head" style="--cat:${CATS[i.category].color}">
        <p class="eyebrow" style="color:var(--cat)">${CATS[i.category].en}${i.area ? ` · ${esc(i.area)}` : ""}</p>
        <input class="input-line title-input" data-f="name" value="${esc(i.name)}" maxlength="200" aria-label="이름">
        ${d.headline ? `<p class="lede">${esc(d.headline)}</p>` : ""}
      </div>
      <div class="btn-row">
        <button class="btn grow ${i.done ? "btn-accent" : "btn-ink"}" data-act="visit" data-id="${id}">${icon("check", 18)} ${i.done ? "다녀왔어요" : "방문 체크"}</button>
        <button class="btn btn-line" data-act="upload" data-item="${id}" aria-label="사진·영상 올리기">${icon("camera", 18)} 올리기</button>
      </div>
      <button class="plan-cta" data-act="plan" data-id="${id}">
        ${icon("calendar", 18)}<span>${i.day_date ? `<b>${esc(dayLabel(i.day_date))}${i.time ? ` ${esc(i.time)}` : ""}</b><small>일정 바꾸기 · 시간 추천</small>`
          : `<b>일정에 넣기</b><small>날짜만 고르면 빈 시간·동선으로 시간을 추천해요</small>`}</span>${icon("next", 16)}</button>
      ${i.day_date ? `<div class="cost-row"><span>${icon("wallet", 16)} 이 일정 비용</span>${costChip(i)}</div>
        <button class="link danger-link" data-act="unplan" data-id="${id}">${icon("x", 14)} 일정에서 빼기</button>` : ""}
      ${i.done ? `<p class="hint center">${esc(stamp(i.done_at))} · ${esc(i.done_by || "")} 기록</p>` : ""}
      ${ytBlock(i)}
      ${enrichNote(i)}
      ${detailBody(i)}
      ${linksEditor(i)}

      <div class="link-row">
        <a href="${mapsUrl(q)}" target="_blank" rel="noopener">${icon("map", 18)}<span>지도</span></a>
        <a href="${imageSearchUrl(q)}" target="_blank" rel="noopener">${icon("image", 18)}<span>사진 더 보기</span></a>
        <a href="${ytSearchUrl(`${i.name} ${t.destination || ""}`)}" target="_blank" rel="noopener">${icon("play", 18)}<span>유튜브</span></a>
      </div>

      <details class="edit-box" ${openEdit ? "open" : ""}><summary>${icon("pencil", 16)} 직접 수정 · 메모</summary>
        ${photos.length > 1 ? `<div class="field"><label>카드 대표 사진</label>
          <div class="pick-row">${photos.map((p) => {
            const on = thumbPathOf(i) === p.path;
            return `<button class="pick sm ${on ? "on" : ""}" data-act="set-thumb" data-id="${id}" data-path="${esc(p.path)}"
              style="background-image:url('${esc(p.src)}')" aria-label="이 사진을 대표 사진으로" aria-pressed="${on}">${on ? `<span class="pick-on">${icon("check", 14)}</span>` : ""}</button>`;
          }).join("")}</div></div>` : ""}
        <div class="field"><label>카테고리</label><div class="chips">${SPOT_KEYS.map((k) =>
          `<button class="chip-btn ${i.category === k ? "on" : ""}" data-act="set-cat" data-id="${id}" data-cat="${k}" style="--cat:${CATS[k].color}">${icon(CATS[k].ic, 15)} ${CATS[k].short}</button>`).join("")}</div></div>
        <div class="grid2">
          <div class="field"><label>날짜</label><select class="input" data-f="day_date">${dayOptions(i.day_date)}</select></div>
          <div class="field"><label>시간</label><input class="input" data-f="time" value="${esc(i.time || "")}" placeholder="오전, 18:00" maxlength="40"></div>
          <div class="field"><label>지역</label><input class="input" data-f="area" value="${esc(i.area || "")}" maxlength="100"></div>
          <div class="field"><label>가격</label><input class="input" data-f="price" value="${esc(i.price || "")}" maxlength="100"></div>
        </div>
        <div class="field"><label>메모</label><textarea class="input" data-f="note" rows="3" maxlength="2000">${esc(i.note || "")}</textarea></div>
        <label class="check-line"><input type="checkbox" data-f="reservation_needed" ${i.reservation_needed ? "checked" : ""}> 예약 필요</label>
        <p class="save-state" data-save-state></p>
        <button class="btn btn-block btn-ghost danger" data-act="del-item" data-id="${id}">${icon("trash", 16)} 이 스팟 삭제</button>
      </details>`;
    if (scroll) sheet.el.closest(".sheet").scrollTop = scroll;
    bindGallery(sheet.el);
    lazyWiki(sheet.el);
    bindAutosave(sheet.el, (patch) => rpc("upsert_item", { p_trip: T.id, p_item: { id, ...patch } }).then((r) => {
      if ("day_date" in patch || "time" in patch || "reservation_needed" in patch) afterScheduleChange(id);
      return r;
    }));
  };
  const sheet = openSheet("", { onClose: closed, flush: true });
  T.afterReload = () => sheetIsOpen() && draw();
  T.liveItem = id;
  draw();
}


export function openAddSpot(cat, day) {
  const s = openSheet(`
    <p class="eyebrow">NEW SPOT</p><h2 class="sheet-title">어디에 가 볼까요?</h2>
    <form class="stack" data-add-spot>
      <input class="input input-lg" name="name" required maxlength="200" placeholder="장소 이름 (예: 이치란 라멘 본점)">
      <div class="chips">${SPOT_KEYS.map((k) => `<label class="chip-radio" style="--cat:${CATS[k].color}">
        <input type="radio" name="category" value="${k}" ${k === (cat || "place") ? "checked" : ""}><span>${icon(CATS[k].ic, 15)} ${CATS[k].short}</span></label>`).join("")}</div>
      <div class="grid2">
        <div class="field"><label>날짜</label><select class="input" name="day_date">${dayOptions(day || "")}</select></div>
        <div class="field"><label>지역</label><input class="input" name="area" maxlength="100"></div>
      </div>
      <div class="field"><label>${icon("link", 14)} 찾아 둔 링크 <small class="muted">· 한 줄에 하나, 여러 개 가능</small></label>
        <textarea class="input" name="links" rows="3" placeholder="블로그·인스타·네이버 지도·구글 지도 링크를 붙여 넣으면&#10;사진을 뽑고 메뉴·가격·운영시간을 정리해 드려요"></textarea></div>
      <textarea class="input" name="note" rows="2" maxlength="2000" placeholder="메모"></textarea>
      <button class="btn btn-ink btn-block" type="submit">담기</button>
    </form>`, { onClose: closed });
  const form = $("[data-add-spot]", s.el);
  setTimeout(() => form.name.focus(), 250);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const by = await askName();
    try {
      const fields = Object.fromEntries(new FormData(form));
      fields.links = (fields.links || "").split(/\s+/).filter((u) => /^https?:\/\//i.test(u)).map((url) => ({ url }));
      const id = await rpc("upsert_item", { p_trip: T.id, p_item: fields, p_by: by });
      T.data = await rpc("get_trip", { p_trip: T.id });
      toast("담았어요");
      openSpot(id);
    } catch (err) {
      toast(err.message);
    }
  });
}

/** 고른 연령대·여행 유형을 여행에 저장 (다음 추천·자동 짜기의 기본값) */
export async function saveProfile(prof) {
  const cur = trip().input || {};
  if ((cur.age || "") === prof.age && (cur.party || "") === prof.party) return;
  try {
    await rpc("update_trip", { p_trip: T.id, p_patch: { input: prof } });
    T.data.trip.input = { ...cur, ...prof };
  } catch {} // 저장이 안 돼도 이번 요청에는 반영
}

export function openRecommend(cat) {
  const label = cat ? CATS[cat].label : "스팟";
  const s = openSheet(`
    <p class="eyebrow">${icon("sparkles", 14)} AI PICK</p><h2 class="sheet-title">${esc(label)} 더 추천받기</h2>
    <p class="muted">이미 담긴 곳은 빼고 골라 와요. 추천은 목록에 더해지기만 해요.</p>
    <form class="stack" data-reco>
      <div class="seg wide">${[3, 5, 8].map((n) => `<label><input type="radio" name="count" value="${n}" ${n === 5 ? "checked" : ""}><span>${n}곳</span></label>`).join("")}</div>
      ${profileFields(trip().input || {})}
      <p class="hint">고르면 그 나이대·일행이 온라인 후기에서 실제로 많이 찾는 곳 위주로 골라 와요</p>
      <input class="input" name="request" maxlength="300" placeholder="원하는 느낌 (예: 현지인 맛집, 야경, 비 오는 날)">
      <label class="check-line"><input type="checkbox" name="web" checked> 웹에서 최신 정보 확인</label>
      <button class="btn btn-ink btn-block" type="submit">추천 요청</button>
      <p class="hint center">소유자 PC의 작업기가 처리해요 · 보통 1~5분</p>
    </form>`, { onClose: closed });
  bindProfile(s.el);
  $("[data-reco]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const prof = readProfile(f);
    try {
      await saveProfile(prof);
      await rpc("request_job", { p_trip: T.id, p_type: "recommend", p_params: {
        category: cat || "any", count: Number(f.count.value), request: f.request.value.trim(), web_search: f.web.checked, ...prof,
      } });
      s.close(true);
      toast("추천을 요청했어요");
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}
