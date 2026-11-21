/* 여행 계획 – 함께 쓰는 웹 앱 (GitHub Pages + Supabase)
 *
 * 소유자: 소유자 키로 로그인 → 여행 만들기·삭제
 * 동행자: 공유 링크(#/trip/<id>)로 접속 → 보기·체크·메모·사진·실지출·AI 수정 요청
 * AI 생성·수정은 소유자 PC의 작업기(내 Claude 구독)가 처리한다.
 */

const CFG = window.TRAVEL_CONFIG || {};
const $app = document.getElementById("app");
const $topActions = document.getElementById("topbar-actions");
let pollTimer = null;
let elapsedTimer = null;
let current = null; // { id, data, tab }

// ---------- 유틸 ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, "<br>");
const mapsUrl = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
const imageUrl = (q) => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
const won = (n) => (n || n === 0 ? Number(n).toLocaleString("ko-KR") : "");

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2000);
}

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(iso).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

function dday(start) {
  if (!start) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(start + "T00:00:00") - today) / 86400000);
  if (Number.isNaN(diff)) return "";
  if (diff > 0) return `D-${diff}`;
  if (diff === 0) return "D-DAY";
  return "다녀옴";
}

function dateRange(inp) {
  if (!inp?.start_date) return "";
  const f = (d) => d.replaceAll("-", ".");
  return inp.end_date && inp.end_date !== inp.start_date ? `${f(inp.start_date)} – ${f(inp.end_date)}` : f(inp.start_date);
}

const ownerKey = () => store("ownerKey");

function myName() {
  let name = store("myName");
  if (!name) {
    name = (prompt("함께 쓰는 사람들에게 보일 이름(닉네임)을 알려 주세요") || "").trim().slice(0, 20);
    if (name) store("myName", name);
  }
  return name || "익명";
}

function rememberTrip(id, title) {
  let recent = [];
  try {
    recent = JSON.parse(store("recentTrips") || "[]");
  } catch {}
  recent = [{ id, title }, ...recent.filter((r) => r.id !== id)].slice(0, 10);
  store("recentTrips", JSON.stringify(recent));
}

function forgetTrip(id) {
  try {
    store("recentTrips", JSON.stringify(JSON.parse(store("recentTrips") || "[]").filter((r) => r.id !== id)));
  } catch {}
}

// ---------- Supabase ----------
function headers(extra = {}) {
  const h = { apikey: CFG.key, ...extra };
  if (!String(CFG.key).startsWith("sb_")) h.Authorization = `Bearer ${CFG.key}`;
  return h;
}

async function rpc(fn, params = {}) {
  const res = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new Error(data?.message || res.statusText || "요청 실패");
  return data;
}
const ownerRpc = (fn, params = {}) => rpc(fn, { p_owner_key: ownerKey(), ...params });

const photoUrl = (path) => `${CFG.url}/storage/v1/object/public/photos/${path.split("/").map(encodeURIComponent).join("/")}`;

async function compressImage(file, max = 1600, quality = 0.82) {
  if (file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), "image/jpeg", quality));
}

