/* Supabase 연결: RPC 호출, 사진·영상 업로드 */
import { store } from "./util.js";

export const CFG = window.TRAVEL_CONFIG || {};
export const MAX_VIDEO_MB = 50; // Supabase 무료 플랜 파일 1개 최대 크기

function headers(extra = {}) {
  const h = { apikey: CFG.key, ...extra };
  if (!String(CFG.key).startsWith("sb_")) h.Authorization = `Bearer ${CFG.key}`;
  return h;
}

export async function rpc(fn, params = {}) {
  const res = await fetch(`${CFG.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new Error(data?.message || res.statusText || "요청 실패");
  return data;
}

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
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
};

/** 사진은 줄여서, 영상은 그대로 올린다. {path, kind} 반환. onProgress(0~1) */
export async function uploadFile(tripId, file, onProgress) {
  const isVideo = file.type.startsWith("video/");
  if (isVideo && file.size > MAX_VIDEO_MB * 1024 * 1024) {
    throw new Error(`영상은 ${MAX_VIDEO_MB}MB 이하만 올릴 수 있어요 (무료 저장 공간 한도). 짧게 잘라서 올려 주세요.`);
  }
  const blob = isVideo ? file : await compressImage(file);
  const type = blob.type || file.type;
  const ext = EXT[type];
  if (!ext) throw new Error("지원하지 않는 형식이에요 (사진: JPG·PNG·WEBP·GIF / 영상: MP4·MOV·WEBM)");
  const path = `${tripId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

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
  return { path, kind: isVideo ? "video" : "photo" };
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
