/* 일정 탭 + 고정 일정 편집 */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js?v=2611240316";
import { icon } from "./icons.js?v=2611240316";
import { isMaking, renderRecord } from "./record.js?v=2611240316";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js?v=2611240316";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js?v=2611240316";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js?v=2611240316";
import { toMin } from "./geo.js?v=2611240316";
import { costChip } from "./trip-cost.js?v=2611240316";
import { voucherChip } from "./trip-voucher.js?v=2611240316";
import { T, header, reload, schedule } from "./trip.js?v=2611240316";
import { act, bgAttrs, closed, dayOf, dayOptions, days, itemById, spots, trip } from "./trip-shared.js?v=2611240316";

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

  const vs = T.data.vouchers || [];
  const vRead = vs.filter((v) => v.status === "pending" || v.status === "working").length;
  const vTodo = vs.filter((v) => v.status === "done" && !v.item_id).length;
  return `
    <div data-push hidden></div>
    <div data-worker hidden></div>
    <button class="voucher-bar" data-act="voucher-box">${icon("ticket", 18)}
      <span><b>예약·바우처 ${vs.length ? vs.length : ""}</b><small>${vRead ? `${vRead}개 읽는 중` : vTodo ? `${vTodo}개 확인하고 일정에 넣기` : "항공권·숙소 메일·입장권·QR 넣기"}</small></span>
      ${vRead ? `<span class="mini-spin"></span>` : vTodo ? `<span class="dot-badge">${vTodo}</span>` : icon("plus", 18)}</button>
    <div class="date-strip" role="tablist">${ds.map((d, i) => `<button class="date-chip ${d === today ? "today" : ""} ${d < today && ph.kind === "during" ? "past" : ""}"
      data-act="day-jump" data-day="${d}"><small>${wdEn(d)}</small><b>${Number(d.slice(8))}</b><small>DAY ${i + 1}</small></button>`).join("")}</div>
    ${order.map((d) => dayBlock(d, ds.indexOf(d), d === today)).join("")}
    ${past.length ? `<details class="past-days"><summary>지난 날 ${past.length}일 ${icon("next", 16)}</summary>
      ${past.map((d) => dayBlock(d, ds.indexOf(d), false)).join("")}</details>` : ""}
    ${undated.length ? `<button class="undated" data-act="go-undated">${icon("pin", 18)} 날짜를 정하지 않은 스팟 <b>${undated.length}</b>곳 ${icon("next", 16)}</button>` : ""}`;
}