async function uploadPhoto(tripId, file) {
  const blob = await compressImage(file);
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[blob.type];
  if (!ext) throw new Error("지원하지 않는 사진 형식이에요 (JPG·PNG·WEBP·GIF)");
  const path = `${tripId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const res = await fetch(`${CFG.url}/storage/v1/object/photos/${path}`, {
    method: "POST",
    headers: headers({ "Content-Type": blob.type }),
    body: blob,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "사진 업로드 실패");
  return path;
}

async function deletePhotos(paths) {
  if (!paths.length) return;
  await fetch(`${CFG.url}/storage/v1/object/photos`, {
    method: "DELETE",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: paths }),
  }).catch(() => {});
}

// ---------- 라우터 ----------
function stopTimers() {
  clearTimeout(pollTimer);
  clearInterval(elapsedTimer);
}

function renderTopbar() {
  $topActions.innerHTML = ownerKey()
    ? `<a href="#/new" class="btn btn-primary btn-sm">+ 새 여행</a>`
    : `<a href="#/login" class="btn btn-sm">소유자</a>`;
}

function route() {
  stopTimers();
  current = null;
  window.scrollTo(0, 0);
  if (!CFG.url || !CFG.key) return renderNotConfigured();
  renderTopbar();
  const hash = location.hash.slice(1) || "/";
  const m = hash.match(/^\/trip\/([0-9a-f-]{36})(?:\/(\w+))?$/i);
  if (hash === "/login") renderLogin();
  else if (hash === "/new") ownerKey() ? renderNew() : (location.hash = "#/login");
  else if (m) loadTrip(m[1], m[2]);
  else ownerKey() ? renderList() : renderLanding();
}
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => !document.hidden && current && refresh());
route();

// ---------- 시작 화면 ----------
function renderNotConfigured() {
  $app.innerHTML = `<div class="card stack"><h2>아직 연결 설정이 안 됐어요</h2>
    <p class="muted">소유자 PC에서 <code>setup</code> 명령을 실행하면 <code>docs/config.js</code>가 채워집니다. README를 참고해 주세요.</p></div>`;
}

function renderLanding() {
  let recent = [];
  try {
    recent = JSON.parse(store("recentTrips") || "[]");
  } catch {}
  $app.innerHTML = `
    <div class="card empty">
      <div class="emoji">🧳</div>
      <h2>함께 만드는 여행 계획</h2>
      <p class="muted">공유받은 여행 링크로 접속해 주세요.</p>
      ${recent.length ? `<div class="stack" style="text-align:left;max-width:420px;margin:24px auto 0">
        <div class="sub">최근 본 여행</div>
        ${recent.map((r) => `<a class="card trip-card" href="#/trip/${esc(r.id)}">${esc(r.title)}</a>`).join("")}</div>` : ""}
      <p style="margin-top:28px"><a href="#/login" class="small">소유자 로그인</a></p>
    </div>`;
}

function renderLogin() {
  $app.innerHTML = `
    <form class="card form stack" id="login-form" style="max-width:480px;margin:0 auto">
      <h2>소유자 로그인</h2>
      <p class="muted small">setup 때 받은 소유자 키를 넣으면 이 기기에서 여행을 만들고 삭제할 수 있어요. 다른 사람에게 알려주지 마세요.</p>
      <div class="field"><label for="owner-key">소유자 키</label><input type="text" id="owner-key" autocomplete="off" required></div>
      <div class="actions">
        <button class="btn btn-primary" type="submit">로그인</button>
        ${ownerKey() ? `<button class="btn" type="button" id="logout">이 기기에서 로그아웃</button>` : ""}
      </div>
    </form>`;
  document.getElementById("logout")?.addEventListener("click", () => {
    store("ownerKey", null);
    location.hash = "#/";
  });
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = document.getElementById("owner-key").value.trim();
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

// ---------- 목록 (소유자) ----------
async function renderList() {
  $app.innerHTML = `<p class="muted">불러오는 중…</p>`;
  let trips;
  try {
    trips = await ownerRpc("list_trips");
  } catch (e) {
    $app.innerHTML = `<div class="card error-box stack"><p>목록을 불러오지 못했어요: ${esc(e.message)}</p><a href="#/login" class="btn">소유자 키 다시 넣기</a></div>`;
    return;
  }

  const head = `
    <div class="page-head">
      <div><h1>내 여행</h1><p class="muted">여행을 만들고 링크로 동행자와 함께 써 보세요.</p></div>
    </div>`;

  if (!trips.length) {
    $app.innerHTML = head + `
      <div class="card empty">
        <div class="emoji">🗺️</div>
        <h2>아직 여행이 없어요</h2>
        <p class="muted">목적지와 날짜만 넣어도 일정 초안을 만들어 드려요.</p>
        <a href="#/new" class="btn btn-primary">첫 여행 만들기</a>
      </div>`;
    return;
  }

  const status = (t) =>
    t.status === "queued" ? `<span class="chip chip-warn">대기 중</span>`
    : t.status === "generating" ? `<span class="chip chip-warn">만드는 중…</span>`
    : t.status === "error" && !t.has_plan ? `<span class="chip chip-danger">오류</span>`
    : `<span class="chip chip-accent">${esc(dday(t.input.start_date))}</span>`;

  $app.innerHTML = head + `
    <div class="grid grid-3">${trips.map((t) => `
      <a class="card trip-card" href="#/trip/${esc(t.id)}">
        ${status(t)}
        <h3>${esc(t.title)}</h3>
        <div class="muted small">📍 ${esc(t.input.destination)}</div>
        <div class="muted small">🗓️ ${esc(dateRange(t.input))}</div>
      </a>`).join("")}
    </div>`;
}

// ---------- 새 여행 (소유자) ----------
function renderNew() {
  $app.innerHTML = `
    <div class="page-head"><div><h1>새 여행 만들기</h1>
      <p class="muted">아는 만큼만 적어도 돼요. 확정된 예약은 그대로 두고 나머지를 채워 드려요.</p></div></div>
    <form class="card form stack" id="trip-form">
      <div class="field"><label for="title">여행 이름 *</label>
        <input type="text" id="title" name="title" required maxlength="100" placeholder="예: 2027 벚꽃 보러 가는 오사카"></div>
      <div class="field"><label for="destination">목적지 *</label>
        <input type="text" id="destination" name="destination" required placeholder="예: 일본 오사카·교토"></div>
      <div class="row">
        <div class="field"><label for="start_date">출발일 *</label><input type="date" id="start_date" name="start_date" required></div>
        <div class="field"><label for="end_date">도착일 *</label><input type="date" id="end_date" name="end_date" required></div>
      </div>
      <div class="field"><label for="companions">동행</label>
        <input type="text" id="companions" name="companions" placeholder="예: 2명 (커플)"></div>
      <div class="row3">
        <div class="field"><label for="total">총예산 (원, 전체 인원)</label>
          <input type="number" id="total" name="total" min="0" step="10000" placeholder="예: 2400000"></div>
        <div class="field"><label for="currency">현지 통화</label>
          <input type="text" id="currency" name="currency" maxlength="10" placeholder="예: JPY"></div>
        <div class="field"><label for="rate">환율 (1 현지통화 = ?원)</label>
          <input type="number" id="rate" name="rate" min="0" step="any" placeholder="예: 9.1"></div>
      </div>
      <div class="field"><label for="budget">예산 메모</label>
        <input type="text" id="budget" name="budget" placeholder="예: 항공·숙소 포함, 식비 넉넉히">
        <span class="hint">총예산·통화·환율은 AI와 별개로 저장되고, 예산 탭의 잔액 계산 기준이 돼요. 나중에 바꿀 수 있어요.</span></div>
      <div class="field"><label for="style">여행 스타일</label>
        <textarea id="style" name="style" placeholder="예: 사진 명소 위주, 현지 맛집, 하루 2~3곳만 여유롭게"></textarea></div>
      <div class="field"><label for="must_do">꼭 하고 싶은 것</label>
        <textarea id="must_do" name="must_do" placeholder="예: 교토 벚꽃 명소, 유니버설 스튜디오 하루"></textarea></div>
      <div class="field"><label for="bookings">확정된 예약</label>
        <textarea id="bookings" name="bookings" placeholder="예: 대한항공 KE723 04/02 09:00~10:40 / 숙소: 난바 OO호텔 2박"></textarea>
        <span class="hint">항공편, 숙소, 공연 등. 원문 그대로 따로 저장돼 개요 맨 위에 표시되고, AI가 바꿀 수 없어요.</span></div>
      <div class="field"><label for="memo">메모</label>
        <textarea id="memo" name="memo" placeholder="예: 첫날은 가볍게, 마지막 날은 공항 가기 전 쇼핑"></textarea></div>
      <div class="row3">
        <div class="field"><label>최신 정보 검색</label>
          <label class="toggle-row"><input type="checkbox" name="web_search" checked> 웹에서 행사·휴무·맛집 확인</label>
          <span class="hint">끄면 1~3분, 대신 모든 정보가 '미확인'으로 표시돼요.</span></div>
        <div class="field"><label for="max_searches">검색 깊이</label>
          <select id="max_searches" name="max_searches">
            <option value="6">가볍게 (최대 6회, 약 5분)</option>
            <option value="15" selected>보통 (최대 15회, 약 10분)</option>
            <option value="25">꼼꼼히 (최대 25회, 약 15분+)</option>
          </select></div>
        <div class="field"><label for="model">모델</label>
          <select id="model" name="model">
            <option value="">기본 (계정 설정)</option>
            <option value="sonnet">Sonnet (구독 사용량 절약)</option>
            <option value="opus">Opus (가장 꼼꼼함)</option>
          </select></div>
      </div>
      <p class="hint">💡 계획은 소유자 PC의 작업기가 만들어요. '여행계획 작업기 실행'이 켜져 있어야 시작됩니다.<br>
        🔒 입력한 내용(예약 메모 포함)은 계획 작성을 위해 Claude(Anthropic)로 전송되고, 구독 사용량이 차감돼요.</p>
      <div class="actions"><button class="btn btn-primary" type="submit">✨ 계획 만들기</button>
        <a href="#/" class="btn">취소</a></div>
    </form>`;

  const form = document.getElementById("trip-form");
  form.start_date.addEventListener("change", () => {
    if (!form.end_date.value || form.end_date.value < form.start_date.value) form.end_date.value = form.start_date.value;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const { total, currency, rate, ...input } = Object.fromEntries(fd.entries());
    input.web_search = fd.get("web_search") === "on";
    input.max_searches = Number(input.max_searches) || 15;
    input.budget_settings = { total: total || null, currency: currency.trim() || null, rate: rate || null };
    if (input.end_date < input.start_date) return toast("도착일이 출발일보다 빨라요");
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const id = await ownerRpc("create_trip", { p_input: input });
      location.hash = `#/trip/${id}`;
    } catch (err) {
      toast("만들기 실패: " + err.message);
      btn.disabled = false;
    }
  });
}

