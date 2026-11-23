/* 예약·바우처: 항공권·숙소 메일·입장권·QR을 사진·PDF·붙여넣기로 넣기 → (작업기) 읽기 → 확인 후 일정·지출 반영 → 현장에서 크게 보기 */
import { deleteFiles, fileUrl, rpc, uploadFile } from "./api.js?v=2611240302";
import { toMin } from "./geo.js?v=2611240302";
import { icon } from "./icons.js?v=2611240302";
import { askName, closeSheet, openSheet } from "./ui.js?v=2611240302";
import { $, $$, dayLabel, esc, toast, won } from "./util.js?v=2611240302";
import { T, reload } from "./trip.js?v=2611240302";
import { closed, days, itemById, trip } from "./trip-shared.js?v=2611240302";
import { afterScheduleChange, costOf } from "./trip-cost.js?v=2611240302";

export const KIND = {
  flight: ["항공", "plane"], hotel: ["숙소", "bed"], ticket: ["입장권·공연", "ticket"], tour: ["투어·체험", "compass"],
  restaurant: ["식당 예약", "utensils"], transport: ["교통", "bus"], other: ["기타", "card"],
};
const EXP_BY_KIND = { flight: "transport", transport: "transport", hotel: "stay", ticket: "ticket", tour: "ticket", restaurant: "food" };
const STATUS = { pending: "읽기 대기", working: "읽는 중", done: "확인 필요", error: "읽지 못함", manual: "보관" };

export const vouchersOf = (itemId) => (T.data.vouchers || []).filter((v) => v.item_id === itemId);
const isImage = (v) => (v.mime || "").startsWith("image/");
const isPdf = (v) => v.mime === "application/pdf";
const reading = (v) => v.status === "pending" || v.status === "working";

/** 타임라인 줄에 붙는 바우처 버튼 */
export function voucherChip(i) {
  const vs = vouchersOf(i.id);
  return vs.length ? `<button class="v-chip" data-act="voucher-show" data-id="${i.id}" aria-label="${esc(i.name)} 바우처 보기">${icon("ticket", 14)}${vs.length > 1 ? vs.length : ""}</button>` : "";
}

// ---------- 바우처함 ----------
export function openVoucherBox() {
  const sheet = openSheet("", { onClose: closed });
  const draw = () => {
    const list = (T.data.vouchers || []).slice().reverse();
    sheet.el.innerHTML = `
      <p class="eyebrow">${icon("ticket", 14)} BOOKINGS</p>
      <h2 class="sheet-title">예약·바우처</h2>
      <p class="muted">항공권·숙소 예약 메일·입장권·QR을 넣으면 날짜·시간·예약번호·금액을 읽어서 일정과 지출에 넣어 드려요.
        원본은 그 일정에 붙어 있어서 현장에서 바로 크게 꺼내 볼 수 있어요 (오프라인 OK).</p>
      <div class="v-add">
        <button class="btn btn-ink" data-v-upload>${icon("camera", 18)} 사진·PDF 올리기</button>
        <button class="btn btn-line" data-v-paste>${icon("copy", 18)} 메일 내용 붙여넣기</button>
      </div>
      <label class="check-line"><input type="checkbox" data-v-ai checked> 내용 자동으로 읽기 <small class="muted">(끄면 파일만 보관)</small></label>
      <form class="stack" data-v-paste-form hidden>
        <textarea class="input" name="body" rows="7" maxlength="20000" required placeholder="예약 확인 메일·문자 내용을 그대로 붙여 넣으세요"></textarea>
        <button class="btn btn-ink btn-block" type="submit">읽어서 넣기</button>
      </form>
      ${list.length ? `<ul class="v-list">${list.map(row).join("")}</ul>`
        : `<p class="hint center">아직 넣은 예약이 없어요. 앱의 바우처 화면 스크린샷이나 메일의 PDF 첨부도 돼요.</p>`}
      <p class="hint">바우처에는 이름·예약번호가 들어 있어요. 읽는 동안 내용이 Claude로 전송되고, 원본은 이 여행 링크를 가진 사람만 볼 수 있어요.</p>`;
    $("[data-v-upload]", sheet.el).onclick = () => pickVouchers($("[data-v-ai]", sheet.el).checked);
    $("[data-v-paste]", sheet.el).onclick = () => {
      const f = $("[data-v-paste-form]", sheet.el);
      f.hidden = !f.hidden;
      if (!f.hidden) f.body.focus();
    };
    $("[data-v-paste-form]", sheet.el).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await rpc("add_voucher", { p_trip: T.id, p_v: { body: e.target.body.value, mime: "text/plain", ai: true }, p_by: await askName() });
        toast("읽고 있어요 · 작업기가 켜져 있어야 해요");
        await reload();
        draw();
      } catch (err) {
        toast(err.message);
      }
    };
  };
  T.afterReload = () => draw();
  T.liveKey = (d) => JSON.stringify((d.vouchers || []).map((v) => [v.id, v.status, v.item_id]));
  draw();
}

