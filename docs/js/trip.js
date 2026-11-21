/* 여행 화면 (매거진형): 개요 · 일정 · 스팟 · 앨범 · 예산 · 준비 (+ 기록 만들기는 record.js) */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js";
import { icon } from "./icons.js";
import { isMaking, renderRecord } from "./record.js";
import { askName, closeSheet, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js";
import { commonsImages, lazyWiki } from "./wiki.js";

const $app = document.getElementById("app");
const TABS = [
  ["overview", "home", "홈"],
  ["schedule", "calendar", "일정"],
  ["spots", "pin", "스팟"],
  ["album", "image", "앨범"],
  ["budget", "wallet", "예산"],
  ["prep", "backpack", "준비"],
];
const EXP_CATS = {
  food: ["식비", "utensils"], transport: ["교통", "bus"], stay: ["숙소", "bed"],
  shopping: ["쇼핑", "bag"], ticket: ["입장·체험", "ticket"], etc: ["기타", "card"],
};
const JOB_LABEL = { plan: "여행 추천", recommend: "추천 더 받기", blog: "블로그 글" };

let T = null; // { id, data, tab, sub, filter, pending }
let pollTimer = null;

// ---------- 진입·새로고침 ----------
export async function openTrip(id, tab = "overview", sub = "") {
  stop();
  $app.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  let data;
  try {
    data = await rpc("get_trip", { p_trip: id });
  } catch (e) {
    $app.innerHTML = errorPage(`여행을 불러오지 못했어요. ${e.message}`);
    return;
  }
  if (!data) {
    forget(id);
    $app.innerHTML = errorPage("여행을 찾을 수 없어요. 링크가 잘못됐거나 삭제된 여행이에요.");
    return;
  }
  remember(id, data.trip.title);
  T = { id, data, tab: tab || store(`tab:${id}`) || "overview", sub, filter: store("spotFilter") || "all", pending: null };
  render();
  schedule();
}

export function stop() {
  clearTimeout(pollTimer);
  T = null;
}

const busy = () => ["queued", "generating"].includes(T?.data.trip.status);

function schedule() {
  clearTimeout(pollTimer);
  if (T) pollTimer = setTimeout(poll, busy() ? 4000 : 9000);
}

function editing() {
  const a = document.activeElement;
  return !!a && $app.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !["checkbox", "file", "radio"].includes(a.type)));
}

async function poll() {
  if (!T) return;
  if (!document.hidden) {
    try {
      const data = await rpc("get_trip", { p_trip: T.id });
      if (!T) return;
      if (!data) return (location.hash = "#/");
      if (JSON.stringify(data) !== JSON.stringify(T.data)) {
        if (sheetIsOpen() || editing() || isMaking()) T.pending = data;
        else apply(data);
      }
    } catch {}
  }
  schedule();
}

function apply(data) {
  T.data = data;
  T.pending = null;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

async function reload() {
  const data = await rpc("get_trip", { p_trip: T.id });
  if (!T || !data) return;
  if (editing()) T.pending = data;
  else apply(data);
  T.afterReload?.();
}

document.addEventListener("visibilitychange", () => !document.hidden && T && poll());

// ---------- 데이터 도우미 ----------
const trip = () => T.data.trip;
const items = (cat) => T.data.items.filter((i) => (cat ? i.category === cat : true));
const spots = () => T.data.items.filter(isSpot);
const itemById = (id) => T.data.items.find((i) => i.id === id);
const mediaOf = (itemId) => T.data.media.filter((m) => m.item_id === itemId);
const dayOf = (d) => T.data.days.find((x) => x.day_date === d) || {};
const days = () => tripDays(trip());
const isOwner = () => !!ownerKey();

/** 자동 사진 찾기 속성. 식당·카페는 동명 브랜드 등 엉뚱한 사진이 많아 쓰지 않는다 */
function wikiAttrs(i) {
  if (!i || i.category === "food" || i.category === "cafe") return "";
  return `data-wiki="${esc(i.name)}" data-wiki-en="${esc(i.search_query || "")}"`;
}

function thumbOf(item) {
  const photo = mediaOf(item.id).find((m) => m.kind === "photo");
  return photo ? fileUrl(photo.path) : "";
}

/** 배경 이미지 속성: 직접 올린 사진 > 위키 사진 > (없음 → CSS 기본).
 *  style 속성은 한 요소에 하나만 유효하므로 카테고리 색(--cat)도 여기서 함께 만든다 */
function bgAttrs(i) {
  const t = thumbOf(i);
  const cat = `--cat:${CATS[i.category]?.color || "var(--ink-3)"};`;
  return t ? `style="${cat}background-image:url('${esc(t)}')" data-has="1"` : `style="${cat}" ${wikiAttrs(i)}`;
}

function coverOf() {
  const t = trip();
  if (t.cover_path) return fileUrl(t.cover_path);
  const photo = T.data.media.find((m) => m.kind === "photo");
  return photo ? fileUrl(photo.path) : "";
}

function remember(id, title) {
  let recent = [];
  try {
    recent = JSON.parse(store("recentTrips") || "[]");
  } catch {}
  store("recentTrips", JSON.stringify([{ id, title }, ...recent.filter((r) => r.id !== id)].slice(0, 10)));
}
function forget(id) {
  try {
    store("recentTrips", JSON.stringify(JSON.parse(store("recentTrips") || "[]").filter((r) => r.id !== id)));
  } catch {}
}

const errorPage = (msg) => `<div class="page"><div class="empty"><p>${esc(msg)}</p><a class="btn" href="#/">처음으로</a></div></div>`;

async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    await reload();
  } catch (e) {
    toast(e.message);
  }
}

const secHead = (title, eyebrow = "", action = "") =>
  `<header class="sec-head"><div>${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ""}<h2>${title}</h2></div>${action}</header>`;