// ---------- 여행 상세 ----------
async function loadTrip(id, tab) {
  $app.innerHTML = `<p class="muted">불러오는 중…</p>`;
  let data;
  try {
    data = await rpc("get_trip", { p_trip: id });
  } catch (e) {
    $app.innerHTML = `<div class="card error-box">여행을 불러오지 못했어요: ${esc(e.message)}</div>`;
    return;
  }
  if (!data) {
    forgetTrip(id);
    $app.innerHTML = `<div class="card empty"><div class="emoji">🔍</div><h2>여행을 찾을 수 없어요</h2>
      <p class="muted">링크가 잘못됐거나 삭제된 여행이에요.</p><a href="#/" class="btn">처음으로</a></div>`;
    return;
  }
  rememberTrip(id, data.trip.title);
  current = { id, data, tab };
  renderTripView();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!current) return;
  const busy = ["queued", "generating"].includes(current.data.trip.status);
  pollTimer = setTimeout(refresh, busy ? 5000 : 10000);
}

// 입력 중이거나 아직 안 보낸 내용이 있으면 화면을 갈아엎지 않는다
function isEditing() {
  const a = document.activeElement;
  if (a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !["checkbox", "file"].includes(a.type)))) return true;
  if ([...$app.querySelectorAll("form[data-bookings-form]:not([hidden]), form#revise-form:not([hidden])")].length) return true;
  return [...$app.querySelectorAll(".entry-form textarea, [data-convert], .add-expense input")].some((el) => el.value.trim())
    || [...$app.querySelectorAll("input[type=file]")].some((el) => el.files.length);
}

async function refresh({ force = false } = {}) {
  if (!current) return;
  const id = current.id;
  if (!force && (document.hidden || isEditing())) return schedulePoll();
  try {
    const data = await rpc("get_trip", { p_trip: id });
    if (!current || current.id !== id) return;
    if (!data) return route();
    if (force || JSON.stringify(data) !== JSON.stringify(current.data)) {
      current.data = data;
      const y = window.scrollY;
      renderTripView();
      window.scrollTo(0, y);
    }
  } catch {}
  schedulePoll();
}

function renderTripView() {
  clearInterval(elapsedTimer);
  const t = current.data.trip;
  if (!t.plan) return t.status === "error" ? renderError(t) : renderWaiting(t);
  renderPlan();
}

function renderWaiting(t) {
  const since = new Date(t.updated_at).getTime();
  const queued = t.status === "queued";
  $app.innerHTML = `
    <div class="card progress">
      <div class="spinner"></div>
      <h2>${esc(t.title)}</h2>
      <p class="muted">${queued
        ? "작업 대기 중이에요. 소유자 PC의 작업기가 켜져 있으면 곧 시작돼요."
        : `Claude가 ${t.input.web_search ? "최신 정보를 조사하고 " : ""}일정을 정리하고 있어요.`}</p>
      ${t.progress ? `<p class="progress-text">${esc(t.progress)}</p>` : ""}
      <p class="muted small">${t.input.web_search ? "보통 5~15분" : "보통 1~3분"} 걸려요. 이 창을 닫아도 계속 만들어져요.</p>
      <p class="small" id="elapsed"></p>
      <div class="actions" style="justify-content:center;margin-top:18px">
        <button class="btn btn-sm" data-act="share">🔗 공유 링크 복사</button>
        <button class="btn btn-sm btn-danger" data-act="cancel">⏹️ 취소</button>
      </div>
    </div>`;
  const el = document.getElementById("elapsed");
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    el.textContent = `경과 ${Math.floor(s / 60)}분 ${s % 60}초`;
  };
  tick();
  elapsedTimer = setInterval(tick, 1000);
  bindTripActions();
}

function renderError(t) {
  $app.innerHTML = `
    <div class="card error-box stack">
      <h2>계획을 만들지 못했어요</h2>
      <p class="muted">${esc(t.title)}</p>
      <pre>${esc(t.error)}</pre>
      <div class="actions">
        <button class="btn btn-primary" data-act="retry">다시 시도</button>
        ${ownerKey() ? `<button class="btn btn-danger" data-act="delete">삭제</button>` : ""}
      </div>
    </div>`;
  bindTripActions();
}

function shareLink() {
  return `${location.origin}${location.pathname}#/trip/${current.id}`;
}

