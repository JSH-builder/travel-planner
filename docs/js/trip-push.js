/* 일정 알림 (웹 푸시)
 * - '알림 켜기' → 알림 허용 → 이 휴대폰의 푸시 구독을 여행에 저장 (시간대 포함)
 * - 소유자 PC 작업기가 일정 시간에 맞춰 보냄 (비행기 3시간 전, 페리·공연 1시간 전, 일정 30분 전, 스팟 15분 전, 전날 밤 21시 요약)
 * - 여행을 열 때마다 시간대를 갱신 → 해외에 도착하면 현지 시간으로 알림
 */
import { CFG, rpc } from "./api.js?v=2611240257";
import { icon } from "./icons.js?v=2611240257";
import { esc, store, toast } from "./util.js?v=2611240257";
import { T } from "./trip.js?v=2611240257";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !!CFG.vapid;
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "";

function keyBytes(b64) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function currentSub() {
  if (!supported()) return null;
  const reg = await swReg();
  return reg.pushManager.getSubscription();
}

const wait = (p, ms, msg) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(msg)), ms))]);

/** 서비스 워커 준비 (등록이 없거나 아직 안 켜졌으면 직접 등록 — 무한정 기다리지 않게) */
async function swReg() {
  let reg = await navigator.serviceWorker.getRegistration();
  if (!reg) reg = await navigator.serviceWorker.register("sw.js");
  if (!reg.active) reg = await wait(navigator.serviceWorker.ready, 10000, "앱 준비가 늦어요. 새로고침 후 다시 눌러 주세요");
  return reg;
}

/** 알림 줄에 진행 상황·안내를 표시 (토스트는 금방 사라져서) */
function say(html) {
  const el = document.querySelector("[data-push]");
  if (!el) return;
  el.hidden = false;
  el.className = "push-bar off";
  el.innerHTML = `${icon("bell", 16)}<span class="grow">${html}</span>`;
}
const QUIET = `<b>알림 허용 창이 안 떴어요</b>
  <small>① 크롬 ⋮ → 설정 → 사이트 설정 → 알림: 맨 위 스위치 켜기 · '알림 요청 조용히 표시' 끄기 · 차단됨 목록에 이 사이트가 있으면 허용<br>
  ② 휴대폰 설정 → 애플리케이션 → Chrome → 알림 허용<br>
  홈 화면 앱이면: 아이콘 길게 누르기 → 앱 정보 → 알림 → 허용. 그다음 다시 켜기</small>
  <button class="chip-btn strong sm" data-act="push-on">다시 켜기</button>`;

/** "unsupported" | "denied" | "on" | "off" (on = 이 여행으로 켜져 있음) */
export async function pushState() {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const sub = await currentSub().catch(() => null);
  return sub && store("pushTrip") === T.id ? "on" : "off";
}

export async function enablePush() {
  if (!supported()) return toast("이 브라우저는 알림을 지원하지 않아요. 크롬에서 열어 주세요");
  say(`<b><span class="mini-spin"></span> 알림 허용을 기다리는 중…</b><small>화면에 '허용' 창이 뜨면 허용을 눌러 주세요</small>`);
  let perm = Notification.permission;
  if (perm !== "granted") {
    try {
      // 크롬은 예전에 무시한 사이트엔 창 대신 주소창에 조용히 아이콘만 띄움 → 응답이 안 오면 안내
      perm = await wait(Notification.requestPermission(), 15000, "quiet");
    } catch {
      return say(QUIET);
    }
  }
  if (perm !== "granted") {
    return say(`<b>알림이 차단돼 있어요</b><small>${perm === "denied"
      ? "크롬 ⋮ → 설정 → 사이트 설정 → 알림 → 차단됨에서 이 사이트를 허용으로 · 휴대폰 설정 → 애플리케이션 → Chrome → 알림 허용"
      : "허용을 눌러야 알림을 보낼 수 있어요"}</small><button class="chip-btn strong sm" data-act="push-on">다시 켜기</button>`);
  }
  try {
    say(`<b><span class="mini-spin"></span> 이 휴대폰을 알림 받을 기기로 등록하는 중…</b>`);
    const reg = await swReg();
    const sub = (await reg.pushManager.getSubscription()) ||
      (await wait(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(CFG.vapid) }), 20000,
        "푸시 등록이 응답하지 않아요 (Google Play 서비스·인터넷 확인)"));
    await rpc("add_push_sub", { p_trip: T.id, p_sub: sub.toJSON(), p_tz: tz(), p_label: store("myName") || null });
    store("pushTrip", T.id);
    toast("알림을 켰어요 · 30초쯤 뒤 확인 알림이 와요 (작업기가 켜져 있어야 해요)");
  } catch (e) {
    return say(`<b>알림을 켜지 못했어요</b><small>${esc(e.message || String(e))}</small>
      <button class="chip-btn strong sm" data-act="push-on">다시 켜기</button>`);
  }
  fillPush(document);
}

export async function disablePush() {
  try {
    const sub = await currentSub();
    if (sub) {
      await rpc("remove_push_sub", { p_trip: T.id, p_endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    store("pushTrip", null);
    toast("알림을 껐어요");
  } catch (e) {
    toast(e.message);
  }
  fillPush(document);
}

/** 여행을 열 때: 이 여행으로 켜 둔 알림이면 시간대만 갱신 (홍콩 도착 → 홍콩 시간) */
export async function refreshPush() {
  if (!supported() || Notification.permission !== "granted" || store("pushTrip") !== T.id || !navigator.onLine) return;
  try {
    const sub = await currentSub();
    if (sub) await rpc("add_push_sub", { p_trip: T.id, p_sub: sub.toJSON(), p_tz: tz(), p_label: null });
  } catch {}
}

/** 일정 탭 위 알림 줄 */
export async function fillPush(root) {
  const el = root.querySelector("[data-push]");
  if (!el || !T) return;
  const st = await pushState();
  if (st === "unsupported") return (el.hidden = true);
  el.hidden = false;
  el.className = `push-bar ${st}`;
  el.innerHTML = st === "on"
    ? `${icon("bell", 16)}<span class="grow"><b>일정 알림 켜짐</b><small>${esc(tz())} 시간 기준 · 비행기 3시간·페리·공연 1시간·일정 30분·스팟 15분 전</small></span>
       <button class="chip-btn sm" data-act="push-off">끄기</button>`
    : st === "denied"
      ? `${icon("bell", 16)}<span class="grow"><b>알림이 차단돼 있어요</b><small>크롬 ⋮ → 설정 → 사이트 설정 → 알림에서 허용해 주세요</small></span>`
      : `${icon("bell", 16)}<span class="grow"><b>일정 시간에 알림 받기</b><small>앱을 닫아 둬도 휴대폰으로 알려 드려요</small></span>
       <button class="chip-btn strong sm" data-act="push-on">켜기</button>`;
}
