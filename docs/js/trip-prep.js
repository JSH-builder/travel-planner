/* 준비 탭 */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js?v=2611220409";
import { icon } from "./icons.js?v=2611220409";
import { isMaking, renderRecord } from "./record.js?v=2611220409";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js?v=2611220409";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js?v=2611220409";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js?v=2611220409";
import { T, reload } from "./trip.js?v=2611220409";
import { act, closed, itemById, items, secHead, spots, trip } from "./trip-shared.js?v=2611220409";

// ---------- 준비 ----------
export function prep() {
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

export function openPrepEdit(id) {
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
