/* 홈(개요) 탭 */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js?v=2611220944";
import { icon } from "./icons.js?v=2611220944";
import { isMaking, renderRecord } from "./record.js?v=2611220944";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js?v=2611220944";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js?v=2611220944";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js?v=2611220944";
import { youtubeSection } from "./trip-youtube.js?v=2611220944";
import { toMin } from "./geo.js?v=2611220944";
import { $app, T, busy, jobBanner, schedule } from "./trip.js?v=2611220944";
import { album } from "./trip-album.js?v=2611220944";
import { budget } from "./trip-money.js?v=2611220944";
import { prep } from "./trip-prep.js?v=2611220944";
import { act, bgAttrs, coverOf, secHead, spots, thumbOf, trip, wikiAttrs } from "./trip-shared.js?v=2611220944";

// ---------- 홈(개요) ----------
// 원칙: 여행 중 길 위에서 폰을 연 사람이 '지금 뭘 하면 되지?'를 3초 안에 알 수 있게.
//       위에서부터 지금 할 일 → 오늘 → 스팟 → 예약 → 참고 정보 순. 장식은 빼고 정보만.
const isTimed = (i) => toMin(i.time) != null;
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

/** 지금 할 일 카드: 여행 중=다음 일정, 여행 전=출발까지 남은 날·남은 준비, 여행 후=기록 만들기 */
function nowCard(t, ph, sp) {
  const items = T.data.items;
  if (ph.kind === "during") {
    const today = todayISO();
    const line = items.filter((i) => i.day_date === today && (i.category === "schedule" || isSpot(i)) && isTimed(i))
      .sort((a, b) => toMin(a.time) - toMin(b.time));
    const now = nowMin();
    const endOf = (i) => toMin(i.end_time) ?? toMin(i.time) + (i.category === "schedule" ? 60 : 60);
    const cur = line.find((i) => toMin(i.time) <= now && endOf(i) > now);
    const next = line.find((i) => toMin(i.time) > now);
    const focus = cur || next;
    const after = focus ? line.filter((i) => toMin(i.time) > toMin(focus.time)).slice(0, 2) : [];
    const vs = focus ? (T.data.vouchers || []).filter((v) => v.item_id === focus.id) : [];
    const where = focus && (focus.place || focus.details?.address || focus.name);
    if (!focus) {
      const left = sp.filter((i) => i.day_date === today && !i.done);
      return `<section class="now-card">
        <p class="eyebrow">TODAY · DAY ${ph.index + 1}</p>
        <h2>${line.length ? "오늘 정해 둔 일정은 다 끝났어요" : "오늘은 정해진 시간 일정이 없어요"}</h2>
        <p class="muted">${left.length ? `오늘 가 보려던 곳이 ${left.length}곳 남았어요.` : "오늘의 기록을 한 줄 남겨 보세요."}</p>
        <div class="btn-row"><button class="btn btn-ink grow" data-tab="schedule">${icon("calendar", 18)} 오늘 일정 보기</button></div>
      </section>`;
    }
    const mins = toMin(focus.time) - now;
    const when = cur ? "지금" : mins < 60 ? `${mins}분 뒤` : `${Math.floor(mins / 60)}시간 ${mins % 60 ? `${mins % 60}분 ` : ""}뒤`;
    return `<section class="now-card live">
      <p class="eyebrow"><span class="pulse"></span>${cur ? "NOW" : "NEXT"} · ${esc(when)}</p>
      <p class="now-time">${esc(focus.time)}${focus.end_time ? `<small> – ${esc(focus.end_time)}</small>` : ""}</p>
      <h2>${esc(focus.name)}</h2>
      ${where && where !== focus.name ? `<p class="muted">${icon("pin", 14)} ${esc(where)}</p>` : ""}
      <div class="now-actions">
        <a class="btn btn-ink" href="${esc(mapsDir(where || focus.name, t))}" target="_blank" rel="noopener">${icon("map", 18)} 길찾기</a>
        ${vs.length ? `<button class="btn btn-accent" data-act="voucher-show" data-id="${focus.id}">${icon("ticket", 18)} 바우처</button>` : ""}
        <button class="btn btn-line" data-act="${focus.category === "schedule" ? "sched-open" : "spot-open"}" data-id="${focus.id}">자세히</button>
      </div>
      ${after.length ? `<ul class="now-next">${after.map((i) => `<li><b>${esc(i.time)}</b><span>${esc(i.name)}</span></li>`).join("")}</ul>` : ""}
    </section>`;
  }
  if (ph.kind === "before") {
    const todos = items.filter((i) => i.category === "todo" && !i.done);
    const vTodo = (T.data.vouchers || []).filter((v) => v.status === "done" && !v.item_id).length;
    const loose = sp.filter((i) => !i.day_date).length;
    const first = items.filter((i) => i.category === "schedule" && i.day_date === t.start_date && isTimed(i))
      .sort((a, b) => toMin(a.time) - toMin(b.time))[0];
    return `<section class="now-card">
      <p class="eyebrow">BEFORE YOU GO</p>
      <p class="now-time">D-${ph.n}<small> · ${esc(dayLabel(t.start_date))}${first ? ` ${esc(first.time)} ${esc(first.name)}` : " 출발"}</small></p>
      <ul class="todo-mini">
        ${todos.slice(0, 3).map((i) => `<li><button class="check sm" data-act="toggle-done" data-id="${i.id}" aria-label="${esc(i.name)} 완료">${icon("check", 14)}</button><span>${esc(i.name)}</span></li>`).join("")}
      </ul>
      <div class="now-links">
        ${todos.length > 3 ? `<button data-tab="prep">할 일 ${todos.length - 3}개 더 ${icon("next", 14)}</button>` : todos.length ? "" : `<span class="ok">${icon("check", 14)} 할 일 다 했어요</span>`}
        ${loose ? `<button data-tab="schedule">시간 정할 스팟 ${loose}곳 ${icon("next", 14)}</button>` : ""}
        ${vTodo ? `<button data-act="voucher-box">확인할 바우처 ${vTodo}개 ${icon("next", 14)}</button>` : ""}
      </div>
    </section>`;
  }
  if (ph.kind === "after") {
    return `<section class="record-block">
      <p class="eyebrow light">MEMORIES</p><h2>여행을 기록으로</h2>
      <p>다녀온 곳과 사진으로 블로그 글과 영상을 만들어 보세요.</p>
      <button class="btn btn-white" data-tab="record">${icon("pen", 18)} 글 · ${icon("film", 18)} 영상 만들기</button></section>`;
  }
  return "";
}

