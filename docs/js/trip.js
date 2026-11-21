/* 여행 화면: 개요 · 일정 · 스팟 · 앨범 · 예산 · 준비 (+ 기록 만들기는 record.js) */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js";
import { isMaking, renderRecord } from "./record.js";
import { askName, closeSheet, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wd, won, ytSearchUrl,
} from "./util.js";
import { commonsImages, lazyWiki } from "./wiki.js";

const $app = document.getElementById("app");
const TABS = [
  ["overview", "🏠", "개요"],
  ["schedule", "📅", "일정"],
  ["spots", "📍", "스팟"],
  ["album", "🖼️", "앨범"],
  ["budget", "💰", "예산"],
  ["prep", "🧳", "준비"],
];
const EXP_CATS = { food: "🍽️ 식비", transport: "🚌 교통", stay: "🏨 숙소", shopping: "🛍️ 쇼핑", ticket: "🎟️ 입장·체험", etc: "💳 기타" };
const STYLE_JOB = { plan: "새 여행 추천", recommend: "추천 더 받기", blog: "블로그 글 쓰기" };

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
    $app.innerHTML = errorPage(`여행을 불러오지 못했어요: ${e.message}`);
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

/** 내가 바꾼 뒤 즉시 다시 불러오기 */
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
  if (i.category === "food" || i.category === "cafe") return "";
  return `data-wiki="${esc(i.name)}" data-wiki-en="${esc(i.search_query || "")}"`;
}

function thumbOf(item) {
  const photo = mediaOf(item.id).find((m) => m.kind === "photo");
  return photo ? fileUrl(photo.path) : "";
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

const errorPage = (msg) => `<div class="page"><div class="empty"><div class="emoji">🔍</div><p>${esc(msg)}</p>
  <a class="btn" href="#/">처음으로</a></div></div>`;

async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    await reload();
  } catch (e) {
    toast(e.message);
  }
}

// ---------- 전체 틀 ----------
function render() {
  const t = trip();
  if (T.tab === "record") {
    $app.innerHTML = renderRecord(T, { header: header(true) });
    afterRender();
    return;
  }
  const valid = TABS.map(([k]) => k);
  if (!valid.includes(T.tab)) T.tab = "overview";
  const view = { overview, schedule: scheduleTab, spots: spotsTab, album, budget, prep }[T.tab]();
  $app.innerHTML = `
    ${header()}
    ${jobBanner()}
    <main class="tab-body">${view}</main>
    ${T.tab === "spots" ? `<button class="fab" data-act="add-spot" data-cat="${esc(T.sub || "")}" aria-label="스팟 추가">＋</button>` : ""}
    <nav class="bottom-nav" aria-label="여행 메뉴">${TABS.map(([k, icon, label]) =>
      `<button class="${k === T.tab ? "active" : ""}" data-tab="${k}" aria-current="${k === T.tab}"><span>${icon}</span>${label}</button>`).join("")}</nav>`;
  document.title = `${t.title} · 여행 계획`;
  afterRender();
}

function afterRender() {
  lazyWiki($app);
  if (T.tab === "overview") fillCommons();
}

function header(back = false) {
  const t = trip();
  return `<header class="app-header">
    ${back ? `<button class="icon-btn" data-tab="overview" aria-label="뒤로">‹</button>`
      : isOwner() ? `<a class="icon-btn" href="#/" aria-label="내 여행">‹</a>` : `<span class="icon-btn ghost"></span>`}
    <button class="header-title" data-act="edit-trip">${esc(t.title)}</button>
    <button class="icon-btn" data-act="menu" aria-label="메뉴">⋯</button>
  </header>`;
}

function jobBanner() {
  const t = trip();
  if (busy()) {
    const what = STYLE_JOB[t.job?.type] || "AI 작업";
    return `<div class="banner">
      <div class="spinner sm"></div>
      <div class="grow"><strong>${t.status === "queued" ? `${what} 대기 중` : `AI가 ${what} 중`}</strong>
        <div class="small">${esc(t.progress || (t.status === "queued" ? "소유자 PC의 작업기가 켜지면 바로 시작해요" : "잠시만요…"))}</div></div>
      <button class="btn btn-sm" data-act="cancel-job">취소</button></div>`;
  }
  if (t.status === "error") {
    return `<div class="banner banner-error"><div class="grow"><strong>AI 작업이 실패했어요</strong>
      <div class="small">${esc((t.error || "").slice(0, 160))}</div></div>
      <button class="btn btn-sm" data-act="retry-job">다시 시도</button></div>`;
  }
  return "";
}

