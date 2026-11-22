/* 지출 탭 (일정 비용 + 직접 기록한 지출 자동 합산) */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js?v=2611220919";
import { icon } from "./icons.js?v=2611220919";
import { isMaking, renderRecord } from "./record.js?v=2611220919";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js?v=2611220919";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js?v=2611220919";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js?v=2611220919";
import { EXP_CATS, T, reload } from "./trip.js?v=2611220919";
import { act, closed, dayOptions, secHead, trip } from "./trip-shared.js?v=2611220919";

// ---------- 지출 ----------
/** 동행 인원 (예: "조성희, 이승희" → 2, "친구 3명" → 3). 모르면 0 */
function headcount(t) {
  const c = (t.companions || "").trim();
  if (!c) return 0;
  const n = /(\d+)\s*명/.exec(c);
  if (n) return Number(n[1]);
  if (/혼자|나홀로/.test(c)) return 1;
  const ko = { 둘: 2, 두: 2, 셋: 3, 세: 3, 넷: 4, 네: 4, 다섯: 5, 여섯: 6 };
  const w = /(둘|셋|넷|다섯|여섯)이|(두|세|네|다섯|여섯)\s*(명|사람)/.exec(c);
  if (w) return ko[w[1] || w[2]];
  if (/커플|부부|연인/.test(c)) return 2;
  const names = c.split(/[,，·/&]|\s+그리고\s+|\s+와\s+|\s+과\s+/).map((x) => x.trim()).filter(Boolean);
  return names.length > 1 ? names.length : 0;
}

export function budget() {
  const t = trip();
  const b = t.budget || {};
  const ex = T.data.expenses;
  const spent = ex.reduce((a, e) => a + e.amount, 0);
  const people = headcount(t);
  const fromPlan = ex.filter((e) => e.item_id).reduce((a, e) => a + e.amount, 0);
  const byCat = Object.entries(EXP_CATS).map(([k, [l, ic]]) => [l, ic, ex.filter((e) => (e.category || "etc") === k).reduce((a, e) => a + e.amount, 0)]).filter(([, , v]) => v);
  const groups = {};
  ex.forEach((e) => (groups[e.day_date || ""] ||= []).push(e));
  const dayKeys = Object.keys(groups).sort((a, z) => (a || "9").localeCompare(z || "9"));
  const itemName = (e) => (e.item_id && T.data.items.find((i) => i.id === e.item_id)?.name) || e.title;

  return `
    <div class="money">
      <p class="eyebrow">TOTAL SPENT</p>
      <p class="big">${won(spent)}<small>원</small></p>
      <p class="money-sub">${people ? `<span>1인 약 ${won(Math.round(spent / people))}원 · ${people}명</span>` : "<span></span>"}
        ${fromPlan ? `<span>일정 비용 ${won(fromPlan)}원 포함</span>` : ""}</p>
    </div>
    <div class="btn-row"><button class="btn btn-ink grow" data-act="exp-add">${icon("plus", 18)} 지출 기록</button>
      <button class="btn btn-line" data-act="budget-set">${icon("globe", 16)} 환율</button></div>
    <p class="hint px">일정 탭의 각 일정 옆 '비용'에 넣은 금액도 여기에 자동으로 더해져요.</p>
    ${b.currency && b.rate ? `<div class="converter">${icon("globe", 18)}
      <input class="input" type="number" inputmode="decimal" min="0" step="any" placeholder="${esc(b.currency)}" data-convert>
      <span>=</span><b data-convert-out>0원</b><small class="muted">1 ${esc(b.currency)} = ${b.rate}원</small></div>` : ""}
    ${dayKeys.length > 1 ? `<section class="sec">${secHead("날짜별", "BY DAY")}<div class="day-sums">${dayKeys.map((k) => {
      const v = groups[k].reduce((a, e) => a + e.amount, 0);
      return `<div><small>${k ? dayLabel(k) : "날짜 없음"}</small><b>${won(v)}</b></div>`;
    }).join("")}</div></section>` : ""}
    ${byCat.length ? `<section class="sec">${secHead("어디에 썼나", "BREAKDOWN")}${byCat.map(([l, ic, v]) =>
      `<div class="cat-bar">${icon(ic, 16)}<span>${l}</span><span class="bar"><span style="width:${(v / spent) * 100}%"></span></span><b>${won(v)}</b></div>`).join("")}</section>` : ""}
    ${ex.length ? `<section class="sec">${secHead("지출 내역", "EXPENSES")}${dayKeys.slice().reverse().map((k) => `
      <p class="list-hd"><span>${k ? dayLabel(k) : "날짜 없음"}</span><span>${won(groups[k].reduce((a, e) => a + e.amount, 0))}원</span></p>
      <ul class="list">${groups[k].map((e) => `<li data-act="${e.item_id ? "cost" : "exp-open"}" data-id="${e.item_id || e.id}">
        <span class="list-ic">${icon((EXP_CATS[e.category] || EXP_CATS.etc)[1], 18)}</span>
        <span class="grow">${esc(itemName(e))}<small>${e.item_id ? `<em class="tag-plan">일정</em> ` : ""}${esc(e.by_name || "")}</small></span><b>${won(e.amount)}</b></li>`).join("")}</ul>`).join("")}</section>`
      : `<p class="muted center">쓴 돈을 기록하거나 일정에 비용을 넣으면 여기서 자동으로 합산돼요.</p>`}`;
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
    <p class="eyebrow">EXCHANGE RATE</p><h2 class="sheet-title">환율</h2>
    <p class="muted">현지 통화로 지출·비용을 넣으면 이 환율로 원화로 바꿔서 합산해요.</p>
    <form class="stack" data-bset>
      <div class="grid2">
        <div class="field"><label>현지 통화</label><input class="input" name="currency" maxlength="10" value="${esc(b.currency || "")}" placeholder="HKD"></div>
        <div class="field"><label>1 현지통화 = ?원</label><input class="input" name="rate" type="number" inputmode="decimal" min="0" step="any" value="${b.rate ?? ""}" placeholder="185"></div>
      </div>
      <p class="hint">환전할 때 받은 값으로 넣으면 정확해요.</p>
      <button class="btn btn-ink btn-block" type="submit">저장</button>
    </form>`, { onClose: closed });
  $("[data-bset]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await rpc("update_trip", { p_trip: T.id, p_patch: { budget: { currency: f.currency.value || null, rate: f.rate.value || null } } });
      s.close();
      toast("저장했어요");
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}
