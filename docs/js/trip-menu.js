/* 여행 정보 수정·예약 원문·메뉴 */
import { deleteFiles, fileUrl, ownerKey, ownerRpc, rpc, uploadFile } from "./api.js?v=2611221119";
import { icon } from "./icons.js?v=2611221119";
import { isMaking, renderRecord } from "./record.js?v=2611221119";
import { askName, closeSheet, isInstalled, openInstallGuide, openSheet, openViewer, openYouTube, sheetIsOpen } from "./ui.js?v=2611221119";
import {
  $, $$, CATS, SPOT_KEYS, dateRange, dayLabel, debounce, esc, imageSearchUrl, isSpot, linkify, mapsUrl, md, pad2, phase,
  routeUrl, safeUrl, spotQuery, stamp, store, timeAgo, toast, todayISO, tripDays, wdEn, won, ytSearchUrl,
} from "./util.js?v=2611221119";
import { commonsImages, lazyWiki, wikiThumb } from "./wiki.js?v=2611221119";
import { T, reload } from "./trip.js?v=2611221119";
import { act, closed, isOwner, trip } from "./trip-shared.js?v=2611221119";

// ---------- 여행 정보·메뉴 ----------
export function openEditTrip() {
  const t = trip();
  const s = openSheet(`
    <p class="eyebrow">TRIP</p><h2 class="sheet-title">여행 정보</h2>
    <form class="stack" data-trip-edit>
      <input class="input input-lg" name="title" value="${esc(t.title)}" maxlength="120" required aria-label="여행 이름">
      <div class="field"><label>목적지</label><input class="input" name="destination" value="${esc(t.destination || "")}" maxlength="120"></div>
      <div class="grid2">
        <div class="field"><label>출발</label><input class="input" type="date" name="start_date" value="${t.start_date || ""}"></div>
        <div class="field"><label>도착</label><input class="input" type="date" name="end_date" value="${t.end_date || ""}"></div>
      </div>
      <div class="field"><label>함께 가는 사람</label><input class="input" name="companions" value="${esc(t.companions || "")}" maxlength="200"></div>
      <button class="btn btn-ink btn-block" type="submit">저장</button>
    </form>`, { onClose: closed });
  $("[data-trip-edit]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await rpc("update_trip", { p_trip: T.id, p_patch: Object.fromEntries(new FormData(e.target)) });
      s.close();
      toast("저장했어요");
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

export function openBookings() {
  const s = openSheet(`<p class="eyebrow">BOOKED</p><h2 class="sheet-title">확정 예약</h2>
    <p class="muted">항공편·숙소·공연 예약을 원문 그대로 적어 두세요. AI가 바꾸지 않아요.</p>
    <form class="stack" data-book><textarea class="input mono" name="b" rows="8" maxlength="4000"
      placeholder="KE723 04/02 09:00 ICN→KIX (예약번호 ABC123)&#10;난바 OO호텔 3박">${esc(trip().bookings || "")}</textarea>
      <button class="btn btn-ink btn-block" type="submit">저장</button></form>`, { onClose: closed });
  $("[data-book]", s.el).addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await rpc("update_trip", { p_trip: T.id, p_patch: { bookings: e.target.b.value.trim() } });
      s.close();
      await reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

export const shareLink = () => `${location.origin}${location.pathname}#/trip/${T.id}`;

export function openMenu() {
  openSheet(`<p class="eyebrow">MENU</p><h2 class="sheet-title">${esc(trip().title)}</h2>
    <div class="menu-list">
      <button data-act="share">${icon("share", 20)}<span>공유 링크 복사<small>함께 갈 사람에게 이 링크만 보내세요</small></span></button>
      <button data-act="edit-trip">${icon("pencil", 20)}<span>여행 정보 고치기</span></button>
      <button data-act="voucher-box">${icon("ticket", 20)}<span>예약·바우처<small>항공권·숙소 메일·입장권·QR → 일정·지출에 자동</small></span></button>
      <button data-act="yt-import">${icon("play", 20)}<span>유튜브에서 본 곳 담기<small>영상 요약 + 나온 장소를 스팟으로</small></span></button>
      <button data-act="cover-pick">${icon("image", 20)}<span>표지 사진 고르기<small>내 여행 목록의 썸네일</small></span></button>
      <button data-tab="record">${icon("film", 20)}<span>여행 기록 만들기<small>블로그 글 · 여행 영상</small></span></button>
      <button data-act="offline-save">${icon("download", 20)}<span>오프라인용으로 저장<small>출발 전 와이파이에서 한 번: 데이터가 없어도 일정·사진이 보여요</small></span></button>
      ${isInstalled() ? "" : `<button data-act="install">${icon("plus", 20)}<span>홈 화면에 앱으로 추가<small>주소창 없이 앱처럼 열려요</small></span></button>`}
      <button data-act="export">${icon("download", 20)}<span>백업 내보내기 (JSON)</span></button>
      <button data-act="print">${icon("printer", 20)}<span>인쇄 / PDF</span></button>
      ${isOwner() ? `<button class="danger" data-act="delete-trip">${icon("trash", 20)}<span>여행 삭제</span></button>`
        : `<a href="#/login">${icon("key", 20)}<span>소유자 로그인</span></a>`}
    </div>`, { onClose: closed });
}