// ---------- 개요 ----------
function overview() {
  const t = trip();
  const s = t.summary || {};
  const ph = phase(t);
  const sp = spots();
  const visited = sp.filter((i) => i.done).length;
  const photos = T.data.media.filter((m) => m.kind === "photo").length;
  const videos = T.data.media.length - photos;
  const spent = T.data.expenses.reduce((a, e) => a + e.amount, 0);
  const total = t.budget?.total;
  const prepItems = T.data.items.filter((i) => i.category === "todo" || i.category === "packing");
  const prepDone = prepItems.filter((i) => i.done).length;
  const cover = coverOf();

  const today = ph.kind === "during" ? todayISO() : null;
  const todayList = today ? T.data.items.filter((i) => i.day_date === today && (i.category === "schedule" || isSpot(i))) : [];

  const stat = (icon, label, value, sub, pct, tab) => `<button class="stat" data-tab="${tab}">
    <span class="stat-icon">${icon}</span><span class="stat-label">${label}</span>
    <strong>${value}</strong>${sub ? `<span class="small muted">${sub}</span>` : ""}
    ${pct !== null ? `<span class="bar"><span style="width:${Math.min(100, pct)}%"></span></span>` : ""}</button>`;

  const alerts = (s.alerts || []).map((a) => (typeof a === "string" ? { text: a } : a));

  return `
    <section class="hero ${cover ? "has-img" : ""}" ${cover ? `style="background-image:url('${esc(cover)}')"`
      : `data-wiki="${esc(t.destination || t.title)}" data-wiki-en="${esc(s.destination_en || "")}"`}>
      <div class="hero-shade"></div>
      <div class="hero-text">
        <span class="chip chip-glass">${esc(ph.label)}</span>
        <h1 data-act="edit-trip">${esc(t.title)}</h1>
        <p>📍 ${esc(t.destination || "여행지 미정")} · ${esc(dateRange(t))}${t.companions ? ` · ${esc(t.companions)}` : ""}</p>
      </div>
    </section>

    ${today ? `<section class="card today">
      <div class="row-between"><h2 class="section-title">오늘 · ${esc(dayLabel(today))}</h2>
        <button class="link" data-tab="schedule">일정 전체 ›</button></div>
      ${todayList.length ? `<ul class="mini-list">${todayList.slice(0, 5).map((i) => `<li data-act="${i.category === "schedule" ? "sched-open" : "spot-open"}" data-id="${i.id}">
        <span>${i.category === "schedule" ? "🕒" : CATS[i.category].icon}</span><span class="grow">${esc(i.time ? `${i.time} ` : "")}${esc(i.name)}</span>
        ${isSpot(i) ? (i.done ? `<span class="chip chip-done">방문</span>` : "") : ""}</li>`).join("")}</ul>`
        : `<p class="muted small">오늘 잡힌 일정이 없어요.</p>`}
    </section>` : ""}

    <section class="stats">
      ${stat("📍", "방문", `${visited}<small>/${sp.length}</small>`, "", sp.length ? (visited / sp.length) * 100 : 0, "spots")}
      ${stat("🖼️", "사진·영상", `${photos + videos}`, `사진 ${photos} · 영상 ${videos}`, null, "album")}
      ${stat("💰", "지출", `${won(spent)}<small>원</small>`, total ? `예산 ${won(total)}원` : "예산 미설정", total ? (spent / total) * 100 : null, "budget")}
      ${stat("🧳", "준비", `${prepDone}<small>/${prepItems.length}</small>`, "", prepItems.length ? (prepDone / prepItems.length) * 100 : 0, "prep")}
    </section>

    ${!sp.length ? `<section class="card empty-cta">
      <h2 class="section-title">아직 스팟이 없어요</h2>
      <p class="muted">AI에게 추천을 받거나, 가고 싶은 곳을 직접 추가해 보세요.</p>
      <div class="btn-row"><button class="btn btn-primary" data-act="ai-plan" ${busy() ? "disabled" : ""}>✨ AI 추천 받기</button>
        <button class="btn" data-tab="spots">✍️ 직접 추가</button></div></section>` : ""}

    <section class="cat-tiles">${SPOT_KEYS.map((k) => {
      const list = sp.filter((i) => i.category === k);
      return `<button class="cat-tile" data-act="go-cat" data-cat="${k}" style="--cat:${CATS[k].color}">
        <span class="cat-emoji">${CATS[k].icon}</span><span>${CATS[k].label}</span>
        <small>${list.filter((i) => i.done).length}/${list.length}</small></button>`;
    }).join("")}</section>

    <section class="card">
      <div class="row-between"><h2 class="section-title">📌 확정 예약</h2><button class="link" data-act="edit-bookings">수정</button></div>
      <p class="hint">직접 입력한 원문 그대로예요. AI가 바꾸지 않아요.</p>
      ${t.bookings ? `<div class="quote">${linkify(t.bookings)}</div>` : `<p class="muted small">항공·숙소·공연 예약을 적어 두세요.</p>`}
    </section>

    ${alerts.length ? `<section class="card card-warn"><h2 class="section-title">⚠️ 미리 알아 둘 것</h2>
      <ul class="plain">${alerts.map((a) => `<li>${esc(a.text)} ${srcBadge(a)}</li>`).join("")}</ul></section>` : ""}

    <section class="block">
      <h2 class="section-title px">▶️ 여행 영상 미리 보기</h2>
      <div class="hscroll">${(s.videos || []).map((v) => `<button class="yt-card" data-act="yt" data-vid="${esc(v.id)}">
        <span class="yt-thumb" style="background-image:url('https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg')"><span class="yt-play">▶</span></span>
        <span class="yt-title">${esc(v.title)}</span><span class="small muted">${esc(v.author || "")}</span></button>`).join("")}
        ${videoQueries(s, t).map((q) => `<a class="yt-card" href="${ytSearchUrl(q)}" target="_blank" rel="noopener">
          <span class="yt-thumb yt-query" data-wiki="${esc(t.destination || t.title)}"><span class="yt-play">▶</span><span class="yt-q">${esc(q)}</span></span>
          <span class="yt-title">YouTube에서 '${esc(q)}' 보기</span></a>`).join("")}</div></section>

    <section class="block">
      <div class="row-between px"><h2 class="section-title">🌏 여행지 미리보기</h2>
        <a class="link" href="${imageSearchUrl(t.destination || t.title)}" target="_blank" rel="noopener">더 보기 ›</a></div>
      <div class="hscroll" data-commons="${esc(s.destination_en || t.destination || t.title)}"><div class="muted small px">사진 불러오는 중…</div></div>
    </section>

    ${(s.must_eat || []).length ? `<section class="card"><h2 class="section-title">😋 꼭 먹어볼 것</h2>
      <div class="chips">${s.must_eat.map((m) => `<span class="chip">${esc(m)}</span>`).join("")}</div></section>` : ""}

    ${(s.basic_info || []).length ? `<details class="card"><summary class="section-title">ℹ️ 기본 정보</summary>
      <ul class="plain">${s.basic_info.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></details>` : ""}

    <section class="card record-cta">
      <h2 class="section-title">🎞️ 여행 기록 남기기</h2>
      <p class="muted small">${ph.kind === "after" ? "여행이 끝났어요! 모은 기록으로 블로그 글과 영상을 만들어 보세요." : "여행이 끝나면 방문 기록·사진·영상으로 블로그 글과 영상을 만들 수 있어요."}</p>
      <div class="btn-row"><button class="btn ${ph.kind === "after" ? "btn-primary" : ""}" data-tab="record">✍️ 블로그 글 · 🎬 여행 영상</button></div>
    </section>

    ${s.researched_on || (s.sources || []).length ? `<details class="card"><summary class="small muted">🔎 AI 조사 ${esc(s.researched_on || "")} · 출처 ${(s.sources || []).length}개</summary>
      <ul class="plain small">${(s.sources || []).filter((x) => safeUrl(x.url)).map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a></li>`).join("")}</ul></details>` : ""}
  `;
}

function videoQueries(s, t) {
  const q = s.video_queries || [];
  const dest = (t.destination || t.title || "").split(/[·,]/)[0].trim();
  return q.length ? q : [`${dest} 여행 브이로그`, `${dest} 맛집`, `${dest} 가볼만한곳`];
}

async function fillCommons() {
  const box = $("[data-commons]", $app);
  if (!box) return;
  const list = await commonsImages(box.dataset.commons, 8);
  if (!$app.contains(box)) return;
  box.innerHTML = list.length
    ? list.map((p) => `<a class="photo-card" href="${esc(p.page)}" target="_blank" rel="noopener" style="background-image:url('${esc(p.thumb)}')">
        ${p.credit ? `<span>${esc(p.credit)}</span>` : ""}</a>`).join("")
    : `<p class="muted small px">사진을 찾지 못했어요. '더 보기'에서 확인해 보세요.</p>`;
}

function srcBadge(x) {
  if (x?.verified && safeUrl(x.source_url)) {
    return `<a class="badge badge-ok" href="${esc(x.source_url)}" target="_blank" rel="noopener">✓ 확인됨</a>`;
  }
  return `<span class="badge badge-muted" title="AI의 기억·추측이에요. 직접 확인해 주세요">미확인</span>`;
}

// ---------- 일정 ----------
function scheduleTab() {
  const ds = days();
  if (!ds.length) {
    return `<div class="page"><div class="empty"><div class="emoji">📅</div><p>여행 날짜를 정하면 날짜별 일정이 생겨요.</p>
      <button class="btn btn-primary" data-act="edit-trip">날짜 정하기</button></div></div>`;
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
      data-act="day-jump" data-day="${d}"><small>Day ${i + 1}</small><strong>${md(d)}</strong><small>${wd(d)}</small></button>`).join("")}</div>
    ${ph.kind === "during" ? `<p class="hint px">오늘 일정이 맨 위에 있어요. 지난 날은 아래에 모아 뒀어요.</p>` : ""}
    <div class="stack-lg">${order.map((d) => dayCard(d, ds.indexOf(d), d === today)).join("")}</div>
    ${past.length ? `<details class="past-days"><summary>지난 일정 ${past.length}일</summary>
      <div class="stack-lg">${past.map((d) => dayCard(d, ds.indexOf(d), false)).join("")}</div></details>` : ""}
    ${undated.length ? `<button class="card link-card" data-act="go-undated">📌 날짜 미정 스팟 ${undated.length}곳 — 날짜를 정해 보세요 ›</button>` : ""}`;
}

function dayCard(d, idx, isToday) {
  const dd = dayOf(d);
  const sched = T.data.items.filter((i) => i.category === "schedule" && i.day_date === d)
    .sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  const sp = spots().filter((i) => i.day_date === d);
  const mediaIds = new Set(sp.map((i) => i.id));
  const media = T.data.media.filter((m) => m.day_date === d || mediaIds.has(m.item_id));
  const route = routeUrl(sp, trip());

  return `<section class="card day-card ${isToday ? "is-today" : ""}" id="day-${d}">
    <div class="day-head">
      <div><span class="day-no">Day ${idx + 1}</span> <strong>${dayLabel(d)}</strong> ${isToday ? `<span class="chip chip-accent">오늘</span>` : ""}</div>
      <span class="small muted">${sp.filter((i) => i.done).length}/${sp.length} 방문</span>
    </div>
    <input class="input input-ghost day-title" data-day-field="title" data-day="${d}" value="${esc(dd.title || "")}" placeholder="이 날의 테마 (예: 도착 · 야경 산책)" maxlength="100">

    <div class="sub-head">🕒 시간 정해진 일정 <button class="link" data-act="add-schedule" data-day="${d}">＋ 추가</button></div>
    ${sched.length ? `<ul class="timeline">${sched.map((s) => `<li data-act="sched-open" data-id="${s.id}">
      <span class="time">${esc(s.time || "—")}</span><span class="grow">${esc(s.name)}</span></li>`).join("")}</ul>` : `<p class="muted small">없음</p>`}

    <div class="sub-head">📍 가볼 곳 <button class="link" data-act="add-spot" data-day="${d}">＋ 추가</button></div>
    ${sp.length ? `<ul class="spot-rows">${sp.map(spotRow).join("")}</ul>` : `<p class="muted small">아직 없어요. 스팟 탭에서 날짜를 정하거나 여기서 추가하세요.</p>`}
    ${route ? `<a class="link small" href="${route}" target="_blank" rel="noopener">🗺️ 구글 지도로 이 날 경로·이동 시간 보기</a>` : ""}

    <div class="sub-head">🖼️ 사진·영상 <button class="link" data-act="upload" data-day="${d}">＋ 올리기</button></div>
    ${media.length ? `<div class="thumb-strip">${media.slice(0, 12).map(thumbTile).join("")}</div>` : ""}

    <textarea class="input diary" data-day-field="diary" data-day="${d}" rows="3" maxlength="8000"
      placeholder="✍️ 오늘의 기록 — 무엇을 보고 느꼈나요? (자동 저장, 블로그 글에 쓰여요)">${esc(dd.diary || "")}</textarea>
  </section>`;
}

function spotRow(i) {
  return `<li class="spot-row ${i.done ? "done" : ""}">
    <button class="spot-row-main" data-act="spot-open" data-id="${i.id}">
      <span class="dot" style="--cat:${CATS[i.category].color}">${CATS[i.category].icon}</span>
      <span class="grow"><strong>${esc(i.name)}</strong><small class="muted">${esc([i.time, i.area].filter(Boolean).join(" · "))}</small></span>
    </button>
    ${visitBtn(i, true)}</li>`;
}

function visitBtn(i, compact = false) {
  return `<button class="visit ${i.done ? "on" : ""} ${compact ? "compact" : ""}" data-act="visit" data-id="${i.id}"
    aria-pressed="${i.done}" aria-label="${esc(i.name)} 방문 체크">${i.done ? "✓ 방문" : compact ? "방문" : "○ 방문 체크"}</button>`;
}

function thumbTile(m) {
  const url = fileUrl(m.path);
  return `<button class="thumb" data-act="media-open" data-id="${m.id}" aria-label="${m.kind === "video" ? "영상" : "사진"} 보기">
    ${m.kind === "video" ? `<video src="${esc(url)}#t=0.1" preload="metadata" muted playsinline></video><span class="play">▶</span>`
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
    <div class="chip-scroll">
      <button class="chip-btn ${!cat && !undatedOnly ? "on" : ""}" data-act="go-cat" data-cat="">전체 <small>${all.length}</small></button>
      ${SPOT_KEYS.map((k) => `<button class="chip-btn ${cat === k ? "on" : ""}" data-act="go-cat" data-cat="${k}" style="--cat:${CATS[k].color}">
        ${CATS[k].icon} ${CATS[k].label} <small>${all.filter((i) => i.category === k).length}</small></button>`).join("")}
      ${all.some((i) => !i.day_date) ? `<button class="chip-btn ${undatedOnly ? "on" : ""}" data-act="go-cat" data-cat="undated">📌 날짜 미정</button>` : ""}
    </div>
    <div class="row-between px toolbar">
      <div class="seg">${[["all", "전체"], ["todo", "안 가봄"], ["done", "방문함"]].map(([k, l]) =>
        `<button class="${T.filter === k ? "on" : ""}" data-act="vis-filter" data-v="${k}">${l}</button>`).join("")}</div>
      <button class="btn btn-sm btn-soft" data-act="recommend" data-cat="${cat}" ${busy() ? "disabled" : ""}>✨ ${esc(label)} AI 추천</button>
    </div>
    ${list.length ? `<div class="spot-grid">${list.map(spotCard).join("")}</div>`
      : `<div class="empty"><div class="emoji">${cat ? CATS[cat].icon : "🗺️"}</div>
        <p>${T.filter === "done" ? "아직 방문한 곳이 없어요." : `${esc(label)}가 아직 없어요.`}</p>
        <div class="btn-row"><button class="btn btn-primary" data-act="add-spot" data-cat="${cat}">＋ 직접 추가</button>
        <button class="btn" data-act="recommend" data-cat="${cat}" ${busy() ? "disabled" : ""}>✨ AI 추천</button></div></div>`}`;
}

function spotCard(i) {
  const thumb = thumbOf(i);
  const n = mediaOf(i.id).length;
  return `<article class="spot-card ${i.done ? "done" : ""}" style="--cat:${CATS[i.category].color}">
    <button class="spot-img ${thumb ? "has-img" : ""}" data-act="spot-open" data-id="${i.id}"
      ${thumb ? `style="background-image:url('${esc(thumb)}')"` : wikiAttrs(i)}
      aria-label="${esc(i.name)} 자세히">
      <span class="spot-fallback">${CATS[i.category].icon}</span>
      <span class="chip chip-cat">${CATS[i.category].icon} ${CATS[i.category].short}</span>
      ${i.done ? `<span class="stamp">VISITED</span>` : ""}
      ${n ? `<span class="media-count">📷 ${n}</span>` : ""}
    </button>
    <div class="spot-info" data-act="spot-open" data-id="${i.id}">
      <strong>${esc(i.name)}</strong>
      <small class="muted">${esc([i.day_date ? md(i.day_date) : "", i.area].filter(Boolean).join(" · ") || " ")}</small>
      ${i.note ? `<p class="clamp">${esc(i.note)}</p>` : ""}
      <div class="badges">${i.origin === "ai" ? `<span class="badge badge-ai">AI</span>${srcBadge(i)}` : `<span class="badge badge-user">직접</span>`}
        ${i.reservation_needed ? `<span class="badge badge-warn">예약</span>` : ""}</div>
    </div>
    ${visitBtn(i)}
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
      <div class="detail-hero ${media.length ? "" : "wiki"}" ${media.length ? "" : wikiAttrs(i)}>
        ${media.length ? `<div class="hscroll tight">${media.map(thumbTile).join("")}</div>` : `<span class="spot-fallback big">${CATS[i.category].icon}</span>`}
      </div>
      <div class="btn-row">
        <button class="btn btn-soft grow" data-act="upload" data-item="${id}">📷 사진·🎬 영상 올리기</button>
      </div>
      ${visitBtn(i).replace('class="visit', 'class="visit big')}
      ${i.done ? `<p class="hint center">${esc(stamp(i.done_at))} · ${esc(i.done_by || "")} 방문</p>` : ""}

      <div class="field"><label>이름</label><input class="input" data-f="name" value="${esc(i.name)}" maxlength="200"></div>
      <div class="field"><label>카테고리</label><div class="chips">${SPOT_KEYS.map((k) =>
        `<button class="chip-btn ${i.category === k ? "on" : ""}" data-act="set-cat" data-id="${id}" data-cat="${k}" style="--cat:${CATS[k].color}">${CATS[k].icon} ${CATS[k].short}</button>`).join("")}</div></div>
      <div class="grid2">
        <div class="field"><label>날짜</label><select class="input" data-f="day_date">${dayOptions(i.day_date)}</select></div>
        <div class="field"><label>시간</label><input class="input" data-f="time" value="${esc(i.time || "")}" placeholder="예: 오전, 18:00" maxlength="40"></div>
        <div class="field"><label>지역</label><input class="input" data-f="area" value="${esc(i.area || "")}" maxlength="100"></div>
        <div class="field"><label>가격</label><input class="input" data-f="price" value="${esc(i.price || "")}" maxlength="100"></div>
      </div>
      <div class="field"><label>메모</label><textarea class="input" data-f="note" rows="3" maxlength="2000">${esc(i.note || "")}</textarea></div>
      <label class="check-line"><input type="checkbox" data-f="reservation_needed" ${i.reservation_needed ? "checked" : ""}> 예약 필요</label>
      <p class="save-state small muted" data-save-state></p>

      <div class="link-grid">
        <a class="btn btn-sm" href="${mapsUrl(q)}" target="_blank" rel="noopener">🗺️ 지도</a>
        <a class="btn btn-sm" href="${imageSearchUrl(q)}" target="_blank" rel="noopener">🖼️ 사진 예시</a>
        <a class="btn btn-sm" href="${ytSearchUrl(`${i.name} ${t.destination || ""}`)}" target="_blank" rel="noopener">▶️ 유튜브</a>
      </div>
      <p class="small muted">${i.origin === "ai" ? `AI 추천 ${srcBadge(i)}` : `직접 추가${i.created_by ? ` · ${esc(i.created_by)}` : ""}`}</p>
      <button class="btn btn-block btn-danger-soft" data-act="del-item" data-id="${id}">이 스팟 삭제</button>`;
    lazyWiki(sheet.el);
    bindAutosave(sheet.el, (patch) => rpc("upsert_item", { p_trip: T.id, p_item: { id, ...patch } }));
  };
  const sheet = openSheet("", { onClose: closed });
  T.afterReload = () => sheetIsOpen() && draw();
  draw();
}

function closed() {
  T && (T.afterReload = null);
  if (T?.pending) apply(T.pending);
  else if (T) render();
}

function dayOptions(selected) {
  return `<option value="">날짜 미정</option>` + days().map((d, i) =>
    `<option value="${d}" ${d === selected ? "selected" : ""}>Day ${i + 1} · ${dayLabel(d)}</option>`).join("");
}

/** data-f 칸을 바꾸면 자동 저장 */
function bindAutosave(root, save) {
  const state = $("[data-save-state]", root);
  const run = async (el) => {
    const v = el.type === "checkbox" ? el.checked : el.value;
    if (el.dataset.f === "name" && !String(v).trim()) return state && (state.textContent = "이름은 비워 둘 수 없어요");
    state && (state.textContent = "저장 중…");
    try {
      await save({ [el.dataset.f]: v });
      state && (state.textContent = "✓ 저장됨");
      const data = await rpc("get_trip", { p_trip: T.id });
      if (data) {
        T.data = data;
        T.pending = data; // 시트를 닫으면 화면에 반영
      }
    } catch (e) {
      state && (state.textContent = `저장 실패: ${e.message}`);
    }
  };
  $$("[data-f]", root).forEach((el) => {
    const d = debounce(() => run(el), 700);
    el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", el.tagName === "SELECT" || el.type === "checkbox" ? () => run(el) : d);
  });
}

function openAddSpot(cat, day) {
  const s = openSheet(`
    <h2 class="sheet-title">스팟 추가</h2>
    <form class="stack" data-add-spot>
      <div class="field"><label>이름 *</label><input class="input" name="name" required maxlength="200" placeholder="예: 이치란 라멘 본점"></div>
      <div class="field"><label>카테고리</label><div class="chips">${SPOT_KEYS.map((k) => `<label class="chip-radio" style="--cat:${CATS[k].color}">
        <input type="radio" name="category" value="${k}" ${k === (cat || "place") ? "checked" : ""}><span>${CATS[k].icon} ${CATS[k].short}</span></label>`).join("")}</div></div>
      <div class="grid2">
        <div class="field"><label>날짜</label><select class="input" name="day_date">${dayOptions(day || "")}</select></div>
        <div class="field"><label>지역</label><input class="input" name="area" maxlength="100"></div>
      </div>
      <div class="field"><label>메모</label><textarea class="input" name="note" rows="2" maxlength="2000" placeholder="메뉴, 팁, 링크 등"></textarea></div>
      <button class="btn btn-primary btn-block" type="submit">추가</button>
    </form>`, { onClose: closed });
  const form = $("[data-add-spot]", s.el);
  setTimeout(() => form.name.focus(), 250);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const by = await askName();
    try {
      const fd = Object.fromEntries(new FormData(form));
      const id = await rpc("upsert_item", { p_trip: T.id, p_item: fd, p_by: by });
      T.data = await rpc("get_trip", { p_trip: T.id });
      toast("추가했어요");
      openSpot(id);
    } catch (err) {
      toast(err.message);
    }
  });
}

function openRecommend(cat) {
  const label = cat ? CATS[cat].label : "스팟";
  const s = openSheet(`
    <h2 class="sheet-title">✨ ${esc(label)} AI 추천 더 받기</h2>
    <p class="muted small">이미 목록에 있는 곳은 빼고 추천해요. 추천은 목록에 추가만 되고, 직접 고친 내용은 그대로예요.</p>
    <form class="stack" data-reco>
      <div class="field"><label>몇 곳?</label><div class="seg">${[3, 5, 8].map((n) =>
        `<label><input type="radio" name="count" value="${n}" ${n === 5 ? "checked" : ""}><span>${n}곳</span></label>`).join("")}</div></div>
      <div class="field"><label>원하는 느낌 (선택)</label>
        <input class="input" name="request" maxlength="300" placeholder="예: 현지인 맛집, 야경 좋은 곳, 비 오는 날 갈 곳"></div>
      <label class="check-line"><input type="checkbox" name="web" checked> 웹에서 최신 정보 확인 (조금 더 걸려요)</label>
      <button class="btn btn-primary btn-block" type="submit">추천 요청</button>
      <p class="hint">소유자 PC의 작업기가 처리해요. 보통 1~5분.</p>
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

// ---------- 일정 항목 ----------
function openSchedule(id, day) {
  const i = id ? itemById(id) : { name: "", time: "", day_date: day, note: "" };
  const s = openSheet(`
    <h2 class="sheet-title">${id ? "일정 수정" : "일정 추가"}</h2>
    <form class="stack" data-sched>
      <div class="field"><label>내용 *</label><input class="input" name="name" required maxlength="200" value="${esc(i.name)}" placeholder="예: 공항 도착, 체크인, 공연"></div>
      <div class="grid2">
        <div class="field"><label>날짜</label><select class="input" name="day_date">${dayOptions(i.day_date)}</select></div>
        <div class="field"><label>시간</label><input class="input" type="time" name="time" value="${esc(/^\d{1,2}:\d{2}$/.test(i.time || "") ? i.time.padStart(5, "0") : "")}"></div>
      </div>
      <div class="field"><label>메모</label><textarea class="input" name="note" rows="2" maxlength="2000">${esc(i.note || "")}</textarea></div>
      <button class="btn btn-primary btn-block" type="submit">저장</button>
      ${id ? `<button class="btn btn-block btn-danger-soft" type="button" data-act="del-item" data-id="${id}">삭제</button>` : ""}
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
    <section class="card upload-card">
      <h2 class="section-title">🖼️ 함께 모으는 앨범</h2>
      <p class="muted small">여기서 올리거나, 스팟 카드·일정에서 올린 사진·영상이 모두 모여요.</p>
      <button class="btn btn-primary btn-block" data-act="upload">📷 사진·🎬 영상 올리기</button>
      <p class="hint">사진은 자동으로 줄여서 저장돼요. 영상은 1개 50MB까지 (무료 저장 공간 1GB).</p>
    </section>
    ${media.length ? keys.map((k) => `<section class="block">
      <h3 class="group-title px">${k ? `Day ${ds.indexOf(k) + 1 || "–"} · ${dayLabel(k)}` : "날짜 없음"} <small class="muted">${groups[k].length}</small></h3>
      <div class="album-grid">${groups[k].map((m) => {
        const it = m.item_id && itemById(m.item_id);
        return `<div class="album-cell">${thumbTile(m)}${it ? `<span class="album-tag">${CATS[it.category]?.icon || "📌"} ${esc(it.name)}</span>` : ""}</div>`;
      }).join("")}</div></section>`).join("")
      : `<div class="empty"><div class="emoji">📷</div><p>아직 사진이 없어요. 여행의 순간을 함께 모아 보세요.</p></div>`}`;
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
      ? rpc("update_trip", { p_trip: T.id, p_patch: { cover_path: view[i].path } }).then(() => toast("대표 사진으로 정했어요"))
      : toast("대표 사진은 사진만 가능해요"),
    onClose: () => reload(),
  });
}

