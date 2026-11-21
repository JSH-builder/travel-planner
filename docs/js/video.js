/* 여행 기록 영상 자동 만들기 – 브라우저 안에서 (Canvas + MediaRecorder), 서버·비용 없음
 *
 * 구성: 제목 카드 → (날짜 카드 → 그날 사진·영상) × 날짜 → 마무리 카드
 * 사진은 천천히 확대(Ken Burns), 영상은 앞부분을 소리와 함께, 배경음악(선택)은 영상 구간에서 작게.
 * 실제 시간만큼 재생하며 녹화하므로 영상 길이만큼 걸린다. 그동안 화면을 켜 두어야 한다.
 */

const FPS = 30;

export function videoSupported() {
  return typeof MediaRecorder !== "undefined" && !!HTMLCanvasElement.prototype.captureStream;
}

function pickMime() {
  const list = ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return list.find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function loadVideo(src) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.playsInline = true;
    v.preload = "auto";
    v.oncanplay = () => resolve(v);
    v.onerror = () => resolve(null);
    v.src = src;
    setTimeout(() => resolve(v.readyState >= 2 ? v : null), 15000);
  });
}

/** 비율 유지하며 꽉 채우기 + 확대 */
function drawCover(ctx, src, W, H, zoom = 1) {
  const sw = src.videoWidth || src.naturalWidth || src.width;
  const sh = src.videoHeight || src.naturalHeight || src.height;
  if (!sw || !sh) return;
  const s = Math.max(W / sw, H / sh) * zoom;
  const w = sw * s, h = sh * s;
  ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
}

function wrapText(ctx, text, maxW) {
  const words = String(text).split(/(\s+)/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line + w;
    if (ctx.measureText(test).width > maxW && line.trim()) {
      lines.push(line.trim());
      line = w.trimStart();
    } else line = test;
  }
  if (line.trim()) lines.push(line.trim());
  // 한글은 띄어쓰기 없이 길 수 있어 글자 단위로도 자른다
  return lines.flatMap((l) => {
    if (ctx.measureText(l).width <= maxW) return [l];
    const out = [];
    let cur = "";
    for (const ch of l) {
      if (ctx.measureText(cur + ch).width > maxW) {
        out.push(cur);
        cur = ch;
      } else cur += ch;
    }
    return cur ? [...out, cur] : out;
  });
}

function textBlock(ctx, lines, x, y, lineH) {
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineH));
}

/**
 * @param o.trip {title, destination, dateText}
 * @param o.media [{src, kind, caption, dayLabel, dayKey}] 날짜순
 * @param o.dayTitles {dayKey: {label, title}}
 */
