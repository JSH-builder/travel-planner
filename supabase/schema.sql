-- =====================================================================
-- 여행 계획 앱 DB (v2)
-- Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run.
-- 여러 번 실행해도 안전합니다. v1에서 올려도 기존 여행은 유지됩니다.
--
-- 보안 구조
--  * 테이블은 RLS로 잠그고 직접 접근을 막는다. 모든 접근은 아래 함수(RPC)로만.
--  * 여행 id(UUID, 추측 불가)를 아는 사람 = 공유 링크를 받은 사람 → 보기·편집·방문 체크·사진/영상·지출·AI 요청
--  * 여행 만들기·삭제·목록·AI 작업 처리는 소유자 키(owner key)가 있어야 가능
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 테이블 ----------
create table if not exists public.trips (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  input         jsonb not null default '{}'::jsonb,
  status        text not null default 'done' check (status in ('queued', 'generating', 'done', 'error')),
  error         text,
  plan          jsonb,                       -- v1 데이터 (옮기기 전까지만 사용)
  revision_note text,
  requested_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.trips add column if not exists budget      jsonb not null default '{}'::jsonb;  -- {total, currency, rate}
alter table public.trips add column if not exists bookings    text;                               -- 확정 예약 원문
alter table public.trips add column if not exists progress    text;                               -- AI 진행 상황
alter table public.trips add column if not exists destination text;
alter table public.trips add column if not exists start_date  date;
alter table public.trips add column if not exists end_date    date;
alter table public.trips add column if not exists companions  text;
alter table public.trips add column if not exists cover_path  text;
alter table public.trips add column if not exists summary     jsonb not null default '{}'::jsonb;  -- AI 개요 (주의사항·기본정보·추천영상 등)
alter table public.trips add column if not exists job         jsonb;                               -- 대기/진행 중인 AI 작업 {type, params}
alter table public.trips add column if not exists blog        jsonb;                               -- AI가 쓴 블로그 글

-- v1 → v2: input 안에 있던 기본 정보를 컬럼으로
update public.trips set
  destination = coalesce(destination, input->>'destination'),
  start_date  = coalesce(start_date, nullif(input->>'start_date', '')::date),
  end_date    = coalesce(end_date, nullif(input->>'end_date', '')::date),
  companions  = coalesce(companions, input->>'companions')
where destination is null and input ? 'destination';

create table if not exists public.items (
  id                 uuid primary key default gen_random_uuid(),
  trip_id            uuid not null references public.trips on delete cascade,
  category           text not null check (category in
                       ('photo', 'food', 'cafe', 'place', 'landmark', 'activity', 'schedule', 'todo', 'packing')),
  name               text not null,
  area               text,
  day_date           date,
  time               text,
  note               text,
  price              text,
  reservation_needed boolean not null default false,
  search_query       text,
  source_url         text,
  verified           boolean not null default false,
  origin             text not null default 'user' check (origin in ('ai', 'user')),
  done               boolean not null default false,   -- 스팟: 방문함 / 할 일·준비물: 완료
  done_at            timestamptz,
  done_by            text,
  sort               double precision not null default extract(epoch from now()),
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists items_trip_idx on public.items (trip_id, category);
alter table public.items add column if not exists thumb_path text;  -- 스팟 카드 대표 사진 (직접 고름)
-- 사진·정보 모으기 (작업기가 링크·웹에서 모아 정리)
alter table public.items add column if not exists links   jsonb not null default '[]'::jsonb;  -- 직접 찾은 링크 [{url}]
alter table public.items add column if not exists photos  jsonb not null default '[]'::jsonb;  -- 모아 온 사진 [{path, page, site}]
alter table public.items add column if not exists details jsonb not null default '{}'::jsonb;  -- 정리된 정보 (메뉴·가격·운영시간·주의사항 등)
alter table public.items add column if not exists enrich  text;          -- 모으기 상태: pending / working / done / error
alter table public.items add column if not exists enrich_error text;
-- 일정 짜기: 끝 시간·장소(일정용)·좌표(이동 시간 계산)·머무는 시간
alter table public.items add column if not exists end_time text;
alter table public.items add column if not exists place    text;
alter table public.items add column if not exists lat      double precision;
alter table public.items add column if not exists lng      double precision;
alter table public.items add column if not exists stay_min int;

create table if not exists public.media (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips on delete cascade,
  item_id    uuid references public.items on delete set null,  -- 카드에서 올린 사진·영상 (카드를 지워도 앨범엔 남음)
  day_date   date,
  kind       text not null check (kind in ('photo', 'video')),
  path       text not null,
  caption    text,
  by_name    text,
  created_at timestamptz not null default now()
);
create index if not exists media_trip_idx on public.media (trip_id, created_at);

create table if not exists public.expenses (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips on delete cascade,
  title      text not null,
  amount     bigint not null check (amount >= 0),
  category   text,
  day_date   date,
  by_name    text,
  created_at timestamptz not null default now()
);
create index if not exists expenses_trip_idx on public.expenses (trip_id, created_at);
-- 일정(스팟·일정)에 넣은 비용 → 지출로 자동 기록. 일정을 지우면 그 비용도 지워짐
alter table public.expenses add column if not exists item_id uuid references public.items on delete cascade;
create unique index if not exists expenses_item_uniq on public.expenses (item_id) where item_id is not null;

create table if not exists public.days (
  trip_id  uuid not null references public.trips on delete cascade,
  day_date date not null,
  title    text,
  diary    text,
  updated_at timestamptz not null default now(),
  primary key (trip_id, day_date)
);

create table if not exists public.app_config (
  id             int primary key default 1 check (id = 1),
  owner_key_hash text not null
);

alter table public.trips      enable row level security;
alter table public.items      enable row level security;
alter table public.media      enable row level security;
alter table public.expenses   enable row level security;
alter table public.days       enable row level security;
alter table public.app_config enable row level security;

create table if not exists public.vouchers (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips on delete cascade,
  item_id    uuid references public.items on delete set null,  -- 붙어 있는 일정·스팟
  kind       text not null default 'other',                    -- flight / hotel / ticket / tour / restaurant / transport / other
  title      text,
  file_path  text,                                             -- 사진·PDF (저장소 경로)
  mime       text,
  body       text,                                             -- 붙여 넣은 메일 글
  parsed     jsonb not null default '{}'::jsonb,               -- 읽어 낸 내용
  status     text not null default 'pending',                  -- pending / working / done / error / manual
  error      text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vouchers_trip_idx on public.vouchers (trip_id, created_at);
alter table public.vouchers enable row level security;

revoke all on public.trips, public.items, public.media, public.expenses, public.days, public.app_config
  from anon, authenticated;

-- ---------- v1 함수 정리 (이름·형태가 바뀐 것) ----------
drop function if exists public.create_trip(text, jsonb);
drop function if exists public.import_trip(text, jsonb, jsonb);
drop function if exists public.set_check(uuid, text, boolean, text);
drop function if exists public.set_actual(uuid, text, bigint, text);
drop function if exists public.add_entry(uuid, text, text, text, text);
drop function if exists public.delete_entry(uuid, uuid);
drop function if exists public.request_revision(uuid, text);
drop function if exists public.set_bookings(uuid, text);
drop function if exists public.set_budget(uuid, jsonb);
drop function if exists public.complete_job(text, uuid, jsonb);
drop function if exists public.fail_job(text, uuid, text);

-- ---------- 내부 도우미 ----------
create or replace function public._owner_ok(p_key text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from app_config where owner_key_hash = encode(digest(coalesce(p_key, ''), 'sha256'), 'hex'));
$$;

create or replace function public._require_owner(p_key text) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not _owner_ok(p_key) then raise exception '소유자 키가 올바르지 않습니다' using errcode = '42501'; end if;
end $$;

create or replace function public._require_trip(p_trip uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from trips where id = p_trip) then
    raise exception '여행을 찾을 수 없습니다' using errcode = 'P0002';
  end if;
end $$;

create or replace function public.trip_exists(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from trips where id::text = p_id);
$$;

create or replace function public._clean_budget(p jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare v_total numeric; v_rate numeric; v_cur text;
begin
  p := coalesce(p, '{}'::jsonb);
  v_total := nullif(p->>'total', '')::numeric;
  v_rate  := nullif(p->>'rate', '')::numeric;
  v_cur   := upper(left(nullif(trim(p->>'currency'), ''), 10));
  if v_total is not null and (v_total < 0 or v_total > 1e12) then raise exception '총예산 값이 올바르지 않습니다'; end if;
  if v_rate is not null and (v_rate <= 0 or v_rate > 1e6) then raise exception '환율 값이 올바르지 않습니다'; end if;
  return jsonb_strip_nulls(jsonb_build_object('total', round(v_total), 'currency', v_cur, 'rate', v_rate));
exception when invalid_text_representation then
  raise exception '숫자를 확인해 주세요';
end $$;

create or replace function public._date(p text) returns date
language plpgsql immutable set search_path = public as $$
begin
  return nullif(trim(coalesce(p, '')), '')::date;
exception when others then
  raise exception '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)';
end $$;

-- 링크 목록 정리: http(s) 주소만, 중복 제거, 최대 10개 → [{url}]
create or replace function public._clean_links(p jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('url', u) order by ord), '[]'::jsonb)
  from (
    select u, min(ord) as ord from (
      select trim(case when jsonb_typeof(x) = 'string' then x #>> '{}' else x ->> 'url' end) as u, ord
      from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) with ordinality e(x, ord)
    ) s
    where u ~* '^https?://[^\s]+$' and length(u) <= 600
    group by u order by min(ord) limit 10
  ) z;
$$;

-- ---------- 소유자 ----------
create or replace function public.init_owner(p_key text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(coalesce(p_key, '')) < 24 then raise exception '소유자 키가 너무 짧습니다'; end if;
  if exists (select 1 from app_config) then return _owner_ok(p_key); end if;
  insert into app_config (id, owner_key_hash) values (1, encode(digest(p_key, 'sha256'), 'hex'));
  return true;
end $$;

create or replace function public.list_trips(p_owner_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'destination', t.destination, 'start_date', t.start_date, 'end_date', t.end_date,
      'status', t.status,
      'cover_path', coalesce(t.cover_path, (select m.path from media m where m.trip_id = t.id and m.kind = 'photo' order by m.created_at limit 1)),
      'destination_en', t.summary->>'destination_en',
      'spots', (select count(*) from items i where i.trip_id = t.id and i.category in ('photo','food','cafe','place','landmark','activity')),
      'visited', (select count(*) from items i where i.trip_id = t.id and i.done and i.category in ('photo','food','cafe','place','landmark','activity')),
      'media', (select count(*) from media m where m.trip_id = t.id)
    ) order by t.start_date desc nulls last, t.created_at desc)
    from trips t
  ), '[]'::jsonb);
end $$;

-- p_trip: {title, destination, start_date, end_date, companions, bookings, budget{}, input{style, must_do, memo, web_search, max_searches, model}}
create or replace function public.create_trip(p_owner_key text, p_trip jsonb, p_ai boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_start date; v_end date;
begin
  perform _require_owner(p_owner_key);
  v_start := _date(p_trip->>'start_date');
  v_end   := coalesce(_date(p_trip->>'end_date'), v_start);
  if v_start is not null and v_end < v_start then raise exception '도착일이 출발일보다 빠릅니다'; end if;
  insert into trips (title, destination, start_date, end_date, companions, bookings, budget, input, status, job)
  values (
    left(coalesce(nullif(trim(p_trip->>'title'), ''), '새 여행'), 120),
    left(p_trip->>'destination', 120), v_start, v_end, left(p_trip->>'companions', 200),
    left(nullif(p_trip->>'bookings', ''), 4000), _clean_budget(p_trip->'budget'),
    coalesce(p_trip->'input', '{}'::jsonb),
    case when p_ai then 'queued' else 'done' end,
    case when p_ai then jsonb_build_object('type', 'plan', 'params', '{}'::jsonb) end
  ) returning id into v_id;
  return v_id;
end $$;

create or replace function public.delete_trip(p_owner_key text, p_trip uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  delete from trips where id = p_trip;
end $$;

-- ---------- 공유 링크로 쓰는 기능 (여행 id 필요) ----------
create or replace function public.get_trip(p_trip uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'trip', jsonb_build_object(
      'id', t.id, 'title', t.title, 'destination', t.destination, 'start_date', t.start_date, 'end_date', t.end_date,
      'companions', t.companions, 'bookings', t.bookings, 'budget', t.budget, 'input', t.input,
      'cover_path', t.cover_path, 'summary', t.summary, 'blog', t.blog,
      'status', t.status, 'job', t.job, 'progress', t.progress, 'error', t.error, 'updated_at', t.updated_at
    ),
    'items', coalesce((select jsonb_agg(to_jsonb(i) - 'trip_id' order by i.day_date nulls last, i.sort) from items i where i.trip_id = t.id), '[]'::jsonb),
    'media', coalesce((select jsonb_agg(to_jsonb(m) - 'trip_id' order by m.created_at) from media m where m.trip_id = t.id), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(to_jsonb(e) - 'trip_id' order by e.created_at) from expenses e where e.trip_id = t.id), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(to_jsonb(d) - 'trip_id' order by d.day_date) from days d where d.trip_id = t.id), '[]'::jsonb),
    'vouchers', coalesce((select jsonb_agg(to_jsonb(v) - 'trip_id' order by v.created_at) from vouchers v where v.trip_id = t.id), '[]'::jsonb)
  )
  from trips t where t.id = p_trip;
$$;

-- 제목·기간·동행·예약 원문·예산 기준·표지 등 수정 (보낸 항목만 바뀜)
create or replace function public.update_trip(p_trip uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare t trips;
begin
  select * into t from trips where id = p_trip for update;
  if not found then raise exception '여행을 찾을 수 없습니다'; end if;
  if p_patch ? 'title' then
    if coalesce(trim(p_patch->>'title'), '') = '' then raise exception '제목을 입력해 주세요'; end if;
    t.title := left(trim(p_patch->>'title'), 120);
  end if;
  if p_patch ? 'destination' then t.destination := left(p_patch->>'destination', 120); end if;
  if p_patch ? 'start_date'  then t.start_date := _date(p_patch->>'start_date'); end if;
  if p_patch ? 'end_date'    then t.end_date := _date(p_patch->>'end_date'); end if;
  if t.start_date is not null and t.end_date is not null and t.end_date < t.start_date then
    raise exception '도착일이 출발일보다 빠릅니다';
  end if;
  if p_patch ? 'companions'  then t.companions := left(p_patch->>'companions', 200); end if;
  if p_patch ? 'bookings'    then t.bookings := left(nullif(p_patch->>'bookings', ''), 4000); end if;
  if p_patch ? 'budget'      then t.budget := _clean_budget(p_patch->'budget'); end if;
  if p_patch ? 'cover_path'  then
    if p_patch->>'cover_path' is not null and p_patch->>'cover_path' not like p_trip::text || '/%' then raise exception '잘못된 사진 경로'; end if;
    t.cover_path := p_patch->>'cover_path';
  end if;
  update trips set title = t.title, destination = t.destination, start_date = t.start_date, end_date = t.end_date,
    companions = t.companions, bookings = t.bookings, budget = t.budget, cover_path = t.cover_path, updated_at = now()
  where id = p_trip;
end $$;

-- 스팟·일정·할 일·준비물 추가/수정. id가 없으면 추가, 있으면 보낸 항목만 수정
create or replace function public.upsert_item(p_trip uuid, p_item jsonb, p_by text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p_item->>'id', '')::uuid; r items; v_links jsonb;
begin
  perform _require_trip(p_trip);
  if v_id is null then
    if coalesce(trim(p_item->>'name'), '') = '' then raise exception '이름을 입력해 주세요'; end if;
    v_links := _clean_links(p_item->'links');
    insert into items (trip_id, category, name, area, day_date, time, note, price, reservation_needed, search_query, origin, created_by,
                       links, enrich, end_time, place)
    values (p_trip, p_item->>'category', left(trim(p_item->>'name'), 200), left(p_item->>'area', 100), _date(p_item->>'day_date'),
            left(p_item->>'time', 40), left(p_item->>'note', 2000), left(p_item->>'price', 100),
            coalesce((p_item->>'reservation_needed')::boolean, false), left(p_item->>'search_query', 200), 'user', left(p_by, 40),
            v_links, case when jsonb_array_length(v_links) > 0 then 'pending' end,
            left(p_item->>'end_time', 40), left(p_item->>'place', 200))
    returning id into v_id;
    return v_id;
  end if;

  select * into r from items where id = v_id and trip_id = p_trip for update;
  if not found then raise exception '항목을 찾을 수 없습니다'; end if;
  if p_item ? 'name' then
    if coalesce(trim(p_item->>'name'), '') = '' then raise exception '이름을 입력해 주세요'; end if;
    r.name := left(trim(p_item->>'name'), 200);
  end if;
  if p_item ? 'category'           then r.category := p_item->>'category'; end if;
  if p_item ? 'area'               then r.area := left(p_item->>'area', 100); end if;
  if p_item ? 'day_date'           then r.day_date := _date(p_item->>'day_date'); end if;
  if p_item ? 'time'               then r.time := left(p_item->>'time', 40); end if;
  if p_item ? 'note'               then r.note := left(p_item->>'note', 2000); end if;
  if p_item ? 'price'              then r.price := left(p_item->>'price', 100); end if;
  if p_item ? 'reservation_needed' then r.reservation_needed := coalesce((p_item->>'reservation_needed')::boolean, false); end if;
  if p_item ? 'search_query'       then r.search_query := left(p_item->>'search_query', 200); end if;
  if p_item ? 'end_time'           then r.end_time := left(p_item->>'end_time', 40); end if;
  if p_item ? 'place' then
    if r.place is distinct from left(p_item->>'place', 200) then r.lat := null; r.lng := null; end if;  -- 장소가 바뀌면 좌표 다시 찾기
    r.place := left(p_item->>'place', 200);
  end if;
  if p_item ? 'lat' or p_item ? 'lng' then
    r.lat := case when (p_item->>'lat') ~ '^-?[0-9]{1,3}(\.[0-9]+)?$' then
                case when abs((p_item->>'lat')::float) <= 90 then (p_item->>'lat')::float end end;
    r.lng := case when (p_item->>'lng') ~ '^-?[0-9]{1,3}(\.[0-9]+)?$' then
                case when abs((p_item->>'lng')::float) <= 180 then (p_item->>'lng')::float end end;
  end if;
  if p_item ? 'stay_min' then
    r.stay_min := case when (p_item->>'stay_min') ~ '^[0-9]{1,3}$' then least(600, greatest(5, (p_item->>'stay_min')::int)) end;
  end if;
  if p_item ? 'sort'               then r.sort := (p_item->>'sort')::double precision; end if;
  if p_item ? 'thumb_path' then
    if p_item->>'thumb_path' is not null and p_item->>'thumb_path' not like p_trip::text || '/%' then raise exception '잘못된 사진 경로'; end if;
    r.thumb_path := p_item->>'thumb_path';
  end if;
  if p_item ? 'links' then
    v_links := _clean_links(p_item->'links');
    if v_links is distinct from r.links and jsonb_array_length(v_links) > 0 then r.enrich := 'pending'; end if;  -- 새 링크 → 다시 정리
    r.links := v_links;
  end if;
  if p_item ? 'photos' then  -- 모아 온 사진은 빼기만 가능
    r.photos := (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(p_item->'photos') x
                 where r.photos @> jsonb_build_array(x));
  end if;
  if p_item->>'enrich' = 'pending' then r.enrich := 'pending'; end if;  -- 다시 모으기
  update items set category = r.category, name = r.name, area = r.area, day_date = r.day_date, time = r.time, note = r.note,
    price = r.price, reservation_needed = r.reservation_needed, search_query = r.search_query, sort = r.sort,
    thumb_path = r.thumb_path, links = r.links, photos = r.photos, enrich = r.enrich,
    end_time = r.end_time, place = r.place, lat = r.lat, lng = r.lng, stay_min = r.stay_min, updated_at = now()
  where id = v_id;
  return v_id;
end $$;

create or replace function public.delete_item(p_trip uuid, p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from items where id = p_item and trip_id = p_trip;
end $$;

-- 방문함 / 완료 체크 (시간·누가 했는지 자동 기록)
create or replace function public.set_done(p_trip uuid, p_item uuid, p_done boolean, p_by text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  update items set done = p_done,
    done_at = case when p_done then now() end,
    done_by = case when p_done then left(p_by, 40) end,
    updated_at = now()
  where id = p_item and trip_id = p_trip;
  if not found then raise exception '항목을 찾을 수 없습니다'; end if;
end $$;

create or replace function public.add_media(
  p_trip uuid, p_item uuid, p_kind text, p_path text, p_caption text default null, p_by text default null, p_day text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_day date := _date(p_day);
begin
  perform _require_trip(p_trip);
  if p_path not like p_trip::text || '/%' then raise exception '잘못된 파일 경로'; end if;
  if p_item is not null then
    if not exists (select 1 from items where id = p_item and trip_id = p_trip) then raise exception '항목을 찾을 수 없습니다'; end if;
    v_day := coalesce(v_day, (select day_date from items where id = p_item));
  end if;
  insert into media (trip_id, item_id, day_date, kind, path, caption, by_name)
  values (p_trip, p_item, v_day, p_kind, p_path, left(nullif(p_caption, ''), 500), left(p_by, 40))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.update_media(p_trip uuid, p_media uuid, p_caption text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update media set caption = left(nullif(p_caption, ''), 500) where id = p_media and trip_id = p_trip;
end $$;

-- 지운 파일 경로를 돌려준다 (화면에서 저장소 파일도 지우도록)
create or replace function public.delete_media(p_trip uuid, p_media uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_path text;
begin
  delete from media where id = p_media and trip_id = p_trip returning path into v_path;
  update trips set cover_path = null where id = p_trip and cover_path = v_path;
  update items set thumb_path = null where trip_id = p_trip and thumb_path = v_path;
  return v_path;
end $$;

create or replace function public.upsert_expense(p_trip uuid, p_exp jsonb, p_by text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p_exp->>'id', '')::uuid; v_amount bigint;
begin
  perform _require_trip(p_trip);
  if coalesce(trim(p_exp->>'title'), '') = '' then raise exception '지출 항목을 입력해 주세요'; end if;
  begin
    v_amount := round((p_exp->>'amount')::numeric);
  exception when others then raise exception '금액을 확인해 주세요';
  end;
  if v_amount is null or v_amount < 0 then raise exception '금액을 확인해 주세요'; end if;
  if v_id is null then
    insert into expenses (trip_id, title, amount, category, day_date, by_name)
    values (p_trip, left(trim(p_exp->>'title'), 100), v_amount, left(p_exp->>'category', 30), _date(p_exp->>'day_date'), left(p_by, 40))
    returning id into v_id;
  else
    update expenses set title = left(trim(p_exp->>'title'), 100), amount = v_amount, category = left(p_exp->>'category', 30),
      day_date = _date(p_exp->>'day_date')
    where id = v_id and trip_id = p_trip;
  end if;
  return v_id;
end $$;

-- 일정 비용: 금액이 있으면 그 일정의 지출을 만들거나 고치고, 0·빈 값이면 지운다. 지출 id 반환
create or replace function public.set_item_cost(p_trip uuid, p_item uuid, p_amount numeric, p_category text default null, p_by text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare it items; v_id uuid;
begin
  perform _require_trip(p_trip);
  select * into it from items where id = p_item and trip_id = p_trip;
  if not found then raise exception '항목을 찾을 수 없습니다'; end if;
  if p_amount is null or p_amount <= 0 then
    delete from expenses where item_id = p_item and trip_id = p_trip;
    return null;
  end if;
  if p_amount > 100000000 then raise exception '금액을 확인해 주세요'; end if;
  insert into expenses (trip_id, item_id, title, amount, category, day_date, by_name)
  values (p_trip, p_item, left(it.name, 100), round(p_amount), left(coalesce(p_category, 'etc'), 30), it.day_date, left(p_by, 40))
  on conflict (item_id) where item_id is not null do update set
    title = excluded.title, amount = excluded.amount, category = coalesce(p_category, expenses.category), day_date = excluded.day_date
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.delete_expense(p_trip uuid, p_exp uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from expenses where id = p_exp and trip_id = p_trip;
end $$;

-- 날짜별 제목·일기
create or replace function public.set_day(p_trip uuid, p_date text, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_date date := _date(p_date);
begin
  perform _require_trip(p_trip);
  if v_date is null then raise exception '날짜가 필요합니다'; end if;
  insert into days (trip_id, day_date, title, diary) values (p_trip, v_date, left(p_patch->>'title', 100), left(p_patch->>'diary', 8000))
  on conflict (trip_id, day_date) do update set
    title = case when p_patch ? 'title' then left(p_patch->>'title', 100) else days.title end,
    diary = case when p_patch ? 'diary' then left(p_patch->>'diary', 8000) else days.diary end,
    updated_at = now();
end $$;

-- AI 작업 요청: plan(새 여행 추천) / recommend(추천 더 받기) / blog(블로그 글)
create or replace function public.request_job(p_trip uuid, p_type text, p_params jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_trip(p_trip);
  if p_type not in ('plan', 'recommend', 'blog', 'youtube') then raise exception '알 수 없는 작업입니다'; end if;
  if length(coalesce(p_params, '{}'::jsonb)::text) > 4000 then raise exception '요청이 너무 깁니다'; end if;
  update trips set status = 'queued', job = jsonb_build_object('type', p_type, 'params', coalesce(p_params, '{}'::jsonb)),
    error = null, progress = null, requested_at = now(), updated_at = now()
  where id = p_trip and status in ('done', 'error');
  if not found then raise exception '이미 AI가 작업 중입니다. 끝난 뒤 다시 요청해 주세요'; end if;
end $$;

create or replace function public.cancel_job(p_trip uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update trips set status = 'done', job = null, progress = null, error = null, updated_at = now()
  where id = p_trip and status in ('queued', 'generating');
  if not found then raise exception '진행 중인 AI 작업이 없습니다'; end if;
end $$;

create or replace function public.trip_status(p_trip uuid) returns text
language sql stable security definer set search_path = public as $$
  select status from trips where id = p_trip;
$$;

-- ---------- 작업기 (소유자 PC) ----------
create or replace function public.reset_stuck(p_owner_key text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform _require_owner(p_owner_key);
  update trips set status = 'queued', progress = null, updated_at = now() where status = 'generating';
  get diagnostics n = row_count;
  update items set enrich = 'pending' where enrich = 'working';
  update vouchers set status = 'pending' where status = 'working';
  return n;
end $$;

-- ---------- 사진·정보 모으기 ----------
-- 화면: 스팟 하나(p_item) 또는 아직 정리 안 된 스팟 전체를 대기열에 넣는다. 넣은 개수 반환
create or replace function public.request_enrich(p_trip uuid, p_item uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform _require_trip(p_trip);
  update items set enrich = 'pending', enrich_error = null, updated_at = now()
  where trip_id = p_trip and category in ('photo', 'food', 'cafe', 'place', 'landmark', 'activity')
    and coalesce(enrich, '') <> 'working'
    and (case when p_item is not null then id = p_item
              else coalesce(enrich, '') <> 'pending' and (details = '{}'::jsonb or enrich = 'error') end);
  get diagnostics n = row_count;
  return n;
end $$;

-- 작업기: 대기 중인 스팟을 최대 p_limit개 가져와 '작업 중'으로 바꾼다
create or replace function public.claim_enrich(p_owner_key text, p_limit int default 4) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform _require_owner(p_owner_key);
  with c as (
    select id from items where enrich = 'pending' order by updated_at limit greatest(1, least(coalesce(p_limit, 4), 10))
    for update skip locked
  ), u as (
    update items i set enrich = 'working', enrich_error = null from c where i.id = c.id returning i.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', u.id, 'trip_id', u.trip_id, 'category', u.category, 'name', u.name, 'area', u.area, 'note', u.note,
    'price', u.price, 'search_query', u.search_query, 'origin', u.origin, 'links', u.links, 'photos', u.photos,
    'destination', t.destination, 'destination_en', t.summary->>'destination_en', 'model', t.input->>'model'
  )), '[]'::jsonb) into v
  from u join trips t on t.id = u.trip_id;
  return v;
end $$;

-- 작업기: 결과 저장. 그사이 스팟이 지워졌거나 다시 요청됐으면 false (작업기가 올린 사진을 지움)
create or replace function public.finish_enrich(p_owner_key text, p_item uuid, p_details jsonb, p_photos jsonb, p_error text default null)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  if p_error is not null then
    update items set enrich = 'error', enrich_error = left(p_error, 500), updated_at = now() where id = p_item and enrich = 'working';
    return found;
  end if;
  update items set
    details = coalesce(p_details, '{}'::jsonb),
    photos = coalesce(p_photos, '[]'::jsonb),
    area = coalesce(nullif(area, ''), left(p_details->>'area', 100)),
    lat = coalesce(lat, case when jsonb_typeof(p_details->'lat') = 'number' then (p_details->>'lat')::float end),
    lng = coalesce(lng, case when jsonb_typeof(p_details->'lng') = 'number' then (p_details->>'lng')::float end),
    price = coalesce(nullif(price, ''), left(p_details->>'price_range', 100)),
    enrich = 'done', enrich_error = null, updated_at = now()
  where id = p_item and enrich = 'working';
  return found;
end $$;

create or replace function public.claim_job(p_owner_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r trips;
begin
  perform _require_owner(p_owner_key);
  select * into r from trips where status = 'queued' order by requested_at limit 1 for update skip locked;
  if not found then return null; end if;
  update trips set status = 'generating', progress = null, updated_at = now() where id = r.id;
  return jsonb_build_object('id', r.id, 'job', coalesce(r.job, jsonb_build_object('type', 'plan', 'params', '{}'::jsonb)));
end $$;

create or replace function public.set_progress(p_owner_key text, p_trip uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  update trips set progress = left(p_text, 300) where id = p_trip and status = 'generating';
end $$;

-- AI 결과 반영 (추가만, 사용자 데이터는 덮어쓰지 않음). 그사이 취소됐으면 false
-- p_result: {summary: {...병합}, items: [...], days: [{date, title}], blog: {...}}
create or replace function public.complete_job(p_owner_key text, p_trip uuid, p_result jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  perform 1 from trips where id = p_trip and status = 'generating' for update;
  if not found then return false; end if;

  insert into items (trip_id, category, name, area, day_date, time, note, price, reservation_needed, search_query,
                     source_url, verified, origin, sort, created_by, enrich)
  select p_trip, x->>'category', left(x->>'name', 200), left(x->>'area', 100), _date(x->>'day_date'), left(x->>'time', 40),
         left(x->>'note', 2000), left(x->>'price', 100), coalesce((x->>'reservation_needed')::boolean, false),
         left(x->>'search_query', 200), left(x->>'source_url', 500), coalesce((x->>'verified')::boolean, false),
         'ai', extract(epoch from now()) + ord, 'AI',
         case when x->>'category' in ('photo', 'food', 'cafe', 'place', 'landmark', 'activity') then 'pending' end  -- 사진·정보 자동 모으기
  from jsonb_array_elements(coalesce(p_result->'items', '[]'::jsonb)) with ordinality as e(x, ord)
  where x->>'category' in ('photo', 'food', 'cafe', 'place', 'landmark', 'activity', 'schedule', 'todo', 'packing')
    and coalesce(trim(x->>'name'), '') <> '';

  insert into days (trip_id, day_date, title)
  select p_trip, _date(x->>'date'), left(x->>'title', 100)
  from jsonb_array_elements(coalesce(p_result->'days', '[]'::jsonb)) e(x)
  where coalesce(x->>'date', '') <> ''
  on conflict (trip_id, day_date) do update set title = coalesce(nullif(days.title, ''), excluded.title);

  update trips set
    summary = summary || coalesce(p_result->'summary', '{}'::jsonb),
    blog = coalesce(p_result->'blog', blog),
    status = 'done', job = null, error = null, progress = null, updated_at = now()
  where id = p_trip;
  return true;
end $$;

create or replace function public.fail_job(p_owner_key text, p_trip uuid, p_error text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  update trips set status = 'error', error = left(p_error, 2000), progress = null, updated_at = now()
  where id = p_trip and status = 'generating';
  return found;
end $$;

-- 전체 백업 (v1 plan 포함)
create or replace function public.export_all(p_owner_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  return coalesce((select jsonb_agg(get_trip(id) || jsonb_build_object('legacy_plan', plan) order by created_at) from trips), '[]'::jsonb);
end $$;

-- v1 계획을 아직 v2 항목으로 옮기지 않은 여행
create or replace function public.legacy_plans(p_owner_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'start_date', t.start_date, 'end_date', t.end_date, 'plan', t.plan))
    from trips t where t.plan is not null and not exists (select 1 from items i where i.trip_id = t.id)
  ), '[]'::jsonb);
end $$;

-- v1 → v2 옮기기: 항목 추가 + 개요 저장 + v1 plan 비우기
create or replace function public.migrate_trip(p_owner_key text, p_trip uuid, p_result jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  update trips set status = 'generating' where id = p_trip;
  perform complete_job(p_owner_key, p_trip, p_result);
  update trips set plan = null where id = p_trip;
end $$;

-- ---------- 예약·바우처 (항공권·숙소 메일·입장권·QR) ----------
-- 사진·PDF를 올리거나 메일 글을 붙여 넣으면 작업기가 Claude로 읽어 parsed에 정리 → 화면에서 확인 후 일정·지출에 반영
create or replace function public.add_voucher(p_trip uuid, p_v jsonb, p_by text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_path text := nullif(p_v->>'file_path', ''); v_body text := nullif(trim(coalesce(p_v->>'body', '')), '');
begin
  perform _require_trip(p_trip);
  if v_path is null and v_body is null then raise exception '사진·PDF를 올리거나 내용을 붙여 넣어 주세요'; end if;
  if v_path is not null and v_path not like p_trip::text || '/%' then raise exception '잘못된 파일 경로'; end if;
  insert into vouchers (trip_id, item_id, kind, title, file_path, mime, body, status, created_by)
  values (p_trip, nullif(p_v->>'item_id', '')::uuid, coalesce(nullif(p_v->>'kind', ''), 'other'), left(p_v->>'title', 200), v_path,
          left(p_v->>'mime', 60), left(v_body, 20000),
          case when coalesce((p_v->>'ai')::boolean, true) then 'pending' else 'manual' end, left(p_by, 40))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.update_voucher(p_trip uuid, p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_trip(p_trip);
  if p_patch ? 'item_id' and nullif(p_patch->>'item_id', '') is not null
     and not exists (select 1 from items where id = (p_patch->>'item_id')::uuid and trip_id = p_trip) then
    raise exception '항목을 찾을 수 없습니다';
  end if;
  update vouchers set
    item_id = case when p_patch ? 'item_id' then nullif(p_patch->>'item_id', '')::uuid else item_id end,
    kind    = case when p_patch ? 'kind' then coalesce(nullif(p_patch->>'kind', ''), kind) else kind end,
    title   = case when p_patch ? 'title' then left(p_patch->>'title', 200) else title end,
    status  = case when p_patch->>'status' = 'pending' and status in ('done', 'error', 'manual') then 'pending' else status end,
    updated_at = now()
  where id = p_id and trip_id = p_trip;
end $$;

-- 지우고 파일 경로를 돌려준다 (화면이 저장소에서 파일도 지움)
create or replace function public.delete_voucher(p_trip uuid, p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_path text;
begin
  perform _require_trip(p_trip);
  delete from vouchers where id = p_id and trip_id = p_trip returning file_path into v_path;
  return v_path;
end $$;

create or replace function public.claim_voucher(p_owner_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r vouchers; t trips;
begin
  perform _require_owner(p_owner_key);
  select * into r from vouchers where status = 'pending' order by created_at limit 1 for update skip locked;
  if not found then return null; end if;
  update vouchers set status = 'working', error = null, updated_at = now() where id = r.id;
  select * into t from trips where id = r.trip_id;
  return jsonb_build_object('id', r.id, 'trip_id', r.trip_id, 'kind', r.kind, 'file_path', r.file_path, 'mime', r.mime, 'body', r.body,
    'trip', jsonb_build_object('title', t.title, 'destination', t.destination, 'start_date', t.start_date, 'end_date', t.end_date,
                               'companions', t.companions, 'model', t.input->>'model'));
end $$;

create or replace function public.finish_voucher(p_owner_key text, p_id uuid, p_parsed jsonb, p_error text default null) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  update vouchers set
    parsed = case when p_error is null then coalesce(p_parsed, '{}'::jsonb) else parsed end,
    kind   = case when p_error is null then coalesce(nullif(p_parsed->>'kind', ''), kind) else kind end,
    title  = case when p_error is null then coalesce(nullif(title, ''), left(p_parsed->>'title', 200)) else title end,
    status = case when p_error is null then 'done' else 'error' end,
    error  = left(p_error, 500), updated_at = now()
  where id = p_id and status = 'working';
  return found;
end $$;

-- ---------- 함수 권한 ----------
revoke execute on function public._owner_ok(text), public._require_owner(text), public._require_trip(uuid),
  public._clean_budget(jsonb), public._date(text), public._clean_links(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.trip_exists(text), public.init_owner(text), public.list_trips(text), public.create_trip(text, jsonb, boolean),
  public.delete_trip(text, uuid), public.get_trip(uuid), public.update_trip(uuid, jsonb),
  public.upsert_item(uuid, jsonb, text), public.delete_item(uuid, uuid), public.set_done(uuid, uuid, boolean, text),
  public.add_media(uuid, uuid, text, text, text, text, text), public.update_media(uuid, uuid, text), public.delete_media(uuid, uuid),
  public.upsert_expense(uuid, jsonb, text), public.delete_expense(uuid, uuid), public.set_day(uuid, text, jsonb),
  public.request_job(uuid, text, jsonb), public.cancel_job(uuid), public.trip_status(uuid),
  public.reset_stuck(text), public.claim_job(text), public.set_progress(text, uuid, text),
  public.complete_job(text, uuid, jsonb), public.fail_job(text, uuid, text), public.export_all(text),
  public.legacy_plans(text), public.migrate_trip(text, uuid, jsonb),
  public.request_enrich(uuid, uuid), public.claim_enrich(text, int), public.finish_enrich(text, uuid, jsonb, jsonb, text),
  public.set_item_cost(uuid, uuid, numeric, text, text),
  public.add_voucher(uuid, jsonb, text), public.update_voucher(uuid, uuid, jsonb), public.delete_voucher(uuid, uuid),
  public.claim_voucher(text), public.finish_voucher(text, uuid, jsonb, text)
  to anon, authenticated;

-- ---------- 사진·영상 저장소 ----------
-- 무료 플랜은 파일 1개당 최대 50MB, 전체 1GB. 사진은 화면에서 자동으로 줄여서 올림
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 52428800,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm', 'application/pdf'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "trip photos read" on storage.objects;
create policy "trip photos read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'photos' and public.trip_exists((storage.foldername(name))[1]));

drop policy if exists "trip photos upload" on storage.objects;
create policy "trip photos upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'photos' and public.trip_exists((storage.foldername(name))[1]));

drop policy if exists "trip photos delete" on storage.objects;
create policy "trip photos delete" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'photos' and public.trip_exists((storage.foldername(name))[1]));