function bindTripActions() {
  const on = (act, fn) => $app.querySelector(`[data-act="${act}"]`)?.addEventListener("click", fn);

  on("share", async () => {
    try {
      await navigator.clipboard.writeText(shareLink());
      toast("링크를 복사했어요. 동행자에게 보내 주세요!");
    } catch {
      prompt("이 링크를 복사해 보내 주세요", shareLink());
    }
  });
  on("print", () => window.print());
  on("cancel", async () => {
    if (!confirm("AI 작업을 취소할까요?")) return;
    try {
      await rpc("cancel_job", { p_trip: current.id });
      toast("취소했어요");
      refresh({ force: true });
    } catch (e) {
      toast(e.message);
    }
  });
  on("export", () => {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), ...current.data }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${current.data.trip.title.replace(/[\\/:*?"<>|]/g, "_")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  on("retry", async () => {
    try {
      await rpc("request_revision", { p_trip: current.id, p_note: null });
      refresh({ force: true });
    } catch (e) {
      toast(e.message);
    }
  });
  on("revise", () => {
    const panel = document.getElementById("revise-form");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) panel.querySelector("textarea").focus();
  });
  document.getElementById("revise-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const note = e.target.note.value.trim();
    if (!note) return toast("어떻게 바꿀지 적어 주세요");
    try {
      await rpc("request_revision", { p_trip: current.id, p_note: `${note} (요청: ${myName()})` });
      e.target.note.value = "";
      toast("요청했어요. 끝나면 자동으로 바뀌어요");
      refresh({ force: true });
    } catch (err) {
      toast(err.message);
    }
  });
  on("delete", async () => {
    if (!confirm(`'${current.data.trip.title}' 여행을 삭제할까요? 사진·메모까지 모두 지워지고 되돌릴 수 없어요.`)) return;
    try {
      await deletePhotos(current.data.entries.filter((e) => e.photo_path).map((e) => e.photo_path));
      await ownerRpc("delete_trip", { p_trip: current.id });
      forgetTrip(current.id);
      location.hash = "#/";
    } catch (e) {
      toast(e.message);
    }
  });
}

const TABS = [
  ["overview", "개요"],
  ["days", "일정"],
  ["places", "가볼 곳"],
  ["food", "맛집"],
  ["budget", "예산"],
  ["prep", "준비물"],
  ["album", "앨범"],
];

function renderPlan() {
  const { trip: t } = current.data;
  const p = t.plan;
  const valid = TABS.map(([k]) => k);
  const tab = valid.includes(current.tab) ? current.tab : valid.includes(store(`tab:${t.id}`)) ? store(`tab:${t.id}`) : "overview";
  current.tab = tab;
  const dd = dday(t.input.start_date);
  const busy = ["queued", "generating"].includes(t.status);

  const banner = busy
    ? `<div class="banner"><div class="spinner spinner-sm"></div><div style="flex:1"><strong>${t.status === "queued" ? "AI 수정 대기 중 (소유자 PC 작업기가 켜지면 시작)" : "AI가 수정하는 중"}</strong>
        <div class="small">${esc(t.revision_note || "")}</div>
        ${t.progress ? `<div class="small progress-text">${esc(t.progress)}</div>` : ""}
        <div class="small muted">끝나면 자동으로 바뀌어요. 그동안 체크·메모·사진은 그대로 쓸 수 있어요.</div></div>
        <button class="btn btn-sm btn-danger" data-act="cancel">취소</button></div>`
    : t.status === "error"
      ? `<div class="banner banner-error"><div><strong>AI 수정에 실패했어요</strong><div class="small muted">${esc(t.error)}</div></div>
          <button class="btn btn-sm" data-act="retry">다시 시도</button></div>`
      : "";

  $app.innerHTML = `
    <section class="hero">
      ${ownerKey() ? `<a href="#/" class="small">← 내 여행</a>` : ""}
      <h1>${esc(p.heading || t.title)}</h1>
      <div class="meta">
        ${dd ? `<span class="chip chip-accent">${esc(dd)}</span>` : ""}
        <span class="muted">📍 ${esc(t.input.destination)}</span>
        <span class="muted">🗓️ ${esc(dateRange(t.input))}</span>
        <span class="muted small">${p.researched_on ? `🔎 웹 조사 ${esc(p.researched_on)}` : "🔎 웹 조사 없이 작성됨"}</span>
      </div>
      <div class="actions" style="margin-top:14px">
        <button class="btn btn-sm btn-primary" data-act="share">🔗 공유 링크 복사</button>
        <button class="btn btn-sm" data-act="revise" ${busy ? "disabled" : ""}>✏️ AI에게 수정 요청</button>
        <button class="btn btn-sm" data-act="print">🖨️ 인쇄 / PDF</button>
        <button class="btn btn-sm" data-act="export">⬇️ 내보내기 (JSON)</button>
        ${ownerKey() ? `<button class="btn btn-sm btn-danger" data-act="delete">삭제</button>` : ""}
      </div>
      <form class="card stack" id="revise-form" hidden style="margin-top:14px">
        <label class="sub" for="note">AI에게 수정 요청</label>
        <textarea name="note" id="note" maxlength="1500" placeholder="예: 2일차를 비 오는 날 실내 위주로 바꿔줘 / 3일차 저녁에 야경 명소 추가해줘"></textarea>
        <div class="actions"><button class="btn btn-primary btn-sm" type="submit">요청하기</button>
          <span class="hint">소유자 PC의 작업기가 처리해요. 체크·메모·사진은 유지돼요.</span></div>
      </form>
    </section>
    ${banner}
    <nav class="tabs">${TABS.map(([k, label]) => `<button class="tab ${k === tab ? "active" : ""}" data-tab="${k}">${label}</button>`).join("")}</nav>
    <div id="tab-body"></div>`;

  bindTripActions();
  $app.querySelectorAll(".tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      current.tab = btn.dataset.tab;
      store(`tab:${t.id}`, btn.dataset.tab);
      history.replaceState(null, "", `#/trip/${t.id}/${btn.dataset.tab}`);
      $app.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      drawTab();
    })
  );
  drawTab();
}

// ---------- 체크·메모·사진 ----------
// 체크는 목록 순번이 아니라 "종류 + 항목 이름"으로 저장한다.
// AI가 계획을 다시 만들어 순서가 바뀌어도 같은 이름의 항목에만 체크가 남고,
// 이름이 바뀌거나 사라진 항목의 체크는 다른 항목에 옮겨 붙지 않는다.
function itemKey(kind, text) {
  const name = String(text ?? "").split(/\s[—–]\s/)[0].replace(/\s+/g, " ").trim().toLowerCase();
  return `${kind}:${name}`.slice(0, 90);
}

function isChecked(key, fallback = false) {
  const checks = current.data.checks || {};
  return key in checks ? checks[key] : fallback;
}

function checkItem(key, text, { fallback = false, mapQuery = "" } = {}) {
  const map = mapQuery ? `<a class="map" href="${mapsUrl(mapQuery)}" target="_blank" rel="noopener">지도</a>` : "";
  return `<li class="check-row"><label class="check"><input type="checkbox" data-check="${esc(key)}" ${isChecked(key, fallback) ? "checked" : ""}><span>${esc(text)}</span></label>${map}</li>`;
}

