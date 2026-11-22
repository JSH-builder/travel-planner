/* 여행 화면 공용: 데이터 도우미·사진·저장·시트 닫기 */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js?v=2611221119";
import { icon } from "./icons.js?v=2611221119";
import { isMaking, renderRecord } from "./record.js?v=2611221119";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js?v=2611221119";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js?v=2611221119";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js?v=2611221119";
import { T, apply, header, reload, render } from "./trip.js?v=2611221119";

// ---------- 데이터 도우미 ----------
export const trip = () => T.data.trip;
export const items = (cat) => T.data.items.filter((i) => (cat ? i.category === cat : true));
export const spots = () => T.data.items.filter(isSpot);
export const itemById = (id) => T.data.items.find((i) => i.id === id);
export const mediaOf = (itemId) => T.data.media.filter((m) => m.item_id === itemId);
export const dayOf = (d) => T.data.days.find((x) => x.day_date === d) || {};
export const days = () => tripDays(trip());
export const isOwner = () => !!ownerKey();

/** 자동 사진 찾기 속성. 식당·카페는 동명 브랜드 등 엉뚱한 사진이 많아 쓰지 않는다 */
export function wikiAttrs(i) {
  if (!i || i.category === "food" || i.category === "cafe") return "";
  return `data-wiki="${esc(i.name)}" data-wiki-en="${esc(i.search_query || "")}"`;
}

/** 카드 대표 사진: 직접 고른 사진 > 처음 올린 사진 > 모아 온 사진 첫 장 */
export function thumbPathOf(item) {
  const own = mediaOf(item.id).filter((m) => m.kind === "photo").map((m) => m.path);
  const ext = (item.photos || []).map((p) => p.path);
  if (item.thumb_path && (own.includes(item.thumb_path) || ext.includes(item.thumb_path))) return item.thumb_path;
  return own[0] || ext[0] || "";
}

/** 스팟 사진 전체 (대표 사진이 맨 앞): 직접 올린 사진·영상 + 모아 온 사진 */
export function galleryOf(i) {
  const own = mediaOf(i.id).map((m) => ({ type: "media", id: m.id, path: m.path, src: fileUrl(m.path), kind: m.kind,
    caption: m.caption || "", site: m.by_name || "", meta: [m.by_name, timeAgo(m.created_at)].filter(Boolean).join(" · ") }));
  const ext = (i.photos || []).map((p) => ({ type: "ext", path: p.path, src: fileUrl(p.path), kind: "photo",
    page: p.page, site: p.site || "", meta: p.site ? `사진 출처 · ${p.site}` : "" }));
  const all = [...own, ...ext];
  const k = all.findIndex((x) => x.path === thumbPathOf(i));
  if (k > 0) all.unshift(...all.splice(k, 1));
  return all;
}

export const enriching = (i) => i.enrich === "pending" || i.enrich === "working";
export function thumbOf(item) {
  const p = thumbPathOf(item);
  return p ? fileUrl(p) : "";
}

/** 배경 이미지 속성: 직접 올린 사진 > 위키 사진 > (없음 → CSS 기본).
 *  style 속성은 한 요소에 하나만 유효하므로 카테고리 색(--cat)도 여기서 함께 만든다 */
export function bgAttrs(i) {
  const t = thumbOf(i);
  const cat = `--cat:${CATS[i.category]?.color || "var(--ink-3)"};`;
  return t ? `style="${cat}background-image:url('${esc(t)}')" data-has="1"` : `style="${cat}" ${wikiAttrs(i)}`;
}

export function coverOf() {
  const t = trip();
  if (t.cover_path) return fileUrl(t.cover_path);
  // 회색 건물·음식 사진보다 풍경이 표지로 좋다: 사진 명소 > 랜드마크 > 가볼 곳의 사진 → 처음 올린 사진
  for (const cat of ["photo", "landmark", "place"]) {
    const it = T.data.items.find((i) => i.category === cat && (i.photos || []).length);
    if (it) return fileUrl(it.photos[0].path);
  }
  const photo = T.data.media.find((m) => m.kind === "photo");
  return photo ? fileUrl(photo.path) : "";
}

export function remember(id, title) {
  let recent = [];
  try {
    recent = JSON.parse(store("recentTrips") || "[]");
  } catch {}
  store("recentTrips", JSON.stringify([{ id, title }, ...recent.filter((r) => r.id !== id)].slice(0, 10)));
}
export function forget(id) {
  try {
    store("recentTrips", JSON.stringify(JSON.parse(store("recentTrips") || "[]").filter((r) => r.id !== id)));
  } catch {}
}

export const errorPage = (msg) => `<div class="page"><div class="empty"><p>${esc(msg)}</p><a class="btn" href="#/">처음으로</a></div></div>`;

export async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    await reload();
  } catch (e) {
    toast(e.message);
  }
}

export const secHead = (title, eyebrow = "", action = "") =>
  `<header class="sec-head"><div>${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ""}<h2>${title}</h2></div>${action}</header>`;


export function closed() {
  if (!T) return;
  T.afterReload = null;
  T.liveItem = null;
  T.liveKey = null;
  if (T.pending) apply(T.pending);
  else render();
}

export function dayOptions(selected) {
  return `<option value="">날짜 미정</option>` + days().map((d, i) =>
    `<option value="${d}" ${d === selected ? "selected" : ""}>Day ${i + 1} · ${dayLabel(d)}</option>`).join("");
}

export function bindAutosave(root, save) {
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
