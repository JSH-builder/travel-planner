/* 오프라인 모드: 마지막으로 받은 여행 데이터를 폰에 저장해 두고, 연결이 끊긴 동안의 변경은 모아 뒀다가 연결되면 보낸다.
 *
 * - 읽기: get_trip / list_trips 성공 결과를 저장 → 연결이 없으면 저장본으로 보여 줌
 * - 쓰기: 방문 체크·스팟 수정·지출·하루 기록·사진 설명은 오프라인에서도 가능 (화면에 바로 반영 + 대기열)
 *   새 스팟·새 지출도 가능 (임시 id로 만들었다가 올릴 때 진짜 id로 바꿈)
 * - 사진 올리기·AI 요청·삭제할 수 없는 작업은 연결이 필요하다고 알려 줌
 */

const KEY_TRIP = (id) => `off:trip:${id}`;
const KEY_LIST = "off:list";
const KEY_OUTBOX = "off:outbox";
const listeners = new Set();
let offline = false;

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // 저장 공간 부족 등 → 오프라인 저장만 포기
  }
}

// ---------- 연결 상태 ----------
export const isOffline = () => offline;
export const pendingCount = () => load(KEY_OUTBOX, []).length;
export function onNetChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function setOffline(v) {
  if (offline === v) return;
  offline = v;
  listeners.forEach((fn) => fn(v));
}
const notify = () => listeners.forEach((fn) => fn(offline));

// ---------- 읽기 저장본 ----------
export function remember(fn, params, data) {
  if (fn === "get_trip" && data) {
    // 아직 못 보낸 변경이 있으면 서버 값 위에 다시 얹어서 저장 (보낸 뒤에야 서버에 반영되므로)
    const out = load(KEY_OUTBOX, []).filter((o) => o.params.p_trip === params.p_trip);
    const copy = JSON.parse(JSON.stringify(data));
    out.forEach((o) => applyLocal(copy, o.fn, o.params, o.localId));
    save(KEY_TRIP(params.p_trip), copy);
    return copy;
  }
  if (fn === "list_trips" && data) save(KEY_LIST, data);
  return data;
}
export function cached(fn, params) {
  if (fn === "get_trip") return load(KEY_TRIP(params.p_trip), null);
  if (fn === "list_trips") return load(KEY_LIST, null);
  return undefined;
}