// ---------- 전체 틀 ----------
function render() {
  const t = trip();
  document.title = `${t.title} · 여행 계획`;
  if (T.tab === "record") {
    $app.innerHTML = renderRecord(T, { header: header(true) });
    afterRender();
    return;
  }
  if (!TABS.some(([k]) => k === T.tab)) T.tab = "overview";
  const view = { overview, schedule: scheduleTab, spots: spotsTab, album, budget, prep }[T.tab]();
  $app.innerHTML = `
    ${header()}
    ${T.tab === "overview" ? "" : jobBanner()}
    <main class="tab-body tab-${T.tab}">${view}</main>
    ${T.tab === "spots" ? `<button class="fab" data-act="add-spot" data-cat="${esc(SPOT_KEYS.includes(T.sub) ? T.sub : "")}" aria-label="스팟 추가">${icon("plus", 26)}</button>` : ""}
    <nav class="bottom-nav" aria-label="여행 메뉴">${TABS.map(([k, ic, label]) =>
      `<button class="${k === T.tab ? "active" : ""}" data-tab="${k}" aria-current="${k === T.tab}">${icon(ic, 22)}<span>${label}</span></button>`).join("")}</nav>`;
  afterRender();
}

function afterRender() {
  lazyWiki($app);
  if (T.tab === "overview") fillCommons();
}

function header(back = false) {
  const t = trip();
  const onHero = T.tab === "overview";
  return `<header class="app-header ${onHero ? "on-hero" : ""}">
    ${back ? `<button class="icon-btn" data-tab="overview" aria-label="뒤로">${icon("back", 24)}</button>`
      : isOwner() ? `<a class="icon-btn" href="#/" aria-label="내 여행">${icon("back", 24)}</a>` : `<span class="icon-btn ghost"></span>`}
    <button class="header-title" data-act="edit-trip">${onHero ? "" : esc(t.title)}</button>
    <button class="icon-btn" data-act="share" aria-label="공유">${icon("share", 21)}</button>
    <button class="icon-btn" data-act="menu" aria-label="메뉴">${icon("more", 24)}</button>
  </header>`;
}

function jobBanner() {
  const t = trip();
  if (busy()) {
    const what = JOB_LABEL[t.job?.type] || "AI 작업";
    return `<div class="banner">${icon("sparkles", 18, "spin-soft")}
      <div class="grow"><strong>${t.status === "queued" ? `${what} 대기 중` : `${what} 만드는 중`}</strong>
        <p>${esc(t.progress || (t.status === "queued" ? "소유자 PC의 작업기가 켜지면 바로 시작해요" : "잠시만요"))}</p></div>
      <button class="btn btn-sm btn-line" data-act="cancel-job">취소</button></div>`;
  }
  if (t.status === "error") {
    return `<div class="banner banner-error">${icon("alert", 18)}<div class="grow"><strong>AI 작업이 실패했어요</strong>
      <p>${esc((t.error || "").slice(0, 140))}</p></div><button class="btn btn-sm btn-line" data-act="retry-job">다시</button></div>`;
  }
  return "";
}