const mapsDir = (q, t) => `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", destination: q, travelmode: "transit" })}`;

/** 예약 카드: 바우처가 붙었거나 예약번호가 적힌 일정 */
function bookings(t) {
  const vs = T.data.vouchers || [];
  const list = T.data.items.filter((i) => i.category === "schedule" && (vs.some((v) => v.item_id === i.id) || /예약번호|예약확정|예약 확정|바우처|예약완료/.test(i.note || "")))
    .sort((a, b) => `${a.day_date || ""}${a.time || ""}`.localeCompare(`${b.day_date || ""}${b.time || ""}`));
  const kindIc = (i) => (/항공|KE\d|OZ\d|공항|flight/i.test(`${i.name} ${i.note}`) ? "plane" : /호텔|체크인|체크아웃|숙소/.test(i.name) ? "bed"
    : /페리|ferry|기차|버스/i.test(i.name) ? "bus" : "ticket");
  const no = (i) => /예약번호\s*([A-Z0-9-]{5,})/i.exec(i.note || "")?.[1];
  if (!list.length && !t.bookings) {
    return `<section class="sec">${secHead("예약", "BOOKINGS")}
      <button class="empty-line" data-act="voucher-box">${icon("ticket", 18)} 항공권·숙소·입장권 바우처를 넣으면 여기 모여요 ${icon("next", 16)}</button></section>`;
  }
  return `<section class="sec">
    ${secHead("예약", "BOOKINGS", `<button class="link" data-act="voucher-box">${icon("plus", 16)} 바우처</button>`)}
    ${list.length ? `<ul class="booking-list">${list.map((i) => {
      const has = vs.some((v) => v.item_id === i.id);
      return `<li><button data-act="${has ? "voucher-show" : "sched-open"}" data-id="${i.id}">
        <span class="bk-ic">${icon(kindIc(i), 18)}</span>
        <span class="grow"><b>${esc(i.name)}</b><small>${i.day_date ? `${esc(dayLabel(i.day_date))} ${esc(i.time || "")}` : ""}${no(i) ? ` · ${esc(no(i))}` : ""}</small></span>
        ${has ? `<span class="bk-v">${icon("ticket", 14)} 바우처</span>` : icon("next", 16)}</button></li>`;
    }).join("")}</ul>` : ""}
    ${t.bookings ? `<details class="memo-fold"><summary>예약 메모 원문 <button class="link" data-act="edit-bookings">수정</button></summary><div class="memo">${linkify(t.bookings)}</div></details>` : ""}
  </section>`;
}