export function dayBlock(d, idx, isToday) {
  const dd = dayOf(d);
  const sp = spots().filter((i) => i.day_date === d);
  // 시간이 정해진 일정·스팟은 한 줄 타임라인으로, 시간 미정 스팟은 아래 따로
  const timed = T.data.items.filter((i) => i.day_date === d && (i.category === "schedule" || isSpot(i)) && toMin(i.time) != null)
    .sort((a, b) => toMin(a.time) - toMin(b.time));
  const untimedSched = T.data.items.filter((i) => i.day_date === d && i.category === "schedule" && toMin(i.time) == null);
  const untimed = sp.filter((i) => toMin(i.time) == null);
  const dayCost = T.data.expenses.filter((e) => e.day_date === d).reduce((a, e) => a + e.amount, 0);
  const ids = new Set(sp.map((i) => i.id));
  const media = T.data.media.filter((m) => m.day_date === d || ids.has(m.item_id));
  const route = nextRoute(timed, d, isToday);

  return `<section class="day ${isToday ? "is-today" : ""}" id="day-${d}">
    <header class="day-hd">
      <span class="day-num">${pad2(idx + 1)}</span>
      <div class="grow"><p class="eyebrow">DAY ${idx + 1} · ${wdEn(d)}${isToday ? ` · <em>TODAY</em>` : ""}</p>
        <h3>${dayLabel(d)}</h3></div>
      <span class="day-meta">${sp.length ? `<span class="muted small">방문 ${sp.filter((i) => i.done).length}/${sp.length}</span>` : ""}
        ${dayCost ? `<button class="day-cost" data-tab="budget">${won(dayCost)}원</button>` : ""}</span>
    </header>
    <input class="input-line day-title" data-day-field="title" data-day="${d}" value="${esc(dd.title || "")}" placeholder="이 날의 테마를 적어 보세요" maxlength="100">

    ${timed.length || untimedSched.length ? `<ol class="timeline">${timed.map((i, k) =>
        (k ? `<li class="tl-gap" data-leg="${timed[k - 1].id}|${i.id}"><span class="mini-spin"></span></li>` : "") + tlItem(i)).join("")}
        ${untimedSched.map(tlItem).join("")}</ol>`
      : `<button class="tl-empty" data-act="add-schedule" data-day="${d}">${icon("clock", 18)} 이 날 정해진 일정(항공·체크인·예약)을 넣어 보세요</button>`}
    ${untimed.length ? `<p class="sub-label">시간 미정 ${untimed.length}곳 <small>· '시간 추천'을 누르면 일정 사이 빈 시간에 넣어 드려요</small></p>
      <ul class="rows">${untimed.map((i) => spotRow(i, d)).join("")}</ul>` : ""}

    <div class="day-actions">
      <button class="chip-btn auto" data-act="day-plan" data-day="${d}">${icon("sparkles", 16)} 자동 짜기</button>
      <button class="chip-btn strong" data-act="add-schedule" data-day="${d}">${icon("plus", 16)} 일정 추가</button>
      <button class="chip-btn" data-act="add-spot" data-day="${d}">${icon("pin", 16)} 스팟</button>
      <button class="chip-btn" data-act="upload" data-day="${d}">${icon("camera", 16)} 사진</button>
    </div>
    ${route ? `<div class="next-route">
      <span class="eyebrow">${icon("map", 13)} ${route.label}</span>
      <p>${route.stops.map((x) => `<b>${esc(x.name.replace(/\s*[(（].*$/, ""))}</b>`).join(" → ")}</p>
      <div class="row-btns">
        <a class="chip-btn strong" href="${route.one}" target="_blank" rel="noopener">${icon("bus", 15)} ${esc(route.stops[0].name.replace(/\s*[(（].*$/, "").slice(0, 14))}까지 길찾기</a>
        ${route.three ? `<a class="chip-btn" href="${route.three}" target="_blank" rel="noopener">${icon("map", 15)} ${route.stops.length}곳 이어서 보기</a>` : ""}
      </div></div>` : ""}

    ${media.length ? `<div class="strip">${media.slice(0, 12).map(thumbTile).join("")}</div>` : ""}
    <label class="diary-card"><span class="eyebrow">${icon("pen", 13)} 오늘의 기록</span>
      <textarea class="diary" data-day-field="diary" data-day="${d}" rows="3" maxlength="8000"
        placeholder="무엇을 보고 느꼈나요? 한 줄이면 충분해요 (자동 저장 · 블로그 글에 쓰여요)">${esc(dd.diary || "")}</textarea></label>
  </section>`;
}

/** 그날 동선에서 '다음 3곳'만: 방문 체크(또는 오늘 이미 지난 시간)한 곳 다음부터.
 * 구글 지도는 대중교통 모드에서 경유지를 무시해서 전체 경로가 안 보였음 →
 * 다음 1곳은 대중교통 길찾기, 3곳 이어 보기는 경유지가 되는 기본 모드로 */
function nextRoute(timed, d, isToday) {
  const tr = trip();
  const loc = (i) => (i.lat != null && i.lng != null ? `${i.lat},${i.lng}` : isSpot(i) ? spotQuery(i, tr) : i.place || "");
  const stops = [];
  for (const i of timed) {
    const q = loc(i);
    if (!q) continue;
    if (stops.length && stops[stops.length - 1].q === q) { stops[stops.length - 1].item = i; continue; } // 같은 장소 연속은 하나로
    stops.push({ q, item: i, name: i.name });
  }
  // 출국 공항·탑승처럼 앞쪽에 몰린 공항 일정은 마지막(도착 공항) 하나만
  const isAir = (x) => /airport|공항/i.test(`${x.item.place || ""} ${x.name}`);
  while (stops.length > 1 && isAir(stops[0]) && isAir(stops[1])) stops.shift();
  if (stops.length < 2) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let past = -1;
  stops.forEach((x, k) => {
    const end = toMin(x.item.end_time) ?? toMin(x.item.time);
    if (x.item.done || (isToday && end != null && end <= nowMin)) past = k;
  });
  if (past >= stops.length - 1) return null; // 다 다녀옴
  // 오늘이면 출발지는 '내 위치'(비워 두면 구글이 현재 위치로), 아니면 직전 장소
  const from = past >= 0 ? stops[past] : isToday ? null : stops[0];
  const start = past >= 0 ? past + 1 : isToday ? 0 : 1;
  const next = stops.slice(start, start + 3);
  if (!next.length) return null;
  const url = (dest, via, mode) => {
    const p = new URLSearchParams({ api: "1", destination: dest.q });
    if (from && !(isToday && past >= 0 && mode === "transit")) p.set("origin", from.q);
    if (via.length) p.set("waypoints", via.map((x) => x.q).join("|"));
    if (mode) p.set("travelmode", mode);
    return `https://www.google.com/maps/dir/?${p}`;
  };
  return {
    label: past >= 0 ? `다녀온 곳 다음 · ${from.name.replace(/\s*[(（].*$/, "").slice(0, 16)}에서` : isToday ? "지금 위치에서 다음 3곳" : `${from.name.replace(/\s*[(（].*$/, "").slice(0, 16)}에서 다음 3곳`,
    stops: next,
    one: url(next[0], [], "transit"),
    three: next.length > 1 ? url(next[next.length - 1], next.slice(0, -1), "") : "",
  };
}

export function spotRow(i, planDay = "") {
  return `<li class="row ${i.done ? "done" : ""}">
    <button class="row-main" data-act="spot-open" data-id="${i.id}">
      <span class="row-thumb" ${bgAttrs(i)}>${icon(CATS[i.category].ic, 18, "fallback-ic")}</span>
      <span class="grow"><b>${esc(i.name)}</b><small>${esc([CATS[i.category].label, i.time, i.area].filter(Boolean).join(" · "))}</small></span>
    </button>
    ${planDay ? `<button class="chip-btn sm" data-act="plan" data-id="${i.id}" data-day="${planDay}">${icon("clock", 14)} 시간 추천</button>` : ""}
    ${checkBtn(i)}</li>`;
}

/** 타임라인 한 줄: 일정(시계) 또는 스팟(사진) */
function tlItem(i) {
  const range = `${esc(i.time || "")}${i.end_time ? `<small>~${esc(i.end_time)}</small>` : ""}`;
  if (i.category === "schedule") {
    return `<li class="tl-item sched" data-act="sched-open" data-id="${i.id}">
      <button class="tl-time" data-act="tl-menu" data-id="${i.id}" aria-label="${esc(i.name)} 시간 바꾸기·빼기">${range || "—"}</button>
      <span class="tl-dot">${icon("clock", 14)}</span>
      <span class="tl-body"><b>${esc(i.name)}</b>${i.place || i.note ? `<small>${esc([i.place, i.note].filter(Boolean).join(" · "))}</small>` : ""}</span>
      ${voucherChip(i)}${costChip(i)}</li>`;
  }
  return `<li class="tl-item spot ${i.done ? "done" : ""}" style="--cat:${CATS[i.category].color}">
    <button class="tl-time" data-act="tl-menu" data-id="${i.id}" aria-label="${esc(i.name)} 시간 바꾸기·빼기">${range}</button>
    <span class="tl-dot cat">${icon(CATS[i.category].ic, 14)}</span>
    <button class="tl-body" data-act="spot-open" data-id="${i.id}"><b>${esc(i.name)}</b>
      <small>${esc([CATS[i.category].label, i.details?.price_range || i.area].filter(Boolean).join(" · "))}</small></button>
    ${voucherChip(i)}${costChip(i)}
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
  const i = id ? itemById(id) : { name: "", time: "", end_time: "", place: "", day_date: day, note: "" };
  const hhmm = (v) => (/^\d{1,2}:\d{2}$/.test(v || "") ? v.padStart(5, "0") : "");
  const s = openSheet(`
    <p class="eyebrow">TIMETABLE</p><h2 class="sheet-title">${id ? "일정 고치기" : "일정 추가"}</h2>
    <form class="stack" data-sched>
      <input class="input input-lg" name="name" required maxlength="200" value="${esc(i.name)}" placeholder="예: 공항 도착, 호텔 체크인, 공연">
      <div class="field"><label>날짜</label><select class="input" name="day_date">${dayOptions(i.day_date)}</select></div>
      <div class="grid2">
        <div class="field"><label>시작</label><input class="input" type="time" name="time" value="${esc(hhmm(i.time))}"></div>
        <div class="field"><label>끝 <small class="muted">(선택)</small></label><input class="input" type="time" name="end_time" value="${esc(hhmm(i.end_time))}"></div>
      </div>
      <div class="field"><label>장소 <small class="muted">· 넣으면 앞뒤 일정과의 이동 시간을 계산해요</small></label>
        <input class="input" name="place" maxlength="200" value="${esc(i.place || "")}" placeholder="예: 홍콩국제공항, 하버 그랜드 구룡 호텔"></div>
      <textarea class="input" name="note" rows="2" maxlength="2000" placeholder="메모 (예약 번호, 터미널 등)">${esc(i.note || "")}</textarea>
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
