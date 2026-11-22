/* 일정 짜기: 스팟 '일정에 넣기'(날짜만 고르면 빈 시간·동선으로 추천) + 하루 타임라인의 이동 시간 */
import { rpc } from "./api.js?v=2611220947";
import { coordsOf, directionsUrl, leg, legText, point, STAY, stayOf, suggestSlot, toHHMM, toMin } from "./geo.js?v=2611220947";
import { icon } from "./icons.js?v=2611220947";
import { closeSheet, openSheet } from "./ui.js?v=2611220947";
import { $, $$, CATS, dayLabel, esc, toast, wdEn } from "./util.js?v=2611220947";
import { T, reload } from "./trip.js?v=2611220947";
import { closed, days, itemById, trip } from "./trip-shared.js?v=2611220947";
import { afterScheduleChange } from "./trip-cost.js?v=2611220947";

/** 찾은 좌표는 DB에도 저장 (다음부터 바로 계산) */
export function saveCoords(item, lat, lng) {
  rpc("upsert_item", { p_trip: T.id, p_item: { id: item.id, lat, lng } }).catch(() => {});
}

/** 스팟 → 일정에 넣기: 날짜 고르기 → 추천 시간 → 등록 */
export function openPlan(id, presetDay = "") {
  const state = { day: presetDay || itemById(id)?.day_date || "", stay: stayOf(itemById(id) || {}), result: null, busy: false };
  const sheet = openSheet("", { onClose: closed });

  const draw = () => {
    const i = itemById(id);
    if (!i) return closeSheet();
    const ds = days();
    const r = state.result;
    sheet.el.innerHTML = `
      <p class="eyebrow">${icon("calendar", 14)} PLAN</p>
      <h2 class="sheet-title">${esc(i.name)}, 언제 갈까요?</h2>
      <p class="muted">날짜만 고르면 그날 일정 사이 빈 시간과 이동 거리를 보고 시간을 추천해요.</p>
      <div class="day-pick">${ds.map((d, k) => `<button class="${state.day === d ? "on" : ""}" data-plan-day="${d}">
        <small>DAY ${k + 1}</small><b>${Number(d.slice(8))}</b><small>${wdEn(d)}</small></button>`).join("")}</div>
      <div class="field"><label>머무는 시간</label><div class="seg stay-seg">${[30, 45, 60, 90, 120].map((m) =>
        `<button class="${state.stay === m ? "on" : ""}" data-plan-stay="${m}">${m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간${m % 60 ? " 반" : ""}`}</button>`).join("")}</div></div>
      <div data-plan-out>${!state.day ? "" : state.busy ? `<div class="plan-card loading"><span class="mini-spin"></span> 그날 일정과 동선을 계산하는 중…</div>`
        : r ? resultHtml(i, r) : ""}</div>`;
  };

  const resultHtml = (i, r) => {
    const t = trip();
    if (!r.ok) {
      return `<div class="plan-card warn">${icon("alert", 18)}<p>${esc(r.reason)}</p></div>
        <div class="plan-actions">
          <button class="btn btn-ink btn-block" data-plan-save="notime">${icon("calendar", 18)} 시간 없이 ${dayLabel(state.day)}에 넣기</button>
          ${manualHtml()}</div>`;
    }
    const me = { ...i, lat: r.me?.[0] ?? i.lat, lng: r.me?.[1] ?? i.lng };
    const row = (x, label) => `<li class="tl-node ${label ? "me" : ""}"><b>${esc(x.time || "")}</b><span>${esc(x.name)}</span>${label ? `<em>${label}</em>` : ""}</li>`;
    const legRow = (l, a, b) => `<li class="tl-leg">${icon(l?.mode === "도보" ? "pin" : "bus", 14)} ${legText(l)}
      <a href="${esc(directionsUrl(point(a, t), point(b, t), l?.mode === "도보" ? "walking" : "transit"))}" target="_blank" rel="noopener">구글 길찾기 ${icon("external", 12)}</a></li>`;
    return `<div class="plan-card">
        <p class="eyebrow">RECOMMENDED · ${dayLabel(state.day)}</p>
        <p class="plan-time">${toHHMM(r.start)} <span>– ${toHHMM(r.end)}</span></p>
        <p class="plan-why">${esc(r.reason)}</p>
        <ol class="tl-mini">
          ${r.prev ? row(r.prev) + legRow(r.inLeg, r.prev, me) : ""}
          ${row({ name: i.name, time: toHHMM(r.start) }, "추천")}
          ${r.next ? legRow(r.outLeg, me, r.next) + row(r.next) : ""}
        </ol>
        <p class="hint">이동 시간은 지도 거리로 계산한 값이에요. 정확한 경로·소요 시간은 '구글 길찾기'로 확인하세요.</p>
      </div>
      <div class="plan-actions">
        <button class="btn btn-accent btn-block" data-plan-save="suggest">${icon("check", 18)} ${toHHMM(r.start)}에 등록</button>
        ${manualHtml()}
        <button class="btn btn-ghost btn-block" data-plan-save="notime">시간 없이 이 날에만 넣기</button>
        ${i.day_date ? `<button class="btn btn-ghost btn-block danger" data-act="unplan" data-id="${i.id}">${icon("x", 16)} 일정에서 빼기 (지금 ${esc(dayLabel(i.day_date))})</button>` : ""}
      </div>`;
  };
  const manualHtml = () => `<form class="plan-manual" data-plan-manual>
      <input class="input" type="time" name="time" required aria-label="직접 정할 시간">
      <button class="btn btn-line" type="submit">이 시간으로</button></form>`;

  const compute = async () => {
    if (!state.day) return draw();
    state.busy = true;
    state.result = null;
    draw();
    try {
      const i = { ...itemById(id), stay_min: state.stay };
      state.result = await suggestSlot(i, state.day, T.data.items, trip(), saveCoords);
    } catch (e) {
      state.result = { ok: false, reason: `계산하지 못했어요: ${e.message}` };
    }
    state.busy = false;
    draw();
  };

  const save = async (patch, msg) => {
    try {
      await rpc("upsert_item", { p_trip: T.id, p_item: { id, day_date: state.day, stay_min: state.stay, ...patch } });
      sheet.close(true);
      toast(msg);
      await afterScheduleChange(id);
    } catch (e) {
      toast(e.message);
    }
  };

  sheet.el.addEventListener("click", (e) => {
    const d = e.target.closest("[data-plan-day]")?.dataset.planDay;
    if (d) {
      state.day = d;
      return compute();
    }
    const m = e.target.closest("[data-plan-stay]")?.dataset.planStay;
    if (m) {
      state.stay = Number(m);
      return state.day ? compute() : draw();
    }
    const how = e.target.closest("[data-plan-save]")?.dataset.planSave;
    if (how === "suggest" && state.result?.ok) {
      const r = state.result;
      return save({ time: toHHMM(r.start), end_time: toHHMM(r.end) }, `${dayLabel(state.day)} ${toHHMM(r.start)}에 넣었어요`);
    }
    if (how === "notime") return save({ time: "", end_time: "" }, `${dayLabel(state.day)}에 넣었어요`);
  });
  sheet.el.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-plan-manual]");
    if (!f) return;
    e.preventDefault();
    const start = toMin(f.time.value);
    if (start == null) return;
    save({ time: toHHMM(start), end_time: toHHMM(start + state.stay) }, `${dayLabel(state.day)} ${toHHMM(start)}에 넣었어요`);
  });
  if (state.day) compute();
  else draw();
}

/** 일정 탭: 타임라인의 이동 시간 칸 채우기 (좌표는 없으면 찾아서 저장, 1초에 1곳씩) */
let legRun = 0;
export async function fillLegs(root) {
  const run = ++legRun;
  const t = trip();
  for (const el of $$("[data-leg]", root)) {
    if (run !== legRun || !document.body.contains(el)) return;
    const [a, b] = el.dataset.leg.split("|").map(itemById);
    if (!a || !b) continue;
    const ca = await coordsOf(a, t, (la, ln) => saveCoords(a, la, ln));
    const cb = await coordsOf(b, t, (la, ln) => saveCoords(b, la, ln));
    if (run !== legRun) return;
    const l = ca && cb ? await leg(ca, cb) : null;
    if (!l) {
      el.innerHTML = ""; // 장소를 모르는 일정 사이(예: 비행기 출발→도착)는 이동 표시 없음
      continue;
    }
    const gap = toMin(b.time) - (toMin(a.end_time) ?? toMin(a.time) + (a.category === "schedule" ? 30 : stayOf(a)));
    const tight = l && gap < l.min;
    el.classList.toggle("tight", !!tight);
    el.innerHTML = `${icon(l?.mode === "도보" ? "pin" : "bus", 13)} ${l ? legText(l) : "이동"}${tight ? " · 시간이 빠듯해요" : ""}
      <a href="${esc(directionsUrl(point(a, t), point(b, t), l?.mode === "도보" ? "walking" : "transit"))}" target="_blank" rel="noopener">길찾기</a>`;
  }
}

export { STAY };