function placeQuery(text) {
  const name = String(text).split(/\s[—–-]\s/)[0].replace(/\(.*?\)/g, "").replace(/^\(?(여유|선택|대안)[^)]*\)?\s*/, "").trim();
  return `${name} ${current.data.trip.input.destination}`;
}

// 하루 갈 곳을 순서대로 이은 구글 지도 경로 (실제 이동 시간은 구글이 계산)
function routeLink(places) {
  const stops = (places || []).map(placeQuery).slice(0, 10);
  if (stops.length < 2) return "";
  const [origin, ...rest] = stops;
  const destination = rest.pop();
  const params = new URLSearchParams({ api: "1", origin, destination, travelmode: "transit" });
  if (rest.length) params.set("waypoints", rest.join("|"));
  return `<p class="small" style="margin-top:10px"><a href="https://www.google.com/maps/dir/?${params}" target="_blank" rel="noopener">🗺️ 구글 지도로 경로·이동 시간 보기</a>
    <span class="muted">(갈 곳 순서대로, 대중교통 기준)</span></p>`;
}

// 출처·확인 표시: AI가 이번 조사에서 웹으로 확인한 정보인지
function srcBadge(item) {
  const url = item?.source_url;
  if (item?.verified && /^https?:\/\//i.test(url || "")) {
    return `<a class="badge badge-ok" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(url)}">✓ 확인됨 · 출처</a>`;
  }
  return `<span class="badge badge-unverified" title="AI의 기억·추측이에요. 직접 확인해 주세요">미확인</span>`;
}

const SOURCE_LEGEND = `<p class="muted small"><span class="badge badge-ok">✓ 확인됨</span> 이번 조사에서 웹으로 확인한 정보(출처 링크) ·
  <span class="badge badge-unverified">미확인</span> AI의 기억·추측이라 직접 확인이 필요한 정보</p>`;

const entriesOf = (section) => current.data.entries.filter((e) => e.section === section);

function entryHtml(e, { label = "" } = {}) {
  return `<div class="entry">
    ${e.photo_path ? `<a href="${photoUrl(e.photo_path)}" target="_blank" rel="noopener"><img src="${photoUrl(e.photo_path)}" alt="${esc(e.body || "사진")}" loading="lazy"></a>` : ""}
    ${e.body ? `<p>${linkify(e.body)}</p>` : ""}
    <div class="entry-meta"><span>${label ? `${esc(label)} · ` : ""}${esc(e.by_name || "익명")} · ${timeAgo(e.created_at)}</span>
      <button class="link-btn" type="button" data-del-entry="${esc(e.id)}">삭제</button></div>
  </div>`;
}

function entryForm(section, placeholder = "메모, 추천 장소, 링크 등을 함께 남겨요") {
  return `<form class="entry-form" data-section="${esc(section)}">
    <textarea name="body" rows="2" maxlength="4000" placeholder="${esc(placeholder)}"></textarea>
    <div class="entry-actions">
      <label class="btn btn-sm">📷 사진<input type="file" name="photos" accept="image/*" multiple hidden></label>
      <span class="muted small file-info"></span>
      <button class="btn btn-primary btn-sm" type="submit">추가</button>
    </div>
  </form>`;
}

function entriesBlock(section, title = "💬 함께 남긴 메모·사진") {
  const items = entriesOf(section);
  return `<section class="card">
    <h2 class="section-title">${title}</h2>
    ${items.length ? `<div class="entry-list">${items.map((e) => entryHtml(e)).join("")}</div>` : ""}
    ${entryForm(section)}
  </section>`;
}

function sectionLabel(section) {
  const m = section.match(/^day-(\d+)$/);
  if (m) return `Day ${Number(m[1]) + 1}`;
  return { overview: "개요", places: "가볼 곳", food: "맛집", budget: "예산", prep: "준비물", album: "앨범" }[section] || section;
}

function drawTab() {
  const body = document.getElementById("tab-body");
  const p = current.data.trip.plan;
  const renderers = { overview, days, places, food, budget, prep, album };
  body.innerHTML = renderers[current.tab]?.(p) || `<p class="muted">내용이 없어요.</p>`;
  bindTabEvents(body);
}

