/* 서비스 워커: 홈 화면 앱 + 오프라인 모드.
 *
 * - 화면 파일(HTML·CSS·JS·아이콘): 인터넷 먼저 → 실패하거나 4초 넘게 걸리면 저장본. 업데이트는 그대로 바로 반영됨
 * - 사진(내 저장소·위키미디어)·글꼴: 저장본 먼저 → 없으면 받아서 저장 (본 사진은 오프라인에서도 보임)
 * - 여행 데이터(Supabase 함수 호출)는 POST라 여기서 다루지 않고 js/offline.js가 저장한다
 */
const SHELL = "shell-v1";
const MEDIA = "media-v1";
const MEDIA_MAX = 800; // 사진 저장 최대 개수 (넘으면 오래된 것부터 지움)

const CORE = [
  "./", "index.html", "app.css", "config.js", "manifest.webmanifest",
  "icons/favicon.svg", "icons/favicon-32.png", "icons/icon-192.png", "icons/apple-touch-icon.png",
  ...["main", "api", "offline", "util", "icons", "ui", "wiki", "record", "video", "trip", "trip-shared", "trip-overview",
    "trip-schedule", "trip-spots", "trip-album", "trip-money", "trip-prep", "trip-menu", "trip-plan", "geo", "trip-youtube"].map((n) => `js/${n}.js`),
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.all(CORE.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, MEDIA].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isMedia = (url) =>
  url.pathname.includes("/storage/v1/object/public/") || url.hostname.endsWith("wikimedia.org") || url.hostname.endsWith("wikipedia.org");
const isFont = (url) => url.hostname === "cdn.jsdelivr.net" || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com");

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) return e.respondWith(networkFirst(req));
  if (isMedia(url) && !url.pathname.includes("/w/api.php")) return e.respondWith(cacheFirst(req, MEDIA, true));
  if (isFont(url)) return e.respondWith(cacheFirst(req, SHELL, false));
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  // no-cache: 매번 서버에 '바뀌었나' 확인 (안 바뀌었으면 304로 가볍게). 배포 직후 새·옛 파일이 섞이지 않게
  // (페이지 이동 요청은 옵션을 붙여 다시 만들 수 없어서 주소로 새로 요청)
  const fresh = req.mode === "navigate" ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" }) : fetch(req, { cache: "no-cache" });
  const fromNet = fresh.then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  fromNet.catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
  try {
    const res = await Promise.race([fromNet, timeout.then(() => null)]);
    if (res) return res;
  } catch {}
  const hit = (await cache.match(req, { ignoreSearch: true })) ||
    (req.mode === "navigate" ? await cache.match("index.html") : null);
  if (hit) return hit;
  return fromNet; // 저장본도 없으면 끝까지 기다림
}

async function cacheFirst(req, name, trim) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === "opaque") {
      await cache.put(req, res.clone());
      if (trim) trimCache(cache);
    }
    return res;
  } catch (err) {
    return new Response("", { status: 504, statusText: "offline" });
  }
}

let trimming = false;
async function trimCache(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - MEDIA_MAX))) await cache.delete(k);
  } finally {
    trimming = false;
  }
}
