/* 좌표·이동 시간·일정 추천 (모두 무료).
 *
 * - 좌표: OpenStreetMap Nominatim (1초 1번 규칙 지킴, 결과는 폰과 DB에 저장)
 * - 도보 시간: OpenStreetMap 도보 경로(routing.openstreetmap.de). 실패하면 직선거리로 추정
 * - 먼 거리: 대중교통·택시 시간을 거리로 추정 → 정확한 경로는 '구글 지도 길찾기' 버튼으로 확인
 *   (구글 길찾기 API는 결제 계정이 필요해서 쓰지 않음)
 */

// ---------- 시간 ----------
export const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec((t || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const toHHMM = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const ceil10 = (m) => Math.ceil(m / 10) * 10;

export const STAY = { photo: 30, food: 60, cafe: 45, place: 60, landmark: 60, activity: 90, bar: 90, schedule: 60 };
export const stayOf = (i) => i.stay_min || STAY[i.category] || 60;

// ---------- 좌표 ----------
const GEO_KEY = "geo:cache";
let lastGeo = 0;
const geoCache = (() => {
  try {
    return JSON.parse(localStorage.getItem(GEO_KEY) || "{}");
  } catch {
    return {};
  }
})();

async function nominatim(q) {
  if (q in geoCache) return geoCache[q];
  const wait = 1100 - (Date.now() - lastGeo);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeo = Date.now();
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: "json", limit: "1", "accept-language": "ko" })}`);
    const hit = (await res.json())[0];
    geoCache[q] = hit ? [Number(hit.lat), Number(hit.lon)] : null;
    try {
      localStorage.setItem(GEO_KEY, JSON.stringify(geoCache));
    } catch {}
    return geoCache[q];
  } catch {
    return null; // 오프라인 등 → 저장하지 않고 다음에 다시
  }
}

/** 한국어 위키백과 좌표 (역·랜드마크·호텔 등 한국어 이름이 OpenStreetMap에서 안 찾아질 때) */
async function koWiki(q) {
  const key = `wiki:${q}`;
  if (key in geoCache) return geoCache[key];
  try {
    const u = `https://ko.wikipedia.org/w/api.php?${new URLSearchParams({ action: "query", generator: "search", gsrsearch: q, gsrlimit: "1",
      prop: "coordinates", format: "json", origin: "*" })}`;
    const page = Object.values((await (await fetch(u)).json()).query?.pages || {})[0];
    const c = page?.coordinates?.[0];
    geoCache[key] = c ? [c.lat, c.lon] : null;
    try {
      localStorage.setItem(GEO_KEY, JSON.stringify(geoCache));
    } catch {}
    return geoCache[key];
  } catch {
    return null;
  }
}

async function photon(q, near) {
  const key = `photon:${q}`;
  if (key in geoCache) return geoCache[key];
  try {
    const p = new URLSearchParams({ q, limit: "1", ...(near ? { lat: near[0], lon: near[1] } : {}) });
    const f = (await (await fetch(`https://photon.komoot.io/api/?${p}`)).json()).features?.[0];
    geoCache[key] = f ? [f.geometry.coordinates[1], f.geometry.coordinates[0]] : null;
    try {
      localStorage.setItem(GEO_KEY, JSON.stringify(geoCache));
    } catch {}
    return geoCache[key];
  } catch {
    return null;
  }
}

/** 여행지 중심 좌표 (엉뚱한 동명 장소를 거르는 데 씀) */
async function centerOf(trip) {
  const en = trip.destination_en || trip.summary?.destination_en;
  const ko = (trip.destination || "").split(/[·,/]/)[0].trim();
  const words = ko.split(/\s+/);
  for (const q of [en, ko, words[words.length - 1]].filter(Boolean)) {
    const c = (await nominatim(q)) || (await koWiki(q));
    if (c) return c;
  }
  return null;
}

/** 항목 좌표 [lat, lng]. 없으면 찾아서 save(lat, lng)로 DB에 저장.
 *  OpenStreetMap은 영문·현지어 이름을 잘 찾으므로 영문 검색어·주소를 먼저, 한국어는 나중에 + 위키백과 좌표 */