function row(v) {
  const [label, ic] = KIND[v.kind] || KIND.other;
  const p = v.parsed || {};
  const seg = (p.segments || [])[0];
  return `<li class="v-row"><button data-act="voucher-open" data-id="${v.id}">
    <span class="v-thumb ${isImage(v) ? "img" : ""}" ${isImage(v) ? `style="background-image:url('${esc(fileUrl(v.file_path))}')"` : ""}>${isImage(v) ? "" : icon(isPdf(v) ? "receipt" : ic, 20)}</span>
    <span class="grow"><b>${esc(v.title || p.title || (v.body ? v.body.slice(0, 30) : "예약 문서"))}</b>
      <small>${esc(label)}${seg?.date ? ` · ${esc(dayLabel(seg.date))}${seg.time ? ` ${esc(seg.time)}` : ""}` : ""}${p.booking_no ? ` · ${esc(p.booking_no)}` : ""}</small></span>
    <span class="v-status ${v.item_id ? "linked" : v.status}">${reading(v) ? `<span class="mini-spin"></span>` : ""}${v.item_id ? "일정에 반영됨" : STATUS[v.status] || v.status}</span>
  </button><button class="icon-btn sm v-del" data-act="voucher-del" data-id="${v.id}" aria-label="바우처 삭제">${icon("trash", 16)}</button></li>`;
}

/** 이 바우처로 만든 일정 (반영할 때 search_query에 'voucher:<id>' 표시) */
const createdBy = (vid) => T.data.items.filter((i) => i.search_query === `voucher:${vid}`);

/** 바우처 삭제: 바우처만 / 바우처로 만든 일정·비용까지 */
export function askDeleteVoucher(id) {
  const v = (T.data.vouchers || []).find((x) => x.id === id);
  if (!v) return;
  const made = createdBy(id);
  const cost = made.reduce((a, i) => a + (costOf(i.id)?.amount || 0), 0);
  // 바우처를 기존 일정에 붙이며 넣은 비용 (예: '홍콩공항 도착'에 넣은 항공권 금액)
  const host = v.item_id && !made.some((i) => i.id === v.item_id) ? itemById(v.item_id) : null;
  const hostCost = host && costOf(host.id);
  const krw = v.parsed?.amount_krw || 0;
  const hostOwned = hostCost && (!krw || hostCost.amount === krw) ? hostCost : null;
  const anything = made.length || hostOwned;
  const s = openSheet(`
    <p class="eyebrow">${icon("trash", 14)} DELETE</p>
    <h2 class="sheet-title">${esc(v.title || v.parsed?.title || "예약 문서")} 지우기</h2>
    ${anything ? `<p class="muted">이 바우처로 넣은 것들이에요.</p>
      <ul class="plain small">${made.map((i) => `<li>일정: ${i.day_date ? `${esc(dayLabel(i.day_date))} ${esc(i.time || "")} · ` : ""}${esc(i.name)}${costOf(i.id) ? ` (비용 ${won(costOf(i.id).amount)}원)` : ""}</li>`).join("")}
        ${hostOwned ? `<li>비용 ${won(hostOwned.amount)}원 ('${esc(host.name)}'에 넣은 것 · 일정은 남아요)</li>` : ""}</ul>` : ""}
    <div class="plan-actions">
      ${anything ? `<button class="btn btn-accent btn-block" data-del="all">${icon("trash", 16)} 바우처 + 넣은 일정·비용 모두 지우기</button>` : ""}
      <button class="btn ${anything ? "btn-line" : "btn-accent"} btn-block" data-del="only">${icon("trash", 16)} 바우처만 지우기${anything ? " (일정·비용은 남김)" : ""}</button>
      <button class="btn btn-ghost btn-block" data-close>취소</button>
    </div>`, { onClose: closed });
  s.el.addEventListener("click", async (e) => {
    const how = e.target.closest("[data-del]")?.dataset.del;
    if (!how) return;
    try {
      if (how === "all") {
        for (const i of made) await rpc("delete_item", { p_trip: T.id, p_item: i.id }); // 그 일정의 비용도 함께 지워짐
        if (hostOwned) await rpc("set_item_cost", { p_trip: T.id, p_item: host.id, p_amount: 0 });
      }
      const path = await rpc("delete_voucher", { p_trip: T.id, p_id: id });
      if (path) await deleteFiles([path]);
      s.close(true);
      toast(how === "all" ? `바우처와 일정 ${made.length}개를 지웠어요` : "바우처를 지웠어요");
      await afterScheduleChange(null);
    } catch (err) {
      toast(err.message);
    }
  });
}