// ---------- 홈(개요) ----------
function overview() {
  const t = trip();
  const s = t.summary || {};
  const ph = phase(t);
  const sp = spots();
  const visited = sp.filter((i) => i.done).length;
  const mediaN = T.data.media.length;
  const spent = T.data.expenses.reduce((a, e) => a + e.amount, 0);
  const total = t.budget?.total;
  const prepItems = T.data.items.filter((i) => i.category === "todo" || i.category === "packing");
  const prepDone = prepItems.filter((i) => i.done).length;
  const cover = coverOf();
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
      <button data-tab="budget"><b>${total ? won(Math.max(0, total - spent)) : won(spent)}</b><span>${total ? "남은 예산" : "지출(원)"}</span></button>
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
      <div class="rail" data-commons="${esc(s.destination_en || t.destination || t.title)}"><p class="muted px">불러오는 중</p></div>
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

function railCard(i) {
  return `<button class="rail-card" data-act="spot-open" data-id="${i.id}">
    <span class="rail-img" ${bgAttrs(i)}>${icon(CATS[i.category].ic, 26, "fallback-ic")}
      ${i.done ? `<span class="done-dot">${icon("check", 14)}</span>` : ""}</span>
    <small>${esc(i.time || CATS[i.category].label)}</small><b>${esc(i.name)}</b></button>`;
}

function videoQueries(s, t) {
  const q = s.video_queries || [];
  const dest = (t.destination || t.title || "").split(/[·,]/)[0].trim();
  return q.length ? q : dest ? [`${dest} 여행 브이로그`, `${dest} 맛집`, `${dest} 가볼만한곳`] : [];
}

async function fillCommons() {
  const box = $("[data-commons]", $app);
  if (!box) return;
  const list = await commonsImages(box.dataset.commons, 8);
  if (!$app.contains(box)) return;
  box.innerHTML = list.length
    ? list.map((p) => `<a class="scene" href="${esc(p.page)}" target="_blank" rel="noopener" style="background-image:url('${esc(p.thumb)}')">
        ${p.credit ? `<span>© ${esc(p.credit)}</span>` : ""}</a>`).join("")
    : `<p class="muted px">사진을 찾지 못했어요.</p>`;
}

function srcMark(x) {
  if (x?.verified && safeUrl(x.source_url)) {
    return `<a class="src ok" href="${esc(x.source_url)}" target="_blank" rel="noopener">${icon("check", 12)} 확인됨</a>`;
  }
  return `<span class="src" title="AI의 기억·추측이에요. 직접 확인해 주세요">미확인</span>`;
}

// ---------- 일정 ----------
function scheduleTab() {
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

function dayBlock(d, idx, isToday) {
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

function spotRow(i) {
  return `<li class="row ${i.done ? "done" : ""}">
    <button class="row-main" data-act="spot-open" data-id="${i.id}">
      <span class="row-thumb" ${bgAttrs(i)}>${icon(CATS[i.category].ic, 18, "fallback-ic")}</span>
      <span class="grow"><b>${esc(i.name)}</b><small>${esc([CATS[i.category].label, i.time, i.area].filter(Boolean).join(" · "))}</small></span>
    </button>
    ${checkBtn(i)}</li>`;
}

function checkBtn(i, label = "") {
  return `<button class="check ${i.done ? "on" : ""}" data-act="visit" data-id="${i.id}" aria-pressed="${i.done}"
    aria-label="${esc(i.name)} 방문 ${i.done ? "취소" : "체크"}">${icon("check", 18)}${label}</button>`;
}

function thumbTile(m) {
  const url = fileUrl(m.path);
  return `<button class="thumb" data-act="media-open" data-id="${m.id}" aria-label="${m.kind === "video" ? "영상" : "사진"} 보기">
    ${m.kind === "video" ? `<video src="${esc(url)}#t=0.1" preload="metadata" muted playsinline></video><span class="play">${icon("play", 16)}</span>`
      : `<img src="${esc(url)}" alt="${esc(m.caption || "")}" loading="lazy">`}</button>`;
}

// ---------- 스팟 ----------
function spotsTab() {
  const cat = SPOT_KEYS.includes(T.sub) ? T.sub : "";
  const undatedOnly = T.sub === "undated";
  const all = spots();
  let list = cat ? all.filter((i) => i.category === cat) : all;
  if (undatedOnly) list = all.filter((i) => !i.day_date);
  if (T.filter === "todo") list = list.filter((i) => !i.done);
  if (T.filter === "done") list = list.filter((i) => i.done);
  const label = cat ? CATS[cat].label : "스팟";

  return `
    <div class="spots-hd">
      <p class="eyebrow">${cat ? CATS[cat].en : undatedOnly ? "UNDATED" : "ALL SPOTS"}</p>
      <h1>${undatedOnly ? "날짜 미정" : esc(label)} <span class="count">${list.length}</span></h1>
    </div>
    <div class="chip-scroll">
      <button class="chip-btn ${!cat && !undatedOnly ? "on" : ""}" data-act="go-cat" data-cat="">전체</button>
      ${SPOT_KEYS.map((k) => `<button class="chip-btn ${cat === k ? "on" : ""}" data-act="go-cat" data-cat="${k}" style="--cat:${CATS[k].color}">
        ${icon(CATS[k].ic, 16)} ${CATS[k].label}</button>`).join("")}
      ${all.some((i) => !i.day_date) ? `<button class="chip-btn ${undatedOnly ? "on" : ""}" data-act="go-cat" data-cat="undated">날짜 미정</button>` : ""}
    </div>
    <div class="toolbar">
      <div class="seg">${[["all", "전체"], ["todo", "가 볼 곳"], ["done", "다녀온 곳"]].map(([k, l]) =>
        `<button class="${T.filter === k ? "on" : ""}" data-act="vis-filter" data-v="${k}">${l}</button>`).join("")}</div>
      <button class="link" data-act="recommend" data-cat="${cat}" ${busy() ? "disabled" : ""}>${icon("sparkles", 16)} AI 추천</button>
    </div>
    ${list.length ? `<div class="spot-grid">${list.map(spotCard).join("")}</div>`
      : `<div class="empty"><p class="eyebrow">EMPTY</p><h2>${T.filter === "done" ? "아직 다녀온 곳이 없어요" : `${esc(label)}가 비어 있어요`}</h2>
        <div class="btn-row"><button class="btn btn-ink" data-act="add-spot" data-cat="${cat}">${icon("plus", 18)} 직접 담기</button>
        <button class="btn btn-line" data-act="recommend" data-cat="${cat}" ${busy() ? "disabled" : ""}>${icon("sparkles", 18)} AI 추천</button></div></div>`}`;
}

function spotCard(i) {
  const n = mediaOf(i.id).length;
  return `<article class="spot ${i.done ? "done" : ""}" style="--cat:${CATS[i.category].color}">
    <button class="spot-img" data-act="spot-open" data-id="${i.id}" ${bgAttrs(i)} aria-label="${esc(i.name)} 자세히">
      ${icon(CATS[i.category].ic, 30, "fallback-ic")}
      ${n ? `<span class="spot-media">${icon("image", 13)} ${n}</span>` : ""}
      ${i.done ? `<span class="stamp">VISITED<br><small>${esc(md((i.done_at || "").slice(0, 10)))}</small></span>` : ""}
    </button>
    ${checkBtn(i)}
    <button class="spot-text" data-act="spot-open" data-id="${i.id}">
      <small style="color:var(--cat)">${CATS[i.category].label}${i.area ? ` · ${esc(i.area)}` : ""}</small>
      <b>${esc(i.name)}</b>
      ${i.note ? `<span class="clamp">${esc(i.note)}</span>` : ""}
      <small class="muted">${esc([i.day_date ? `${md(i.day_date)} ${wdEn(i.day_date)}` : "", i.time].filter(Boolean).join(" · "))}</small>
    </button>
  </article>`;
}

/** 스팟 상세 (바텀시트). 모든 칸은 자동 저장 */
function openSpot(id) {
  const draw = () => {
    const i = itemById(id);
    if (!i) return closeSheet();
    const media = mediaOf(id);
    const t = trip();
    const q = spotQuery(i, t);
    sheet.el.innerHTML = `
      <div class="detail-img" style="--cat:${CATS[i.category].color}" ${media.length ? "" : wikiAttrs(i)}>
        ${media.length ? `<div class="strip big">${media.map(thumbTile).join("")}</div>` : icon(CATS[i.category].ic, 40, "fallback-ic")}
      </div>
      <p class="eyebrow" style="color:var(--cat)">${CATS[i.category].en}</p>
      <input class="input-line title-input" data-f="name" value="${esc(i.name)}" maxlength="200" aria-label="이름">
      <div class="btn-row">
        <button class="btn grow ${i.done ? "btn-accent" : "btn-ink"}" data-act="visit" data-id="${id}">${icon("check", 18)} ${i.done ? "다녀왔어요" : "방문 체크"}</button>
        <button class="btn btn-line" data-act="upload" data-item="${id}" aria-label="사진·영상 올리기">${icon("camera", 18)} 올리기</button>
      </div>
      ${i.done ? `<p class="hint center">${esc(stamp(i.done_at))} · ${esc(i.done_by || "")} 기록</p>` : ""}

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

      <div class="link-row">
        <a href="${mapsUrl(q)}" target="_blank" rel="noopener">${icon("map", 18)}<span>지도</span></a>
        <a href="${imageSearchUrl(q)}" target="_blank" rel="noopener">${icon("image", 18)}<span>사진</span></a>
        <a href="${ytSearchUrl(`${i.name} ${t.destination || ""}`)}" target="_blank" rel="noopener">${icon("play", 18)}<span>유튜브</span></a>
      </div>
      <p class="hint">${i.origin === "ai" ? `AI 추천 · ${srcMark(i)}` : `직접 담음${i.created_by ? ` · ${esc(i.created_by)}` : ""}`}</p>
      <button class="btn btn-block btn-ghost danger" data-act="del-item" data-id="${id}">${icon("trash", 16)} 삭제</button>`;
    lazyWiki(sheet.el);
    bindAutosave(sheet.el, (patch) => rpc("upsert_item", { p_trip: T.id, p_item: { id, ...patch } }));
  };
  const sheet = openSheet("", { onClose: closed, flush: true });
  T.afterReload = () => sheetIsOpen() && draw();
  draw();
}

function closed() {
  if (!T) return;
  T.afterReload = null;
  if (T.pending) apply(T.pending);
  else render();
}

function dayOptions(selected) {
  return `<option value="">날짜 미정</option>` + days().map((d, i) =>
    `<option value="${d}" ${d === selected ? "selected" : ""}>Day ${i + 1} · ${dayLabel(d)}</option>`).join("");
}

function bindAutosave(root, save) {
  const state = $("[data-save-state]", root);
  const run = async (el) => {
    const v = el.type === "checkbox" ? el.checked : el.value;
    if (el.dataset.f === "name" && !String(v).trim()) return state && (state.textContent = "이름은 비워 둘 수 없어요");
    state && (state.textContent = "저장 중…");
    try {
      await save({ [el.dataset.f]: v });
      state && (state.textContent = "저장됨");
      const data = await rpc("get_trip", { p_trip: T.id });
      if (data) {
        T.data = data;
        T.pending = data;
      }
    } catch (e) {
      state && (state.textContent = `저장 실패: ${e.message}`);
    }
  };
  $$("[data-f]", root).forEach((el) => {
    const instant = el.tagName === "SELECT" || el.type === "checkbox";
    el.addEventListener(instant ? "change" : "input", instant ? () => run(el) : debounce(() => run(el), 700));
  });
}

function openAddSpot(cat, day) {
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
      <textarea class="input" name="note" rows="2" maxlength="2000" placeholder="메모 · 메뉴 · 링크"></textarea>
      <button class="btn btn-ink btn-block" type="submit">담기</button>
    </form>`, { onClose: closed });
  const form = $("[data-add-spot]", s.el);
  setTimeout(() => form.name.focus(), 250);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const by = await askName();
    try {
      const id = await rpc("upsert_item", { p_trip: T.id, p_item: Object.fromEntries(new FormData(form)), p_by: by });
      T.data = await rpc("get_trip", { p_trip: T.id });
      toast("담았어요");
      openSpot(id);
    } catch (err) {
      toast(err.message);
    }
  });
}

function openRecommend(cat) {
  const label = cat ? CATS[cat].label : "스팟";
  const s = openSheet(`
    <p class="eyebrow">${icon("sparkles", 14)} AI PICK</p><h2 class="sheet-title">${esc(label)} 더 추천받기</h2>
    <p class="muted">이미 담긴 곳은 빼고 골라 와요. 추천은 목록에 더해지기만 해요.</p>
    <form class="stack" data-reco>
      <div class="seg wide">${[3, 5, 8].map((n) => `<label><input type="radio" name="count" value="${n}" ${n === 5 ? "checked" : ""}><span>${n}곳</span></label>`).join("")}</div>
      <input class="input" name="request" maxlength="300" placeholder="원하는 느낌 (예: 현지인 맛집, 야경, 비 오는 날)">
      <label class="check-line"><input type="checkbox" name="web" checked> 웹에서 최신 정보 확인</label>
      <button class="btn btn-ink btn-block" type="submit">추천 요청</button>
      <p class="hint center">소유자 PC의 작업기가 처리해요 · 보통 1~5분</p>
    </form>`, { onClose: closed });
  $("[data-reco]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await rpc("request_job", { p_trip: T.id, p_type: "recommend", p_params: {
        category: cat || "any", count: Number(f.count.value), request: f.request.value.trim(), web_search: f.web.checked,
      } });
      s.close(true);
      toast("추천을 요청했어요");
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

function openSchedule(id, day) {
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

// ---------- 앨범 ----------
function album() {
  const media = T.data.media;
  const groups = {};
  media.forEach((m) => (groups[m.day_date || ""] ||= []).push(m));
  const ds = days();
  const keys = Object.keys(groups).sort((a, b) => (a || "9").localeCompare(b || "9"));
  return `
    <div class="spots-hd"><p class="eyebrow">ALBUM</p><h1>앨범 <span class="count">${media.length}</span></h1>
      <p class="muted">카드와 일정에서 올린 사진·영상도 여기 모여요.</p></div>
    <button class="upload-bar" data-act="upload">${icon("upload", 20)}<span><b>사진·영상 올리기</b><small>사진은 자동으로 줄여 저장 · 영상은 50MB까지</small></span></button>
    ${media.length ? keys.map((k) => `<section class="album-day">
      <header class="album-hd">${k ? `<span class="day-num sm">${pad2(ds.indexOf(k) + 1 || 0)}</span><b>${dayLabel(k)}</b>` : `<b>날짜 없음</b>`}<small class="muted">${groups[k].length}</small></header>
      <div class="album-grid">${groups[k].map((m) => {
        const it = m.item_id && itemById(m.item_id);
        return `<div class="album-cell">${thumbTile(m)}${it ? `<span class="album-tag">${esc(it.name)}</span>` : ""}</div>`;
      }).join("")}</div></section>`).join("")
      : `<div class="empty"><p class="eyebrow">NO PHOTOS YET</p><h2>여행의 순간을 모아 보세요</h2></div>`}`;
}

function openMedia(id) {
  const list = [...T.data.media].sort((a, b) => (a.day_date || "9").localeCompare(b.day_date || "9") || a.created_at.localeCompare(b.created_at));
  const view = list.map((m) => {
    const it = m.item_id && itemById(m.item_id);
    return { id: m.id, path: m.path, src: fileUrl(m.path), kind: m.kind, caption: m.caption || "",
      meta: [m.day_date ? dayLabel(m.day_date) : "", it ? it.name : "", m.by_name, timeAgo(m.created_at)].filter(Boolean).join(" · ") };
  });
  openViewer(view, Math.max(0, view.findIndex((v) => v.id === id)), {
    onCaption: (i, text) => rpc("update_media", { p_trip: T.id, p_media: view[i].id, p_caption: text }).catch((e) => toast(e.message)),
    onDelete: async (i) => {
      const path = await rpc("delete_media", { p_trip: T.id, p_media: view[i].id });
      await deleteFiles([path]);
    },
    onCover: (i) => view[i].kind === "photo"
      ? rpc("update_trip", { p_trip: T.id, p_patch: { cover_path: view[i].path } }).then(() => toast("표지로 정했어요"))
      : toast("표지는 사진만 가능해요"),
    onClose: () => reload(),
  });
}

function pickAndUpload({ itemId = null, day = null } = {}) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,video/*";
  input.multiple = true;
  input.addEventListener("change", async () => {
    const files = [...input.files];
    if (!files.length) return;
    const by = await askName();
    const fallbackDay = day || (phase(trip()).kind === "during" ? todayISO() : null);
    let ok = 0;
    for (const [n, f] of files.entries()) {
      try {
        const { path, kind } = await uploadFile(T.id, f, (p) => toast(`올리는 중 ${n + 1}/${files.length} · ${Math.round(p * 100)}%`));
        await rpc("add_media", { p_trip: T.id, p_item: itemId, p_kind: kind, p_path: path, p_caption: null, p_by: by, p_day: itemId ? null : fallbackDay });
        ok++;
      } catch (e) {
        toast(`${f.name}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 1800));
      }
    }
    if (ok) toast(`${ok}개 올렸어요`);
    await reload();
  });
  input.click();
}

