/* 여행 기록 만들기: 블로그 글(AI) + 여행 영상(브라우저에서 자동 제작) */
import { fileUrl, rpc, uploadFile } from "./api.js";
import { tripApi } from "./trip.js";
import { askName } from "./ui.js";
import { $, dayLabel, esc, isSpot, linkify, phase, toast, tripDays } from "./util.js";
import { makeTripVideo, videoSupported } from "./video.js";

const OPENCUT_URL = "https://opencut.app";
let made = null; // 방금 만든 영상 {url, blob, ext, seconds}
let making = false;
export const isMaking = () => making;

export function renderRecord(T, { header }) {
  const t = T.data.trip;
  const blogBusy = ["queued", "generating"].includes(t.status) && t.job?.type === "blog";
  const visited = T.data.items.filter((i) => isSpot(i) && i.done).length;
  const diaries = T.data.days.filter((d) => (d.diary || "").trim()).length;
  const photos = T.data.media.length;
  const ph = phase(t);

  return `${header}
  <main class="tab-body">
    <section class="card">
      <h2 class="section-title">✍️ 블로그 글</h2>
      <p class="muted small">방문 체크 ${visited}곳 · 일기 ${diaries}일 · 사진·영상 ${photos}개를 바탕으로 AI가 후기 글을 써요.
        네이버·티스토리 등 어느 블로그든 붙여 넣을 수 있어요.</p>
      ${ph.kind !== "after" ? `<p class="hint">💡 여행이 끝난 뒤 만들면 기록이 더 풍부해요. 지금 만들어도 되고, 나중에 다시 쓸 수 있어요.</p>` : ""}
      ${blogBusy ? `<div class="banner"><div class="spinner sm"></div><div class="grow"><strong>블로그 글 쓰는 중</strong>
          <div class="small">${esc(t.progress || "소유자 PC의 작업기가 처리해요")}</div></div></div>`
        : t.blog ? blogActions() : `<button class="btn btn-primary btn-block" data-rec="blog-make" ${visited + diaries + photos === 0 ? "disabled" : ""}>✍️ 블로그 글 만들기</button>
          ${visited + diaries + photos === 0 ? `<p class="hint">방문 체크·일기·사진이 하나라도 있어야 만들 수 있어요.</p>` : ""}`}
    </section>
    ${t.blog ? blogPreview(T) : ""}

    <section class="card">
      <h2 class="section-title">🎬 여행 영상 만들기</h2>
      <p class="muted small">앨범의 사진·영상을 날짜순으로 이어 붙여 영상을 만들어요. 휴대폰 안에서 만들어져서 무료예요.</p>
      ${videoSupported() ? videoForm(T) : `<p class="hint">이 브라우저는 영상 만들기를 지원하지 않아요. 크롬·사파리 최신 버전으로 열어 주세요.</p>`}
      <div data-video-out>${made ? videoResult() : ""}</div>
    </section>
  </main>`;
}

// ---------- 블로그 ----------
function blogActions() {
  return `<div class="btn-col">
    <button class="btn btn-primary btn-block" data-rec="blog-copy-html">📋 사진 포함 복사 (블로그에 붙여넣기)</button>
    <button class="btn btn-block" data-rec="blog-copy-text">📝 글만 복사 ([사진 1] 표시 포함)</button>
    <button class="btn btn-block" data-rec="blog-zip">⬇️ 글에 쓴 사진·영상 한 번에 받기 (번호순)</button>
    <button class="btn btn-sm btn-ghost" data-rec="blog-make">🔄 다시 쓰기</button>
  </div>
  <p class="hint">붙여넣기 후 사진이 안 보이면, '한 번에 받기'로 받은 파일을 [사진 1] 자리에 순서대로 올리세요.</p>`;
}

/** 글에 들어간 사진·영상을 순서대로 번호 매기기 */
function blogMedia(T) {
  const byId = Object.fromEntries(T.data.media.map((m) => [m.id, m]));
  const order = [];
  for (const s of T.data.trip.blog.sections) for (const id of s.photo_ids) if (byId[id] && !order.includes(byId[id])) order.push(byId[id]);
  return order;
}

