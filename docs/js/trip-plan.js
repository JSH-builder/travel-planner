/* 일정 짜기: 스팟 '일정에 넣기'(날짜만 고르면 빈 시간·동선으로 추천) + 하루 타임라인의 이동 시간 */
import { rpc } from "./api.js?v=2611240202";
import { coordsOf, directionsUrl, hotelOf, isFlight, leg, legText, planDay, point, STAY, stayOf, suggestSlot, timeline, toHHMM, toMin } from "./geo.js?v=2611240202";
import { icon } from "./icons.js?v=2611240202";
import { closeSheet, openSheet } from "./ui.js?v=2611240202";
import { $, $$, CATS, bindProfile, dayLabel, esc, profileFields, readProfile, toast, wdEn } from "./util.js?v=2611240202";
import { saveProfile } from "./trip-spots.js?v=2611240202";
import { T, reload } from "./trip.js?v=2611240202";
import { closed, days, itemById, trip } from "./trip-shared.js?v=2611240202";
import { afterScheduleChange } from "./trip-cost.js?v=2611240202";

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

// ---------- 하루 자동 짜기 ----------
const SPOT_CATS = new Set(["photo", "food", "cafe", "place", "landmark", "activity", "bar"]);
/** 날짜를 정해 그날 갈 스팟을 고르고, 숙소 도착 시간까지 확정 일정 사이를 자동으로 채운다 */
/** 누구랑 가는지 → 숙소 도착 기본 시간·머무는 시간 */
const SLOW = /가족|부모님|50대/;
function paceOf(prof) {
  const who = `${prof.age || ""} ${prof.party || ""}`;
  if (SLOW.test(who)) return { home: "20:00", k: 1.25, label: "여유 있게 (머무는 시간 ×1.25)" };
  if (/친구|혼자|연인/.test(prof.party || "") && /20대|30대/.test(prof.age || "")) return { home: "22:00", k: 1, label: "보통 · 밤까지" };
  return { home: "21:00", k: 1, label: "보통" };
}
const profLabel = (p) => [p.age, p.party].filter(Boolean).join(" · ");

// 일행별로 잘 맞는 곳을 알려 주는 말 (스팟 이름·소개·메모에서 찾음)
const FIT = {
  연인: /야경|분위기|루프탑|전망|뷰|노을|일몰|커플|데이트|로맨틱|감성|와인/,
  친구: /핫플|인기|활기|야시장|펍|체험|포토|사진|줄 서|웨이팅|늦게까지/,
  "가족(아이)": /아이|어린이|가족|키즈|공원|동물|수족관|놀이|체험|넓/,
  부모님: /전통|정원|사원|사찰|역사|여유|편안|케이블카|크루즈|전망|노포/,
  혼자: /혼자|1인|조용|카운터|산책|서점|미술관|박물관/,
};
const AGE_FIT = { "10대": /인기|포토|디저트|쇼핑|체험/, "20대": /핫플|인기|감성|포토|웨이팅|루프탑/, "30대": /분위기|노포|현지|로컬|전망|와인/,
  "40대": /노포|현지|로컬|전통|역사|전망/, "50대 이상": /전통|역사|정원|여유|편안|노포/ };
const km = (a, b) => {
  const r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos(((a[0] + b[0]) / 2) * r), y = (b[0] - a[0]) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};
const cOf = (i) => (i?.lat != null && i?.lng != null ? [Number(i.lat), Number(i.lng)] : null);

/**
 * 그날 갈 곳을 내가 가진 스팟(날짜 미정·아직 안 간 곳)에서 알아서 고른다.
 * 빈 시간 길이 → 식사·카페·술집·볼거리 개수, 일행·나이에 맞는 곳 우선, 그날 일정·숙소와 가까운 곳끼리.
 * 조금 넉넉히 고르고, 시간에 안 들어가는 곳은 짜 본 뒤 뺀다.
 */