// ---------- 예산 ----------
function budget() {
  const t = trip();
  const b = t.budget || {};
  const ex = T.data.expenses;
  const spent = ex.reduce((a, e) => a + e.amount, 0);
  const left = b.total != null ? b.total - spent : null;
  const pct = b.total ? Math.min(100, (spent / b.total) * 100) : 0;
  const byCat = Object.entries(EXP_CATS).map(([k, [l, ic]]) => [l, ic, ex.filter((e) => (e.category || "etc") === k).reduce((a, e) => a + e.amount, 0)]).filter(([, , v]) => v);
  const groups = {};
  ex.forEach((e) => (groups[e.day_date || ""] ||= []).push(e));
  const est = t.summary?.budget_estimate || [];

  return `
    <div class="money">
      <p class="eyebrow">${left === null ? "SPENT" : left >= 0 ? "LEFT" : "OVER BUDGET"}</p>
      <p class="big ${left !== null && left < 0 ? "danger" : ""}">${won(left === null ? spent : Math.abs(left))}<small>원</small></p>
      ${b.total != null ? `<div class="bar ${left < 0 ? "over" : ""}"><span style="width:${pct}%"></span></div>
        <p class="money-sub"><span>지출 ${won(spent)}원</span><span>예산 ${won(b.total)}원</span></p>`
        : `<p class="muted">총예산을 정하면 남은 돈이 보여요. <button class="link" data-act="budget-set">예산 정하기</button></p>`}
    </div>
    <div class="btn-row"><button class="btn btn-ink grow" data-act="exp-add">${icon("plus", 18)} 지출 기록</button>
      <button class="btn btn-line" data-act="budget-set">${icon("pencil", 16)} 예산</button></div>
    ${b.currency && b.rate ? `<div class="converter">${icon("globe", 18)}
      <input class="input" type="number" inputmode="decimal" min="0" step="any" placeholder="${esc(b.currency)}" data-convert>
      <span>=</span><b data-convert-out>0원</b><small class="muted">1 ${esc(b.currency)} = ${b.rate}원</small></div>` : ""}
    ${byCat.length ? `<section class="sec">${secHead("어디에 썼나", "BREAKDOWN")}${byCat.map(([l, ic, v]) =>
      `<div class="cat-bar">${icon(ic, 16)}<span>${l}</span><span class="bar"><span style="width:${(v / spent) * 100}%"></span></span><b>${won(v)}</b></div>`).join("")}</section>` : ""}
    ${ex.length ? `<section class="sec">${secHead("지출 내역", "EXPENSES")}${Object.keys(groups).sort((a, z) => (z || "0").localeCompare(a || "0")).map((k) => `
      <p class="list-hd"><span>${k ? dayLabel(k) : "날짜 없음"}</span><span>${won(groups[k].reduce((a, e) => a + e.amount, 0))}원</span></p>
      <ul class="list">${groups[k].map((e) => `<li data-act="exp-open" data-id="${e.id}">
        <span class="list-ic">${icon((EXP_CATS[e.category] || EXP_CATS.etc)[1], 18)}</span>
        <span class="grow">${esc(e.title)}<small>${esc(e.by_name || "")}</small></span><b>${won(e.amount)}</b></li>`).join("")}</ul>`).join("")}</section>`
      : `<p class="muted center">쓴 돈을 기록하면 남은 예산이 자동으로 계산돼요.</p>`}
    ${est.length ? `<details class="sec fold"><summary>${secHead(`AI 예상 예산 · ${won(est.reduce((a, x) => a + (x.amount_krw || 0), 0))}원`, "ESTIMATE")}</summary>
      <ul class="plain small">${est.map((x) => `<li>${esc(x.item)} — ${x.amount_krw ? `${won(x.amount_krw)}원` : "미정"} <span class="muted">${esc(x.note || "")}</span></li>`).join("")}</ul></details>` : ""}`;
}