export async function coordsOf(item, trip, save) {
  if (item.lat != null && item.lng != null) return [item.lat, item.lng];
  const city = (trip.destination || "").split(/[·,/]/)[0].trim();
  const cityEn = trip.destination_en || trip.summary?.destination_en || "";
  const plain = (item.name || "").replace(/[(（].*?[)）]/g, "").trim();
  const en = /\(([^)]+)\)/.exec(item.name || "")?.[1];
  const named = item.category === "schedule" ? item.place : plain; // 일정은 '장소' 칸만 (일정 이름은 장소가 아님)
  const sq = /^(voucher|auto):/.test(item.search_query || "") ? "" : item.search_query; // 앱 내부 표시는 검색어가 아님
  const bare = item.place && item.place.replace(/\s*\([^)]*\)/g, "").replace(/\s*Terminal\s*\d+|\s*T\d\b/i, "").trim();
  const qs = [item.details?.address, sq, en && `${en} ${cityEn}`, item.place && cityEn && `${item.place} ${cityEn}`, bare,
    named, named && `${named} ${city}`].filter(Boolean);
  const center = await centerOf(trip);
  const near = (c) => !center || km(center, c) < 300;
  for (const q of [...new Set(qs)]) {
    const c = await nominatim(q);
    if (c && near(c)) return keep(c);
  }
  if (named) {
    const c = await koWiki(named);
    if (c && near(c)) return keep(c);
  }
  // 마지막: Photon (이름이 조금 달라도 찾음) — 여행지 80km 안 결과만
  for (const q of [...new Set(qs)]) {
    const c = await photon(q, center);
    if (c && center && km(center, c) < 80) return keep(c);
  }
  return null;

  function keep(c) {
    item.lat = c[0];
    item.lng = c[1];
    save?.(c[0], c[1]);
    return c;
  }
}

