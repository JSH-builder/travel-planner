/* 여행 화면 핵심: 진입·새로고침·전체 틀·클릭 처리 (화면별 내용은 trip-*.js) */
import { deleteFiles, fileUrl, flushOutbox, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js";
import { prefetchImages } from "./offline.js";
import { fillLegs, openPlan } from "./trip-plan.js";
import { openYoutubeImport } from "./trip-youtube.js";
import { afterScheduleChange, openCost } from "./trip-cost.js";
import { icon } from "./icons.js";
import { isMaking, renderRecord } from "./record.js";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js";
import { album, openCoverPicker, openMedia, pickAndUpload } from "./trip-album.js";
import { openBookings, openEditTrip, openMenu, shareLink } from "./trip-menu.js";
import { budget, openBudgetSettings, openExpense } from "./trip-money.js";
import { fillCommons, overview } from "./trip-overview.js";
import { openPrepEdit, prep } from "./trip-prep.js";
import { openSchedule, scheduleTab } from "./trip-schedule.js";
import { act, enriching, errorPage, forget, isOwner, itemById, remember, spots, trip } from "./trip-shared.js";
import { openAddSpot, openGallery, openRecommend, openSpot, spotsTab } from "./trip-spots.js";

export const $app = document.getElementById("app");
export const TABS = [
  ["overview", "home", "홈"],
  ["schedule", "calendar", "일정"],
  ["spots", "pin", "스팟"],
  ["album", "image", "앨범"],
  ["budget", "wallet", "지출"],
  ["prep", "backpack", "준비"],
];
export const EXP_CATS = {
  food: ["식비", "utensils"], transport: ["교통", "bus"], stay: ["숙소", "bed"],
  shopping: ["쇼핑", "bag"], ticket: ["입장·체험", "ticket"], etc: ["기타", "card"],
};
export const JOB_LABEL = { plan: "여행 추천", recommend: "추천 더 받기", blog: "블로그 글", youtube: "유튜브 정리" };

export let T = null; // { id, data, tab, sub, filter, pending }
export let pollTimer = null;

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
  if (store("openCover") === id) {
    store("openCover", null);
    openCoverPicker();
  }
}

export function stop() {
  clearTimeout(pollTimer);
  T = null;
}

export const busy = () => ["queued", "generating"].includes(T?.data.trip.status);

export function schedule() {
  clearTimeout(pollTimer);
  if (T) pollTimer = setTimeout(poll, busy() || T.data.items.some(enriching) ? 4000 : 9000);
}

export function editing() {
  const a = document.activeElement;
  return !!a && $app.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !["checkbox", "file", "radio"].includes(a.type)));
}

export async function poll() {
  if (!T) return;
  if (!document.hidden) {
    try {
      const data = await rpc("get_trip", { p_trip: T.id });
      if (!T) return;
      if (!data) return (location.hash = "#/");
      if (JSON.stringify(data) !== JSON.stringify(T.data)) {
        // 열린 스팟 상세는 사진·정보가 새로 채워졌을 때만 바로 다시 그린다 (읽는 중에 화면이 흔들리지 않게)
        const live = sheetIsOpen() && T.liveItem && !editing();
        const key = (d) => JSON.stringify(["enrich", "photos", "details"].map((k) => d.items.find((x) => x.id === T.liveItem)?.[k]));
        if (live && key(data) !== key(T.data)) {
          T.data = data;
          T.pending = data;
          T.afterReload?.();
        } else if (sheetIsOpen() || editing() || isMaking()) T.pending = data;
        else apply(data);
      }
    } catch {}
  }
  schedule();
}