function openExpense(id) {
  const e = id ? T.data.expenses.find((x) => x.id === id) : { title: "", amount: "", category: "food", day_date: phase(trip()).kind === "during" ? todayISO() : "" };
  const b = trip().budget || {};
  const s = openSheet(`
    <p class="eyebrow">EXPENSE</p><h2 class="sheet-title">${id ? "지출 고치기" : "얼마 썼어요?"}</h2>
    <form class="stack" data-exp>
      <div class="amount-row"><input class="input input-xl" name="amount" type="number" inputmode="decimal" min="0" step="any" required value="${e.amount}" placeholder="0">
        ${b.currency && b.rate ? `<div class="seg"><label><input type="radio" name="cur" value="KRW" checked><span>원</span></label>
          <label><input type="radio" name="cur" value="LOCAL"><span>${esc(b.currency)}</span></label></div>` : `<span class="unit">원</span>`}</div>
      <p class="hint" data-conv-hint></p>
      <input class="input" name="title" required maxlength="100" value="${esc(e.title)}" placeholder="무엇에? (예: 점심 라멘)">
      <div class="chips">${Object.entries(EXP_CATS).map(([k, [l, ic]]) =>
        `<label class="chip-radio"><input type="radio" name="category" value="${k}" ${k === (e.category || "etc") ? "checked" : ""}><span>${icon(ic, 15)} ${l}</span></label>`).join("")}</div>
      <div class="field"><label>날짜</label><select class="input" name="day_date">${dayOptions(e.day_date)}</select></div>
      <button class="btn btn-ink btn-block" type="submit">저장</button>
      ${id ? `<button class="btn btn-block btn-ghost danger" type="button" data-act="del-exp" data-id="${id}">${icon("trash", 16)} 삭제</button>` : ""}
    </form>`, { onClose: closed });
  const form = $("[data-exp]", s.el);
  const hint = () => {
    const local = form.cur?.value === "LOCAL";
    $("[data-conv-hint]", form).textContent = local ? `= ${won(Math.round((Number(form.amount.value) || 0) * b.rate))}원으로 저장돼요` : "";
  };
  form.addEventListener("input", hint);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const amount = fd.cur === "LOCAL" ? Math.round(Number(fd.amount) * b.rate) : Math.round(Number(fd.amount));
    try {
      await rpc("upsert_expense", { p_trip: T.id, p_exp: { id: id || null, title: fd.title, amount, category: fd.category, day_date: fd.day_date }, p_by: await askName() });
      s.close();
      toast("저장했어요");
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

function openBudgetSettings() {
  const b = trip().budget || {};
  const s = openSheet(`
    <p class="eyebrow">BUDGET</p><h2 class="sheet-title">예산 정하기</h2>
    <form class="stack" data-bset>
      <div class="field"><label>총예산 (원, 전체 인원)</label><input class="input input-lg" name="total" type="number" inputmode="numeric" min="0" step="10000" value="${b.total ?? ""}"></div>
      <div class="grid2">
        <div class="field"><label>현지 통화</label><input class="input" name="currency" maxlength="10" value="${esc(b.currency || "")}" placeholder="JPY"></div>
        <div class="field"><label>1 현지통화 = ?원</label><input class="input" name="rate" type="number" inputmode="decimal" min="0" step="any" value="${b.rate ?? ""}" placeholder="9.1"></div>
      </div>
      <p class="hint">환율은 환전할 때 받은 값으로 넣으면 정확해요.</p>
      <button class="btn btn-ink btn-block" type="submit">저장</button>
    </form>`, { onClose: closed });
  $("[data-bset]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await rpc("update_trip", { p_trip: T.id, p_patch: { budget: { total: f.total.value || null, currency: f.currency.value || null, rate: f.rate.value || null } } });
      s.close();
      toast("저장했어요");
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- 준비 ----------
function prep() {
  const sec = (cat, title, en, ph) => {
    const list = items(cat);
    const done = list.filter((i) => i.done).length;
    return `<section class="sec">
      ${secHead(title, en, `<span class="muted small">${done} / ${list.length}</span>`)}
      <div class="bar"><span style="width:${list.length ? (done / list.length) * 100 : 0}%"></span></div>
      <ul class="checklist">${list.map((i) => `<li class="${i.done ? "done" : ""}">
        <button class="check ${i.done ? "on" : ""}" data-act="toggle-done" data-id="${i.id}" aria-pressed="${i.done}" aria-label="${esc(i.name)}">${icon("check", 16)}</button>
        <span class="grow" data-act="prep-edit" data-id="${i.id}">${esc(i.name)}</span></li>`).join("")}</ul>
      <form class="add-line" data-prep-add="${cat}"><input class="input-line" name="name" maxlength="200" placeholder="${ph}">
        <button class="icon-btn" type="submit" aria-label="추가">${icon("plus", 22)}</button></form>
    </section>`;
  };
  const em = trip().summary?.emergency || [];
  return `<div class="spots-hd"><p class="eyebrow">BEFORE YOU GO</p><h1>떠나기 전에</h1></div>
    ${sec("todo", "할 일", "TO DO", "할 일 추가 (예: 환전, eSIM)")}
    ${sec("packing", "짐 싸기", "PACKING", "챙길 것 추가 (예: 멀티어댑터)")}
    ${em.length ? `<section class="sec">${secHead("비상 연락", "EMERGENCY")}<ul class="plain">${em.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}`;
}

function openPrepEdit(id) {
  const i = itemById(id);
  const s = openSheet(`<p class="eyebrow">EDIT</p><h2 class="sheet-title">고치기</h2>
    <form class="stack" data-pedit><input class="input input-lg" name="name" value="${esc(i.name)}" maxlength="200" required>
      <button class="btn btn-ink btn-block" type="submit">저장</button>
      <button class="btn btn-block btn-ghost danger" type="button" data-act="del-item" data-id="${id}">${icon("trash", 16)} 삭제</button></form>`, { onClose: closed });
  $("[data-pedit]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await rpc("upsert_item", { p_trip: T.id, p_item: { id, name: e.target.name.value } });
      s.close();
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- 여행 정보·메뉴 ----------
function openEditTrip() {
  const t = trip();
  const s = openSheet(`
    <p class="eyebrow">TRIP</p><h2 class="sheet-title">여행 정보</h2>
    <form class="stack" data-trip-edit>
      <input class="input input-lg" name="title" value="${esc(t.title)}" maxlength="120" required aria-label="여행 이름">
      <div class="field"><label>목적지</label><input class="input" name="destination" value="${esc(t.destination || "")}" maxlength="120"></div>
      <div class="grid2">
        <div class="field"><label>출발</label><input class="input" type="date" name="start_date" value="${t.start_date || ""}"></div>
        <div class="field"><label>도착</label><input class="input" type="date" name="end_date" value="${t.end_date || ""}"></div>
      </div>
      <div class="field"><label>함께 가는 사람</label><input class="input" name="companions" value="${esc(t.companions || "")}" maxlength="200"></div>
      <button class="btn btn-ink btn-block" type="submit">저장</button>
    </form>`, { onClose: closed });
  $("[data-trip-edit]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await rpc("update_trip", { p_trip: T.id, p_patch: Object.fromEntries(new FormData(e.target)) });
      s.close();
      toast("저장했어요");
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

function openBookings() {
  const s = openSheet(`<p class="eyebrow">BOOKED</p><h2 class="sheet-title">확정 예약</h2>
    <p class="muted">항공편·숙소·공연 예약을 원문 그대로 적어 두세요. AI가 바꾸지 않아요.</p>
    <form class="stack" data-book><textarea class="input mono" name="b" rows="8" maxlength="4000"
      placeholder="KE723 04/02 09:00 ICN→KIX (예약번호 ABC123)&#10;난바 OO호텔 3박">${esc(trip().bookings || "")}</textarea>
      <button class="btn btn-ink btn-block" type="submit">저장</button></form>`, { onClose: closed });
  $("[data-book]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await rpc("update_trip", { p_trip: T.id, p_patch: { bookings: e.target.b.value.trim() } });
      s.close();
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

const shareLink = () => `${location.origin}${location.pathname}#/trip/${T.id}`;

function openMenu() {
  openSheet(`<p class="eyebrow">MENU</p><h2 class="sheet-title">${esc(trip().title)}</h2>
    <div class="menu-list">
      <button data-act="share">${icon("share", 20)}<span>공유 링크 복사<small>함께 갈 사람에게 이 링크만 보내세요</small></span></button>
      <button data-act="edit-trip">${icon("pencil", 20)}<span>여행 정보 고치기</span></button>
      <button data-tab="record">${icon("film", 20)}<span>여행 기록 만들기<small>블로그 글 · 여행 영상</small></span></button>
      <button data-act="export">${icon("download", 20)}<span>백업 내보내기 (JSON)</span></button>
      <button data-act="print">${icon("printer", 20)}<span>인쇄 / PDF</span></button>
      ${isOwner() ? `<button class="danger" data-act="delete-trip">${icon("trash", 20)}<span>여행 삭제</span></button>`
        : `<a href="#/login">${icon("key", 20)}<span>소유자 로그인</span></a>`}
    </div>`, { onClose: closed });
}

// ---------- 클릭 처리 ----------
document.addEventListener("click", async (e) => {
  if (!T) return;
  const el = e.target.closest("[data-act],[data-tab]");
  if (!el || !document.body.contains(el)) return;
  if (el.dataset.tab && !el.dataset.act) {
    if (sheetIsOpen()) closeSheet();
    T.tab = el.dataset.tab;
    T.sub = "";
    store(`tab:${T.id}`, T.tab);
    history.replaceState(null, "", `#/trip/${T.id}/${T.tab}`);
    render();
    window.scrollTo(0, 0);
    return;
  }
  const a = el.dataset.act;
  const id = el.dataset.id;
  switch (a) {
    case "menu": return openMenu();
    case "edit-trip": closeSheet(); return openEditTrip();
    case "edit-bookings": return openBookings();
    case "share":
      try {
        await navigator.clipboard.writeText(shareLink());
        toast("링크를 복사했어요");
      } catch {
        prompt("이 링크를 복사해 보내 주세요", shareLink());
      }
      return;
    case "go-cat":
    case "go-undated":
      if (sheetIsOpen()) closeSheet();
      T.tab = "spots";
      T.sub = a === "go-undated" ? "undated" : el.dataset.cat;
      history.replaceState(null, "", `#/trip/${T.id}/spots${T.sub && T.sub !== "undated" ? `/${T.sub}` : ""}`);
      render();
      return window.scrollTo(0, 0);
    case "vis-filter":
      T.filter = el.dataset.v;
      store("spotFilter", T.filter);
      return render();
    case "spot-open": return openSpot(id);
    case "add-spot": return openAddSpot(el.dataset.cat, el.dataset.day);
    case "recommend": return openRecommend(el.dataset.cat);
    case "set-cat": return act(() => rpc("upsert_item", { p_trip: T.id, p_item: { id, category: el.dataset.cat } }));
    case "visit": {
      const it = itemById(id);
      const by = await askName();
      el.classList.toggle("on", !it.done);
      return act(() => rpc("set_done", { p_trip: T.id, p_item: id, p_done: !it.done, p_by: by }), it.done ? "방문 취소" : "다녀왔어요 ✓");
    }
    case "toggle-done": {
      const it = itemById(id);
      const by = await askName();
      el.classList.toggle("on", !it.done);
      return act(() => rpc("set_done", { p_trip: T.id, p_item: id, p_done: !it.done, p_by: by }));
    }
    case "del-item":
      if (!confirm("삭제할까요? (올린 사진·영상은 앨범에 남아요)")) return;
      closeSheet();
      return act(() => rpc("delete_item", { p_trip: T.id, p_item: id }), "삭제했어요");
    case "sched-open": return openSchedule(id);
    case "add-schedule": return openSchedule(null, el.dataset.day);
    case "day-jump": {
      const target = $(`#day-${el.dataset.day}`);
      target?.closest("details")?.setAttribute("open", "");
      return target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    case "upload": return pickAndUpload({ itemId: el.dataset.item || null, day: el.dataset.day || null });
    case "media-open": return openMedia(id);
    case "exp-add": return openExpense(null);
    case "exp-open": return openExpense(id);
    case "del-exp":
      if (!confirm("이 지출을 삭제할까요?")) return;
      closeSheet();
      return act(() => rpc("delete_expense", { p_trip: T.id, p_exp: id }), "삭제했어요");
    case "budget-set": return openBudgetSettings();
    case "prep-edit": return openPrepEdit(id);
    case "yt": {
      const v = (trip().summary?.videos || []).find((x) => x.id === el.dataset.vid);
      return v && openYouTube(v);
    }
    case "ai-plan":
      return act(() => rpc("request_job", { p_trip: T.id, p_type: "plan", p_params: {} }), "AI 추천을 요청했어요");
    case "cancel-job":
      if (!confirm("AI 작업을 취소할까요?")) return;
      return act(() => rpc("cancel_job", { p_trip: T.id }), "취소했어요");
    case "retry-job": {
      const job = trip().job || { type: "plan", params: {} };
      return act(() => rpc("request_job", { p_trip: T.id, p_type: job.type, p_params: job.params || {} }), "다시 요청했어요");
    }
    case "export": {
      const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), ...T.data }, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${trip().title.replace(/[\\/:*?"<>|]/g, "_")}.json`;
      link.click();
      return setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    case "print": closeSheet(); return setTimeout(() => window.print(), 300);
    case "delete-trip":
      if (!confirm(`'${trip().title}' 여행을 삭제할까요? 스팟·사진·영상·지출까지 모두 지워지고 되돌릴 수 없어요.`)) return;
      try {
        await deleteFiles(T.data.media.map((m) => m.path));
        await ownerRpc("delete_trip", { p_trip: T.id });
        forget(T.id);
        closeSheet();
        location.hash = "#/";
      } catch (err) {
        toast(err.message);
      }
      return;
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-prep-add]");
  if (!T || !form) return;
  e.preventDefault();
  const name = form.name.value.trim();
  if (!name) return;
  form.name.value = "";
  const by = await askName();
  await act(() => rpc("upsert_item", { p_trip: T.id, p_item: { category: form.dataset.prepAdd, name }, p_by: by }));
  $(`[data-prep-add="${form.dataset.prepAdd}"] input`)?.focus();
});

const saveDay = debounce(async (el) => {
  try {
    await rpc("set_day", { p_trip: T.id, p_date: el.dataset.day, p_patch: { [el.dataset.dayField]: el.value } });
    const dd = T.data.days.find((x) => x.day_date === el.dataset.day);
    if (dd) dd[el.dataset.dayField] = el.value;
    else T.data.days.push({ day_date: el.dataset.day, [el.dataset.dayField]: el.value });
    toast("저장됨");
  } catch (err) {
    toast(err.message);
  }
}, 900);

document.addEventListener("input", (e) => {
  if (!T) return;
  const el = e.target;
  if (el.dataset.dayField) saveDay(el);
  if (el.matches("[data-convert]")) {
    const rate = trip().budget?.rate || 0;
    $("[data-convert-out]").textContent = `${won(Math.round((Number(el.value) || 0) * rate))}원`;
  }
});

export const tripApi = { reload, pickAndUpload, trip: () => T && trip(), data: () => T?.data, id: () => T?.id, busy };