function autoPick(day, prof, start, home) {
  const items = T.data.items;
  const tr = trip();
  const pool = items.filter((i) => SPOT_CATS.has(i.category) && !i.day_date && !i.done);
  if (!pool.length) return [];

  // 빈 시간: 첫날은 비행기 도착 1시간 뒤부터, 마지막 날은 출발 비행기 2시간 전까지
  const tl = timeline(items, day);
  const flights = tl.filter((n) => isFlight(n.item));
  let from = start, to = home;
  if (flights.length && day === tr.start_date) from = Math.max(from, flights[flights.length - 1].end + 60);
  if (flights.length && day === tr.end_date && day !== tr.start_date) to = Math.min(to, flights[0].start - 120);
  let free = to - from;
  for (const n of tl) if (!isFlight(n.item)) free -= Math.max(0, Math.min(n.end, to) - Math.max(n.start, from));
  if (free < 60) return [];
  const has = (t) => from <= t && t <= to;

  // 기준점: 그날 일정의 장소 → 숙소 → 전체 스팟의 가운데
  const dayPts = tl.filter((n) => !isFlight(n.item)).map((n) => cOf(n.item)).filter(Boolean);
  const all = pool.map(cOf).filter(Boolean);
  const mid = (pts) => (pts.length ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length] : null);
  let center = mid(dayPts) || cOf(hotelOf(items)) || mid(all);

  const k = paceOf(prof).k;
  const fit = (i) => {
    const text = `${i.name} ${i.note || ""} ${i.details?.headline || ""} ${i.details?.summary || ""} ${i.details?.best_time || ""}`;
    let b = 0;
    if (prof.party && FIT[prof.party]?.test(text)) b += 2.5;
    if (prof.age && AGE_FIT[prof.age]?.test(text)) b += 1.5;
    if (prof.party && text.includes(prof.party.replace(/\(.*\)/, ""))) b += 1;
    if (/youtube\.com|youtu\.be/.test(i.source_url || "")) b += 0.7; // 영상에서 본 곳
    if (/가족|부모님/.test(prof.party || "") && /클럽|바\b|펍|술/.test(text)) b -= 3;
    return b;
  };
  const score = (i) => (center && cOf(i) ? Math.min(km(center, cOf(i)), 30) : 8) - fit(i);
  const chosen = [];
  const used = new Set();
  let budget = free * 1.25;
  const take = (i) => {
    chosen.push(i);
    used.add(i.id);
    budget -= stayOf(i) * k + 25;
    const pts = chosen.map(cOf).filter(Boolean);
    if (pts.length) center = mid([...dayPts, ...pts]);
  };
  const best = (cats) => pool.filter((i) => cats.includes(i.category) && !used.has(i.id)).sort((a, b) => score(a) - score(b))[0];

  // 1) 식사·카페·술집
  const meals = (has(12 * 60 + 30) ? 1 : 0) + (has(19 * 60) ? 1 : 0);
  for (let n = 0; n < meals; n++) { const f = best(["food"]); if (f) take(f); }
  if (has(15 * 60) && free >= 240) { const c = best(["cafe"]); if (c) take(c); }
  const nightOk = to >= 21 * 60 + 30 && prof.age !== "10대" && !/가족|부모님/.test(prof.party || "");
  if (nightOk) { const b = best(["bar"]); if (b) take(b); }
  // 2) 남은 시간은 볼거리로 (같은 종류만 몰리지 않게)
  const SIGHTS = ["landmark", "place", "photo", "activity"];
  while (budget > 40) {
    const cand = pool.filter((i) => SIGHTS.includes(i.category) && !used.has(i.id))
      .map((i) => ({ i, s: score(i) + chosen.filter((c) => c.category === i.category).length * 1.2 }))
      .sort((a, b) => a.s - b.s)[0];
    if (!cand) break;
    take(cand.i);
  }
  return chosen;
}

