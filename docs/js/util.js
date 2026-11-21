/* 공용 도구: 이스케이프·날짜·카테고리·링크·저장·토스트 */

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const linkify = (s) =>
  esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, "<br>");

export const won = (n) => (n || n === 0 ? Number(n).toLocaleString("ko-KR") : "");

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function toast(msg) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------- 날짜 ----------
const pad = (n) => String(n).padStart(2, "0");
export const iso = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
export const todayISO = () => iso(new Date());
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const parse = (s) => new Date(`${s}T00:00:00`);

export function tripDays(trip) {
  if (!trip.start_date) return [];
  const out = [];
  const end = parse(trip.end_date || trip.start_date);
  for (let d = parse(trip.start_date); d <= end && out.length < 60; d.setDate(d.getDate() + 1)) out.push(iso(d));
  return out;
}

export const md = (s) => (s ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}` : "");
export const wd = (s) => (s ? WEEK[parse(s).getDay()] : "");
export const dayLabel = (s) => `${md(s)} (${wd(s)})`;

export function dateRange(trip) {
  if (!trip.start_date) return "날짜 미정";
  const f = (s) => s.replaceAll("-", ".");
  return trip.end_date && trip.end_date !== trip.start_date ? `${f(trip.start_date)} – ${f(trip.end_date).slice(5)}` : f(trip.start_date);
}

/** 여행 상태: before(D-n) / during(Day n) / after / none */
export function phase(trip) {
  const days = tripDays(trip);
  if (!days.length) return { kind: "none", label: "날짜 미정" };
  const today = todayISO();
  if (today < days[0]) {
    const n = Math.round((parse(days[0]) - parse(today)) / 86400000);
    return { kind: "before", label: `D-${n}`, n };
  }
  if (today > days[days.length - 1]) return { kind: "after", label: "여행 완료" };
  const i = days.indexOf(today);
  return { kind: "during", label: `여행 중 · Day ${i + 1}/${days.length}`, index: i };
}

export function timeAgo(isoStr) {
  const s = Math.max(0, (Date.now() - new Date(isoStr)) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(isoStr).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

export const stamp = (isoStr) =>
  isoStr ? new Date(isoStr).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

// ---------- 카테고리 ----------
export const CATS = {
  photo: { label: "사진 명소", short: "사진", icon: "📸", color: "var(--c-photo)" },
  food: { label: "먹거리", short: "먹거리", icon: "🍜", color: "var(--c-food)" },
  cafe: { label: "카페", short: "카페", icon: "☕", color: "var(--c-cafe)" },
  place: { label: "가볼 곳", short: "가볼 곳", icon: "📍", color: "var(--c-place)" },
  landmark: { label: "랜드마크", short: "랜드마크", icon: "🏛️", color: "var(--c-landmark)" },
  activity: { label: "즐길거리", short: "즐길거리", icon: "🎡", color: "var(--c-activity)" },
};
export const SPOT_KEYS = Object.keys(CATS);
export const isSpot = (i) => SPOT_KEYS.includes(i.category);

// ---------- 링크 ----------
export const mapsUrl = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
export const imageSearchUrl = (q) => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
export const ytSearchUrl = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;

export function spotQuery(item, trip) {
  return item.search_query || `${item.name} ${item.area || ""} ${trip.destination || ""}`.trim();
}

export function routeUrl(items, trip) {
  const stops = items.map((i) => spotQuery(i, trip)).slice(0, 10);
  if (stops.length < 2) return "";
  const [origin, ...rest] = stops;
  const destination = rest.pop();
  const p = new URLSearchParams({ api: "1", origin, destination, travelmode: "transit" });
  if (rest.length) p.set("waypoints", rest.join("|"));
  return `https://www.google.com/maps/dir/?${p}`;
}

export const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