/** 파일 고르기 → 올리기 → 바우처로 등록 (여러 장) */
export function pickVouchers(ai = true, files = null) {
  const go = async (list) => {
    if (!list.length) return;
    const by = await askName();
    let n = 0;
    for (const f of list) {
      try {
        toast(`올리는 중 ${n + 1}/${list.length}`);
        // QR이 잘 읽히게 사진은 덜 줄인다
        const up = await uploadFile(T.id, f, null, { folder: "docs", max: 2400, quality: 0.92 });
        await rpc("add_voucher", { p_trip: T.id, p_v: { file_path: up.path, mime: up.mime, ai, title: ai ? "" : f.name.replace(/\.[^.]+$/, "") }, p_by: by });
        n++;
      } catch (e) {
        toast(e.message);
      }
    }
    if (n) toast(ai ? `${n}장 넣었어요 · 읽는 중 (작업기가 켜져 있어야 해요)` : `${n}장 보관했어요`);
    await reload();
  };
  if (files) return go([...files]);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,application/pdf";
  input.multiple = true;
  input.onchange = () => go([...input.files]);
  input.click();
}

// ---------- 바우처 하나: 확인 → 일정·지출 반영 ----------
/** 이미 있는 일정 중 같은 것으로 보이는 것 (같은 날 ±60분, 또는 편명·이름이 겹침) */
function matchFor(seg) {
  const codes = (seg.title || "").match(/\b[A-Z0-9]{2}\d{3,4}\b/g) || [];
  return T.data.items.find((i) => i.category === "schedule" && i.day_date === seg.date && (
    (toMin(i.time) != null && toMin(seg.time) != null && Math.abs(toMin(i.time) - toMin(seg.time)) <= 30) ||
    codes.some((w) => i.name.includes(w))));
}

