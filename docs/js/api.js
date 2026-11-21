/* Supabase 연결: RPC 호출, 사진·영상 업로드 */
import * as off from "./offline.js?v=2611220405";
import { store } from "./util.js?v=2611220405";

export const CFG = window.TRAVEL_CONFIG || {};
export const MAX_VIDEO_MB = 50; // Supabase 무료 플랜 파일 1개 최대 크기

function headers(extra = {}) {
  const h = { apikey: CFG.key, ...extra };
  if (!String(CFG.key).startsWith("sb_")) h.Authorization = `Bearer ${CFG.key}`;
  return h;
}

/** 실제 요청. 연결 문제면 e.offline = true (빨리 연결이 끊긴 경우) / e.slow = true (응답이 너무 늦음) */
async function send(fn, params) {
  if (navigator.onLine === false) throw Object.assign(new Error("오프라인이에요"), { offline: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
  } catch (e) {
    const slow = e.name === "AbortError";
    throw Object.assign(new Error(slow ? "연결이 너무 느려요. 잠시 후 다시 시도해 주세요" : "오프라인이에요"), { offline: !slow, slow });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new Error(data?.message || res.statusText || "요청 실패");
  return data;
}

/** Supabase 함수 호출. 연결이 없으면 저장본을 보여 주고, 가능한 변경은 모아 뒀다가 연결되면 보낸다 (offline.js) */
export async function rpc(fn, params = {}) {
  if (fn === "get_trip" && off.pendingCount()) {
    const left = await off.flush(send);
    if (left) {
      off.setOffline(true);
      return off.cached(fn, params);
    }
  }
  try {
    const data = await send(fn, params);
    off.setOffline(false);
    return off.remember(fn, params, data);
  } catch (e) {
    if (!e.offline && !e.slow) throw e;
    const saved = off.cached(fn, params);
    if (saved !== undefined && saved !== null) {
      off.setOffline(true);
      return saved;
    }
    if (e.offline && off.canQueue(fn, params)) {
      off.setOffline(true);
      return off.queue(fn, params);
    }
    if (e.offline) off.setOffline(true);
    throw e.offline ? new Error("오프라인이라 지금은 할 수 없어요. 연결되면 다시 시도해 주세요") : e;
  }
}

/** 연결이 돌아오면 모아 둔 변경을 보낸다 */
export const flushOutbox = () => off.flush(send).then((left) => {
  if (!left) off.setOffline(false);
  return left;
});

export const ownerKey = () => store("ownerKey");
export const ownerRpc = (fn, params = {}) => rpc(fn, { p_owner_key: ownerKey(), ...params });

export const fileUrl = (path) =>
  path ? `${CFG.url}/storage/v1/object/public/photos/${path.split("/").map(encodeURIComponent).join("/")}` : "";

async function compressImage(file, max = 1800, quality = 0.84) {
  if (file.type === "image/gif") return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), "image/jpeg", quality));
}

const EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "application/pdf": "pdf",
};

/** 사진은 줄여서, 영상은 그대로 올린다. {path, kind} 반환. onProgress(0~1) */
export async function uploadFile(tripId, file, onProgress, { folder = "", max = 1800, quality = 0.84 } = {}) {
  const isVideo = file.type.startsWith("video/");
  const isPdf = file.type === "application/pdf";
  if (isVideo && file.size > MAX_VIDEO_MB * 1024 * 1024) {
    throw new Error(`영상은 ${MAX_VIDEO_MB}MB 이하만 올릴 수 있어요 (무료 저장 공간 한도). 짧게 잘라서 올려 주세요.`);
  }
  const blob = isVideo || isPdf ? file : await compressImage(file, max, quality);
  const type = blob.type || file.type;
  const ext = EXT[type];
  if (!ext) throw new Error("지원하지 않는 형식이에요 (사진: JPG·PNG·WEBP·GIF / 영상: MP4·MOV·WEBM / 문서: PDF)");
  const path = `${tripId}/${folder ? `${folder}/` : ""}${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${CFG.url}/storage/v1/object/photos/${path}`);
    Object.entries(headers({ "Content-Type": type })).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      let msg = "업로드 실패";
      try {
        msg = JSON.parse(xhr.responseText).message || msg;
      } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("네트워크 오류로 업로드하지 못했어요"));
    xhr.send(blob);
  });
  return { path, kind: isVideo ? "video" : isPdf ? "pdf" : "photo", mime: type };
}

export async function deleteFiles(paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  await fetch(`${CFG.url}/storage/v1/object/photos`, {
    method: "DELETE",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: list }),
  }).catch(() => {});
}