function bindTabEvents(body) {
  const tripId = current.id;

  body.querySelectorAll("[data-check]").forEach((el) =>
    el.addEventListener("change", async () => {
      current.data.checks = { ...current.data.checks, [el.dataset.check]: el.checked };
      try {
        await rpc("set_check", { p_trip: tripId, p_key: el.dataset.check, p_value: el.checked, p_by: myName() });
      } catch {
        toast("저장하지 못했어요");
      }
    })
  );

  body.querySelectorAll("[data-actual]").forEach((el) =>
    el.addEventListener("change", async () => {
      const value = el.value === "" ? null : Math.round(Number(el.value));
      const actuals = { ...current.data.actuals };
      if (value === null) delete actuals[el.dataset.actual];
      else actuals[el.dataset.actual] = value;
      current.data.actuals = actuals;
      try {
        await rpc("set_actual", { p_trip: tripId, p_item: el.dataset.actual, p_value: value, p_by: myName() });
        el.blur();
        drawTab();
        toast("저장했어요");
      } catch {
        toast("저장하지 못했어요");
      }
    })
  );

  body.querySelectorAll(".entry-form").forEach((form) => {
    const files = form.querySelector("input[type=file]");
    const info = form.querySelector(".file-info");
    files.addEventListener("change", () => (info.textContent = files.files.length ? `사진 ${files.files.length}장` : ""));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = form.body.value.trim();
      const photos = [...files.files];
      if (!text && !photos.length) return toast("내용이나 사진을 넣어 주세요");
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      const by = myName();
      try {
        if (!photos.length) {
          await rpc("add_entry", { p_trip: tripId, p_section: form.dataset.section, p_body: text, p_photo_path: null, p_by: by });
        }
        for (const [i, file] of photos.entries()) {
          info.textContent = `업로드 중 ${i + 1}/${photos.length}`;
          const path = await uploadPhoto(tripId, file);
          await rpc("add_entry", { p_trip: tripId, p_section: form.dataset.section, p_body: i === 0 ? text : "", p_photo_path: path, p_by: by });
        }
        form.reset();
        info.textContent = "";
        await refresh({ force: true });
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
  });

  body.querySelectorAll("[data-del-entry]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("이 항목을 삭제할까요?")) return;
      try {
        const path = await rpc("delete_entry", { p_trip: tripId, p_entry: btn.dataset.delEntry });
        if (path) await deletePhotos([path]);
        await refresh({ force: true });
      } catch (e) {
        toast(e.message);
      }
    })
  );

  // 확정 예약 원문 수정
  body.querySelector("[data-edit-bookings]")?.addEventListener("click", () => {
    const form = body.querySelector("[data-bookings-form]");
    form.hidden = !form.hidden;
    if (!form.hidden) form.bookings.focus();
  });
  body.querySelector("[data-bookings-form]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await rpc("set_bookings", { p_trip: tripId, p_text: e.target.bookings.value.trim() });
      e.target.bookings.value = "";
      toast("확정 예약을 저장했어요");
      await refresh({ force: true });
    } catch (err) {
      toast(err.message);
    }
  });

  // 총예산·통화·환율
  body.querySelector("[data-budget-form]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const budget = { total: f.total.value || null, currency: f.currency.value.trim() || null, rate: f.rate.value || null };
    try {
      await rpc("set_budget", { p_trip: tripId, p_budget: budget });
      f.reset();
      toast("예산 기준을 저장했어요");
      await refresh({ force: true });
    } catch (err) {
      toast(err.message);
    }
  });

  // 직접 추가하는 지출 항목
  const saveActual = async (item, value) => {
    await rpc("set_actual", { p_trip: tripId, p_item: item, p_value: value, p_by: myName() });
    await refresh({ force: true });
  };
  body.querySelector("[data-expense-form]")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const item = e.target.item.value.trim();
    const amount = Math.round(Number(e.target.amount.value));
    if (!item) return;
    if (item in (current.data.actuals || {}) || (current.data.trip.plan?.budget || []).some((b) => b.item === item)) {
      return toast("같은 이름의 항목이 있어요. 표에서 금액을 바꿔 주세요");
    }
    e.target.reset();
    try {
      await saveActual(item, amount);
      toast("지출을 추가했어요");
    } catch (err) {
      toast(err.message);
    }
  });
  body.querySelectorAll("[data-del-actual]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm(`'${btn.dataset.delActual}' 지출을 삭제할까요?`)) return;
      try {
        await saveActual(btn.dataset.delActual, null);
      } catch (err) {
        toast(err.message);
      }
    })
  );

  // 현지 통화 → 원 계산기
  const conv = body.querySelector("[data-convert]");
  conv?.addEventListener("input", () => {
    const rate = current.data.trip.budget?.rate || 0;
    body.querySelector("[data-convert-out]").textContent = `${won(Math.round((Number(conv.value) || 0) * rate))}원`;
  });
}