export function openVoucher(id) {
  const sheet = openSheet("", { onClose: closed });
  const draw = () => {
    const v = (T.data.vouchers || []).find((x) => x.id === id);
    if (!v) return closeSheet();
    const p = v.parsed || {};
    const [label, ic] = KIND[v.kind] || KIND.other;
    const segs = (p.segments || []).filter((s) => s.date);
    const tripDays = days();
    const b = trip().budget || {};
    const krw = p.amount_krw || 0;
    const linked = v.item_id && itemById(v.item_id);
    sheet.el.innerHTML = `
      <p class="eyebrow">${icon(ic, 14)} ${esc(label)}</p>
      <h2 class="sheet-title">${esc(v.title || p.title || "예약 문서")}</h2>
      ${v.file_path ? `<button class="v-preview ${isImage(v) ? "" : "doc"}" data-v-full="${id}">
          ${isImage(v) ? `<img src="${esc(fileUrl(v.file_path))}" alt="바우처">` : `${icon("receipt", 28)}<span>PDF 열기</span>`}
          <small>${isImage(v) ? "눌러서 크게 (QR 보여 주기)" : ""}</small></button>`
        : v.body ? `<details class="v-body"><summary>붙여 넣은 글</summary><pre>${esc(v.body)}</pre></details>` : ""}
      ${reading(v) ? `<div class="enrich-state"><span class="mini-spin"></span><div><b>내용을 읽고 있어요</b><small>보통 30초~1분 · 다 되면 자동으로 채워져요</small></div></div>` : ""}
      ${v.status === "error" ? `<div class="enrich-state err">${icon("alert", 18)}<div><b>읽지 못했어요</b><small>${esc(v.error || "")}</small></div></div>` : ""}
      ${v.status === "done" || v.status === "manual" ? `
        <dl class="facts">${[["card", "예약번호", p.booking_no], ["user", "이용자", p.people], ["wallet", "금액", p.amount], ["key", "예약처", p.provider]]
          .filter((f) => f[2]).map(([i2, k, val]) => `<div>${icon(i2, 17)}<dt>${k}</dt><dd>${esc(val)}${k === "예약번호" ? ` <button class="link" data-v-copy="${esc(val)}">복사</button>` : ""}</dd></div>`).join("")}</dl>
        ${(p.key_info || []).length ? `<div class="note-box"><h3>${icon("info", 15)} 현장에서 필요한 정보</h3><ul>${p.key_info.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        ${(p.unclear || []).length ? `<div class="note-box warn"><h3>${icon("alert", 15)} 확실하지 않은 부분 · 원본으로 확인</h3><ul>${p.unclear.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        ${linked ? `<div class="plan-card"><p class="eyebrow">LINKED</p><p><b>${esc(linked.name)}</b> 일정에 붙어 있어요${linked.day_date ? ` · ${esc(dayLabel(linked.day_date))} ${esc(linked.time || "")}` : ""}</p></div>` : `
        <section class="d-sec"><h3>일정에 넣기</h3>
          ${segs.length ? `<form class="v-apply" data-v-apply>
            ${segs.map((s, k) => {
              const m = matchFor(s);
              return `<label class="v-seg"><input type="checkbox" name="seg" value="${k}" checked>
                <span><b>${esc(s.title)}</b><small>${esc(dayLabel(s.date))} ${esc(s.time || "")}${s.end_time ? `~${esc(s.end_time)}` : ""}${s.place ? ` · ${esc(s.place)}` : ""}</small>
                ${!tripDays.includes(s.date) ? `<em class="warn">여행 기간 밖 날짜</em>` : m ? `<em>기존 '${esc(m.name)}'에 붙여요</em>` : `<em>새 일정으로 넣어요</em>`}</span></label>`;
            }).join("")}
            <div class="field"><label>비용 (지출에 자동 합산)</label>
              <div class="amount-row"><input class="input" name="amount" type="number" inputmode="decimal" min="0" step="any" value="${krw || ""}" placeholder="${esc(p.amount || "0")}">
              ${b.currency && b.rate ? `<div class="seg"><label><input type="radio" name="cur" value="KRW" checked><span>원</span></label>
                <label><input type="radio" name="cur" value="LOCAL"><span>${esc(b.currency)}</span></label></div>` : `<span class="unit">원</span>`}</div>
              ${p.amount && !krw ? `<p class="hint">문서 금액: ${esc(p.amount)} — 원화로 넣거나 현지 통화를 골라 주세요</p>` : ""}</div>
            <button class="btn btn-accent btn-block" type="submit">${icon("check", 18)} 일정에 반영</button>
          </form>` : `<p class="muted">날짜·시간을 읽지 못했어요. 붙일 일정을 직접 고르세요.</p>`}
          <div class="field"><label>또는 이미 있는 일정·스팟에 붙이기</label>
            <select class="input" data-v-attach><option value="">고르기…</option>${T.data.items.filter((i) => i.day_date || i.category === "schedule" || ["landmark", "activity", "food"].includes(i.category))
              .sort((a, z) => `${a.day_date || "9"}${a.time || ""}`.localeCompare(`${z.day_date || "9"}${z.time || ""}`))
              .map((i) => `<option value="${i.id}">${i.day_date ? `${esc(dayLabel(i.day_date))} ${esc(i.time || "")} · ` : ""}${esc(i.name)}</option>`).join("")}</select></div>
        </section>`}` : ""}
      <div class="btn-row">
        ${v.status !== "pending" && v.status !== "working" ? `<button class="btn btn-line grow" data-v-reread>${icon("refresh", 16)} 다시 읽기</button>` : ""}
        ${linked ? `<button class="btn btn-line grow" data-v-unlink>연결 해제</button>` : ""}
        <button class="btn btn-ghost danger" data-v-del>${icon("trash", 16)}</button>
      </div>`;

    $("[data-v-full]", sheet.el)?.addEventListener("click", () => showFull(v));
    $$("[data-v-copy]", sheet.el).forEach((bt) => bt.addEventListener("click", () => navigator.clipboard?.writeText(bt.dataset.vCopy).then(() => toast("복사했어요"))));
    $("[data-v-reread]", sheet.el)?.addEventListener("click", async () => {
      await rpc("update_voucher", { p_trip: T.id, p_id: id, p_patch: { status: "pending" } }).catch((e) => toast(e.message));
      await reload();
    });
    $("[data-v-unlink]", sheet.el)?.addEventListener("click", async () => {
      await rpc("update_voucher", { p_trip: T.id, p_id: id, p_patch: { item_id: "" } }).catch((e) => toast(e.message));
      await reload();
    });
    $("[data-v-del]", sheet.el).addEventListener("click", () => askDeleteVoucher(id));
    $("[data-v-attach]", sheet.el)?.addEventListener("change", async (e) => {
      if (!e.target.value) return;
      await rpc("update_voucher", { p_trip: T.id, p_id: id, p_patch: { item_id: e.target.value } }).catch((er) => toast(er.message));
      toast("붙였어요");
      await reload();
    });
    $("[data-v-apply]", sheet.el)?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const picked = $$("input[name=seg]:checked", f).map((x) => segs[Number(x.value)]);
      if (!picked.length) return toast("넣을 일정을 하나 이상 골라 주세요");
      const n = Number(f.amount.value) || 0;
      const amount = Math.round(f.cur?.value === "LOCAL" ? n * b.rate : n);
      const by = await askName();
      try {
        let first = null;
        for (const s of picked) {
          const m = matchFor(s);
          const note = [p.booking_no && `예약번호 ${p.booking_no}`, s.note, p.provider].filter(Boolean).join(" · ");
          const patch = { day_date: s.date, time: s.time || "", end_time: s.end_time || "", place: s.place || "" };
          let itemId;
          if (m) {
            // 기존 일정에 붙일 때는 직접 넣은 시간·장소를 지키고 빈 칸만 채운다
            itemId = m.id;
            const keep = { ...(m.time ? {} : { time: patch.time, end_time: patch.end_time }), ...(m.place ? {} : { place: patch.place }) };
            await rpc("upsert_item", { p_trip: T.id, p_item: { id: m.id, ...keep, ...(m.note?.includes(p.booking_no || "\u0000") ? {} : { note: [m.note, note].filter(Boolean).join(" · ") }) } });
          } else {
            itemId = await rpc("upsert_item", { p_trip: T.id, p_by: by, p_item: { category: "schedule", name: s.title, note, search_query: `voucher:${id}`, ...patch } });
          }
          first ||= itemId;
        }
        await rpc("update_voucher", { p_trip: T.id, p_id: id, p_patch: { item_id: first } });
        if (amount > 0 && !costOf(first)) {
          await rpc("set_item_cost", { p_trip: T.id, p_item: first, p_amount: amount, p_category: EXP_BY_KIND[v.kind] || "etc", p_by: by });
        }
        sheet.close(true);
        toast(`일정 ${picked.length}개에 반영했어요${amount > 0 ? ` · ${won(amount)}원 지출` : ""}`);
        await afterScheduleChange(first);
      } catch (err) {
        toast(err.message);
      }
    });
  };
  T.afterReload = () => draw();
  T.liveKey = (d) => JSON.stringify((d.vouchers || []).find((x) => x.id === id) || null);
  draw();
}

