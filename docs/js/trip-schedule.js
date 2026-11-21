/* 일정 탭 + 고정 일정 편집 */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js";
import { icon } from "./icons.js";
import { isMaking, renderRecord } from "./record.js";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js";
import { T, header, reload, schedule } from "./trip.js";
import { act, bgAttrs, closed, dayOf, dayOptions, days, itemById, spots, trip } from "./trip-shared.js";

// ---------- 일정 ----------
export function scheduleTab() {
  const ds = days();
  if (!ds.length) {
    return `<div class="empty"><p class="eyebrow">NO DATES</p><h2>여행 날짜를 정해 주세요</h2>
      <p class="muted">날짜를 정하면 날짜별 일정이 생겨요.</p><button class="btn btn-ink" data-act="edit-trip">날짜 정하기</button></div>`;
  }
  const today = todayISO();
  const ph = phase(trip());
  let order = ds;
  let past = [];
  if (ph.kind === "during") {
    order = ds.filter((d) => d >= today);
    past = ds.filter((d) => d < today);
  }
  const undated = spots().filter((i) => !i.day_date);

  return `
    <div class="date-strip" role="tablist">${ds.map((d, i) => `<button class="date-chip ${d === today ? "today" : ""} ${d < today && ph.kind === "during" ? "past" : ""}"
      data-act="day-jump" data-day="${d}"><small>${wdEn(d)}</small><b>${Number(d.slice(8))}</b><small>DAY ${i + 1}</small></button>`).join("")}</div>
    ${order.map((d) => dayBlock(d, ds.indexOf(d), d === today)).join("")}
    ${past.length ? `<details class="past-days"><summary>지난 날 ${past.length}일 ${icon("next", 16)}</summary>
      ${past.map((d) => dayBlock(d, ds.indexOf(d), false)).join("")}</details>` : ""}
    ${undated.length ? `<button class="undated" data-act="go-undated">${icon("pin", 18)} 날짜를 정하지 않은 스팟 <b>${undated.length}</b>곳 ${icon("next", 16)}</button>` : ""}`;
}

export function dayBlock(d, idx, isToday) {
  const dd = dayOf(d);
  const sched = T.data.items.filter((i) => i.category === "schedule" && i.day_date === d)
    .sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  const sp = spots().filter((i) => i.day_date === d);
  const ids = new Set(sp.map((i) => i.id));
  const media = T.data.media.filter((m) => m.day_date === d || ids.has(m.item_id));
  const route = routeUrl(sp, trip());

  return `<section class="day ${isToday ? "is-today" : ""}" id="day-${d}">
    <header class="day-hd">
      <span class="day-num">${pad2(idx + 1)}</span>
      <div class="grow"><p class="eyebrow">DAY ${idx + 1} · ${wdEn(d)}${isToday ? ` · <em>TODAY</em>` : ""}</p>
        <h3>${dayLabel(d)}</h3></div>
      <span class="muted small">${sp.filter((i) => i.done).length}/${sp.length}</span>
    </header>
    <input class="input-line day-title" data-day-field="title" data-day="${d}" value="${esc(dd.title || "")}" placeholder="이 날의 테마를 적어 보세요" maxlength="100">

    ${sched.length ? `<ul class="times">${sched.map((s) => `<li data-act="sched-open" data-id="${s.id}"><b>${esc(s.time || "—")}</b><span>${esc(s.name)}</span></li>`).join("")}</ul>` : ""}
    ${sp.length ? `<ul class="rows">${sp.map(spotRow).join("")}</ul>` : ""}

    <div class="day-actions">
      <button class="chip-btn" data-act="add-spot" data-day="${d}">${icon("plus", 16)} 스팟</button>
      <button class="chip-btn" data-act="add-schedule" data-day="${d}">${icon("clock", 16)} 시간 일정</button>
      <button class="chip-btn" data-act="upload" data-day="${d}">${icon("camera", 16)} 사진</button>
      ${route ? `<a class="chip-btn" href="${route}" target="_blank" rel="noopener">${icon("map", 16)} 경로</a>` : ""}
    </div>

    ${media.length ? `<div class="strip">${media.slice(0, 12).map(thumbTile).join("")}</div>` : ""}
    <textarea class="diary" data-day-field="diary" data-day="${d}" rows="3" maxlength="8000"
      placeholder="오늘의 기록 — 무엇을 보고 느꼈나요? (자동 저장, 블로그 글에 쓰여요)">${esc(dd.diary || "")}</textarea>
  </section>`;
}

export function spotRow(i) {
  return `<li class="row ${i.done ? "done" : ""}">
    <button class="row-main" data-act="spot-open" data-id="${i.id}">
      <span class="row-thumb" ${bgAttrs(i)}>${icon(CATS[i.category].ic, 18, "fallback-ic")}</span>
      <span class="grow"><b>${esc(i.name)}</b><small>${esc([CATS[i.category].label, i.time, i.area].filter(Boolean).join(" · "))}</small></span>
    </button>
    ${checkBtn(i)}</li>`;
}

export function checkBtn(i, label = "") {
  return `<button class="check ${i.done ? "on" : ""}" data-act="visit" data-id="${i.id}" aria-pressed="${i.done}"
    aria-label="${esc(i.name)} 방문 ${i.done ? "취소" : "체크"}">${icon("check", 18)}${label}</button>`;
}

export function thumbTile(m) {
  const url = fileUrl(m.path);
  return `<button class="thumb" data-act="media-open" data-id="${m.id}" aria-label="${m.kind === "video" ? "영상" : "사진"} 보기">
    ${m.kind === "video" ? `<video src="${esc(url)}#t=0.1" preload="metadata" muted playsinline></video><span class="play">${icon("play", 16)}</span>`
      : `<img src="${esc(url)}" alt="${esc(m.caption || "")}" loading="lazy">`}</button>`;
}


export function openSchedule(id, day) {
  const i = id ? itemById(id) : { name: "", time: "", day_date: day, note: "" };
  const s = openSheet(`
    <p class="eyebrow">TIMETABLE</p><h2 class="sheet-title">${id ? "일정 고치기" : "시간 정해진 일정"}</h2>
    <form class="stack" data-sched>
      <input class="input input-lg" name="name" required maxlength="200" value="${esc(i.name)}" placeholder="예: 공항 도착, 체크인, 공연">
      <div class="grid2">
        <div class="field"><label>날짜</label><select class="input" name="day_date">${dayOptions(i.day_date)}</select></div>
        <div class="field"><label>시간</label><input class="input" type="time" name="time" value="${esc(/^\d{1,2}:\d{2}$/.test(i.time || "") ? i.time.padStart(5, "0") : "")}"></div>
      </div>
      <textarea class="input" name="note" rows="2" maxlength="2000" placeholder="메모">${esc(i.note || "")}</textarea>
      <button class="btn btn-ink btn-block" type="submit">저장</button>
      ${id ? `<button class="btn btn-block btn-ghost danger" type="button" data-act="del-item" data-id="${id}">${icon("trash", 16)} 삭제</button>` : ""}
    </form>`, { onClose: closed });
  $("[data-sched]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await rpc("upsert_item", { p_trip: T.id, p_item: { ...(id ? { id } : { category: "schedule" }), ...fd }, p_by: await askName() });
      s.close();
      toast("저장했어요");
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}