// ---------- 화면 조각 ----------
function table(headers, rows) {
  if (!rows.length) return "";
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
const card = (title, inner) => (inner ? `<section class="card"><h2 class="section-title">${title}</h2>${inner}</section>` : "");
const list = (items) => (items?.length ? `<ul class="info-list">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");

// ---------- 탭: 개요 ----------
function overview(p) {
  const t = current.data.trip;
  const callout = (cls, title, items) =>
    items?.length ? `<div class="callout ${cls}"><strong>${title}</strong><ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>` : "";

  // 확정 예약: 사용자가 입력한 원문을 앱이 그대로 보여 준다 (AI 결과와 별개 데이터)
  const bookings = `
    <section class="callout callout-ok" id="bookings-box">
      <div class="row-between"><strong>📌 확정 예약 — 직접 입력한 원문</strong>
        <button class="btn btn-sm" type="button" data-edit-bookings>수정</button></div>
      <p class="small muted" style="margin:2px 0 8px">AI가 바꾸지 않는 기준 정보예요. 아래 AI 정리본과 다르면 이 내용이 맞아요.</p>
      ${t.bookings ? `<div class="bookings-text">${linkify(t.bookings)}</div>` : `<p class="muted small">아직 입력한 확정 예약이 없어요.</p>`}
      <form class="stack" data-bookings-form hidden>
        <textarea name="bookings" maxlength="4000" rows="5" placeholder="예: 대한항공 KE723 04/02 09:00~10:40 예약번호 ABC123 / 숙소: 난바 OO호텔 2박">${esc(t.bookings || "")}</textarea>
        <div class="actions"><button class="btn btn-primary btn-sm" type="submit">저장</button></div>
      </form>
    </section>`;

  const alerts = (p.alerts || []).map((a) => (typeof a === "string" ? { text: a } : a));
  const alertBox = alerts.length
    ? `<div class="callout callout-warn"><strong>⚠️ 주의·변경 사항</strong>
        <ul>${alerts.map((a) => `<li>${esc(a.text)} ${srcBadge(a)}</li>`).join("")}</ul></div>`
    : "";

  const flights = table(
    ["구분", "항공사", "날짜", "시간", "편명", "가격", "상태"],
    (p.flights || []).map((f) => [f.direction, f.airline, f.date, f.time, f.flight_no, f.price, f.status].map(esc))
  );
  const lodgings = table(
    ["숙소", "지역", "체크인", "체크아웃", "가격", "위치", "상태"],
    (p.lodgings || []).map((l) => [
      esc(l.name), esc(l.area), esc(l.check_in), esc(l.check_out), esc(l.price),
      `<a href="${mapsUrl(l.map_query || l.name)}" target="_blank" rel="noopener">${esc(l.address || "지도")}</a>`,
      esc(l.status),
    ])
  );
  const reservations = table(
    ["구분", "이름", "장소", "날짜", "시간", "가격", "상태", "운영 정보"],
    (p.reservations || []).map((r) => [...[r.category, r.name, r.place, r.date, r.time, r.price, r.status].map(esc), srcBadge(r)])
  );
  const resNotes = (p.reservations || []).flatMap((r) => (r.notes || []).map((n) => `${r.name}: ${n}`));
  const aiLabel = (title) => `${title} <span class="badge badge-ai">AI 정리본</span>`;

  return `<div class="stack">
    ${bookings}
    ${alertBox}
    ${callout("callout-plain", "🤖 AI가 요약한 확정 사항", p.confirmed)}
    <div class="grid grid-2">
      ${card("📌 기본 정보", list(p.basic_info))}
      ${card("⚡ 지금 할 일", p.todos?.length ? `<ul class="checks">${p.todos.map((t) => checkItem(itemKey("todo", t.text), t.text, { fallback: t.done })).join("")}</ul>` : "")}
    </div>
    ${card(aiLabel("🛫 항공권"), flights)}
    ${card(aiLabel("🏨 숙소"), lodgings)}
    ${card(aiLabel("🎫 예약"), reservations + list(resNotes))}
    ${entriesBlock("overview")}
  </div>`;
}

// ---------- 탭: 일정 ----------
function days(p) {
  if (!p.days?.length) return "";
  const intro = `<div class="callout callout-info small" style="margin-bottom:16px">⏰ 시간이 정해진 건 고정 일정만이에요. 갈 곳·먹을 곳은 AI가 <strong>같은 지역끼리 묶은 목록</strong>이고,
    이동 시간·순서·교통편은 검증되지 않았어요. 날짜별 <strong>🗺️ 구글 지도로 경로 보기</strong>에서 실제 이동 시간을 확인하세요.</div>`;
  return intro + `<div class="stack">${p.days.map((d, di) => {
    const notes = entriesOf(`day-${di}`);
    return `
    <section class="card day">
      <h3>${esc(d.title)}</h3>
      ${d.fixed_schedule.length ? `<ul class="timeline">${d.fixed_schedule.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
      ${d.stay ? `<p class="small muted">🛏️ 숙박: ${esc(d.stay)}</p>` : ""}
      <div class="grid grid-2">
        ${d.places.length ? `<div><div class="sub">📸 갈 곳</div><ul class="checks">${d.places.map((x) => checkItem(itemKey("go", x), x, { mapQuery: placeQuery(x) })).join("")}</ul></div>` : ""}
        ${d.foods.length ? `<div><div class="sub">🍴 먹을 곳</div><ul class="checks">${d.foods.map((x) => checkItem(itemKey("eat", x), x, { mapQuery: placeQuery(x) })).join("")}</ul></div>` : ""}
      </div>
      ${routeLink(d.places)}
      <details class="day-notes" ${notes.length ? "open" : ""}>
        <summary>💬 이 날의 메모·사진 ${notes.length ? `(${notes.length})` : ""}</summary>
        ${notes.length ? `<div class="entry-list">${notes.map((e) => entryHtml(e)).join("")}</div>` : ""}
        ${entryForm(`day-${di}`, "이 날 추가하고 싶은 곳, 메모, 사진")}
      </details>
    </section>`;
  }).join("")}</div>`;
}

// ---------- 탭: 가볼 곳 ----------
function places(p) {
  const spots = (p.photo_spots || []).map((s, i) => `
    <div class="card place">
      <span class="chip">${esc(s.area)}</span>
      <h4>${esc(s.name)}</h4>
      <div class="small muted">🕐 ${esc(s.best_time)}</div>
      <p class="small">${esc(s.point)}</p>
      <div class="links">
        <a href="${imageUrl(s.search_query_en + " photo")}" target="_blank" rel="noopener">📷 예시 사진</a>
        <a href="${mapsUrl(s.search_query_en)}" target="_blank" rel="noopener">🗺️ 지도</a>
        ${srcBadge(s)}
      </div>
      <ul class="checks">${checkItem(itemKey("spot", s.name), "갈래요")}</ul>
    </div>`).join("");

  const acts = table(
    ["", "장소/활동", "지역", "소요시간", "가격", "예약", "우선순위", "메모", "정보"],
    (p.activities || []).map((a) => {
      const key = itemKey("act", a.name);
      return [
        `<input type="checkbox" data-check="${esc(key)}" ${isChecked(key) ? "checked" : ""} aria-label="${esc(a.name)}">`,
        esc(a.name), esc(a.area), esc(a.duration), esc(a.price),
        a.reservation_needed ? "필요" : "",
        `<span class="stars">${"★".repeat(Math.max(1, Math.min(3, a.priority)))}</span>`,
        esc(a.note),
        srcBadge(a),
      ];
    })
  );

  return `<div class="stack">
    ${SOURCE_LEGEND}
    ${spots ? `<h2 class="section-title">📸 사진 명소</h2><div class="grid grid-3">${spots}</div>` : ""}
    ${card("🎯 놀거리 / 액티비티", acts)}
    ${entriesBlock("places", "💬 추가로 가보고 싶은 곳")}
  </div>`;
}

// ---------- 탭: 맛집 ----------
function food(p) {
  const must = p.must_eat?.length
    ? card("😋 꼭 먹어볼 것", `<div class="chips">${p.must_eat.map((m) => `<span class="chip chip-accent">${esc(m)}</span>`).join("")}</div>`)
    : "";
  const groups = {};
  (p.restaurants || []).forEach((r, i) => (groups[r.meal_type || "기타"] ||= []).push([r, i]));
  const sections = Object.entries(groups).map(([type, items]) => `
    <h2 class="section-title">${esc(type)}</h2>
    <div class="grid grid-3">${items.map(([r, i]) => `
      <div class="card place">
        <span class="chip">${esc(r.area)}</span>
        <h4>${esc(r.name)}</h4>
        <div class="small">${esc(r.menu)}</div>
        <div class="small muted">${esc(r.feature)}${r.price_range ? " · " + esc(r.price_range) : ""}</div>
        ${r.reservation_needed ? `<span class="chip chip-warn">예약 필요</span>` : ""}
        <div class="links"><a href="${mapsUrl(r.search_query_en)}" target="_blank" rel="noopener">🗺️ 지도</a>${srcBadge(r)}</div>
        <ul class="checks">${checkItem(itemKey("rest", r.name), "갈래요")}</ul>
      </div>`).join("")}</div>`).join("");
  return `<div class="stack">${SOURCE_LEGEND}${must}${sections}${entriesBlock("food", "💬 추가로 가보고 싶은 맛집")}</div>`;
}

// ---------- 탭: 예산 ----------
function budget(p) {
  const items = p.budget || [];
  const settings = current.data.trip.budget || {};
  const actuals = current.data.actuals || {};
  const total = settings.total ?? null; // 사용자가 정한 총예산 (원)
  const planned = items.reduce((s, i) => s + (i.amount_krw || 0), 0); // AI 예산표 합계 (추정)
  const spent = Object.values(actuals).reduce((s, v) => s + (v || 0), 0); // 실제 입력한 지출 전체
  const left = total !== null ? total - spent : null;
  const cur = settings.currency;
  const rate = settings.rate;

  const stat = (label, value, hint = "", color = "") =>
    `<div class="card"><div class="muted small">${label}</div><h2 ${color ? `style="color:${color}"` : ""}>${value}</h2>${hint ? `<div class="small muted">${hint}</div>` : ""}</div>`;

  const settingsForm = `
    <form class="card stack" data-budget-form>
      <h2 class="section-title">⚙️ 예산 기준 (직접 입력)</h2>
      <div class="row3">
        <div class="field"><label for="b-total">총예산 (원)</label>
          <input type="number" id="b-total" name="total" min="0" step="10000" value="${total ?? ""}" placeholder="예: 2400000"></div>
        <div class="field"><label for="b-cur">현지 통화</label>
          <input type="text" id="b-cur" name="currency" maxlength="10" value="${esc(cur || "")}" placeholder="예: JPY"></div>
        <div class="field"><label for="b-rate">환율 (1 현지통화 = ?원)</label>
          <input type="number" id="b-rate" name="rate" min="0" step="any" value="${rate ?? ""}" placeholder="예: 9.1"></div>
      </div>
      <div class="actions"><button class="btn btn-primary btn-sm" type="submit">저장</button>
        <span class="hint">환율은 환전할 때 받은 값으로 넣으면 정확해요.</span></div>
    </form>`;

  const converter = cur && rate
    ? `<section class="card"><h2 class="section-title">💱 ${esc(cur)} → 원 계산기</h2>
        <div class="converter"><input type="number" min="0" step="any" placeholder="${esc(cur)} 금액" data-convert>
        <span>× ${rate} =</span><strong data-convert-out>0원</strong></div>
        <p class="hint">실지출은 원화로 입력해요. 현지 통화로 쓴 금액은 여기서 바꿔 넣으세요.</p></section>`
    : "";

  const actualInput = (name) =>
    `<input type="number" min="0" step="100" placeholder="0" data-actual="${esc(name)}" value="${actuals[name] ?? ""}" aria-label="${esc(name)} 실지출">`;
  const rows = items.map((i) => `<tr>
      <td>${esc(i.item)}</td>
      <td class="num">${won(i.amount_krw || "")}</td>
      <td class="num">${actualInput(i.item)}</td>
      <td class="muted small">${esc(i.note)}</td></tr>`).join("");
  // AI 예산표에 없는, 직접 추가한 지출 항목
  const planNames = new Set(items.map((i) => i.item));
  const extraRows = Object.keys(actuals).filter((k) => !planNames.has(k)).map((k) => `<tr>
      <td>${esc(k)} <span class="badge badge-ai">직접 추가</span></td><td class="num"></td>
      <td class="num">${actualInput(k)}</td>
      <td><button class="link-btn" type="button" data-del-actual="${esc(k)}">삭제</button></td></tr>`).join("");

  return `<div class="stack">
    <div class="grid grid-4">
      ${stat("총예산 (직접 입력)", total !== null ? `${won(total)}원` : "—", total !== null ? "" : "아래에서 입력해 주세요")}
      ${stat("실지출 합계", `${won(spent)}원`)}
      ${stat(left === null ? "총예산 잔액" : left >= 0 ? "총예산 잔액" : "총예산 초과", left === null ? "—" : `${won(Math.abs(left))}원`,
        "", left === null ? "" : left >= 0 ? "var(--accent)" : "var(--danger)")}
      ${stat("AI 예산표 합계", `${won(planned)}원`, "AI가 추정한 참고값")}
    </div>
    ${total !== null && planned > total ? `<div class="callout callout-warn small">⚠️ AI 예산표 합계(${won(planned)}원)가 총예산보다 ${won(planned - total)}원 많아요. 항목을 조정해 보세요.</div>` : ""}
    ${settingsForm}
    ${converter}
    <section class="card"><h2 class="section-title">항목별 예산·지출 <span class="badge badge-ai">예산은 AI 추정</span></h2>
      <div class="table-wrap"><table>
      <thead><tr><th>항목</th><th class="num">AI 예산</th><th class="num">실지출 (원)</th><th>비고</th></tr></thead>
      <tbody>${rows}${extraRows}</tbody>
      <tfoot><tr><td>합계</td><td class="num">${won(planned)}</td><td class="num">${won(spent)}</td><td></td></tr></tfoot>
    </table></div>
      <form class="add-expense" data-expense-form>
        <input type="text" name="item" maxlength="60" placeholder="지출 항목 추가 (예: 공항 리무진)" required>
        <input type="number" name="amount" min="0" step="100" placeholder="금액 (원)" required>
        <button class="btn btn-sm" type="submit">+ 추가</button>
      </form>
    </section>
    ${entriesBlock("budget", "💬 영수증·지출 메모")}
  </div>`;
}

// ---------- 탭: 준비물 ----------
function prep(p) {
  const checks = (prefix, items) => (items?.length ? `<ul class="checks">${items.map((t) => checkItem(itemKey(prefix, t), t)).join("")}</ul>` : "");
  const safe = (p.sources || []).filter((s) => /^https?:\/\//i.test(s.url));
  const sources = safe.length
    ? `<ul class="info-list">${safe.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a></li>`).join("")}</ul>`
    : "";
  return `<div class="stack">
    <div class="grid grid-2">
      ${card("✅ 여행 전", checks("before", p.checklist_before))}
      ${card("🧳 짐 싸기", checks("pack", p.packing))}
    </div>
    ${card("🆘 비상 연락", list(p.emergency))}
    ${card("📝 메모", list(p.memo))}
    ${card("🔗 조사 출처", sources)}
    ${entriesBlock("prep", "💬 추가 준비물·메모")}
  </div>`;
}

// ---------- 탭: 앨범 ----------
function album() {
  const photos = current.data.entries.filter((e) => e.photo_path).reverse();
  return `<div class="stack">
    <section class="card">
      <h2 class="section-title">📷 사진 올리기</h2>
      ${entryForm("album", "사진 설명 (선택)")}
    </section>
    ${photos.length
      ? `<div class="album">${photos.map((e) => entryHtml(e, { label: sectionLabel(e.section) })).join("")}</div>`
      : `<p class="muted">아직 사진이 없어요. 여행 중 찍은 사진을 함께 모아 보세요.</p>`}
  </div>`;
}
