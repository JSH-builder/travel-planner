/* 시작점: 주소(#/...)에 따라 화면 고르기 + 내 여행 목록·새 여행·로그인 */
import { CFG, fileUrl, ownerKey, ownerRpc, rpc } from "./api.js";
import { openTrip, stop } from "./trip.js";
import { $, $$, dateRange, esc, phase, store, toast } from "./util.js";
import { lazyWiki } from "./wiki.js";

const $app = document.getElementById("app");

function route() {
  stop();
  window.scrollTo(0, 0);
  document.title = "여행 계획";
  if (!CFG.url || !CFG.key) return notConfigured();
  const parts = (location.hash.slice(1) || "/").split("/").filter(Boolean); // ["trip", id, tab, sub]
  if (parts[0] === "trip" && /^[0-9a-f-]{36}$/i.test(parts[1] || "")) return openTrip(parts[1], parts[2], parts[3] || "");
  if (parts[0] === "login") return login();
  if (parts[0] === "new") return ownerKey() ? newTrip() : (location.hash = "#/login");
  return ownerKey() ? myTrips() : landing();
}
window.addEventListener("hashchange", route);

function notConfigured() {
  $app.innerHTML = `<div class="page"><div class="empty"><div class="emoji">⚙️</div><h2>연결 설정이 필요해요</h2>
    <p class="muted">소유자 PC에서 '연결 설정.bat'을 실행하면 docs/config.js가 채워져요.</p></div></div>`;
}

function landing() {
  let recent = [];
  try {
    recent = JSON.parse(store("recentTrips") || "[]");
  } catch {}
  $app.innerHTML = `<div class="page">
    <div class="empty"><div class="emoji">🧳</div><h1>함께 만드는 여행 계획</h1>
      <p class="muted">공유받은 여행 링크로 들어와 주세요.</p></div>
    ${recent.length ? `<h2 class="section-title">최근 본 여행</h2><div class="stack">${recent.map((r) =>
      `<a class="card link-card" href="#/trip/${esc(r.id)}">${esc(r.title)} ›</a>`).join("")}</div>` : ""}
    <p class="center" style="margin-top:32px"><a class="link" href="#/login">소유자 로그인</a></p></div>`;
}