function blogPreview(T) {
  const b = T.data.trip.blog;
  const order = blogMedia(T);
  const num = (m) => order.indexOf(m) + 1;
  const byId = Object.fromEntries(T.data.media.map((m) => [m.id, m]));
  return `<article class="card blog" data-blog>
    <h1>${esc(b.title)}</h1>
    <p>${linkify(b.intro)}</p>
    ${b.sections.map((s) => `<h2>${esc(s.heading)}</h2>
      ${s.photo_ids.map((id) => byId[id]).filter(Boolean).map((m) => m.kind === "video"
        ? `<figure><video src="${esc(fileUrl(m.path))}" controls playsinline preload="metadata"></video><figcaption>[영상 ${num(m)}] ${esc(m.caption || "")}</figcaption></figure>`
        : `<figure><img src="${esc(fileUrl(m.path))}" alt="${esc(m.caption || "")}" loading="lazy"><figcaption>[사진 ${num(m)}] ${esc(m.caption || "")}</figcaption></figure>`).join("")}
      ${s.body.split(/\n+/).map((p) => `<p>${linkify(p)}</p>`).join("")}`).join("")}
    <p>${linkify(b.outro)}</p>
    <p class="tags">${b.tags.map((x) => `#${esc(x.replace(/\s+/g, ""))}`).join(" ")}</p>
    <p class="hint">AI 작성 · ${esc((b.generated_at || "").replace("T", " "))}</p>
  </article>`;
}

function blogText(T) {
  const b = T.data.trip.blog;
  const order = blogMedia(T);
  const byId = Object.fromEntries(T.data.media.map((m) => [m.id, m]));
  const marks = (s) => s.photo_ids.map((id) => byId[id]).filter(Boolean)
    .map((m) => `[${m.kind === "video" ? "영상" : "사진"} ${order.indexOf(m) + 1}]`).join(" ");
  return [b.title, "", b.intro, "", ...b.sections.flatMap((s) => [`■ ${s.heading}`, marks(s), s.body, ""]), b.outro, "",
    b.tags.map((x) => `#${x.replace(/\s+/g, "")}`).join(" ")].filter((x) => x !== undefined).join("\n");
}

async function copyHtml(T) {
  const el = $("[data-blog]");
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".hint").forEach((n) => n.remove());
  clone.querySelectorAll("video").forEach((v) => v.replaceWith(Object.assign(document.createElement("p"), { textContent: `🎬 ${v.nextElementSibling?.textContent || "영상"}` })));
  const html = clone.innerHTML;
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([blogText(T)], { type: "text/plain" }),
    })]);
  } catch {
    // 옛 브라우저: 선택 영역 복사
    const box = Object.assign(document.createElement("div"), { innerHTML: html, contentEditable: "true" });
    box.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(box);
    const r = document.createRange();
    r.selectNodeContents(box);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    document.execCommand("copy");
    box.remove();
  }
  toast("복사했어요. 블로그 글쓰기 화면에 붙여 넣으세요");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("도구를 불러오지 못했어요"));
    document.head.appendChild(s);
  });
}

