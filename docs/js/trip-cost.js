/* 일정 비용 · 자동 할 일
 * - 일정(확정 일정·스팟)마다 비용 → 지출로 자동 기록 (set_item_cost: 일정 하나당 지출 하나, 지우면 같이 지워짐)
 * - 스팟을 일정에 넣으면 필요한 할 일(예약·현금·티켓)을 자동으로 만들고, 일정에서 빼면 지움
 */
import { rpc } from "./api.js";
import { icon } from "./icons.js";
import { openSheet } from "./ui.js";
import { $, dayLabel, esc, isSpot, md, toast, won } from "./util.js";
import { EXP_CATS, T, reload } from "./trip.js";
import { closed, itemById, trip } from "./trip-shared.js";

export const costOf = (itemId) => T.data.expenses.find((e) => e.item_id === itemId);

/** 항목 → 지출 분류 */
export function catFor(i) {
  if (i.category === "food" || i.category === "cafe") return "food";
  if (["activity", "landmark", "photo", "place"].includes(i.category)) return "ticket";
  const n = `${i.name} ${i.note || ""}`;
  if (/항공|KE\d|OZ\d|페리|ferry|버스|택시|공항|MTR|지하철|기차|트램/i.test(n)) return "transport";
  if (/호텔|숙소|체크인|체크아웃|hotel/i.test(n)) return "stay";
  if (/쇼|공연|티켓|입장|박물관/.test(n)) return "ticket";
  return "etc";
}

/** 타임라인·상세의 비용 버튼 */
export function costChip(i) {
  const c = costOf(i.id);
  return `<button class="cost-chip ${c ? "on" : ""}" data-act="cost" data-id="${i.id}" aria-label="${esc(i.name)} 비용">
    ${c ? `${won(c.amount)}원` : `${icon("plus", 12)} 비용`}</button>`;
}

/** 비용 입력 (원 또는 현지 통화 → 원으로 저장) */
export function openCost(id) {
  const i = itemById(id);
  if (!i) return;
  const c = costOf(id);
  const b = trip().budget || {};
  const cat = c?.category || catFor(i);
  const s = openSheet(`
    <p class="eyebrow">${icon("wallet", 14)} COST</p>
    <h2 class="sheet-title">${esc(i.name)}</h2>
    <p class="muted">${i.day_date ? `${dayLabel(i.day_date)}${i.time ? ` ${esc(i.time)}` : ""} · ` : ""}넣은 비용은 지출 기록에 자동으로 더해져요.</p>
    <form class="stack" data-cost>
      <div class="amount-row"><input class="input input-xl" name="amount" type="number" inputmode="decimal" min="0" step="any" value="${c ? c.amount : ""}" placeholder="0" autofocus>
        ${b.currency && b.rate ? `<div class="seg"><label><input type="radio" name="cur" value="KRW" checked><span>원</span></label>
          <label><input type="radio" name="cur" value="LOCAL"><span>${esc(b.currency)}</span></label></div>` : `<span class="unit">원</span>`}</div>
      <p class="hint" data-conv-hint>${b.rate ? "" : "현지 통화로 넣으려면 지출 탭에서 환율을 정해 주세요."}</p>
      ${i.details?.price_range ? `<p class="hint">${icon("info", 13)} 참고 가격대: ${esc(i.details.price_range)}</p>` : ""}
      <div class="chips">${Object.entries(EXP_CATS).map(([k, [l, ic]]) =>
        `<label class="chip-radio"><input type="radio" name="category" value="${k}" ${k === cat ? "checked" : ""}><span>${icon(ic, 15)} ${l}</span></label>`).join("")}</div>
      <button class="btn btn-ink btn-block" type="submit">저장</button>
      ${c ? `<button class="btn btn-ghost btn-block danger" type="button" data-cost-clear>${icon("trash", 16)} 비용 지우기</button>` : ""}
    </form>`, { onClose: closed });
  const form = $("[data-cost]", s.el);
  form.addEventListener("input", () => {
    if (form.cur?.value === "LOCAL") $("[data-conv-hint]", form).textContent = `= ${won(Math.round((Number(form.amount.value) || 0) * b.rate))}원으로 저장돼요`;
  });
  const save = async (amount) => {
    try {
      await rpc("set_item_cost", { p_trip: T.id, p_item: id, p_amount: amount, p_category: form.category.value, p_by: localStorage.getItem("myName") || null });
      s.close(true);
      toast(amount ? `${won(amount)}원을 지출에 넣었어요` : "비용을 지웠어요");
      await reload();
    } catch (e) {
      toast(e.message);
    }
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const n = Number(form.amount.value) || 0;
    save(Math.round(form.cur?.value === "LOCAL" ? n * b.rate : n));
  });
  $("[data-cost-clear]", s.el)?.addEventListener("click", () => save(0));
}