/** 파일 고르기 → 올리기 → 앨범·카드에 연결 */
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
  const byCat = Object.entries(EXP_CATS).map(([k, l]) => [l, ex.filter((e) => (e.category || "etc") === k).reduce((a, e) => a + e.amount, 0)]).filter(([, v]) => v);
  const groups = {};
  ex.forEach((e) => (groups[e.day_date || ""] ||= []).push(e));
  const est = t.summary?.budget_estimate || [];

  return `
    <section class="card budget-hero">
      <div class="row-between"><span class="muted small">총예산 (직접 입력)</span><button class="link" data-act="budget-set">설정</button></div>
      <strong class="big-num">${b.total != null ? `${won(b.total)}원` : "미설정"}</strong>
      <div class="bar lg ${left !== null && left < 0 ? "over" : ""}"><span style="width:${pct}%"></span></div>
      <div class="row-between small"><span>지출 <b>${won(spent)}원</b></span>
        <span>${left === null ? "" : left >= 0 ? `남은 예산 <b class="accent">${won(left)}원</b>` : `초과 <b class="danger">${won(-left)}원</b>`}</span></div>
    </section>
    ${b.currency && b.rate ? `<section class="card converter"><span>💱</span>
      <input class="input" type="number" inputmode="decimal" min="0" step="any" placeholder="${esc(b.currency)} 금액" data-convert>
      <span>→</span><strong data-convert-out>0원</strong><small class="muted">1 ${esc(b.currency)} = ${b.rate}원</small></section>` : ""}
    <button class="btn btn-primary btn-block" data-act="exp-add">＋ 지출 기록</button>
    ${byCat.length ? `<section class="card"><h2 class="section-title">어디에 썼나</h2>${byCat.map(([l, v]) =>
      `<div class="cat-bar"><span>${l}</span><span class="bar"><span style="width:${(v / spent) * 100}%"></span></span><b>${won(v)}</b></div>`).join("")}</section>` : ""}
    ${ex.length ? Object.keys(groups).sort((a, z) => (z || "0").localeCompare(a || "0")).map((k) => `<section class="block">
      <h3 class="group-title px">${k ? dayLabel(k) : "날짜 없음"} <small class="muted">${won(groups[k].reduce((a, e) => a + e.amount, 0))}원</small></h3>
      <ul class="list-card">${groups[k].map((e) => `<li data-act="exp-open" data-id="${e.id}">
        <span>${(EXP_CATS[e.category] || EXP_CATS.etc).split(" ")[0]}</span>
        <span class="grow">${esc(e.title)}<small class="muted">${esc(e.by_name || "")}</small></span><b>${won(e.amount)}원</b></li>`).join("")}</ul></section>`).join("")
      : `<div class="empty small"><p class="muted">쓴 돈을 기록하면 남은 예산이 자동으로 계산돼요.</p></div>`}
    ${est.length ? `<details class="card"><summary class="small muted">🤖 AI 예상 예산 (참고용) · ${won(est.reduce((a, x) => a + (x.amount_krw || 0), 0))}원</summary>
      <ul class="plain small">${est.map((x) => `<li>${esc(x.item)} — ${x.amount_krw ? `${won(x.amount_krw)}원` : "미정"} <span class="muted">${esc(x.note || "")}</span></li>`).join("")}</ul></details>` : ""}`;
}