export function apply(data) {
  T.data = data;
  T.pending = null;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

export async function reload() {
  const data = await rpc("get_trip", { p_trip: T.id });
  if (!T || !data) return;
  if (editing()) T.pending = data;
  else apply(data);
  T.afterReload?.();
}

document.addEventListener("visibilitychange", () => !document.hidden && T && poll());

// ---------- 전체 틀 ----------
export function render() {
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

export function afterRender() {
  lazyWiki($app);
  if (T.tab === "overview") fillCommons();
  if (T.tab === "schedule") fillLegs($app);
}

export function header(back = false) {
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

export function jobBanner() {
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
    case "cover-pick": closeSheet(); return openCoverPicker();
    case "set-cover": {
      const path = el.dataset.path || null;
      T.coverFallback = null;
      return act(() => rpc("update_trip", { p_trip: T.id, p_patch: { cover_path: path } }), path ? "표지를 바꿨어요" : "자동 표지로 바꿨어요");
    }
    case "upload-cover":
      return pickAndUpload({ photoOnly: true, multiple: false,
        onUploaded: (path) => rpc("update_trip", { p_trip: T.id, p_patch: { cover_path: path } }).then(() => toast("표지를 바꿨어요")) });
    case "set-thumb":
      return act(() => rpc("upsert_item", { p_trip: T.id, p_item: { id, thumb_path: el.dataset.path } }), "대표 사진을 바꿨어요");
    case "install": closeSheet(); return openInstallGuide();
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
    case "cost": closeSheet(); return openCost(id);
    case "plan": closeSheet(); return openPlan(id, el.dataset.day || "");
    case "gal-open": return openGallery(id, Number(el.dataset.idx) || 0);
    case "enrich": {
      const n = await rpc("request_enrich", { p_trip: T.id, p_item: id || null }).catch((err) => toast(err.message));
      if (n === undefined) return;
      toast(n ? (id ? "사진·정보를 모아 올게요. 작업기가 켜져 있어야 해요" : `${n}곳의 사진·정보를 모아 올게요`) : "새로 모을 곳이 없어요");
      return reload();
    }
    case "link-del": {
      const it = itemById(id);
      const links = (it.links || []).filter((_, k) => k !== Number(el.dataset.idx));
      return act(() => rpc("upsert_item", { p_trip: T.id, p_item: { id, links } }), "링크를 뺐어요");
    }
    case "add-spot": return openAddSpot(el.dataset.cat, el.dataset.day);
    case "recommend": return openRecommend(el.dataset.cat);
    case "yt-import": closeSheet(); return openYoutubeImport();
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
    case "del-item": {
      if (!confirm("삭제할까요? (올린 사진·영상은 앨범에 남아요)")) return;
      const ext = (itemById(id)?.photos || []).map((p) => p.path);
      closeSheet();
      await act(async () => {
        await rpc("delete_item", { p_trip: T.id, p_item: id });
        await deleteFiles(ext);
      }, "삭제했어요");
      return afterScheduleChange(null);
    }
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
    case "offline-save": {
      closeSheet();
      const d = T.data;
      const urls = [
        ...d.media.filter((m) => m.kind === "photo").map((m) => fileUrl(m.path)),
        ...d.items.flatMap((i) => (i.photos || []).map((p) => fileUrl(p.path))),
        trip().cover_path ? fileUrl(trip().cover_path) : "",
      ];
      toast(`사진 ${urls.filter(Boolean).length}장을 받는 중…`);
      const n = await prefetchImages(urls);
      return toast(`오프라인용 저장 완료 · 일정·스팟과 사진 ${n}장`);
    }
    case "delete-trip":
      if (!confirm(`'${trip().title}' 여행을 삭제할까요? 스팟·사진·영상·지출까지 모두 지워지고 되돌릴 수 없어요.`)) return;
      try {
        await deleteFiles([...T.data.media.map((m) => m.path), ...T.data.items.flatMap((i) => (i.photos || []).map((p) => p.path))]);
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

// 스팟 상세: 링크 추가 → 저장하면 서버가 자동으로 '사진·정보 모으기' 대기열에 넣음
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-link-add]");
  if (!T || !form) return;
  e.preventDefault();
  const id = form.dataset.linkAdd;
  const url = form.url.value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return toast("http로 시작하는 링크를 넣어 주세요");
  const it = itemById(id);
  if ((it.links || []).some((l) => l.url === url)) return toast("이미 넣은 링크예요");
  if ((it.links || []).length >= 10) return toast("링크는 10개까지 넣을 수 있어요");
  form.url.value = "";
  form.url.blur();
  await act(() => rpc("upsert_item", { p_trip: T.id, p_item: { id, links: [...(it.links || []), { url }] } }), "링크를 넣었어요. 사진·정보를 정리해 올게요");
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

export const saveDay = debounce(async (el) => {
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

// 연결이 돌아오면 모아 둔 변경을 보내고 새로 불러오기
window.addEventListener("online", async () => {
  await flushOutbox().catch(() => {});
  if (T) reload().catch(() => {});
});

export const tripApi = { reload, pickAndUpload, trip: () => T && trip(), data: () => T?.data, id: () => T?.id, busy };
