/* 시작점: 주소(#/...)에 따라 화면 고르기 + 내 여행 목록·새 여행·로그인 */
import { CFG, fileUrl, flushOutbox, ownerKey, ownerRpc, rpc } from "./api.js?v=2611221020";
import { isOffline, onNetChange, pendingCount, setOffline } from "./offline.js?v=2611221020";
import { icon } from "./icons.js?v=2611221020";
import { openTrip, stop } from "./trip.js?v=2611221020";
import { isInstalled, openInstallGuide } from "./ui.js?v=2611221020";
import { $, $$, dateRange, esc, phase, store, toast } from "./util.js?v=2611221020";
import { lazyWiki } from "./wiki.js?v=2611221020";

const $app = document.getElementById("app");

function route() {
  stop();
  window.scrollTo(0, 0);
  document.title = "여행 계획";
  if (!CFG.url || !CFG.key) return notConfigured();
  const parts = (location.hash.slice(1) || "/").split("/").filter(Boolean); // ["trip", id, tab, sub]
  if (parts[0] === "trip" && /^[0-9a-f-]{36}$/i.test(parts[1] || "")) return openTrip(parts[1], parts[2], parts[3] || "");
  if (parts[0] === "login") return login();
  if (parts[0] === "share") return shareInbox();
  if (parts[0] === "new") return ownerKey() ? newTrip() : (location.hash = "#/login");
  return ownerKey() ? myTrips() : landing();
}
window.addEventListener("hashchange", route);

/** 안드로이드 공유로 들어온 파일·글: 어느 여행에 넣을지 고르기 */
async function shareInbox() {
  let meta = null;
  try {
    meta = await (await (await caches.open("share-inbox")).match("./__share/meta"))?.json();
  } catch {}
  let trips = [];
  try {
    trips = ownerKey() ? await ownerRpc("list_trips") : JSON.parse(store("recentTrips") || "[]");
  } catch {
    trips = JSON.parse(store("recentTrips") || "[]");
  }
  const n = meta?.files?.length || 0;
  $app.innerHTML = `<div class="page">
    <header class="page-head"><a class="icon-btn" href="#/" aria-label="뒤로">${icon("back", 24)}</a></header>
    <p class="eyebrow">${icon("ticket", 14)} SHARED</p><h1 class="display sm">어느 여행에 넣을까요?</h1>
    <p class="muted">${meta ? `${n ? `파일 ${n}개` : ""}${n && meta.text ? " · " : ""}${meta.text ? "글" : ""}을 받았어요. 고른 여행의 예약·바우처로 읽어서 넣어요.` : "공유받은 내용이 없어요."}</p>
    ${meta ? `<div class="trip-list" style="margin-top:16px">${trips.map((t) => `<button class="btn btn-line btn-block" data-share-trip="${esc(t.id)}">${esc(t.title)}</button>`).join("")
      || `<p class="hint">여행을 한 번 열어 두면 여기에 나와요.</p>`}</div>` : ""}
  </div>`;
  $app.querySelectorAll("[data-share-trip]").forEach((b) => b.addEventListener("click", () => {
    store("pendingShare", b.dataset.shareTrip);
    location.hash = `#/trip/${b.dataset.shareTrip}/schedule`;
  }));
}

// ---------- 오프라인 표시 ----------
const netBar = document.createElement("div");
netBar.className = "net-bar";
netBar.setAttribute("role", "status");
document.body.appendChild(netBar);
function drawNet() {
  const n = pendingCount();
  const off = isOffline() || navigator.onLine === false;
  netBar.innerHTML = off
    ? `${icon("alert", 15)} 오프라인 · 저장본 보는 중${n ? ` · ${n}건 대기` : ""}`
    : n ? `<span class="mini-spin"></span> ${n}건 올리는 중` : "";
  netBar.title = off ? "연결이 없어 마지막으로 저장된 내용을 보여 주고 있어요. 바꾼 내용은 연결되면 자동으로 올라가요." : "";
  netBar.classList.toggle("on", off || n > 0);
  document.body.classList.toggle("is-offline", off);
}
onNetChange(drawNet);
window.addEventListener("offline", () => setOffline(true));
window.addEventListener("online", () => setTimeout(drawNet, 50));
drawNet();
if (pendingCount() && navigator.onLine !== false) flushOutbox().catch(() => {});