// ---------- 이동 시간 ----------
const km = ([a, b], [c, d]) => {
  const R = 6371, rad = Math.PI / 180;
  const x = Math.sin(((c - a) * rad) / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(((d - b) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const legCache = new Map();

/** 두 좌표 사이 이동 {min, mode: "도보"|"대중교통·택시", km} */
export async function leg(a, b) {
  if (!a || !b) return null;
  const key = `${a}|${b}`;
  if (legCache.has(key)) return legCache.get(key);
  const d = km(a, b);
  if (d > 80) return null; // 비행기·장거리 구간 (예: 인천 ↔ 홍콩)은 이동 시간 계산 안 함
  let out;
  if (d <= 1.6) {
    let min = Math.round((d * 1.3 / 4.5) * 60); // 직선거리 → 실제 길 1.3배, 시속 4.5km
    try {
      const url = `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=false`;
      const r = await (await fetch(url)).json();
      if (r.routes?.[0]) min = Math.round(r.routes[0].duration / 60);
    } catch {}
    out = { min: Math.max(1, min), mode: "도보", km: d };
  } else {
    // 대중교통·택시 추정: 가까우면 시내 속도, 멀면 전철·공항철도 속도 (대기·환승 포함)
    const min = d < 5 ? 10 + (d / 15) * 60 : d < 20 ? 12 + (d / 25) * 60 : 15 + (d / 45) * 60;
    out = { min: Math.round(min), mode: "대중교통·택시", km: d };
  }
  legCache.set(key, out);
  return out;
}

export function directionsUrl(from, to, mode = "transit") {
  const p = (x) => (x.coords ? x.coords.join(",") : x.query);
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", origin: p(from), destination: p(to), travelmode: mode })}`;
}

// ---------- 영업시간 ----------
/** 비행기 일정인지 (편명 또는 공항이 장소) */
export const isFlight = (i) => i?.category === "schedule" && (/\b[A-Z0-9]{2}\d{3,4}\b/.test(i.name || "") || /airport|공항/i.test(i.place || ""));

export function openHours(details) {
  const h = details?.hours || "";
  if (/24\s*시간|24h|24 hours/i.test(h)) return [0, 24 * 60];
  if (/가게마다|매장마다|점포마다/.test(h)) return null; // 거리·시장처럼 가게마다 다른 곳 (괄호 속 '마감' 시간을 영업시간으로 착각하지 않게)
  const m = /(\d{1,2}):(\d{2})\s*[–~\-—]\s*(\d{1,2}):(\d{2})/.exec(h);
  if (!m) return null;
  const open = Number(m[1]) * 60 + Number(m[2]);
  let close = Number(m[3]) * 60 + Number(m[4]);
  if (close <= open) close += 24 * 60; // 자정 넘어서까지
  return [open, close];
}

// ---------- 하루 타임라인 ----------
/** 그날 시간이 정해진 항목들 (시간순): {item, start, end} */
export function timeline(items, day, exceptId) {
  return items
    .filter((i) => i.day_date === day && i.id !== exceptId && toMin(i.time) != null)
    .map((i) => {
      const start = toMin(i.time);
      const end = toMin(i.end_time) ?? start + (i.category === "schedule" ? 30 : stayOf(i)); // 체크인 같은 일정은 30분
      return { item: i, start, end: Math.max(end, start + 10) };
    })
    .sort((a, b) => a.start - b.start);
}

/** 영업시간을 모를 때: 술집은 저녁부터, 나머지는 08~23시 */
const defaultHours = (s) => (s.category === "bar" ? [17 * 60, 24 * 60] : [8 * 60, 23 * 60]);

/** 카테고리별 선호 시간대 (분) */
function preferred(spot) {
  const bt = `${spot.details?.best_time || ""} ${spot.time || ""}`;
  if (/해\s*질|일몰|노을|야경|밤|저녁/.test(bt)) return 18 * 60;
  if (/아침|오전|개장|오픈/.test(bt)) return 10 * 60;
  if (spot.category === "food") return null; // 식사 시간대 중 가까운 쪽
  if (spot.category === "cafe") return 15 * 60;
  if (spot.category === "bar") return 20 * 60 + 30;
  return 14 * 60;
}

/**
 * 스팟을 그날 어디에 넣으면 좋은지 계산.
 * 반환: {ok, start, end, prev, next, inLeg, outLeg, reason} 또는 {ok:false, reason}
 */
export async function suggestSlot(spot, day, items, trip, saveCoords) {
  const stay = stayOf(spot);
  const tl = timeline(items, day, spot.id);
  const hours = openHours(spot.details) || defaultHours(spot);
  const me = await coordsOf(spot, trip, (la, ln) => saveCoords(spot, la, ln));
  // 하루의 처음과 끝 (가상의 시작·끝: 9시~22시)
  const nodes = [{ item: null, start: 9 * 60, end: 9 * 60 }, ...tl, { item: null, start: 22 * 60, end: 22 * 60 }];
  if (tl.length && tl[0].start < 9 * 60) nodes[0] = { item: null, start: tl[0].start, end: tl[0].start };
  if (tl.length && tl[tl.length - 1].end > 22 * 60) nodes[nodes.length - 1] = { item: null, start: 23 * 60 + 59, end: 23 * 60 + 59 };

  const coords = new Map();
  for (const n of tl) coords.set(n.item.id, await coordsOf(n.item, trip, (la, ln) => saveCoords(n.item, la, ln)));

  let best = null;
  for (let k = 0; k < nodes.length - 1; k++) {
    const prev = nodes[k], next = nodes[k + 1];
    const pc = prev.item && coords.get(prev.item.id), nc = next.item && coords.get(next.item.id);
    const inLeg = pc && me ? await leg(pc, me) : null;
    const outLeg = nc && me ? await leg(me, nc) : null;
    const tIn = prev.item ? (isFlight(prev.item) ? 60 + (inLeg?.min ?? 60) : (inLeg?.min ?? 25)) : 0;
    const tOut = next.item ? (isFlight(next.item) ? 120 + (outLeg?.min ?? 60) : (outLeg?.min ?? 25)) : 0;
    const earliest = ceil10(Math.max(prev.end + tIn, hours[0]));
    const latest = Math.min(next.start - tOut - stay, hours[1] - stay);
    if (earliest > latest) continue;
    // 선호 시간에 가장 가깝게
    let want = preferred(spot);
    if (want == null) want = [12 * 60, 18 * 60 + 30].sort((a, b) => Math.abs(a - earliest) - Math.abs(b - earliest))[0];
    const start = Math.max(earliest, Math.floor(Math.min(Math.max(want, earliest), latest) / 10) * 10);
    const direct = pc && nc ? (await leg(pc, nc))?.min ?? 0 : 0;
    const detour = (prev.item ? tIn : 0) + (next.item ? tOut : 0) - direct;
    const score = detour + Math.abs(start - want) / 6; // 동선 우선, 그다음 선호 시간
    if (!best || score < best.score) best = { ok: true, start, end: start + stay, prev: prev.item, next: next.item, inLeg, outLeg, score };
  }
  if (!best) {
    return { ok: false, reason: tl.length ? "이 날은 일정 사이에 들를 만한 빈 시간이 부족해요. 시간 없이 이 날에만 넣거나 다른 날을 골라 보세요." :
      "영업시간 안에 들를 시간이 없어요." };
  }
  const who = (x) => `'${x.name}'${x.time ? `(${x.time})` : ""}`;
  const parts = [];
  if (best.prev && best.next) parts.push(`${who(best.prev)} 다음, ${who(best.next)} 전에 들르면 동선이 가장 짧아요`);
  else if (best.prev) parts.push(`${who(best.prev)} 다음에 들르기 좋아요`);
  else if (best.next) parts.push(`${who(best.next)} 전에 들르기 좋아요`);
  else parts.push("이 날은 정해진 일정이 없어서 이 장소에 어울리는 시간대로 골랐어요");
  if (spot.details?.hours) parts.push(`영업시간 ${spot.details.hours}`);
  best.reason = parts.join(" · ");
  best.me = me;
  return best;
}

export const legText = (l) => (l ? `${l.mode} 약 ${l.min}분` : "이동 시간 확인 필요");
export const placeQuery = (i, trip) => i.place || i.details?.address || `${i.name} ${(trip.destination || "").split(/[·,/]/)[0]}`;
/** 구글 지도 길찾기용 지점 */
export const point = (i, trip) => ({ coords: i.lat != null ? [i.lat, i.lng] : null, query: placeQuery(i, trip) });

// ---------- 하루 자동 짜기 ----------
const HOTEL = /호텔|숙소|체크인|체크아웃|hotel|inn|hostel|resort|게스트하우스|에어비앤비/i;

/** 이 여행의 숙소 (장소가 적힌 체크인 일정 우선) */
export function hotelOf(items) {
  return items.find((i) => i.category === "schedule" && HOTEL.test(i.name) && (i.place || i.lat != null))
    || items.find((i) => i.category === "schedule" && HOTEL.test(`${i.name} ${i.place || ""}`));
}

/** 시간에 민감한 스팟 (야경·해 질 녘)은 그 시간 근처로 미룸 */
const timeBound = (s) => /해\s*질|일몰|노을|야경|밤/.test(`${s.details?.best_time || ""} ${s.details?.headline || ""} ${s.time || ""}`);

/**
 * 그날 확정 일정은 그대로 두고, 고른 스팟을 빈 시간에 동선·영업시간·선호 시간대로 채운다.
 * picks: 넣을 스팟들, start: 출발(분), homeBy: 숙소 도착(분)
 * 반환: {plan: [{item, start, end, inLeg}], left: [못 넣은 스팟], home: {leg, at}, hotel}
 */
export async function planDay({ day, items, trip, picks, start, homeBy, saveCoords }) {
  const ids = new Set(picks.map((p) => p.id));
  const fixed = timeline(items, day).filter((n) => !ids.has(n.item.id));
  const hotel = hotelOf(items);
  const save = (it) => (la, ln) => saveCoords(it, la, ln);
  const hc = hotel ? await coordsOf(hotel, trip, save(hotel)) : null;
  const co = new Map();
  for (const x of [...picks, ...fixed.map((n) => n.item)]) co.set(x.id, await coordsOf(x, trip, save(x)));

  // 앞뒤 경계: 아침엔 숙소에서 출발, 밤엔 숙소로 돌아옴
  const nodes = [{ item: hotel || null, start, end: start, c: hc, virtual: true },
    ...fixed.map((n) => ({ ...n, c: co.get(n.item.id) })),
    { item: hotel || null, start: homeBy, end: homeBy, c: hc, virtual: true, home: true }];
  nodes.sort((a, b) => a.start - b.start || (a.home ? 1 : -1));
  // 첫날: 비행기 도착 전엔 아직 여행지가 아님 / 마지막 날: 출발 비행기 뒤엔 일정 없음
  const flights = nodes.filter((n) => !n.virtual && isFlight(n.item));
  if (flights.length && day === trip.start_date) nodes.splice(0, nodes.indexOf(flights[0]));
  if (flights.length && day === trip.end_date) nodes.splice(nodes.indexOf(flights[flights.length - 1]) + 1);

  const travel = async (a, b, aItem, bItem) => {
    const l = a && b ? await leg(a, b) : null;
    let t = l?.min ?? 25;
    if (aItem && isFlight(aItem) && !aItem.home) t += 60;       // 도착 후 입국·수하물
    if (bItem && isFlight(bItem)) t += 120;                      // 출발 2시간 전 공항
    return { t, l };
  };

  const feasible = async (s, prev, next) => {
    const stay = stayOf(s);
    const hours = openHours(s.details) || defaultHours(s);
    const inT = await travel(prev.c, co.get(s.id), prev.virtual ? null : prev.item, null);
    const outT = await travel(co.get(s.id), next.c, null, next.virtual ? null : next.item);
    const earliest = ceil10(Math.max(prev.end + inT.t, hours[0]));
    const latest = Math.min(next.start - outT.t - stay, hours[1] - stay);
    return { stay, earliest, latest, inT };
  };

  // 1) 시간이 중요한 곳부터 제자리에: 식사(점심 12:00·저녁 18:30), 해 질 녘·야경(17:30), 카페(15:00)
  const left = [...picks];
  const foods = left.filter((s) => s.category === "food" && !timeBound(s));
  const want = new Map();
  if (foods.length === 1) want.set(foods[0].id, homeBy >= 20 * 60 ? 18 * 60 + 30 : 12 * 60);
  else if (foods.length >= 2) { want.set(foods[0].id, 12 * 60); want.set(foods[1].id, 18 * 60 + 30); }
  for (const s of left) if (timeBound(s)) want.set(s.id, 17 * 60 + 30);
  const cafes = left.filter((s) => s.category === "cafe");
  if (cafes.length === 1 && !want.has(cafes[0].id)) want.set(cafes[0].id, 15 * 60);
  // 술집은 저녁 먹고 나서 (숙소 가기 전 마지막)
  for (const s of left) if (s.category === "bar" && !want.has(s.id)) want.set(s.id, Math.max(19 * 60 + 30, Math.min(21 * 60, homeBy - 120)));
  // 식사를 먼저 (시간 맞추기가 가장 중요), 그다음 해 질 녘·카페. 빈 시간 전체에서 원하는 시각에 가장 가까운 곳으로
  const rank = (x) => (x.category === "food" ? 0 : timeBound(x) ? 1 : x.category === "bar" ? 2 : 3);
  const anchors = left.filter((x) => want.has(x.id)).sort((a, b) => rank(a) - rank(b) || want.get(a.id) - want.get(b.id));
  for (const x of anchors) {
    const t = want.get(x.id);
    let best = null;
    for (let k = 0; k < nodes.length - 1; k++) {
      const f = await feasible(x, nodes[k], nodes[k + 1]);
      if (f.earliest > f.latest) continue;
      const at = Math.min(f.latest, Math.max(f.earliest, ceil10(t)));
      if (!best || Math.abs(at - t) < Math.abs(best.at - t)) best = { k, at, stay: f.stay };
    }
    if (!best || Math.abs(best.at - t) > 150) continue; // 원하는 시각에서 2시간 반 넘게 벗어나면 일반 순서로
    nodes.splice(best.k + 1, 0, { item: x, start: best.at, end: best.at + best.stay, c: co.get(x.id), planned: true });
    left.splice(left.indexOf(x), 1);
  }

  // 2) 나머지는 빈 시간에 가까운 곳부터 차례로
  for (let k = 0; k < nodes.length - 1; k++) {
    let prev = nodes[k];
    for (;;) {
      const next = nodes[k + 1];
      let best = null;
      for (const s of left) {
        const f = await feasible(s, prev, next);
        if (f.earliest > f.latest) continue;
        const score = f.inT.t + (f.earliest - (prev.end + f.inT.t)) / 2;
        if (!best || score < best.score) best = { s, at: f.earliest, stay: f.stay, score };
      }
      if (!best) break;
      const node = { item: best.s, start: best.at, end: best.at + best.stay, c: co.get(best.s.id), planned: true };
      nodes.splice(k + 1, 0, node);
      left.splice(left.indexOf(best.s), 1);
      prev = node;
      k++;
    }
  }

  // 3) 결과: 넣은 곳마다 앞 장소에서 오는 이동 시간
  const plan = [];
  for (let k = 1; k < nodes.length; k++) {
    if (!nodes[k].planned) continue;
    const prev = nodes[k - 1];
    plan.push({ item: nodes[k].item, start: nodes[k].start, end: nodes[k].end, inLeg: prev.c && nodes[k].c ? await leg(prev.c, nodes[k].c) : null });
  }
  const lastC = plan.length ? co.get(plan[plan.length - 1].item.id) : null;
  const homeLeg = lastC && hc ? await leg(lastC, hc) : null;
  const lastEnd = plan.length ? plan[plan.length - 1].end : null;
  return { plan, left, hotel, fixed, home: lastEnd != null ? { at: lastEnd + (homeLeg?.min ?? 25), leg: homeLeg } : null };
}