export function overview() {
  const t = trip();
  const s = t.summary || {};
  const ph = phase(t);
  const sp = spots();
  const visited = sp.filter((i) => i.done).length;
  const mediaN = T.data.media.length;
  const spent = T.data.expenses.reduce((a, e) => a + e.amount, 0);
  const prepItems = T.data.items.filter((i) => i.category === "todo" || i.category === "packing");
  const prepDone = prepItems.filter((i) => i.done).length;
  const cover = coverOf() || T.coverFallback || "";
  const eyebrow = (s.destination_en || t.destination || "").toUpperCase();
  const today = ph.kind === "during" ? todayISO() : null;
  const todaySpots = today ? sp.filter((i) => i.day_date === today) : [];
  const alerts = (s.alerts || []).map((a) => (typeof a === "string" ? { text: a } : a));
  const lastDay = ph.kind === "during" && ph.index === tripDays(t).length - 1;

  return `
    <section class="cover ${cover ? "has-img" : ""}" ${cover ? `style="background-image:url('${esc(cover)}')"`
      : `data-wiki="${esc(t.destination || t.title)}" data-wiki-en="${esc(s.destination_en || "")}"`}>
      <button class="cover-edit" data-act="cover-pick" aria-label="표지 사진 바꾸기">${icon("camera", 16)} 표지</button>
      <div class="cover-text">
        <span class="status">${esc(ph.en)}</span>
        ${eyebrow ? `<p class="eyebrow light">${esc(eyebrow)}</p>` : ""}
        <h1 data-act="edit-trip">${esc(t.title)}</h1>
        <p class="cover-meta">${esc(dateRange(t))}${t.companions ? ` &nbsp;·&nbsp; ${esc(t.companions)}` : ""}</p>
      </div>
    </section>

    <section class="numbers">
      <button data-tab="spots"><b>${visited}<i>/${sp.length}</i></b><span>방문</span></button>
      <button data-tab="album"><b>${mediaN}</b><span>사진·영상</span></button>
      <button data-tab="budget"><b>${won(spent)}</b><span>총 지출(원)</span></button>
      <button data-tab="prep"><b>${prepItems.length ? Math.round((prepDone / prepItems.length) * 100) : 0}<i>%</i></b><span>준비</span></button>
    </section>
    ${jobBanner()}

    ${nowCard(t, ph, sp)}

    ${todaySpots.length ? `<section class="sec">
      ${secHead("오늘 갈 곳", `DAY ${pad2(ph.index + 1)} · ${md(today)} ${wdEn(today)}`, `<button class="link" data-tab="schedule">일정 ${icon("next", 16)}</button>`)}
      <div class="rail">${todaySpots.map(railCard).join("")}</div>
    </section>` : ""}

    ${!sp.length ? `<section class="sec cta-block">
      <p class="eyebrow">START</p><h2>어디부터 갈까요?</h2>
      <p class="muted">AI가 취향에 맞는 곳을 골라 주거나, 가고 싶은 곳을 직접 담을 수 있어요.</p>
      <div class="btn-row"><button class="btn btn-ink" data-act="ai-plan" ${busy() ? "disabled" : ""}>${icon("sparkles", 18)} AI 추천 받기</button>
        <button class="btn btn-line" data-act="add-spot" data-cat="">${icon("plus", 18)} 직접 담기</button></div></section>`
    : `<section class="sec">
      ${secHead(`스팟 ${sp.length}곳`, "SPOTS", `<button class="link" data-tab="spots">전체 ${icon("next", 16)}</button>`)}
      <div class="cat-chips">${SPOT_KEYS.map((k) => {
        const n = sp.filter((i) => i.category === k).length;
        return n ? `<button data-act="go-cat" data-cat="${k}" style="--cat:${CATS[k].color}">${icon(CATS[k].ic, 16)}<span>${CATS[k].short}</span><b>${n}</b></button>` : "";
      }).join("")}</div>
    </section>`}

    ${bookings(t)}

    ${alerts.length ? `<section class="sec">
      ${secHead("알아 둘 것", "NOTE")}
      <ol class="notes">${alerts.map((a) => `<li><p>${esc(a.text)}</p>${srcMark(a)}</li>`).join("")}</ol></section>` : ""}

    ${(s.must_eat || []).length ? `<section class="sec">${secHead("꼭 먹어 볼 것", "MUST EAT")}
      <div class="eat-chips">${s.must_eat.map((x) => `<span>${esc(x)}</span>`).join("")}</div></section>` : ""}

    ${youtubeSection(s)}

    ${(s.videos || []).length || (s.video_queries || []).length || t.destination ? `<section class="sec bleed">
      ${secHead("영상으로 미리 보기", "WATCH")}
      <div class="rail">${(s.videos || []).map((v) => `<button class="video-card" data-act="yt" data-vid="${esc(v.id)}">
          <span class="video-thumb" style="background-image:url('https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg')">${icon("play", 22, "play-ic")}</span>
          <b>${esc(v.title)}</b><small>${esc(v.author || "")}</small></button>`).join("")}
        ${videoQueries(s, t).map((q) => `<a class="video-card" href="${ytSearchUrl(q)}" target="_blank" rel="noopener">
          <span class="video-thumb query" data-wiki="${esc(t.destination || t.title)}" data-wiki-en="${esc(s.destination_en || "")}">
            ${icon("play", 22, "play-ic")}<em>${esc(q)}</em></span>
          <b>YouTube에서 보기</b><small>${esc(q)}</small></a>`).join("")}</div>
    </section>` : ""}

    ${(s.basic_info || []).length ? `<details class="sec fold"><summary>${secHead("여행 기본 정보", "INFO")}</summary>
      <dl class="info">${s.basic_info.map((b) => {
        const [k, ...v] = String(b).split(":");
        return v.length ? `<dt>${esc(k.trim())}</dt><dd>${esc(v.join(":").trim())}</dd>` : `<dd class="full">${esc(b)}</dd>`;
      }).join("")}</dl></details>` : ""}

    ${lastDay ? `<section class="record-block">
      <p class="eyebrow light">LAST DAY</p><h2>여행을 기록으로</h2>
      <p>오늘이 마지막 날이에요. 다녀온 곳과 사진으로 블로그 글과 영상을 만들 수 있어요.</p>
      <button class="btn btn-white" data-tab="record">${icon("pen", 18)} 글 · ${icon("film", 18)} 영상 만들기</button></section>` : ""}
  `;
}