function openExpense(id) {
  const e = id ? T.data.expenses.find((x) => x.id === id) : { title: "", amount: "", category: "food", day_date: phase(trip()).kind === "during" ? todayISO() : "" };
  const b = trip().budget || {};
  const s = openSheet(`
    <h2 class="sheet-title">${id ? "지출 수정" : "지출 기록"}</h2>
    <form class="stack" data-exp>
      <div class="field"><label>내용 *</label><input class="input" name="title" required maxlength="100" value="${esc(e.title)}" placeholder="예: 점심 라멘"></div>
      <div class="field"><label>금액 *</label>
        <div class="amount-row"><input class="input" name="amount" type="number" inputmode="decimal" min="0" step="any" required value="${e.amount}">
        ${b.currency && b.rate ? `<div class="seg"><label><input type="radio" name="cur" value="KRW" checked><span>원</span></label>
          <label><input type="radio" name="cur" value="LOCAL"><span>${esc(b.currency)}</span></label></div>` : `<span>원</span>`}</div>
        <span class="hint" data-conv-hint></span></div>
      <div class="field"><label>분류</label><div class="chips">${Object.entries(EXP_CATS).map(([k, l]) =>
        `<label class="chip-radio"><input type="radio" name="category" value="${k}" ${k === (e.category || "etc") ? "checked" : ""}><span>${l}</span></label>`).join("")}</div></div>
      <div class="field"><label>날짜</label><select class="input" name="day_date">${dayOptions(e.day_date)}</select></div>
      <button class="btn btn-primary btn-block" type="submit">저장</button>
      ${id ? `<button class="btn btn-block btn-danger-soft" type="button" data-act="del-exp" data-id="${id}">삭제</button>` : ""}
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
    <h2 class="sheet-title">예산 설정</h2>
    <form class="stack" data-bset>
      <div class="field"><label>총예산 (원, 전체 인원)</label><input class="input" name="total" type="number" inputmode="numeric" min="0" step="10000" value="${b.total ?? ""}"></div>
      <div class="grid2">
        <div class="field"><label>현지 통화</label><input class="input" name="currency" maxlength="10" value="${esc(b.currency || "")}" placeholder="JPY"></div>
        <div class="field"><label>1 현지통화 = ?원</label><input class="input" name="rate" type="number" inputmode="decimal" min="0" step="any" value="${b.rate ?? ""}" placeholder="9.1"></div>
      </div>
      <p class="hint">환율은 환전할 때 받은 값으로 넣으면 정확해요.</p>
      <button class="btn btn-primary btn-block" type="submit">저장</button>
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
  const sec = (cat, title, ph) => {
    const list = items(cat);
    const done = list.filter((i) => i.done).length;
    return `<section class="card">
      <div class="row-between"><h2 class="section-title">${title}</h2><span class="small muted">${done}/${list.length}</span></div>
      <div class="bar"><span style="width:${list.length ? (done / list.length) * 100 : 0}%"></span></div>
      <ul class="checklist">${list.map((i) => `<li class="${i.done ? "done" : ""}">
        <label><input type="checkbox" data-act="toggle-done" data-id="${i.id}" ${i.done ? "checked" : ""}><span>${esc(i.name)}</span></label>
        <button class="icon-btn sm" data-act="prep-edit" data-id="${i.id}" aria-label="수정">✎</button></li>`).join("")}</ul>
      <form class="add-line" data-prep-add="${cat}"><input class="input" name="name" maxlength="200" placeholder="${ph}"><button class="btn btn-sm" type="submit">추가</button></form>
    </section>`;
  };
  const em = trip().summary?.emergency || [];
  return `${sec("todo", "✅ 출발 전 할 일", "예: 환전, eSIM 구매")}
    ${sec("packing", "🧳 준비물", "예: 멀티어댑터")}
    ${em.length ? `<section class="card"><h2 class="section-title">🆘 비상 연락</h2><ul class="plain">${em.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}`;
}

function openPrepEdit(id) {
  const i = itemById(id);
  const s = openSheet(`<h2 class="sheet-title">수정</h2>
    <form class="stack" data-pedit><input class="input" name="name" value="${esc(i.name)}" maxlength="200" required>
      <button class="btn btn-primary btn-block" type="submit">저장</button>
      <button class="btn btn-block btn-danger-soft" type="button" data-act="del-item" data-id="${id}">삭제</button></form>`, { onClose: closed });
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
    <h2 class="sheet-title">여행 정보</h2>
    <form class="stack" data-trip-edit>
      <div class="field"><label>여행 이름</label><input class="input" name="title" value="${esc(t.title)}" maxlength="120" required></div>
      <div class="field"><label>목적지</label><input class="input" name="destination" value="${esc(t.destination || "")}" maxlength="120"></div>
      <div class="grid2">
        <div class="field"><label>출발</label><input class="input" type="date" name="start_date" value="${t.start_date || ""}"></div>
        <div class="field"><label>도착</label><input class="input" type="date" name="end_date" value="${t.end_date || ""}"></div>
      </div>
      <div class="field"><label>동행</label><input class="input" name="companions" value="${esc(t.companions || "")}" maxlength="200"></div>
      <button class="btn btn-primary btn-block" type="submit">저장</button>
    </form>`, { onClose: closed });
  $("[data-trip-edit]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await rpc("update_trip", { p_trip: T.id, p_patch: fd });
      s.close();
      toast("저장했어요");
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

function openBookings() {
  const s = openSheet(`<h2 class="sheet-title">📌 확정 예약</h2>
    <p class="muted small">항공편·숙소·공연 예약을 원문 그대로 적어 두세요. AI가 바꾸지 않아요.</p>
    <form class="stack" data-book><textarea class="input" name="b" rows="8" maxlength="4000"
      placeholder="예: 대한항공 KE723 04/02 09:00 인천→간사이 (예약번호 ABC123)&#10;숙소: 난바 OO호텔 3박">${esc(trip().bookings || "")}</textarea>
      <button class="btn btn-primary btn-block" type="submit">저장</button></form>`, { onClose: closed });
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

function shareLink() {
  return `${location.origin}${location.pathname}#/trip/${T.id}`;
}

function openMenu() {
  openSheet(`<h2 class="sheet-title">${esc(trip().title)}</h2>
    <div class="menu-list">
      <button data-act="share">🔗 공유 링크 복사 <small>동행자에게 이 링크만 보내세요</small></button>
      <button data-act="edit-trip">✏️ 여행 정보 수정</button>
      <button data-tab="record">🎞️ 여행 기록 만들기 <small>블로그 글 · 여행 영상</small></button>
      <button data-act="export">⬇️ 백업 내보내기 (JSON)</button>
      <button data-act="print">🖨️ 인쇄 / PDF</button>
      ${isOwner() ? `<button class="danger" data-act="delete-trip">🗑️ 여행 삭제</button>` : `<a href="#/login">🔑 소유자 로그인</a>`}
    </div>`, { onClose: closed });
}

// ---------- 클릭 처리 (한 곳에서) ----------
document.addEventListener("click", async (e) => {
  if (!T) return;
  const el = e.target.closest("[data-act],[data-tab]");
  if (!el || !(document.body.contains(el))) return;
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
        toast("링크를 복사했어요. 동행자에게 보내 주세요!");
      } catch {
        prompt("이 링크를 복사해 보내 주세요", shareLink());
      }
      return;
    case "go-cat":
      T.tab = "spots";
      T.sub = el.dataset.cat;
      history.replaceState(null, "", `#/trip/${T.id}/spots${T.sub ? `/${T.sub}` : ""}`);
      render();
      return window.scrollTo(0, 0);
    case "go-undated":
      T.tab = "spots";
      T.sub = "undated";
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
      return act(() => rpc("set_done", { p_trip: T.id, p_item: id, p_done: !it.done, p_by: by }), it.done ? "방문 취소" : "✓ 방문 기록했어요");
    }
    case "toggle-done": {
      const it = itemById(id);
      const by = await askName();
      return act(() => rpc("set_done", { p_trip: T.id, p_item: id, p_done: !it.done, p_by: by }));
    }
    case "del-item":
      if (!confirm("삭제할까요? (올린 사진·영상은 앨범에 남아요)")) return;
      closeSheet();
      return act(() => rpc("delete_item", { p_trip: T.id, p_item: id }), "삭제했어요");
    case "sched-open": return openSchedule(id);
    case "add-schedule": return openSchedule(null, el.dataset.day);
    case "day-jump":
      $(`#day-${el.dataset.day}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      $(`#day-${el.dataset.day}`)?.closest("details")?.setAttribute("open", "");
      return;
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

// 준비물 추가, 날짜별 제목·일기 자동 저장, 환율 계산
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-prep-add]");
  if (!T || !form) return;
  e.preventDefault();
  const name = form.name.value.trim();
  if (!name) return;
  form.name.value = "";
  await act(async () => rpc("upsert_item", { p_trip: T.id, p_item: { category: form.dataset.prepAdd, name }, p_by: await askName() }));
  $(`[data-prep-add="${form.dataset.prepAdd}"] input`)?.focus();
});

const saveDay = debounce(async (el) => {
  try {
    await rpc("set_day", { p_trip: T.id, p_date: el.dataset.day, p_patch: { [el.dataset.dayField]: el.value } });
    const dd = T.data.days.find((x) => x.day_date === el.dataset.day);
    if (dd) dd[el.dataset.dayField] = el.value;
    else T.data.days.push({ day_date: el.dataset.day, [el.dataset.dayField]: el.value });
    toast("✓ 저장됨");
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

// 기록 화면(record.js)에서 쓰는 도구
export const tripApi = { reload, pickAndUpload, trip: () => T && trip(), data: () => T?.data, id: () => T?.id, busy };