function notConfigured() {
  $app.innerHTML = `<div class="page"><div class="empty"><p class="eyebrow">SETUP</p><h2>연결 설정이 필요해요</h2>
    <p class="muted">소유자 PC에서 '연결 설정.bat'을 실행하면 docs/config.js가 채워져요.</p></div></div>`;
}

function landing() {
  let recent = [];
  try {
    recent = JSON.parse(store("recentTrips") || "[]");
  } catch {}
  $app.innerHTML = `<div class="page landing">
    <p class="eyebrow">TRAVEL JOURNAL</p>
    <h1 class="display">함께 떠나는<br>여행 노트</h1>
    <p class="muted">공유받은 여행 링크로 들어와 주세요.</p>
    ${recent.length ? `<section class="sec">${secHead("최근 본 여행", "RECENT")}<ul class="list">${recent.map((r) =>
      `<li><a href="#/trip/${esc(r.id)}"><span class="grow">${esc(r.title)}</span>${icon("next", 18)}</a></li>`).join("")}</ul></section>` : ""}
    <p class="center"><a class="link" href="#/login">${icon("key", 16)} 소유자 로그인</a></p></div>`;
}

document.addEventListener("click", (e) => e.target.closest("[data-install-guide]") && openInstallGuide());
// 내 여행 목록 → 썸네일 버튼: 여행을 열면서 바로 표지 고르기 창을 띄운다
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-cover-trip]");
  if (!b) return;
  store("openCover", b.dataset.coverTrip);
  location.hash = `#/trip/${b.dataset.coverTrip}/overview`;
});

const secHead = (title, eyebrow) => `<header class="sec-head"><div><p class="eyebrow">${eyebrow}</p><h2>${title}</h2></div></header>`;

function login() {
  $app.innerHTML = `<div class="page">
    <header class="page-head"><a class="icon-btn" href="#/" aria-label="뒤로">${icon("back", 24)}</a></header>
    <p class="eyebrow">OWNER</p><h1 class="display sm">소유자 로그인</h1>
    <p class="muted">연결 설정 때 만들어진 소유자 키를 넣으면 이 기기에서 여행을 만들고 지울 수 있어요.
      PC의 <b>소유자 키 복사.bat</b>을 실행하면 클립보드에 복사돼요.</p>
    <form class="stack" data-login style="margin-top:20px">
      <input class="input input-lg" name="key" autocomplete="off" placeholder="소유자 키 붙여넣기" required>
      <button class="btn btn-ink btn-block" type="submit">로그인</button>
      ${ownerKey() ? `<button class="btn btn-block btn-ghost" type="button" data-logout>이 기기에서 로그아웃</button>` : ""}
    </form></div>`;
  $("[data-logout]")?.addEventListener("click", () => {
    store("ownerKey", null);
    location.hash = "#/";
  });
  $("[data-login]").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = e.target.key.value.trim();
    try {
      await rpc("list_trips", { p_owner_key: key });
      store("ownerKey", key);
      toast("로그인했어요");
      location.hash = "#/";
    } catch (err) {
      toast(err.message);
    }
  });
}