// ---------- 오프라인 쓰기 ----------
const QUEUEABLE = new Set(["set_done", "upsert_item", "upsert_expense", "delete_expense", "set_day", "update_media"]);
const isLocal = (id) => typeof id === "string" && id.startsWith("local-");
const newLocalId = () => `local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 대기열에 넣을 수 있는 쓰기인지 */
export function canQueue(fn, params) {
  if (!QUEUEABLE.has(fn) || !params?.p_trip) return false;
  if (fn === "upsert_item" && ("photos" in (params.p_item || {}) || "links" in (params.p_item || {}))) return false;
  return !!load(KEY_TRIP(params.p_trip), null); // 저장본이 있어야 화면에 반영 가능
}

/** 쓰기를 대기열에 넣고 저장본에 바로 반영. RPC가 돌려줄 값(새 id 등)을 반환 */
export function queue(fn, params) {
  const box = load(KEY_OUTBOX, []);
  const data = load(KEY_TRIP(params.p_trip), null);
  let result = null;
  let localId = null;
  const ref = fn === "upsert_item" ? params.p_item?.id : fn === "upsert_expense" ? params.p_exp?.id : null;

  if ((fn === "upsert_item" || fn === "upsert_expense") && !ref) {
    localId = newLocalId(); // 새 항목: 임시 id
    result = localId;
  } else if (isLocal(ref)) {
    // 아직 안 올라간 새 항목을 고침 → 만들기 요청에 합친다
    const create = box.find((o) => o.localId === ref);
    if (create) {
      const k = fn === "upsert_item" ? "p_item" : "p_exp";
      const { id, ...patch } = params[k];
      create.params[k] = { ...create.params[k], ...patch };
      applyLocal(data, fn, params);
      save(KEY_TRIP(params.p_trip), data);
      save(KEY_OUTBOX, box);
      notify();
      return ref;
    }
  } else if (fn === "delete_expense" && isLocal(params.p_exp)) {
    save(KEY_OUTBOX, box.filter((o) => o.localId !== params.p_exp));
    applyLocal(data, fn, params);
    save(KEY_TRIP(params.p_trip), data);
    notify();
    return null;
  } else if (fn === "upsert_item" || fn === "upsert_expense") {
    result = ref;
  }
  box.push({ fn, params: JSON.parse(JSON.stringify(params)), localId, at: Date.now() });
  applyLocal(data, fn, params, localId);
  save(KEY_TRIP(params.p_trip), data);
  save(KEY_OUTBOX, box);
  notify();
  return result;
}

/** 저장본(get_trip 결과)에 쓰기를 반영 */
function applyLocal(data, fn, p, localId) {
  if (!data) return;
  const now = new Date().toISOString();
  if (fn === "set_done") {
    const it = data.items.find((i) => i.id === p.p_item);
    if (it) Object.assign(it, { done: p.p_done, done_at: p.p_done ? now : null, done_by: p.p_done ? p.p_by || null : null });
  } else if (fn === "upsert_item") {
    const id = p.p_item.id || localId;
    let it = data.items.find((i) => i.id === id);
    if (!it) {
      it = { id, category: "place", name: "", area: null, day_date: null, time: null, note: null, price: null, reservation_needed: false,
        search_query: null, source_url: null, verified: false, origin: "user", done: false, done_at: null, done_by: null,
        sort: Date.now() / 1000, created_by: p.p_by || null, created_at: now, updated_at: now, thumb_path: null,
        links: [], photos: [], details: {}, enrich: null, enrich_error: null };
      data.items.push(it);
    }
    const { id: _, ...patch } = p.p_item;
    Object.assign(it, patch, { updated_at: now });
    if (it.day_date === "") it.day_date = null;
  } else if (fn === "upsert_expense") {
    const id = p.p_exp.id || localId;
    let e = data.expenses.find((x) => x.id === id);
    if (!e) {
      e = { id, title: "", amount: 0, category: null, day_date: null, by_name: p.p_by || null, created_at: now };
      data.expenses.push(e);
    }
    Object.assign(e, { title: p.p_exp.title, amount: Math.round(Number(p.p_exp.amount) || 0), category: p.p_exp.category || null,
      day_date: p.p_exp.day_date || null });
  } else if (fn === "delete_expense") {
    data.expenses = data.expenses.filter((x) => x.id !== p.p_exp);
  } else if (fn === "set_day") {
    let d = data.days.find((x) => x.day_date === p.p_date);
    if (!d) data.days.push((d = { day_date: p.p_date, title: null, diary: null }));
    Object.assign(d, p.p_patch);
  } else if (fn === "update_media") {
    const m = data.media.find((x) => x.id === p.p_media);
    if (m) m.caption = p.p_caption;
  }
}

// ---------- 연결되면 보내기 ----------
let flushing = null;

/** 대기열을 순서대로 보낸다. send(fn, params)는 실제 RPC. 남은 개수 반환 */
export function flush(send) {
  if (flushing) return flushing;
  flushing = (async () => {
    const ids = load("off:idmap", {}); // 임시 id → 진짜 id (앱을 다시 열어도 유지)
    let box = load(KEY_OUTBOX, []);
    while (box.length) {
      const o = box[0];
      let params = JSON.parse(JSON.stringify(o.params));
      let text = JSON.stringify(params);
      for (const [l, r] of Object.entries(ids)) text = text.replaceAll(l, r);
      params = JSON.parse(text);
      try {
        const res = await send(o.fn, params);
        if (o.localId && res) {
          ids[o.localId] = res;
          save("off:idmap", ids);
        }
      } catch (e) {
        if (e.offline) break; // 아직 연결 안 됨 → 다음에
        console.warn("오프라인 변경을 보내지 못해 버림:", o.fn, e.message); // 서버가 거부 (이미 지워진 항목 등)
      }
      box = load(KEY_OUTBOX, []);
      box.shift();
      // 뒤에 남은 요청 속 임시 id도 진짜 id로
      if (Object.keys(ids).length) {
        box = box.map((x) => {
          let t = JSON.stringify(x);
          for (const [l, r] of Object.entries(ids)) t = t.replaceAll(l, r);
          return JSON.parse(t);
        });
      }
      save(KEY_OUTBOX, box);
      notify();
    }
    flushing = null;
    return box.length;
  })();
  return flushing;
}

/** 오프라인용으로 여행 사진을 미리 받아 둔다 (서비스 워커 캐시). 받은 개수 반환 */
export async function prefetchImages(urls, onProgress) {
  let done = 0;
  const list = [...new Set(urls)].filter(Boolean);
  const worker = async () => {
    while (list.length) {
      const u = list.shift();
      try {
        await fetch(u, { mode: "no-cors", cache: "reload" });
      } catch {}
      onProgress?.(++done);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return done;
}