/** 현장용: 흰 바탕에 크게 (QR 스캔이 잘 되게) */
function showFull(v) {
  if (!isImage(v)) return window.open(fileUrl(v.file_path), "_blank", "noopener");
  const wrap = document.createElement("div");
  wrap.className = "qr-view";
  wrap.innerHTML = `<img src="${esc(fileUrl(v.file_path))}" alt="바우처"><p>화면 밝기를 최대로 올리면 잘 찍혀요 · 눌러서 닫기</p>`;
  wrap.addEventListener("click", () => wrap.remove());
  document.body.appendChild(wrap);
}

/** 일정의 바우처 보기: 하나면 바로 크게(사진) 또는 상세, 여러 개면 목록 */
export function showVouchersOf(itemId) {
  const vs = vouchersOf(itemId);
  if (vs.length === 1) return isImage(vs[0]) ? showFull(vs[0]) : openVoucher(vs[0].id);
  openSheet(`<p class="eyebrow">${icon("ticket", 14)} VOUCHERS</p><h2 class="sheet-title">${esc(itemById(itemId)?.name || "")}</h2>
    <ul class="v-list">${vs.map(row).join("")}</ul>`, { onClose: closed });
}

/** 안드로이드 공유로 받은 파일·글 (서비스 워커가 share-inbox에 보관) → 이 여행의 바우처로 넣기 */
export async function consumeShare() {
  let box, meta;
  try {
    box = await caches.open("share-inbox");
    const m = await box.match("./__share/meta");
    meta = m && (await m.json());
  } catch {
    return;
  }
  if (!meta) return;
  const files = [];
  for (const f of meta.files || []) {
    const r = await box.match(f.key);
    if (r) files.push(new File([await r.blob()], f.name, { type: f.type || r.headers.get("Content-Type") || "" }));
  }
  for (const k of await box.keys()) await box.delete(k);
  if (files.length) await pickVouchers(true, files);
  if (meta.text && meta.text.trim().length > 20) {
    await rpc("add_voucher", { p_trip: T.id, p_v: { body: meta.text, mime: "text/plain", ai: true }, p_by: await askName() })
      .then(() => toast("공유받은 글을 읽고 있어요")).catch((e) => toast(e.message));
    await reload();
  }
  openVoucherBox();
}

export { KIND as VOUCHER_KIND };
