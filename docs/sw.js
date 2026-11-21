/* 홈 화면 설치용 최소 서비스 워커.
 * 화면 파일을 따로 저장(캐시)하지 않고 항상 인터넷에서 최신 버전을 받는다 → 업데이트가 바로 반영됨. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