export async function makeTripVideo(o) {
  const { trip, media, dayTitles = {}, portrait = true, photoSec = 3, clipSec = 6, musicFile = null, maxItems = 40, onProgress } = o;
  if (!videoSupported()) throw new Error("이 브라우저는 영상 만들기를 지원하지 않아요. 크롬·사파리 최신 버전에서 해 주세요.");
  const W = portrait ? 720 : 1280, H = portrait ? 1280 : 720;
  const font = "'Pretendard Variable', Pretendard, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";
  await document.fonts?.ready;

  // 너무 많으면 고르게 골라 쓰기
  let list = media;
  if (list.length > maxItems) {
    const step = list.length / maxItems;
    list = Array.from({ length: maxItems }, (_, i) => list[Math.floor(i * step)]);
  }

  // 미리 불러오기
  onProgress?.(0, "사진·영상 불러오는 중");
  const loaded = [];
  for (const [i, m] of list.entries()) {
    const el = m.kind === "video" ? await loadVideo(m.src) : await loadImage(m.src);
    if (el) loaded.push({ ...m, el });
    onProgress?.(0.15 * ((i + 1) / list.length), "사진·영상 불러오는 중");
  }
  if (!loaded.length) throw new Error("영상에 넣을 사진·영상이 없어요. 앨범에 먼저 올려 주세요.");

  // 장면 목록
  const scenes = [{ type: "title", dur: 3 }];
  let lastDay = null;
  for (const m of loaded) {
    if (m.dayKey !== lastDay) {
      lastDay = m.dayKey;
      if (m.dayKey) scenes.push({ type: "day", dur: 1.8, day: dayTitles[m.dayKey] || { label: m.dayLabel } });
    }
    const dur = m.kind === "video" ? Math.min(clipSec, m.el.duration || clipSec) : photoSec;
    scenes.push({ type: m.kind, dur, m });
  }
  scenes.push({ type: "end", dur: 3 });
  const total = scenes.reduce((s, x) => s + x.dur, 0);

  // 캔버스·오디오·녹화 준비
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  await ac.resume();
  const dest = ac.createMediaStreamDestination();
  const musicGain = ac.createGain();
  musicGain.gain.value = 0.55;
  musicGain.connect(dest);
  if (musicFile) {
    try {
      const buf = await ac.decodeAudioData(await musicFile.arrayBuffer());
      const srcNode = ac.createBufferSource();
      srcNode.buffer = buf;
      srcNode.loop = true;
      srcNode.connect(musicGain);
      srcNode.start();
    } catch {
      console.warn("배경음악을 읽지 못했어요");
    }
  }
  const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, { mimeType: mimeType || undefined, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start(500);

  const cover = loaded.find((m) => m.kind === "photo")?.el || loaded[0].el;
  let doneSec = 0;

  const shade = (a) => {
    const g = ctx.createLinearGradient(0, H * 0.45, 0, H);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };

  function drawScene(sc, t) {
    const p = Math.min(1, t / sc.dur);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";

    if (sc.type === "title" || sc.type === "end") {
      ctx.filter = "blur(6px) brightness(0.55)";
      drawCover(ctx, cover, W, H, 1.1 + 0.05 * p);
      ctx.filter = "none";
      if (sc.type === "title") {
        ctx.font = `600 ${W * 0.04}px ${font}`;
        ctx.fillText(trip.dateText || "", W / 2, H * 0.4);
        ctx.font = `800 ${W * 0.075}px ${font}`;
        textBlock(ctx, wrapText(ctx, trip.title, W * 0.84), W / 2, H * 0.48, W * 0.09);
        ctx.font = `500 ${W * 0.045}px ${font}`;
        ctx.fillText(`📍 ${trip.destination || ""}`, W / 2, H * 0.62);
      } else {
        ctx.font = `800 ${W * 0.07}px ${font}`;
        ctx.fillText("함께해서 즐거웠어요", W / 2, H * 0.47);
        ctx.font = `500 ${W * 0.04}px ${font}`;
        ctx.fillText(`${trip.title}`, W / 2, H * 0.55);
      }
    } else if (sc.type === "day") {
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#ff4d2e";
      ctx.fillRect(W / 2 - W * 0.06, H * 0.38, W * 0.12, Math.max(4, W * 0.008));
      ctx.fillStyle = "#fff";
      ctx.font = `800 ${W * 0.09}px ${font}`;
      ctx.fillText(sc.day.label || "", W / 2, H * 0.47);
      if (sc.day.title) {
        ctx.font = `500 ${W * 0.045}px ${font}`;
        textBlock(ctx, wrapText(ctx, sc.day.title, W * 0.8), W / 2, H * 0.56, W * 0.06);
      }
    } else {
      const m = sc.m;
      drawCover(ctx, m.el, W, H, sc.type === "photo" ? 1 + 0.08 * p : 1);
      if (m.caption) {
        shade(0.65);
        ctx.font = `600 ${W * 0.045}px ${font}`;
        const lines = wrapText(ctx, m.caption, W * 0.86).slice(0, 3);
        textBlock(ctx, lines, W / 2, H - W * 0.12 - (lines.length - 1) * W * 0.06, W * 0.06);
      }
      if (m.dayLabel) {
        ctx.font = `600 ${W * 0.032}px ${font}`;
        ctx.textAlign = "left";
        ctx.fillStyle = "rgba(255,255,255,.9)";
        ctx.fillText(m.dayLabel, W * 0.05, W * 0.08);
      }
    }
    // 장면 앞뒤 페이드
    const fade = Math.min(1, t / 0.35, (sc.dur - t) / 0.35);
    if (fade < 1) {
      ctx.globalAlpha = 1 - Math.max(0, fade);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  for (const sc of scenes) {
    let clip = null;
    if (sc.type === "video") {
      clip = sc.m.el;
      clip.currentTime = 0;
      clip.muted = false;
      try {
        const node = clip._node || (clip._node = ac.createMediaElementSource(clip));
        node.connect(dest);
      } catch {}
      musicGain.gain.setTargetAtTime(0.18, ac.currentTime, 0.2);
      await clip.play().catch(() => {});
    }
    const start = performance.now();
    await new Promise((resolve) => {
      const frame = () => {
        const t = (performance.now() - start) / 1000;
        drawScene(sc, t);
        onProgress?.(0.15 + 0.85 * ((doneSec + Math.min(t, sc.dur)) / total), "영상 만드는 중");
        if (t >= sc.dur) return resolve();
        requestAnimationFrame(frame);
      };
      frame();
    });
    if (clip) {
      clip.pause();
      musicGain.gain.setTargetAtTime(0.55, ac.currentTime, 0.2);
    }
    doneSec += sc.dur;
  }

  rec.stop();
  await stopped;
  ac.close();
  const type = (mimeType || "video/webm").split(";")[0];
  return { blob: new Blob(chunks, { type }), ext: type.includes("mp4") ? "mp4" : "webm", seconds: Math.round(total) };
}