async function myTrips() {
  $app.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  let trips;
  try {
    trips = await ownerRpc("list_trips");
  } catch (e) {
    $app.innerHTML = `<div class="page"><div class="empty"><p>${esc(e.message)}</p><a class="btn btn-ink" href="#/login">소유자 키 다시 넣기</a></div></div>`;
    return;
  }
  const groups = { during: [], before: [], none: [], after: [] };
  trips.forEach((t) => groups[phase(t).kind].push(t));
  groups.before.sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""));

  const card = (t, big = false) => {
    const ph = phase(t);
    const cover = t.cover_path ? fileUrl(t.cover_path) : "";
    return `<div class="trip-wrap"><a class="trip ${big ? "trip-big" : ""}" href="#/trip/${esc(t.id)}">
      <span class="trip-img ${cover ? "has-img" : ""}" ${cover ? `style="background-image:url('${esc(cover)}')"`
        : `data-wiki="${esc(t.destination || t.title)}" data-wiki-en="${esc(t.destination_en || "")}"
           data-commons="${esc(t.destination_en || (t.destination || t.title || "").split(/[·,/]/)[0].trim())}"`}>
        <span class="status">${esc(ph.en)}</span>
        ${["queued", "generating"].includes(t.status) ? `<span class="ai-chip">${icon("sparkles", 13)} AI</span>` : ""}
      </span>
      <span class="trip-text"><small class="eyebrow">${esc((t.destination_en || t.destination || "").toUpperCase())}</small>
        <b>${esc(t.title)}</b>
        <small class="muted">${esc(dateRange(t))} · 스팟 ${t.spots} · 방문 ${t.visited} · 사진 ${t.media}</small></span></a>
      <button class="cover-edit trip-cover-btn" data-cover-trip="${esc(t.id)}" aria-label="${esc(t.title)} 썸네일 바꾸기">${icon("camera", 15)} 썸네일</button></div>`;
  };
  const featured = groups.during[0] || groups.before[0];
  const rest = trips.filter((t) => t !== featured);
  $app.innerHTML = `<div class="page home">
    <header class="page-head"><div class="grow"><p class="eyebrow">MY TRIPS</p><h1 class="display sm">내 여행</h1></div>
      ${isInstalled() ? "" : `<button class="icon-btn" data-install-guide aria-label="홈 화면에 앱으로 추가">${icon("download", 22)}</button>`}
      <a class="icon-btn" href="#/login" aria-label="계정">${icon("user", 22)}</a></header>
    ${trips.length ? `${featured ? card(featured, true) : ""}
      ${rest.length ? `<section class="sec">${secHead("모든 여행", "ARCHIVE")}<div class="trip-list">${rest.map((t) => card(t)).join("")}</div></section>` : ""}`
      : `<div class="empty"><p class="eyebrow">FIRST TRIP</p><h2>첫 여행을 만들어 보세요</h2><p class="muted">AI 추천으로 채우거나 직접 하나씩 담을 수 있어요.</p></div>`}
  </div>
  <a class="fab wide" href="#/new">${icon("plus", 20)} 새 여행</a>`;
  lazyWiki($app);
}

// ---------- 새 여행 ----------
const STYLES = ["사진·감성", "맛집", "카페", "쇼핑", "자연", "역사·문화", "액티비티", "야경", "여유롭게", "알차게"];

