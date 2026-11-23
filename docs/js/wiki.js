/* 장소 사진 자동으로 찾기: 위키백과·위키미디어 공용 (무료, API 키 불필요, 브라우저에서 직접 호출)
 *
 * 엉뚱한 사진을 막기 위해: 문서 제목이 장소 이름과 실제로 겹칠 때만 사진을 쓴다.
 * 식당·카페는 위키백과에 거의 없고 동명이인(브랜드 등)이 많아서 자동 사진을 쓰지 않는다.
 */
import { store } from "./util.js?v=2611240202";

const mem = new Map();
const VERSION = 4; // 규칙을 바꾸면 올려서 예전 캐시를 무시

function cacheGet(key) {
  if (mem.has(key)) return mem.get(key);
  try {
    const v = JSON.parse(store(`wiki${VERSION}:${key}`) || "null");
    if (v && Date.now() - v.t < 14 * 86400000) {
      mem.set(key, v.d);
      return v.d;
    }
  } catch {}
  return undefined;
}
function cacheSet(key, d) {
  mem.set(key, d);
  store(`wiki${VERSION}:${key}`, JSON.stringify({ t: Date.now(), d }));
}

// 국기·문장·지도·로고처럼 '풍경 사진'이 아닌 대표 이미지는 쓰지 않는다
const NOT_PHOTO = /flag_of|coat_of_arms|emblem|seal_of|locator|_map|map_of|location_|logo|\.svg/i;

const norm = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

/** 제목이 이름과 충분히 겹치는지 (예: "Kiyomizu-dera" ↔ "kiyomizudera kyoto") */
function matches(title, names) {
  const t = norm(title);
  if (t.length < 2) return false;
  return names.some((n) => {
    const q = norm(n);
    if (q.length < 2) return false;
    return t.includes(q) || q.includes(t) || (t.length >= 4 && q.startsWith(t.slice(0, Math.max(4, Math.ceil(t.length * 0.7)))));
  });
}

async function searchThumb(lang, query, names) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=4` +
    `&gsrsearch=${encodeURIComponent(query)}&prop=pageimages&piprop=thumbnail&pithumbsize=640`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const pages = Object.values((await res.json()).query?.pages || {}).sort((a, b) => a.index - b.index);
  const hit = pages.find((p) => p.thumbnail && !NOT_PHOTO.test(p.thumbnail.source) && matches(p.title, names));
  return hit?.thumbnail.source || null;
}

/** 이름에서 검색에 쓸 후보: 한글 이름, 괄호 속 영문/현지어, 영문 검색어의 앞부분 */
function candidates(nameKo, queryEn) {
  const inParen = (nameKo.match(/[(（]([^)）]+)[)）]/) || [])[1] || "";
  // "홍콩·마카오", "일본 오사카·교토"처럼 여러 곳이면 첫 장소로 검색
  const base = nameKo.replace(/[(（].*?[)）]/g, "").replace(/^(여유가 있으면|선택|대안)\s*/, "").split(/[·,/]/)[0].trim();
  const en = (queryEn || inParen).trim();
  const enCore = en.split(/,|\s+(?:in|at)\s+/i)[0].trim();
  return { base, en, names: [base, inParen, enCore].filter(Boolean) };
}

/** 장소 대표 이미지 1장. 확신이 없으면 null (카테고리 아이콘으로 표시) */
export async function wikiThumb(nameKo, queryEn = "") {
  const key = `${nameKo}|${queryEn}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const { base, en, names } = candidates(nameKo, queryEn);
  let src = null;
  try {
    if (en) src = await searchThumb("en", en, names);
    if (!src && base) src = await searchThumb("ko", base, names);
  } catch {}
  cacheSet(key, src);
  return src;
}

/** 여행지 사진 여러 장 (위키미디어 공용) */
export async function commonsImages(query, limit = 8) {
  const key = `commons|${query}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  let list = [];
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search` +
      `&gsrnamespace=6&gsrlimit=${limit * 2}&gsrsearch=${encodeURIComponent(`${query} city view filetype:bitmap`)}` +
      `&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640`;
    const res = await fetch(url);
    const pages = Object.values((await res.json()).query?.pages || {}).sort((a, b) => a.index - b.index);
    list = pages
      .map((p) => p.imageinfo?.[0])
      .filter((ii) => ii?.thumburl && !/\.svg/i.test(ii.url))
      .slice(0, limit)
      .map((ii) => ({
        thumb: ii.thumburl,
        page: ii.descriptionurl,
        credit: (ii.extmetadata?.Artist?.value || "").replace(/<[^>]+>/g, "").trim().slice(0, 60),
      }));
  } catch {}
  cacheSet(key, list);
  return list;
}

/** data-wiki="이름" data-wiki-en="영문" 요소에, 화면에 보일 때 배경 이미지를 채운다 */
const io = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && fill(e.target)), { rootMargin: "200px" })
  : null;

async function fill(el) {
  io?.unobserve(el);
  let src = await wikiThumb(el.dataset.wiki, el.dataset.wikiEn);
  // 위키 대표 사진이 없으면(예: '홍콩·마카오') 위키미디어 풍경 사진 첫 장
  if (!src && el.dataset.commons) src = (await commonsImages(el.dataset.commons, 1))[0]?.thumb;
  if (src) {
    el.style.backgroundImage = `url("${src}")`;
    el.classList.add("has-img");
  }
}

export function lazyWiki(root) {
  root.querySelectorAll("[data-wiki]:not(.has-img)").forEach((el) => (io ? io.observe(el) : fill(el)));
}
