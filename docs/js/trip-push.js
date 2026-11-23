/* 일정 알림 (웹 푸시)
 * - '알림 켜기' → 알림 허용 → 이 휴대폰의 푸시 구독을 여행에 저장 (시간대 포함)
 * - 소유자 PC 작업기가 일정 시간에 맞춰 보냄 (비행기 3시간 전, 페리·공연 1시간 전, 일정 30분 전, 스팟 15분 전, 전날 밤 21시 요약)
 * - 여행을 열 때마다 시간대를 갱신 → 해외에 도착하면 현지 시간으로 알림
 */
import { CFG, rpc } from "./api.js?v=2611240229";
import { icon } from "./icons.js?v=2611240229";
import { esc, store, toast } from "./util.js?v=2611240229";
import { T } from "./trip.js?v=2611240229";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && !!CFG.vapid;
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "";

function keyBytes(b64) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function currentSub() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** "unsupported" | "denied" | "on" | "off" (on = 이 여행으로 켜져 있음) */
export async function pushState() {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const sub = await currentSub().catch(() => null);
  return sub && store("pushTrip") === T.id ? "on" : "off";
}

export async function enablePush() {
  if (!supported()) return toast("이 브라우저는 알림을 지원하지 않아요. 크롬에서 열어 주세요");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return toast("알림이 허용되지 않았어요. 휴대폰 설정 → 앱 → 크롬 → 알림에서 켜 주세요");
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(CFG.vapid) }));
    await rpc("add_push_sub", { p_trip: T.id, p_sub: sub.toJSON(), p_tz: tz(), p_label: store("myName") || null });
    store("pushTrip", T.id);
    toast("알림을 켰어요 · 잠시 뒤 확인 알림이 와요 (작업기가 켜져 있어야 해요)");
  } catch (e) {
    toast(`알림을 켜지 못했어요: ${e.message}`);
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
      ? `${icon("bell", 16)}<span class="grow"><b>알림이 차단돼 있어요</b><small>휴대폰 설정 → 앱 → 크롬 → 알림에서 허용해 주세요</small></span>`
      : `${icon("bell", 16)}<span class="grow"><b>일정 시간에 알림 받기</b><small>앱을 닫아 둬도 휴대폰으로 알려 드려요</small></span>
       <button class="chip-btn strong sm" data-act="push-on">켜기</button>`;
}
