/* 예산 탭 */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js";
import { icon } from "./icons.js";
import { isMaking, renderRecord } from "./record.js";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js";
import { EXP_CATS, T, reload } from "./trip.js";
import { act, closed, dayOptions, secHead, trip } from "./trip-shared.js";

// ---------- 예산 ----------
export function budget() {
  const t = trip();
  const b = t.budget || {};
  const ex = T.data.expenses;
  const spent = ex.reduce((a, e) => a + e.amount, 0);
  const left = b.total != null ? b.total - spent : null;
  const pct = b.total ? Math.min(100, (spent / b.total) * 100) : 0;
  const byCat = Object.entries(EXP_CATS).map(([k, [l, ic]]) => [l, ic, ex.filter((e) => (e.category || "etc") === k).reduce((a, e) => a + e.amount, 0)]).filter(([, , v]) => v);
  const groups = {};
  ex.forEach((e) => (groups[e.day_date || ""] ||= []).push(e));
  const est = t.summary?.budget_estimate || [];

  return `
    <div class="money">
      <p class="eyebrow">${left === null ? "SPENT" : left >= 0 ? "LEFT" : "OVER BUDGET"}</p>
      <p class="big ${left !== null && left < 0 ? "danger" : ""}">${won(left === null ? spent : Math.abs(left))}<small>원</small></p>
      ${b.total != null ? `<div class="bar ${left < 0 ? "over" : ""}"><span style="width:${pct}%"></span></div>
        <p class="money-sub"><span>지출 ${won(spent)}원</span><span>예산 ${won(b.total)}원</span></p>`
        : `<p class="muted">총예산을 정하면 남은 돈이 보여요. <button class="link" data-act="budget-set">예산 정하기</button></p>`}
    </div>
    <div class="btn-row"><button class="btn btn-ink grow" data-act="exp-add">${icon("plus", 18)} 지출 기록</button>
      <button class="btn btn-line" data-act="budget-set">${icon("pencil", 16)} 예산</button></div>
    ${b.currency && b.rate ? `<div class="converter">${icon("globe", 18)}
      <input class="input" type="number" inputmode="decimal" min="0" step="any" placeholder="${esc(b.currency)}" data-convert>
      <span>=</span><b data-convert-out>0원</b><small class="muted">1 ${esc(b.currency)} = ${b.rate}원</small></div>` : ""}
    ${byCat.length ? `<section class="sec">${secHead("어디에 썼나", "BREAKDOWN")}${byCat.map(([l, ic, v]) =>
      `<div class="cat-bar">${icon(ic, 16)}<span>${l}</span><span class="bar"><span style="width:${(v / spent) * 100}%"></span></span><b>${won(v)}</b></div>`).join("")}</section>` : ""}
    ${ex.length ? `<section class="sec">${secHead("지출 내역", "EXPENSES")}${Object.keys(groups).sort((a, z) => (z || "0").localeCompare(a || "0")).map((k) => `
      <p class="list-hd"><span>${k ? dayLabel(k) : "날짜 없음"}</span><span>${won(groups[k].reduce((a, e) => a + e.amount, 0))}원</span></p>
      <ul class="list">${groups[k].map((e) => `<li data-act="exp-open" data-id="${e.id}">
        <span class="list-ic">${icon((EXP_CATS[e.category] || EXP_CATS.etc)[1], 18)}</span>
        <span class="grow">${esc(e.title)}<small>${esc(e.by_name || "")}</small></span><b>${won(e.amount)}</b></li>`).join("")}</ul>`).join("")}</section>`
      : `<p class="muted center">쓴 돈을 기록하면 남은 예산이 자동으로 계산돼요.</p>`}
    ${est.length ? `<details class="sec fold"><summary>${secHead(`AI 예상 예산 · ${won(est.reduce((a, x) => a + (x.amount_krw || 0), 0))}원`, "ESTIMATE")}</summary>
      <ul class="plain small">${est.map((x) => `<li>${esc(x.item)} — ${x.amount_krw ? `${won(x.amount_krw)}원` : "미정"} <span class="muted">${esc(x.note || "")}</span></li>`).join("")}</ul></details>` : ""}`;
}

export function openExpense(id) {
  const e = id ? T.data.expenses.find((x) => x.id === id) : { title: "", amount: "", category: "food", day_date: phase(trip()).kind === "during" ? todayISO() : "" };
  const b = trip().budget || {};
  const s = openSheet(`
    <p class="eyebrow">EXPENSE</p><h2 class="sheet-title">${id ? "지출 고치기" : "얼마 썼어요?"}</h2>
    <form class="stack" data-exp>
      <div class="amount-row"><input class="input input-xl" name="amount" type="number" inputmode="decimal" min="0" step="any" required value="${e.amount}" placeholder="0">
        ${b.currency && b.rate ? `<div class="seg"><label><input type="radio" name="cur" value="KRW" checked><span>원</span></label>
          <label><input type="radio" name="cur" value="LOCAL"><span>${esc(b.currency)}</span></label></div>` : `<span class="unit">원</span>`}</div>
      <p class="hint" data-conv-hint></p>
      <input class="input" name="title" required maxlength="100" value="${esc(e.title)}" placeholder="무엇에? (예: 점심 라멘)">
      <div class="chips">${Object.entries(EXP_CATS).map(([k, [l, ic]]) =>
        `<label class="chip-radio"><input type="radio" name="category" value="${k}" ${k === (e.category || "etc") ? "checked" : ""}><span>${icon(ic, 15)} ${l}</span></label>`).join("")}</div>
      <div class="field"><label>날짜</label><select class="input" name="day_date">${dayOptions(e.day_date)}</select></div>
      <button class="btn btn-ink btn-block" type="submit">저장</button>
      ${id ? `<button class="btn btn-block btn-ghost danger" type="button" data-act="del-exp" data-id="${id}">${icon("trash", 16)} 삭제</button>` : ""}
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

export function openBudgetSettings() {
  const b = trip().budget || {};
  const s = openSheet(`
    <p class="eyebrow">BUDGET</p><h2 class="sheet-title">예산 정하기</h2>
    <form class="stack" data-bset>
      <div class="field"><label>총예산 (원, 전체 인원)</label><input class="input input-lg" name="total" type="number" inputmode="numeric" min="0" step="10000" value="${b.total ?? ""}"></div>
      <div class="grid2">
        <div class="field"><label>현지 통화</label><input class="input" name="currency" maxlength="10" value="${esc(b.currency || "")}" placeholder="JPY"></div>
        <div class="field"><label>1 현지통화 = ?원</label><input class="input" name="rate" type="number" inputmode="decimal" min="0" step="any" value="${b.rate ?? ""}" placeholder="9.1"></div>
      </div>
      <p class="hint">환율은 환전할 때 받은 값으로 넣으면 정확해요.</p>
      <button class="btn btn-ink btn-block" type="submit">저장</button>
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