function newTrip() {
  $app.innerHTML = `<div class="page">
    <header class="page-head"><a class="icon-btn" href="#/" aria-label="뒤로">${icon("back", 24)}</a></header>
    <p class="eyebrow">NEW TRIP</p><h1 class="display sm">어디로 떠나요?</h1>
    <form class="stack-lg" data-new style="margin-top:20px">
      <input class="input input-xl" name="destination" required maxlength="120" placeholder="목적지 (예: 일본 오사카)">
      <div class="grid2">
        <div class="field"><label>출발</label><input class="input" type="date" name="start_date" required></div>
        <div class="field"><label>도착</label><input class="input" type="date" name="end_date" required></div>
      </div>
      <div class="field"><label>여행 이름</label><input class="input" name="title" required maxlength="120" placeholder="예: 벚꽃 보러 가는 오사카"></div>
      <div class="field"><label>누구와</label><input class="input" name="companions" maxlength="200" placeholder="예: 친구 1명, 커플, 가족 4명"></div>

      <div class="choice">
        <label><input type="radio" name="mode" value="ai" checked><span>${icon("sparkles", 22)}<b>AI가 채워 주기</b>
          <small>스팟·일정·준비물·예산·추천 영상까지. 이후 마음대로 고칠 수 있어요.</small></span></label>
        <label><input type="radio" name="mode" value="manual"><span>${icon("pen", 22)}<b>직접 채우기</b>
          <small>빈 여행에서 하나씩. 나중에 AI 추천도 받을 수 있어요.</small></span></label>
      </div>
      <div class="stack" data-ai-opts>
        <div class="field"><label>여행 스타일</label><div class="chips">${STYLES.map((s) =>
          `<label class="chip-check"><input type="checkbox" name="styles" value="${s}"><span>${s}</span></label>`).join("")}</div></div>
        <div class="field"><label>꼭 하고 싶은 것</label><textarea class="input" name="must_do" rows="2" placeholder="예: 교토 벚꽃 명소, 유니버설 스튜디오"></textarea></div>
        <div class="grid2">
          <div class="field"><label>최신 정보 검색</label><select class="input" name="max_searches">
            <option value="0">끄기 · 1~3분</option><option value="6">가볍게 · 5분</option>
            <option value="15" selected>보통 · 10분</option><option value="25">꼼꼼히 · 15분+</option></select></div>
          <div class="field"><label>AI 모델</label><select class="input" name="model">
            <option value="">기본</option><option value="sonnet">Sonnet · 절약</option><option value="opus">Opus · 꼼꼼</option></select></div>
        </div>
      </div>

      <details class="fold">
        <summary class="fold-sum">예산 · 확정 예약 <small class="muted">선택</small> ${icon("next", 16)}</summary>
        <div class="stack" style="margin-top:12px">
          <div class="field"><label>총예산 (원, 전체 인원)</label><input class="input" type="number" inputmode="numeric" name="total" min="0" step="10000"></div>
          <div class="grid2">
            <div class="field"><label>현지 통화</label><input class="input" name="currency" maxlength="10" placeholder="JPY"></div>
            <div class="field"><label>1 현지통화 = ?원</label><input class="input" type="number" inputmode="decimal" name="rate" min="0" step="any" placeholder="9.1"></div>
          </div>
          <div class="field"><label>확정 예약 원문</label><textarea class="input mono" name="bookings" rows="3"
            placeholder="KE723 04/02 09:00 ICN→KIX&#10;난바 OO호텔 3박"></textarea>
            <span class="hint">원문 그대로 저장되고 AI가 바꾸지 않아요.</span></div>
        </div>
      </details>

      <p class="hint">AI를 고르면 입력한 내용이 Claude(Anthropic)로 전송되고 소유자의 Claude 구독 사용량이 차감돼요. 소유자 PC의 작업기가 켜져 있을 때 만들어져요.</p>
      <button class="btn btn-ink btn-block btn-lg sticky-cta" type="submit" data-submit>${icon("sparkles", 18)} AI 추천 받기</button>
    </form></div>`;

  const form = $("[data-new]");
  const sync = () => {
    const ai = form.mode.value === "ai";
    $("[data-ai-opts]").hidden = !ai;
    $("[data-submit]").innerHTML = ai ? `${icon("sparkles", 18)} AI 추천 받기` : "여행 만들기";
  };
  form.addEventListener("change", (e) => {
    if (e.target.name === "mode") sync();
    if (e.target.name === "start_date" && (!form.end_date.value || form.end_date.value < form.start_date.value)) form.end_date.value = form.start_date.value;
  });
  form.destination.addEventListener("input", () => {
    if (!form.title.dataset.touched) form.title.value = form.destination.value ? `${form.destination.value} 여행` : "";
  });
  form.title.addEventListener("input", () => (form.title.dataset.touched = "1"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = form;
    if (f.end_date.value < f.start_date.value) return toast("도착일이 출발일보다 빨라요");
    const ai = f.mode.value === "ai";
    const searches = Number(f.max_searches.value);
    const style = $$("input[name=styles]:checked", f).map((x) => x.value).join(", ");
    const payload = {
      title: f.title.value, destination: f.destination.value, start_date: f.start_date.value, end_date: f.end_date.value,
      companions: f.companions.value, bookings: f.bookings.value.trim(),
      budget: { total: f.total.value || null, currency: f.currency.value || null, rate: f.rate.value || null },
      input: ai ? { style, must_do: f.must_do.value, web_search: searches > 0, max_searches: searches || 6, model: f.model.value } : {},
    };
    const btn = $("[data-submit]");
    btn.disabled = true;
    try {
      const id = await ownerRpc("create_trip", { p_trip: payload, p_ai: ai });
      location.hash = `#/trip/${id}`;
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
}

// 모든 정의가 끝난 뒤 시작
route();
