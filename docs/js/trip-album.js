/* 앨범 탭 + 사진 보기·표지 고르기·올리기 */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js?v=2611240202";
import { icon } from "./icons.js?v=2611240202";
import { isMaking, renderRecord } from "./record.js?v=2611240202";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js?v=2611240202";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js?v=2611240202";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js?v=2611240202";
import { T, header, reload } from "./trip.js?v=2611240202";
import { thumbTile } from "./trip-schedule.js?v=2611240202";
import { act, closed, days, itemById, spots, trip } from "./trip-shared.js?v=2611240202";

// ---------- 앨범 ----------
export function album() {
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

export function openMedia(id) {
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

/** 표지(여행 썸네일) 고르기: 앨범 사진 중 선택 / 새로 올리기 / 자동 */
export function openCoverPicker() {
  const draw = () => {
    const t = trip();
    const photos = T.data.media.filter((m) => m.kind === "photo");
    sheet.el.innerHTML = `<p class="eyebrow">COVER</p><h2 class="sheet-title">표지 사진 고르기</h2>
      <p class="muted">홈 화면 맨 위와 '내 여행' 목록 썸네일에 쓰여요.</p>
      <div class="pick-grid">
        <button class="pick auto ${!t.cover_path ? "on" : ""}" data-act="set-cover" data-path="" aria-pressed="${!t.cover_path}">
          ${icon("sparkles", 20)}<span>자동</span><small>첫 사진·풍경</small></button>
        ${photos.map((m) => `<button class="pick ${t.cover_path === m.path ? "on" : ""}" data-act="set-cover" data-path="${esc(m.path)}"
          style="background-image:url('${esc(fileUrl(m.path))}')" aria-label="이 사진을 표지로" aria-pressed="${t.cover_path === m.path}">
          ${t.cover_path === m.path ? `<span class="pick-on">${icon("check", 16)}</span>` : ""}</button>`).join("")}
      </div>
      <button class="btn btn-ink btn-block" data-act="upload-cover">${icon("upload", 18)} 새 사진 올려서 표지로</button>
      ${photos.length ? "" : `<p class="hint center">아직 올린 사진이 없어요. 새 사진을 올리거나 앨범에 먼저 모아 보세요.</p>`}`;
  };
  const sheet = openSheet("", { onClose: closed });
  T.afterReload = () => sheetIsOpen() && draw();
  draw();
}

/** 파일 고르기 → 올리기 → 앨범·카드에 연결. onUploaded(마지막 사진 경로)는 올린 뒤 추가 처리 */
export function pickAndUpload({ itemId = null, day = null, photoOnly = false, multiple = true, onUploaded = null } = {}) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = photoOnly ? "image/*" : "image/*,video/*";
  input.multiple = multiple;
  input.addEventListener("change", async () => {
    const files = [...input.files];
    if (!files.length) return;
    const by = await askName();
    const fallbackDay = day || (phase(trip()).kind === "during" ? todayISO() : null);
    let ok = 0;
    let lastPhoto = "";
    for (const [n, f] of files.entries()) {
      try {
        const { path, kind } = await uploadFile(T.id, f, (p) => toast(`올리는 중 ${n + 1}/${files.length} · ${Math.round(p * 100)}%`));
        await rpc("add_media", { p_trip: T.id, p_item: itemId, p_kind: kind, p_path: path, p_caption: null, p_by: by, p_day: itemId ? null : fallbackDay });
        if (kind === "photo") lastPhoto = path;
        ok++;
      } catch (e) {
        toast(`${f.name}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 1800));
      }
    }
    if (ok) toast(`${ok}개 올렸어요`);
    if (onUploaded && lastPhoto) {
      try {
        await onUploaded(lastPhoto);
      } catch (e) {
        toast(e.message);
      }
    }
    await reload();
  });
  input.click();
}