export function openDayPlan(day) {
  const prof = { age: trip().input?.age || "", party: trip().input?.party || "" };
  const st = { prof, home: paceOf(prof).home, homeTouched: false, start: "09:00", picks: null, more: false, retime: false, result: null, busy: false, who: false, top: new Set() };
  const sheet = openSheet("", { onClose: closed });
  const isSpotItem = (i) => SPOT_CATS.has(i.category);

  const candidates = () => {
    const sp = T.data.items.filter(isSpotItem);
    const thisDay = sp.filter((i) => i.day_date === day && (st.retime || toMin(i.time) == null));
    let undated = sp.filter((i) => !i.day_date);
    if (!st.picks) {
      st.picks = new Set(thisDay.filter((i) => !i.done).map((i) => i.id));
      // 이 날 정해 둔 곳이 없으면: 가진 스팟에서 알아서 골라 바로 짜 본다
      if (!st.picks.size) {
        st.auto = true;
        st.picks = new Set(autoPick(day, st.prof, toMin(st.start), toMin(st.home)).map((i) => i.id));
        st.autoRun = st.picks.size > 0;
      }
    }
    // 고른 날짜 미정 스팟은 위로 (나머지는 '더 고르기' 안에)
    for (const id of st.picks) st.top.add(id);
    const picked = undated.filter((i) => st.top.has(i.id));
    undated = undated.filter((i) => !st.top.has(i.id));
    return { thisDay: [...thisDay, ...picked], undated };
  };
  const repick = () => {
    if (!st.auto) return false;
    st.top = new Set();
    st.picks = new Set(autoPick(day, st.prof, toMin(st.start), toMin(st.home)).map((i) => i.id));
    st.autoRun = st.picks.size > 0;
    return true;
  };
  const short = (n) => n.replace(/\s*[(（].*$/, "");
  const row = (i) => `<label class="dp-pick"><input type="checkbox" value="${i.id}" ${st.picks.has(i.id) ? "checked" : ""}>
    <span class="dp-dot" style="--cat:${CATS[i.category].color}">${icon(CATS[i.category].ic, 14)}</span>
    <span class="grow"><b>${esc(short(i.name))}</b><small>${esc([CATS[i.category].label, i.area, i.details?.hours && `영업 ${i.details.hours.slice(0, 22)}`].filter(Boolean).join(" · "))}</small></span></label>`;

  const resultHtml = (r) => {
    if (!r.plan.length) return `<div class="plan-card warn">${icon("alert", 18)}<p>고른 곳을 넣을 빈 시간이 없어요. 숙소 도착 시간을 늦추거나 고른 곳을 줄여 보세요.</p></div>`;
    const lines = [];
    const all = [...r.fixed.map((n) => ({ fixed: true, item: n.item, start: n.start, end: n.end })), ...r.plan].sort((a, b) => a.start - b.start);
    if (r.hotel && all[0] && !all[0].fixed) lines.push(`<li class="tl-node"><b>${esc(st.start)}</b><span>숙소 출발</span></li>`);
    for (const x of all) {
      if (!x.fixed && x.inLeg) lines.push(`<li class="tl-leg">${icon(x.inLeg.mode === "도보" ? "pin" : "bus", 13)} ${legText(x.inLeg)}</li>`);
      lines.push(`<li class="tl-node ${x.fixed ? "" : "me"}"><b>${toHHMM(x.start)}</b><span>${esc(short(x.item.name))}</span>${x.fixed ? `<em class="fixed">고정</em>` : ""}</li>`);
    }
    if (r.home && r.hotel) {
      lines.push(`<li class="tl-leg">${icon(r.home.leg?.mode === "도보" ? "pin" : "bus", 13)} ${legText(r.home.leg)}</li>`);
      lines.push(`<li class="tl-node"><b>${toHHMM(r.home.at)}</b><span>숙소 도착 (${esc((r.hotel.place || r.hotel.name).split(",")[0])})</span></li>`);
    }
    return `<div class="plan-card">
        <p class="eyebrow">RECOMMENDED · ${r.plan.length}곳</p>
        <ol class="tl-mini">${lines.join("")}</ol>
        ${r.left.length ? `<p class="hint warn-text">${icon("alert", 13)} 시간이 모자라 못 넣은 곳: ${r.left.map((i) => esc(short(i.name))).join(", ")}</p>` : ""}
        <p class="hint">이동 시간은 지도 거리로 계산한 값이에요. 확정 후에도 타임라인에서 시간을 눌러 바꿀 수 있어요.</p>
      </div>
      <button class="btn btn-accent btn-block" data-dp-save>${icon("check", 18)} 이대로 확정</button>`;
  };

  const draw = () => {
    const { thisDay, undated } = candidates();
    const fixed = T.data.items.filter((i) => i.day_date === day && toMin(i.time) != null && (i.category === "schedule" || !st.retime))
      .sort((a, b) => toMin(a.time) - toMin(b.time));
    sheet.el.innerHTML = `
      <p class="eyebrow">${icon("sparkles", 14)} AUTO PLAN</p>
      <h2 class="sheet-title">${esc(dayLabel(day))} 자동으로 짜기</h2>
      ${fixed.length ? `<p class="muted small">그대로 두는 일정: ${fixed.map((i) => `${esc(i.time)} ${esc(short(i.name).slice(0, 14))}`).join(" · ")}</p>` : ""}
      <div class="grid2">
        <div class="field"><label>출발</label><input class="input" type="time" data-dp-start value="${st.start}"></div>
        <div class="field"><label>숙소 도착</label><input class="input" type="time" data-dp-home value="${st.home}"></div>
      </div>
      <div class="dp-quick">${["19:00", "20:00", "21:00", "22:00"].map((t) => `<button class="${st.home === t ? "on" : ""}" data-dp-q="${t}">${t} 도착</button>`).join("")}</div>
      <details class="dp-more dp-who" ${st.who ? "open" : ""}><summary>${icon("user", 14)} ${profLabel(st.prof) ? `${esc(profLabel(st.prof))} 기준` : "누구랑 가요? (고르면 맞춰 짜요)"} · ${paceOf(st.prof).label}</summary>
        <div class="stack">${profileFields(st.prof)}</div></details>
      <section class="d-sec"><h3>갈 곳 고르기 <small class="muted">${st.picks.size}곳</small></h3>
        ${st.auto && st.picks.size ? `<p class="hint">${icon("sparkles", 13)} 이 날로 정해 둔 곳이 없어서 내 스팟 ${T.data.items.filter((i) => isSpotItem(i) && !i.day_date).length}곳 중에서 ${profLabel(st.prof) ? `${esc(profLabel(st.prof))}에게 맞고 ` : ""}동선이 가까운 곳으로 골랐어요. 빼거나 더해도 돼요.</p>` : ""}
        ${thisDay.length ? `<div class="dp-list">${thisDay.map(row).join("")}</div>` : `<p class="muted small">${st.auto ? "넣을 수 있는 날짜 미정 스팟이 없어요. 스팟에서 AI 추천을 먼저 받아 보세요." : "이 날로 정해 둔 스팟이 없어요. 아래에서 골라 주세요."}</p>`}
        ${undated.length ? `<details class="dp-more" ${st.more ? "open" : ""}><summary>날짜 미정 스팟에서 더 고르기 (${undated.length})</summary>
          <div class="dp-list">${undated.map(row).join("")}</div></details>` : ""}
        <label class="check-line small"><input type="checkbox" data-dp-retime ${st.retime ? "checked" : ""}> 이미 시간을 정한 스팟도 다시 짜기</label>
      </section>
      <button class="btn btn-ink btn-block" data-dp-run ${st.picks.size && !st.busy ? "" : "disabled"}>${st.busy ? `<span class="mini-spin"></span> 동선 계산 중…` : `${icon("sparkles", 18)} ${st.picks.size}곳으로 짜 보기`}</button>
      ${st.result ? resultHtml(st.result) : ""}`;
    bindProfile(sheet.el);
    if (st.autoRun && !st.busy) {
      st.autoRun = false;
      setTimeout(run, 0);
    }
  };

  const run = async () => {
    st.busy = true;
    st.result = null;
    draw();
    try {
      const k = paceOf(st.prof).k;
      const picks = T.data.items.filter((i) => st.picks.has(i.id)).map((i) => (k === 1 ? i : { ...i, stay_min: Math.round((stayOf(i) * k) / 5) * 5 }));
      st.result = await planDay({ day, items: T.data.items, trip: trip(), picks, start: toMin(st.start), homeBy: toMin(st.home), saveCoords });
      if (st.auto && st.result.plan.length) {
        for (const i of st.result.left) { st.picks.delete(i.id); st.top.delete(i.id); }
        st.result.left = [];
      }
    } catch (e) {
      toast(`계산하지 못했어요: ${e.message}`);
    }
    st.busy = false;
    draw();
    sheet.el.querySelector(".plan-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  sheet.el.addEventListener("change", (e) => {
    const el = e.target;
    if (el.matches(".dp-pick input")) {
      st.auto = false;
      if (el.checked) st.picks.add(el.value);
      else st.picks.delete(el.value);
      st.more = !!sheet.el.querySelector(".dp-more:not(.dp-who)")?.open;
    } else if (el.matches("[data-dp-retime]")) {
      st.retime = el.checked;
      st.picks = null;
    } else if (el.matches("[data-profile] input")) {
      st.prof = readProfile(sheet.el);
      st.who = true;
      if (!st.homeTouched) st.home = paceOf(st.prof).home;
      saveProfile(st.prof);
      repick();
    } else if (el.matches("[data-dp-home]")) {
      st.home = el.value || "21:00";
      st.homeTouched = true;
      repick();
    } else if (el.matches("[data-dp-start]")) {
      st.start = el.value || "09:00";
      repick();
    }
    else return;
    st.result = null;
    draw();
  });
  sheet.el.addEventListener("click", async (e) => {
    const q = e.target.closest("[data-dp-q]")?.dataset.dpQ;
    if (q) {
      st.home = q;
      st.homeTouched = true;
      repick();
      st.result = null;
      return draw();
    }
    if (e.target.closest("[data-dp-run]")) return run();
    if (e.target.closest("[data-dp-save]") && st.result) {
      const r = st.result;
      try {
        for (const x of r.plan) {
          await rpc("upsert_item", { p_trip: T.id, p_item: { id: x.item.id, day_date: day, time: toHHMM(x.start), end_time: toHHMM(x.end) } });
        }
        sheet.close(true);
        toast(`${dayLabel(day)} 일정 ${r.plan.length}곳을 넣었어요`);
        await afterScheduleChange(null);
      } catch (err) {
        toast(err.message);
      }
    }
  });
  draw();
}
