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

export const STAY = { photo: 30, food: 60, cafe: 45, place: 60, landmark: 60, activity: 90, schedule: 60 };
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
    // 대중교통·택시 추정: 대기·환승 10분 + 평균 시속 18km
    out = { min: Math.round(10 + (d / 18) * 60), mode: "대중교통·택시", km: d };
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
  if (/마다\s*다름|다름\s*\(|가게마다|매장마다/.test(h)) return null;
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
      const end = toMin(i.end_time) ?? start + (i.category === "schedule" ? 60 : stayOf(i));
      return { item: i, start, end: Math.max(end, start + 10) };
    })
    .sort((a, b) => a.start - b.start);
}

/** 카테고리별 선호 시간대 (분) */
function preferred(spot) {
  const bt = `${spot.details?.best_time || ""} ${spot.time || ""}`;
  if (/해\s*질|일몰|노을|야경|밤|저녁/.test(bt)) return 18 * 60;
  if (/아침|오전|개장|오픈/.test(bt)) return 10 * 60;
  if (spot.category === "food") return null; // 식사 시간대 중 가까운 쪽
  if (spot.category === "cafe") return 15 * 60;
  return 14 * 60;
}

/**
 * 스팟을 그날 어디에 넣으면 좋은지 계산.
 * 반환: {ok, start, end, prev, next, inLeg, outLeg, reason} 또는 {ok:false, reason}
 */
export async function suggestSlot(spot, day, items, trip, saveCoords) {
  const stay = stayOf(spot);
  const tl = timeline(items, day, spot.id);
  const hours = openHours(spot.details) || [8 * 60, 23 * 60];
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