export function railCard(i) {
  return `<button class="rail-card" data-act="spot-open" data-id="${i.id}">
    <span class="rail-img" ${bgAttrs(i)}>${icon(CATS[i.category].ic, 26, "fallback-ic")}
      ${i.done ? `<span class="done-dot">${icon("check", 14)}</span>` : ""}</span>
    <small>${esc(i.time || CATS[i.category].label)}</small><b>${esc(i.name)}</b></button>`;
}

export function videoQueries(s, t) {
  const q = s.video_queries || [];
  const dest = (t.destination || t.title || "").split(/[·,]/)[0].trim();
  return q.length ? q : dest ? [`${dest} 여행 브이로그`, `${dest} 맛집`, `${dest} 가볼만한곳`] : [];
}

export async function fillCommons() {
  // 표지 사진이 없고 위키 대표 사진도 못 찾으면 위키미디어 풍경 사진 첫 장을 표지로 (다시 그려도 유지되게 기억)
  const cover = $(".cover", $app);
  if (!cover || cover.classList.contains("has-img") || !T) return;
  const t = trip();
  const wiki = await wikiThumb(cover.dataset.wiki || "", cover.dataset.wikiEn || "");
  if (wiki || !T) return;
  const list = await commonsImages(t.summary?.destination_en || (t.destination || t.title || "").split(/[·,/]/)[0].trim(), 3);
  if (list[0] && T && $app.contains(cover)) {
    T.coverFallback = list[0].thumb;
    cover.style.backgroundImage = `url("${list[0].thumb}")`;
    cover.classList.add("has-img");
  }
}

export function srcMark(x) {
  if (x?.verified && safeUrl(x.source_url)) {
    let host = "";
    try {
      host = new URL(x.source_url).hostname.replace(/^www\./, "");
    } catch {}
    return `<a class="src ok" href="${esc(x.source_url)}" target="_blank" rel="noopener">${icon("external", 12)} ${esc(host || "출처")}</a>`;
  }
  return "";
}