async function downloadZip(T) {
  const order = blogMedia(T);
  if (!order.length) return toast("글에 들어간 사진이 없어요");
  if (!window.JSZip) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  const zip = new window.JSZip();
  for (const [i, m] of order.entries()) {
    toast(`사진 모으는 중 ${i + 1}/${order.length}`);
    const blob = await (await fetch(fileUrl(m.path))).blob();
    const ext = m.path.split(".").pop();
    zip.file(`${String(i + 1).padStart(2, "0")}_${m.kind === "video" ? "영상" : "사진"}${i + 1}.${ext}`, blob);
  }
  zip.file("블로그글.txt", blogText(T));
  const out = await zip.generateAsync({ type: "blob" });
  saveBlob(out, `${T.data.trip.title}_블로그.zip`);
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[\\/:*?"<>|]/g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- 영상 ----------
function videoForm(T) {
  const n = T.data.media.length;
  return `<form class="stack" data-video-form>
    <div class="field"><label>화면 비율</label><div class="seg">
      <label><input type="radio" name="ratio" value="portrait" checked><span>📱 세로 9:16</span></label>
      <label><input type="radio" name="ratio" value="landscape"><span>🖥️ 가로 16:9</span></label></div></div>
    <div class="grid2">
      <div class="field"><label>사진 한 장</label><select class="input" name="photoSec"><option value="2">2초</option><option value="3" selected>3초</option><option value="4">4초</option></select></div>
      <div class="field"><label>영상 클립 최대</label><select class="input" name="clipSec"><option value="3">3초</option><option value="6" selected>6초</option><option value="10">10초</option></select></div>
    </div>
    <div class="field"><label>배경음악 (선택, 내 폰의 음악 파일)</label><input class="input" type="file" name="music" accept="audio/*"></div>
    <button class="btn btn-primary btn-block" type="submit" ${n ? "" : "disabled"}>🎬 영상 만들기 (${n}개 사용, 최대 40개)</button>
    ${n ? `<p class="hint">만드는 동안 이 화면을 켜 두세요. 영상 길이만큼 시간이 걸려요.</p>` : `<p class="hint">앨범에 사진·영상을 먼저 올려 주세요.</p>`}
    <div class="progress" data-video-progress hidden><div class="bar lg"><span></span></div><small class="muted"></small></div>
  </form>`;
}

function videoResult() {
  return `<div class="stack video-result">
    <video src="${made.url}" controls playsinline></video>
    <p class="small muted">${made.seconds}초 · ${(made.blob.size / 1048576).toFixed(1)}MB · ${made.ext.toUpperCase()}</p>
    <button class="btn btn-primary btn-block" data-rec="video-save">⬇️ 내 폰에 저장</button>
    <button class="btn btn-block" data-rec="video-album" ${made.blob.size > 50 * 1048576 ? "disabled" : ""}>🖼️ 앨범에도 올리기${made.blob.size > 50 * 1048576 ? " (50MB 초과)" : ""}</button>
    <a class="btn btn-block" href="${OPENCUT_URL}" target="_blank" rel="noopener">✂️ OpenCut에서 더 편집하기</a>
    <p class="hint">OpenCut은 무료 웹 영상 편집기예요. 먼저 '내 폰에 저장'한 뒤, OpenCut에서 그 파일을 불러와 자막·음악·컷 편집을 하세요.</p>
  </div>`;
}

async function buildVideo(form) {
  if (making) return;
  const T = { data: tripApi.data() };
  const t = T.data.trip;
  const days = tripDays(t);
  const items = Object.fromEntries(T.data.items.map((i) => [i.id, i]));
  const media = [...T.data.media]
    .sort((a, b) => (a.day_date || "9").localeCompare(b.day_date || "9") || a.created_at.localeCompare(b.created_at))
    .map((m) => ({
      src: fileUrl(m.path), kind: m.kind, dayKey: m.day_date || "",
      dayLabel: m.day_date ? `Day ${days.indexOf(m.day_date) + 1} · ${dayLabel(m.day_date)}` : "",
      caption: m.caption || items[m.item_id]?.name || "",
    }));
  const dayTitles = Object.fromEntries(days.map((d, i) => [d, { label: `Day ${i + 1} · ${dayLabel(d)}`, title: T.data.days.find((x) => x.day_date === d)?.title || "" }]));
  const prog = $("[data-video-progress]", form);
  prog.hidden = false;
  making = true;
  form.querySelector("button[type=submit]").disabled = true;
  try {
    const out = await makeTripVideo({
      trip: { title: t.title, destination: t.destination, dateText: t.start_date ? `${t.start_date.replaceAll("-", ".")} – ${(t.end_date || "").slice(5).replace("-", ".")}` : "" },
      media, dayTitles,
      portrait: form.ratio.value === "portrait",
      photoSec: Number(form.photoSec.value), clipSec: Number(form.clipSec.value),
      musicFile: form.music.files[0] || null,
      onProgress: (p, label) => {
        $("span", prog).style.width = `${Math.round(p * 100)}%`;
        $("small", prog).textContent = `${label} ${Math.round(p * 100)}%`;
      },
    });
    if (made) URL.revokeObjectURL(made.url);
    made = { ...out, url: URL.createObjectURL(out.blob) };
    $("[data-video-out]").innerHTML = videoResult();
    toast("영상이 완성됐어요!");
  } catch (e) {
    toast(e.message);
  } finally {
    making = false;
    prog.hidden = true;
    const btn = form.querySelector("button[type=submit]");
    if (btn) btn.disabled = false;
  }
}

// ---------- 이벤트 ----------
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-rec]");
  if (!el || !tripApi.data()) return;
  const T = { data: tripApi.data() };
  switch (el.dataset.rec) {
    case "blog-make":
      if (T.data.trip.blog && !confirm("블로그 글을 새로 쓸까요? 지금 글은 바뀌어요.")) return;
      try {
        await rpc("request_job", { p_trip: tripApi.id(), p_type: "blog", p_params: {} });
        toast("블로그 글을 요청했어요");
        await tripApi.reload();
      } catch (err) {
        toast(err.message);
      }
      return;
    case "blog-copy-html": return copyHtml(T);
    case "blog-copy-text":
      try {
        await navigator.clipboard.writeText(blogText(T));
        toast("글을 복사했어요");
      } catch {
        toast("복사하지 못했어요. 글을 길게 눌러 직접 복사해 주세요");
      }
      return;
    case "blog-zip":
      try {
        await downloadZip(T);
      } catch (err) {
        toast(err.message);
      }
      return;
    case "video-save": return made && saveBlob(made.blob, `${T.data.trip.title}_여행영상.${made.ext}`);
    case "video-album": {
      if (!made) return;
      el.disabled = true;
      try {
        const file = new File([made.blob], `trip.${made.ext}`, { type: made.blob.type });
        const { path } = await uploadFile(tripApi.id(), file, (p) => toast(`올리는 중 ${Math.round(p * 100)}%`));
        await rpc("add_media", { p_trip: tripApi.id(), p_item: null, p_kind: "video", p_path: path, p_caption: "🎬 여행 영상", p_by: await askName(), p_day: null });
        toast("앨범에 올렸어요");
      } catch (err) {
        toast(err.message);
        el.disabled = false;
      }
      return;
    }
  }
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-video-form]");
  if (!form) return;
  e.preventDefault();
  buildVideo(form);
});