function login() {
  $app.innerHTML = `<div class="page">
    <header class="page-head"><a class="icon-btn" href="#/" aria-label="뒤로">‹</a><h1>소유자 로그인</h1></header>
    <form class="card stack" data-login>
      <p class="muted small">연결 설정 때 받은 소유자 키(.env 파일의 OWNER_KEY)를 넣으면 이 기기에서 여행을 만들고 삭제할 수 있어요.</p>
      <input class="input" name="key" autocomplete="off" placeholder="소유자 키" required>
      <button class="btn btn-primary btn-block" type="submit">로그인</button>
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
    $app.innerHTML = `<div class="page"><div class="empty"><p>${esc(e.message)}</p><a class="btn" href="#/login">소유자 키 다시 넣기</a></div></div>`;
    return;
  }
  const groups = { during: [], before: [], none: [], after: [] };
  trips.forEach((t) => groups[phase(t).kind].push(t));
  groups.before.sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""));
  const card = (t) => {
    const ph = phase(t);
    const cover = t.cover_path ? fileUrl(t.cover_path) : "";
    return `<a class="trip-card" href="#/trip/${esc(t.id)}">
      <span class="trip-cover ${cover ? "has-img" : ""}" ${cover ? `style="background-image:url('${esc(cover)}')"`
        : `data-wiki="${esc(t.destination || t.title)}" data-wiki-en="${esc(t.destination_en || "")}"`}>
        <span class="chip chip-glass">${esc(ph.label)}</span>
        ${["queued", "generating"].includes(t.status) ? `<span class="chip chip-ai">✨ AI 작업 중</span>` : ""}</span>
      <span class="trip-info"><strong>${esc(t.title)}</strong>
        <small class="muted">📍 ${esc(t.destination || "미정")} · ${esc(dateRange(t))}</small>
        <small class="muted">스팟 ${t.spots} · 방문 ${t.visited} · 사진 ${t.media}</small></span></a>`;
  };
  const section = (title, list) => (list.length ? `<h2 class="section-title">${title}</h2><div class="trip-list">${list.map(card).join("")}</div>` : "");
  $app.innerHTML = `<div class="page">
    <header class="page-head"><h1>🧳 내 여행</h1><a class="icon-btn" href="#/login" aria-label="계정">⚙</a></header>
    ${trips.length ? section("✈️ 여행 중", groups.during) + section("🗓️ 다가오는 여행", groups.before) + section("📝 날짜 미정", groups.none) + section("📚 지난 여행", groups.after)
      : `<div class="empty"><div class="emoji">🗺️</div><h2>첫 여행을 만들어 보세요</h2><p class="muted">AI 추천으로 채우거나, 직접 하나씩 채울 수 있어요.</p></div>`}
  </div>
  <a class="fab wide" href="#/new">＋ 새 여행</a>`;
  lazyWiki($app);
}

// ---------- 새 여행 ----------
const STYLES = ["📸 사진·감성", "🍜 맛집", "☕ 카페", "🛍️ 쇼핑", "🌿 자연", "🏛️ 역사·문화", "🎢 액티비티", "🌙 야경", "🐢 여유롭게", "🏃 알차게"];

function newTrip() {
  $app.innerHTML = `<div class="page">
    <header class="page-head"><a class="icon-btn" href="#/" aria-label="뒤로">‹</a><h1>새 여행</h1></header>
    <form class="stack-lg" data-new>
      <section class="card stack">
        <h2 class="section-title">어디로 떠나요?</h2>
        <div class="field"><label>여행 이름 *</label><input class="input" name="title" required maxlength="120" placeholder="예: 벚꽃 보러 가는 오사카"></div>
        <div class="field"><label>목적지 *</label><input class="input" name="destination" required maxlength="120" placeholder="예: 일본 오사카·교토"></div>
        <div class="grid2">
          <div class="field"><label>출발 *</label><input class="input" type="date" name="start_date" required></div>
          <div class="field"><label>도착 *</label><input class="input" type="date" name="end_date" required></div>
        </div>
        <div class="field"><label>누구와?</label><input class="input" name="companions" maxlength="200" placeholder="예: 친구 1명, 커플, 가족 4명"></div>
      </section>

      <section class="card stack">
        <h2 class="section-title">어떻게 채울까요?</h2>
        <div class="choice">
          <label><input type="radio" name="mode" value="ai" checked><span><b>✨ AI 추천으로 채우기</b>
            <small>스팟·일정·준비물·예산·추천 영상을 자동으로. 이후 자유롭게 고칠 수 있어요.</small></span></label>
          <label><input type="radio" name="mode" value="manual"><span><b>✍️ 직접 채우기</b>
            <small>빈 여행으로 시작해서 하나씩 추가. 나중에 AI 추천도 받을 수 있어요.</small></span></label>
        </div>
        <div class="stack" data-ai-opts>
          <div class="field"><label>여행 스타일 (여러 개)</label><div class="chips">${STYLES.map((s) =>
            `<label class="chip-check"><input type="checkbox" name="styles" value="${s.slice(s.indexOf(" ") + 1)}"><span>${s}</span></label>`).join("")}</div></div>
          <div class="field"><label>꼭 하고 싶은 것</label><textarea class="input" name="must_do" rows="2" placeholder="예: 교토 벚꽃 명소, 유니버설 스튜디오"></textarea></div>
          <div class="grid2">
            <div class="field"><label>최신 정보 검색</label><select class="input" name="max_searches">
              <option value="0">끄기 (1~3분)</option><option value="6">가볍게 (약 5분)</option>
              <option value="15" selected>보통 (약 10분)</option><option value="25">꼼꼼히 (15분+)</option></select></div>
            <div class="field"><label>AI 모델</label><select class="input" name="model">
              <option value="">기본</option><option value="sonnet">Sonnet (사용량 절약)</option><option value="opus">Opus (꼼꼼)</option></select></div>
          </div>
        </div>
      </section>

      <details class="card">
        <summary class="section-title">💰 예산 · 📌 확정 예약 (선택)</summary>
        <div class="stack" style="margin-top:12px">
          <div class="field"><label>총예산 (원, 전체 인원)</label><input class="input" type="number" inputmode="numeric" name="total" min="0" step="10000"></div>
          <div class="grid2">
            <div class="field"><label>현지 통화</label><input class="input" name="currency" maxlength="10" placeholder="JPY"></div>
            <div class="field"><label>1 현지통화 = ?원</label><input class="input" type="number" inputmode="decimal" name="rate" min="0" step="any" placeholder="9.1"></div>
          </div>
          <div class="field"><label>확정 예약 원문</label><textarea class="input" name="bookings" rows="3"
            placeholder="예: 대한항공 KE723 04/02 09:00 인천→간사이&#10;숙소: 난바 OO호텔 3박"></textarea>
            <span class="hint">원문 그대로 저장되고 AI가 바꾸지 않아요.</span></div>
        </div>
      </details>

      <p class="hint">🔒 AI 추천을 고르면 입력한 내용이 Claude(Anthropic)로 전송되고, 소유자의 Claude 구독 사용량이 차감돼요. AI 작업은 소유자 PC의 작업기가 켜져 있을 때 처리돼요.</p>
      <button class="btn btn-primary btn-block btn-lg sticky-cta" type="submit" data-submit>✨ AI 추천 받기</button>
    </form></div>`;

  const form = $("[data-new]");
  const sync = () => {
    const ai = form.mode.value === "ai";
    $("[data-ai-opts]").hidden = !ai;
    $("[data-submit]").textContent = ai ? "✨ AI 추천 받기" : "여행 만들기";
  };
  form.addEventListener("change", (e) => {
    if (e.target.name === "mode") sync();
    if (e.target.name === "start_date" && (!form.end_date.value || form.end_date.value < form.start_date.value)) form.end_date.value = form.start_date.value;
  });
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

// 모든 정의가 끝난 뒤 시작 (위에서 바로 부르면 STYLES 같은 상수가 아직 준비 전)
route();
