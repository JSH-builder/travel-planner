/* 일정 비용 · 자동 할 일
 * - 일정(확정 일정·스팟)마다 비용 → 지출로 자동 기록 (set_item_cost: 일정 하나당 지출 하나, 지우면 같이 지워짐)
 * - 스팟을 일정에 넣으면 필요한 할 일(예약·현금·티켓)을 자동으로 만들고, 일정에서 빼면 지움
 */
import { rpc } from "./api.js?v=2611240316";
import { icon } from "./icons.js?v=2611240316";
import { openSheet } from "./ui.js?v=2611240316";
import { $, CATS, dayLabel, esc, isSpot, md, toast, won } from "./util.js?v=2611240316";
import { EXP_CATS, T, reload } from "./trip.js?v=2611240316";
import { closed, itemById, trip } from "./trip-shared.js?v=2611240316";

export const costOf = (itemId) => T?.data.expenses.find((e) => e.item_id === itemId);

/** 항목 → 지출 분류 */
export function catFor(i) {
  if (["food", "cafe", "bar"].includes(i.category)) return "food";
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
const TICKET = /(티켓|입장권|패스).{0,12}(미리|사전|온라인)|(미리|사전|온라인).{0,12}(티켓|입장권|예매)/;
const NOT_NEEDED = /예약\s*(필수\s*아님|불필요|필요\s*없|없이|안\s*해도|불가|받지\s*않)|예약\s*없음/;

function wanted() {
  const out = new Map();
  for (const i of T.data.items) {
    if (!isSpot(i) || !i.day_date) continue;
    const d = i.details || {};
    const text = [d.reservation, ...(d.cautions || []), ...(d.tips || []), i.note].filter(Boolean).join(" ");
    const when = `${md(i.day_date)}${i.time ? ` ${i.time}` : ""}`;
    const rsv = d.reservation || "";
    if (i.reservation_needed || (RESERVE.test(rsv) && !NOT_NEEDED.test(rsv))) out.set(`auto:${i.id}:reserve`, `예약하기: ${i.name} (${when})`);
    else if (["landmark", "activity", "photo"].includes(i.category) && TICKET.test(text))
      out.set(`auto:${i.id}:ticket`, `티켓 미리 사 두기 (줄 서기 줄임): ${i.name} (${when})`);
    if (CASH.test(text)) out.set(`auto:${i.id}:cash`, `현금 준비: ${i.name}은 현금만 받아요 (${when})`);
  }
  scheduleNeeds(out);
  return out;
}

// ---------- 확정 일정(항공·페리·공연·예약)에서 챙길 것 ----------
const FLIGHT = /\b[A-Z0-9]{2}\d{3,4}\b|탑승|비행기|항공|공항/;
const FERRY = /페리|ferry|터보젯|워터젯|cotai\s*water/i;
const SHOW = /공연|쇼(?!핑)|\bshow\b|뮤지컬|콘서트|워터쇼|댄싱\s*워터/i;
const TICKETED = /바우처|e-?티켓|QR|클룩|klook|kkday|마이리얼트립|예약\s*확정|예약확정|예매|티켓/i;

function scheduleNeeds(out) {
  const sched = T.data.items.filter((i) => i.category === "schedule" && i.day_date)
    .sort((a, b) => (a.day_date + (a.time || "")).localeCompare(b.day_date + (b.time || "")));
  const flightDay = new Set();
  for (const i of sched) {
    const text = `${i.name} ${i.note || ""}`;
    const head = i.name;
    // '공항 이동', '페리 수속', '공연장 대기'처럼 앞뒤 준비 일정은 본 일정이 아니므로 빼기
    const aside = /이동|수속|퇴장|대기|착석|입장\s*및|터미널|선착장|목표|준비/.test(i.name);
    const airport = /airport|공항/i.test(i.place || "") && /출발|탑승/.test(i.name);
    const when = `${md(i.day_date)}${i.time ? ` ${i.time}` : ""}`;
    const needs = [];
    const arrival = /도착|arrival/i.test(i.name);
    // 비행기: 그날 첫 출발 일정 하나에만 (공항 출발·탑승·편명이 여러 줄이어도 한 번)
    if (aside) {
      if (RESERVE.test(i.note || "") && !NOT_NEEDED.test(i.note || "")) out.set(`auto:${i.id}:reserve`, `예약하기: ${i.name} (${when})`);
      continue;
    }
    if (!arrival && (FLIGHT.test(head) || airport) && !FERRY.test(head)) {
      if (flightDay.has(i.day_date)) continue;
      flightDay.add(i.day_date);
      needs.push("여권", "e-티켓·예약번호", "체크인 마감 시간 확인");
    } else if (!arrival && FERRY.test(head)) {
      needs.push("여권", "페리 티켓(운영사·터미널 확인)", "체크인 마감 시간 확인");
    } else {
      if (SHOW.test(head)) needs.push("회차·좌석 확인", "30분 전 도착");
      if (TICKETED.test(text) && !vouchersHere(i)) needs.push("바우처·QR 저장 (오프라인에서도 보이게)");
    }
    if (needs.length) out.set(`auto:${i.id}:prep`, `챙기기: ${i.name} (${when}) — ${[...new Set(needs)].join(" · ")}`);
    if (RESERVE.test(i.note || "") && !NOT_NEEDED.test(i.note || "") && !/예약\s*확정|예약확정/.test(i.note || ""))
      out.set(`auto:${i.id}:reserve`, `예약하기: ${i.name} (${when})`);
  }
}
const vouchersHere = (i) => (T.data.vouchers || []).some((v) => v.item_id === i.id);

/** 여행을 열 때 한 번: 앱 밖(작업기·다른 기기)에서 바뀐 일정에도 할 일을 맞춘다 */
export async function syncTodosOnOpen() {
  if (!navigator.onLine) return;
  try {
    const n = await syncAutoTodos();
    if (n) {
      await reload();
      toast("할 일을 지금 일정에 맞게 고쳤어요");
    }
  } catch {}
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

/** 일정에서 빼기: 스팟은 날짜·시간만 비우고(스팟은 남음), 확정 일정은 삭제. 넣은 비용·자동 할 일도 정리 */
export async function unplan(id) {
  const i = itemById(id);
  if (!i) return;
  const c = costOf(id);
  const spot = isSpot(i);
  const msg = spot
    ? `'${i.name}'을(를) 일정에서 뺄까요? 스팟 목록에는 그대로 남아요.${c ? `\n넣어 둔 비용 ${won(c.amount)}원도 지출에서 빠져요.` : ""}`
    : `'${i.name}' 일정을 삭제할까요?${c ? `\n넣어 둔 비용 ${won(c.amount)}원도 지출에서 빠져요.` : ""}`;
  if (!confirm(msg)) return;
  try {
    if (c) await rpc("set_item_cost", { p_trip: T.id, p_item: id, p_amount: 0 });
    if (spot) await rpc("upsert_item", { p_trip: T.id, p_item: { id, day_date: "", time: "", end_time: "" } });
    else await rpc("delete_item", { p_trip: T.id, p_item: id });
    toast(spot ? "일정에서 뺐어요 · 스팟에는 남아 있어요" : "일정을 삭제했어요");
  } catch (e) {
    return toast(e.message);
  }
  await afterScheduleChange(null);
}

/** 타임라인에서 시간을 누르면: 시간 바꾸기 · 비용 · 일정에서 빼기 */
export function openTimelineMenu(id) {
  const i = itemById(id);
  if (!i) return;
  const c = costOf(id);
  const spot = isSpot(i);
  openSheet(`
    <p class="eyebrow">${spot ? CATS[i.category].en : "SCHEDULE"}</p>
    <h2 class="sheet-title">${esc(i.name)}</h2>
    <p class="muted">${i.day_date ? dayLabel(i.day_date) : "날짜 미정"}${i.time ? ` · ${esc(i.time)}${i.end_time ? `~${esc(i.end_time)}` : ""}` : ""}</p>
    <div class="menu-list">
      <button data-act="${spot ? "plan" : "sched-open"}" data-id="${id}" ${spot ? `data-day="${esc(i.day_date || "")}"` : ""}>${icon("clock", 20)}<span>시간·날짜 바꾸기${spot ? "<small>빈 시간·동선으로 다시 추천</small>" : ""}</span></button>
      <button data-act="cost" data-id="${id}">${icon("wallet", 20)}<span>${c ? `비용 고치기<small>${won(c.amount)}원</small>` : "비용 넣기"}</span></button>
      ${(T.data.vouchers || []).some((v) => v.item_id === id) ? `<button data-act="voucher-show" data-id="${id}">${icon("ticket", 20)}<span>바우처 보기<small>QR·예약 확인서</small></span></button>`
        : `<button data-act="voucher-box">${icon("ticket", 20)}<span>바우처 넣기<small>항공권·예약 메일·입장권·QR</small></span></button>`}
      ${spot ? `<button data-act="spot-open" data-id="${id}">${icon("info", 20)}<span>스팟 자세히 보기</span></button>` : ""}
      <button class="danger" data-act="unplan" data-id="${id}">${icon(spot ? "x" : "trash", 20)}<span>${spot ? "일정에서 빼기<small>스팟 목록에는 남아요</small>" : "일정 삭제"}</span></button>
    </div>`, { onClose: closed });
}

export { itemById };
