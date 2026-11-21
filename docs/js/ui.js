/* 화면 부품: 바텀시트, 사진·영상 뷰어, 유튜브 플레이어, 이름 묻기 */
import { $, esc, store } from "./util.js";

let current = null; // 열린 시트 {el, close}

export const sheetIsOpen = () => !!current;

/** 아래에서 올라오는 시트. 닫힐 때 onClose 호출 */
export function openSheet(html, { onClose, wide = false } = {}) {
  current?.close(true);
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap";
  wrap.innerHTML = `<div class="sheet-backdrop" data-close></div>
    <section class="sheet ${wide ? "sheet-wide" : ""}" role="dialog" aria-modal="true">
      <div class="sheet-handle" aria-hidden="true"></div>
      <button class="icon-btn sheet-x" type="button" data-close aria-label="닫기">✕</button>
      <div class="sheet-body">${html}</div>
    </section>`;
  document.body.appendChild(wrap);
  document.body.classList.add("no-scroll");
  requestAnimationFrame(() => wrap.classList.add("open"));

  const sheet = { el: $(".sheet-body", wrap), root: wrap, close };
  function close(silent = false) {
    if (current !== sheet) return;
    current = null;
    wrap.classList.remove("open");
    document.body.classList.remove("no-scroll");
    setTimeout(() => wrap.remove(), 220);
    document.removeEventListener("keydown", onKey);
    if (!silent) onClose?.();
  }
  const onKey = (e) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (e) => e.target.closest("[data-close]") && close());

  // 핸들을 아래로 끌어서 닫기
  const handle = $(".sheet-handle", wrap);
  const panel = $(".sheet", wrap);
  let startY = null;
  handle.addEventListener("pointerdown", (e) => {
    startY = e.clientY;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (startY === null) return;
    panel.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
  });
  handle.addEventListener("pointerup", (e) => {
    const dy = e.clientY - (startY ?? e.clientY);
    startY = null;
    panel.style.transform = "";
    if (dy > 90) close();
  });

  current = sheet;
  return sheet;
}

export function closeSheet() {
  current?.close();
}

/** 이름(닉네임) – 처음 한 번만 묻고 기억 */
export function askName() {
  const saved = store("myName");
  if (saved) return Promise.resolve(saved);
  return new Promise((resolve) => {
    const s = openSheet(`
      <h2 class="sheet-title">이름을 알려 주세요</h2>
      <p class="muted">함께 쓰는 사람들에게 누가 체크하고 올렸는지 보여 줄 때 써요.</p>
      <form class="stack" data-name-form>
        <input class="input" name="n" maxlength="20" placeholder="예: 성희" autocomplete="nickname" required>
        <button class="btn btn-primary btn-block" type="submit">확인</button>
      </form>`, { onClose: () => resolve(store("myName") || "익명") });
    const form = $("[data-name-form]", s.el);
    setTimeout(() => form.n.focus(), 250);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      store("myName", form.n.value.trim().slice(0, 20) || "익명");
      s.close();
    });
  });
}

/** 유튜브 영상 재생 (개인정보 보호 모드 도메인) */
export function openYouTube(video) {
  openSheet(`
    <h2 class="sheet-title">${esc(video.title || "추천 영상")}</h2>
    <div class="yt-frame"><iframe src="https://www.youtube-nocookie.com/embed/${esc(video.id)}?autoplay=1&rel=0&playsinline=1"
      title="${esc(video.title || "YouTube")}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>
    ${video.author ? `<p class="muted small">${esc(video.author)}</p>` : ""}
    ${video.why ? `<p>${esc(video.why)}</p>` : ""}
    <a class="btn btn-block" href="https://www.youtube.com/watch?v=${esc(video.id)}" target="_blank" rel="noopener">YouTube 앱에서 열기</a>`, { wide: true });
}

/**
 * 전체 화면 사진·영상 뷰어
 * items: [{src, kind, caption, meta}], actions: {onCaption(i, text), onDelete(i), onCover(i)}
 */
export function openViewer(items, index, actions = {}) {
  const wrap = document.createElement("div");
  wrap.className = "viewer";
  wrap.innerHTML = `
    <div class="viewer-top">
      <span class="viewer-count"></span>
      <button class="icon-btn light" data-v="close" aria-label="닫기">✕</button>
    </div>
    <div class="viewer-stage"></div>
    <button class="viewer-nav prev" data-v="prev" aria-label="이전">‹</button>
    <button class="viewer-nav next" data-v="next" aria-label="다음">›</button>
    <div class="viewer-bottom">
      <div class="viewer-meta small"></div>
      <input class="input viewer-caption" maxlength="500" placeholder="설명 쓰기 (자동 저장)">
      <div class="viewer-actions">
        ${actions.onCover ? `<button class="btn btn-sm light" data-v="cover">대표 사진으로</button>` : ""}
        <a class="btn btn-sm light" data-v="download" download>저장</a>
        ${actions.onDelete ? `<button class="btn btn-sm light danger" data-v="delete">삭제</button>` : ""}
      </div>
    </div>`;
  document.body.appendChild(wrap);
  document.body.classList.add("no-scroll");
  const stage = $(".viewer-stage", wrap);
  const cap = $(".viewer-caption", wrap);
  let i = index;
  let capTimer;

  function show() {
    const it = items[i];
    stage.innerHTML = it.kind === "video"
      ? `<video src="${esc(it.src)}" controls playsinline autoplay></video>`
      : `<img src="${esc(it.src)}" alt="${esc(it.caption || "")}">`;
    $(".viewer-count", wrap).textContent = `${i + 1} / ${items.length}`;
    $(".viewer-meta", wrap).textContent = it.meta || "";
    cap.value = it.caption || "";
    cap.hidden = !actions.onCaption;
    $('[data-v="download"]', wrap).href = it.src;
    $('[data-v="prev"]', wrap).hidden = i === 0;
    $('[data-v="next"]', wrap).hidden = i === items.length - 1;
  }
  function close() {
    wrap.remove();
    document.body.classList.remove("no-scroll");
    document.removeEventListener("keydown", onKey);
    actions.onClose?.();
  }
  const go = (d) => {
    i = Math.max(0, Math.min(items.length - 1, i + d));
    show();
  };
  const onKey = (e) => {
    if (e.target === cap) return;
    if (e.key === "Escape") close();
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "ArrowRight") go(1);
  };
  document.addEventListener("keydown", onKey);
  cap.addEventListener("input", () => {
    clearTimeout(capTimer);
    const at = i;
    capTimer = setTimeout(() => {
      items[at].caption = cap.value;
      actions.onCaption?.(at, cap.value);
    }, 700);
  });
  wrap.addEventListener("click", async (e) => {
    const v = e.target.closest("[data-v]")?.dataset.v;
    if (v === "close") close();
    if (v === "prev") go(-1);
    if (v === "next") go(1);
    if (v === "cover") actions.onCover(i);
    if (v === "delete" && confirm("이 사진·영상을 삭제할까요?")) {
      await actions.onDelete(i);
      items.splice(i, 1);
      if (!items.length) return close();
      i = Math.min(i, items.length - 1);
      show();
    }
  });
  // 좌우 스와이프
  let sx = null;
  stage.addEventListener("touchstart", (e) => (sx = e.touches[0].clientX), { passive: true });
  stage.addEventListener("touchend", (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    sx = null;
  });
  show();
}