/** 일정 날짜가 바뀌면 연결된 지출 날짜도 맞춘다 */
export async function syncCostDay(id) {
  const c = costOf(id);
  if (c) await rpc("set_item_cost", { p_trip: T.id, p_item: id, p_amount: c.amount, p_category: c.category }).catch(() => {});
}

// ---------- 자동 할 일 ----------
const RESERVE = /예약\s*(필수|필요|권장|추천|해야|하는\s*게)|예약\s*없이는|reservation (required|recommended)|book ahead/i;
const CASH = /현금만|현금\s*결제만|cash only|카드\s*(결제\s*)?(안|불가|X|받지)|카드는\s*안/i;
const TICKET = /사전\s*(구매|예매)|온라인\s*(예약|구매|예매)|미리\s*(사|구매|예매)|티켓.{0,8}(미리|사전)/;

function wanted() {
  const out = new Map();
  for (const i of T.data.items) {
    if (!isSpot(i) || !i.day_date) continue;
    const d = i.details || {};
    const text = [d.reservation, ...(d.cautions || []), ...(d.tips || []), i.note].filter(Boolean).join(" ");
    const when = `${md(i.day_date)}${i.time ? ` ${i.time}` : ""}`;
    if (i.reservation_needed || RESERVE.test(d.reservation || "")) out.set(`auto:${i.id}:reserve`, `예약하기: ${i.name} (${when})`);
    else if (TICKET.test(text)) out.set(`auto:${i.id}:ticket`, `티켓 미리 사기: ${i.name} (${when})`);
    if (CASH.test(text)) out.set(`auto:${i.id}:cash`, `현금 준비: ${i.name}은 현금만 받아요 (${when})`);
  }
  return out;
}

/** 일정에 들어간 스팟 기준으로 할 일을 맞춘다. 바뀐 개수 반환 */
export async function syncAutoTodos() {
  const want = wanted();
  const have = T.data.items.filter((i) => i.category === "todo" && (i.search_query || "").startsWith("auto:"));
  let n = 0;
  for (const t of have) {
    if (!want.has(t.search_query)) {
      if (!t.done) {
        await rpc("delete_item", { p_trip: T.id, p_item: t.id }).catch(() => {});
        n++;
      }
    } else if (t.name !== want.get(t.search_query) && !t.done) {
      await rpc("upsert_item", { p_trip: T.id, p_item: { id: t.id, name: want.get(t.search_query) } }).catch(() => {});
      n++;
    }
    want.delete(t.search_query);
  }
  for (const [key, name] of want) {
    await rpc("upsert_item", { p_trip: T.id, p_item: { category: "todo", name, search_query: key }, p_by: "자동" }).catch(() => {});
    n++;
  }
  return n;
}

/** 일정에 넣거나 바꾼 뒤: 비용 날짜 맞추고 할 일 갱신 → 알림 */
export async function afterScheduleChange(id) {
  if (id) await syncCostDay(id);
  const before = T.data.items.filter((i) => i.category === "todo").length;
  await reload();
  const n = await syncAutoTodos();
  if (n) {
    await reload();
    const after = T.data.items.filter((i) => i.category === "todo").length;
    toast(after > before ? `할 일 ${after - before}개를 자동으로 추가했어요` : "할 일을 일정에 맞게 고쳤어요");
  }
}

export { itemById };
