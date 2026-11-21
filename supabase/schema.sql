-- =====================================================================
-- 여행 계획 앱 DB
-- Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run.
-- 여러 번 실행해도 안전합니다.
--
-- 보안 구조
--  * 테이블은 RLS로 잠그고 직접 접근을 막는다. 모든 접근은 아래 함수(RPC)로만.
--  * 여행 id(UUID, 추측 불가)를 아는 사람 = 공유 링크를 받은 사람 → 보기·체크·추가·사진 가능
--  * 여행 생성·삭제·목록·AI 작업 처리는 소유자 키(owner key)가 있어야 가능
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 테이블 ----------
create table if not exists public.trips (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  input         jsonb not null,
  status        text not null default 'queued' check (status in ('queued', 'generating', 'done', 'error')),
  error         text,
  plan          jsonb,
  revision_note text,
  requested_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- AI 결과(plan)와 분리해서 사용자가 직접 관리하는 값
alter table public.trips add column if not exists budget   jsonb not null default '{}'::jsonb;  -- {total, currency, rate}
alter table public.trips add column if not exists bookings text;                               -- 확정 예약 원문
alter table public.trips add column if not exists progress text;                               -- AI 진행 상황

create table if not exists public.checks (
  trip_id    uuid not null references public.trips on delete cascade,
  key        text not null,
  value      boolean not null,
  by_name    text,
  updated_at timestamptz not null default now(),
  primary key (trip_id, key)
);

create table if not exists public.actuals (
  trip_id    uuid not null references public.trips on delete cascade,
  item       text not null,
  value      bigint not null,
  by_name    text,
  updated_at timestamptz not null default now(),
  primary key (trip_id, item)
);

create table if not exists public.entries (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips on delete cascade,
  section    text not null,
  body       text,
  photo_path text,
  by_name    text,
  created_at timestamptz not null default now()
);
create index if not exists entries_trip_idx on public.entries (trip_id, created_at);

create table if not exists public.app_config (
  id             int primary key default 1 check (id = 1),
  owner_key_hash text not null
);

alter table public.trips      enable row level security;
alter table public.checks     enable row level security;
alter table public.actuals    enable row level security;
alter table public.entries    enable row level security;
alter table public.app_config enable row level security;
revoke all on public.trips, public.checks, public.actuals, public.entries, public.app_config from anon, authenticated;

-- ---------- 내부 도우미 ----------
create or replace function public._owner_ok(p_key text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from app_config
    where owner_key_hash = encode(digest(coalesce(p_key, ''), 'sha256'), 'hex')
  );
$$;

create or replace function public._require_owner(p_key text) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not _owner_ok(p_key) then
    raise exception '소유자 키가 올바르지 않습니다' using errcode = '42501';
  end if;
end $$;

create or replace function public._require_trip(p_trip uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from trips where id = p_trip) then
    raise exception '여행을 찾을 수 없습니다' using errcode = 'P0002';
  end if;
end $$;

-- 사진 업로드 정책에서 사용 (폴더명 = 여행 id)
create or replace function public.trip_exists(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from trips where id::text = p_id);
$$;

-- 총예산·통화·환율을 검증해 정리
create or replace function public._clean_budget(p jsonb) returns jsonb
language plpgsql immutable as $$
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

-- ---------- 소유자 ----------
-- 처음 한 번만 소유자 키를 등록. 이미 등록돼 있으면 키가 맞는지만 확인.
create or replace function public.init_owner(p_key text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(coalesce(p_key, '')) < 24 then
    raise exception '소유자 키가 너무 짧습니다';
  end if;
  if exists (select 1 from app_config) then
    return _owner_ok(p_key);
  end if;
  insert into app_config (id, owner_key_hash) values (1, encode(digest(p_key, 'sha256'), 'hex'));
  return true;
end $$;

create or replace function public.list_trips(p_owner_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'input', input, 'status', status, 'error', error,
      'has_plan', plan is not null, 'created_at', created_at
    ) order by input->>'start_date' desc nulls last, created_at desc)
    from trips
  ), '[]'::jsonb);
end $$;

create or replace function public.create_trip(p_owner_key text, p_input jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _require_owner(p_owner_key);
  insert into trips (title, input, status, budget, bookings)
  values (left(coalesce(nullif(p_input->>'title', ''), '새 여행'), 200), p_input - 'budget_settings', 'queued',
          _clean_budget(p_input->'budget_settings'), left(nullif(p_input->>'bookings', ''), 4000))
  returning id into v_id;
  return v_id;
end $$;

-- 이미 만들어진 계획을 그대로 추가 (로컬 데이터 옮기기용)
create or replace function public.import_trip(p_owner_key text, p_input jsonb, p_plan jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _require_owner(p_owner_key);
  insert into trips (title, input, status, plan, budget, bookings)
  values (left(coalesce(nullif(p_input->>'title', ''), '가져온 여행'), 200), p_input - 'budget_settings', 'done', p_plan,
          _clean_budget(p_input->'budget_settings'), left(nullif(p_input->>'bookings', ''), 4000))
  returning id into v_id;
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
      'id', t.id, 'title', t.title, 'input', t.input, 'status', t.status, 'error', t.error,
      'plan', t.plan, 'revision_note', t.revision_note, 'updated_at', t.updated_at,
      'budget', t.budget, 'bookings', t.bookings, 'progress', t.progress
    ),
    'checks',  coalesce((select jsonb_object_agg(c.key, c.value) from checks c where c.trip_id = t.id), '{}'::jsonb),
    'actuals', coalesce((select jsonb_object_agg(a.item, a.value) from actuals a where a.trip_id = t.id), '{}'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'section', e.section, 'body', e.body, 'photo_path', e.photo_path,
        'by_name', e.by_name, 'created_at', e.created_at
      ) order by e.created_at)
      from entries e where e.trip_id = t.id
    ), '[]'::jsonb)
  )
  from trips t where t.id = p_trip;
$$;

create or replace function public.set_check(p_trip uuid, p_key text, p_value boolean, p_by text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_trip(p_trip);
  if length(p_key) > 100 then raise exception '잘못된 항목'; end if;
  insert into checks (trip_id, key, value, by_name, updated_at)
  values (p_trip, p_key, p_value, left(p_by, 40), now())
  on conflict (trip_id, key) do update
    set value = excluded.value, by_name = excluded.by_name, updated_at = now();
end $$;

create or replace function public.set_actual(p_trip uuid, p_item text, p_value bigint, p_by text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_trip(p_trip);
  if length(p_item) > 200 then raise exception '잘못된 항목'; end if;
  if p_value is null then
    delete from actuals where trip_id = p_trip and item = p_item;
  else
    insert into actuals (trip_id, item, value, by_name, updated_at)
    values (p_trip, p_item, p_value, left(p_by, 40), now())
    on conflict (trip_id, item) do update
      set value = excluded.value, by_name = excluded.by_name, updated_at = now();
  end if;
end $$;

create or replace function public.add_entry(
  p_trip uuid, p_section text, p_body text, p_photo_path text default null, p_by text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _require_trip(p_trip);
  if length(coalesce(p_section, '')) = 0 or length(p_section) > 40 then raise exception '잘못된 위치'; end if;
  if length(coalesce(p_body, '')) > 4000 then raise exception '내용이 너무 깁니다 (4000자 이하)'; end if;
  if coalesce(p_body, '') = '' and p_photo_path is null then raise exception '내용이나 사진을 넣어 주세요'; end if;
  if p_photo_path is not null and p_photo_path not like p_trip::text || '/%' then raise exception '잘못된 사진 경로'; end if;
  insert into entries (trip_id, section, body, photo_path, by_name)
  values (p_trip, p_section, nullif(p_body, ''), p_photo_path, left(p_by, 40))
  returning id into v_id;
  return v_id;
end $$;

-- 삭제한 항목의 사진 경로를 돌려준다 (화면에서 사진 파일도 지우도록)
create or replace function public.delete_entry(p_trip uuid, p_entry uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_path text;
begin
  delete from entries where id = p_entry and trip_id = p_trip returning photo_path into v_path;
  return v_path;
end $$;

-- AI 수정 요청 (또는 실패한 생성 다시 시도). 소유자 PC의 작업기가 처리한다.
create or replace function public.request_revision(p_trip uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_trip(p_trip);
  if length(coalesce(p_note, '')) > 2000 then raise exception '요청이 너무 깁니다 (2000자 이하)'; end if;
  update trips
     set status = 'queued', revision_note = nullif(p_note, ''), error = null, progress = null,
         requested_at = now(), updated_at = now()
   where id = p_trip and status in ('done', 'error');
  if not found then raise exception '이미 AI가 작업 중입니다'; end if;
end $$;

-- AI 작업 취소 (대기 중이거나 진행 중일 때). 작업기는 상태 변화를 보고 즉시 중단한다.
create or replace function public.cancel_job(p_trip uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update trips
     set status = case when plan is null then 'error' else 'done' end,
         error = case when plan is null then '취소했습니다. 다시 시도를 누르면 새로 만들어요.' else null end,
         revision_note = null, progress = null, updated_at = now()
   where id = p_trip and status in ('queued', 'generating');
  if not found then raise exception '진행 중인 AI 작업이 없습니다'; end if;
end $$;

-- 확정 예약 원문 (AI가 바꾸지 못하는 사용자 데이터)
create or replace function public.set_bookings(p_trip uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_trip(p_trip);
  if length(coalesce(p_text, '')) > 4000 then raise exception '너무 깁니다 (4000자 이하)'; end if;
  update trips set bookings = nullif(p_text, ''), updated_at = now() where id = p_trip;
end $$;

-- 총예산·통화·환율 (AI 예산표와 별개로 사용자가 정한 값)
create or replace function public.set_budget(p_trip uuid, p_budget jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_trip(p_trip);
  update trips set budget = _clean_budget(p_budget), updated_at = now() where id = p_trip;
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
  return n;
end $$;

create or replace function public.claim_job(p_owner_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r trips;
begin
  perform _require_owner(p_owner_key);
  select * into r from trips where status = 'queued' order by requested_at limit 1 for update skip locked;
  if not found then return null; end if;
  update trips set status = 'generating', progress = null, updated_at = now() where id = r.id;
  return jsonb_build_object('id', r.id, 'input', r.input, 'plan', r.plan, 'revision_note', r.revision_note,
                            'budget', r.budget, 'bookings', r.bookings);
end $$;

create or replace function public.set_progress(p_owner_key text, p_trip uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  update trips set progress = left(p_text, 300) where id = p_trip and status = 'generating';
end $$;

-- 진행 중(generating)일 때만 결과를 반영. 그사이 취소됐으면 false (결과 버림)
drop function if exists public.complete_job(text, uuid, jsonb);
create or replace function public.complete_job(p_owner_key text, p_trip uuid, p_plan jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  update trips set status = 'done', plan = p_plan, error = null, revision_note = null, progress = null, updated_at = now()
   where id = p_trip and status = 'generating';
  return found;
end $$;

drop function if exists public.fail_job(text, uuid, text);
create or replace function public.fail_job(p_owner_key text, p_trip uuid, p_error text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  update trips set status = 'error', error = left(p_error, 2000), progress = null, updated_at = now()
   where id = p_trip and status = 'generating';
  return found;
end $$;

-- 전체 백업용
create or replace function public.export_all(p_owner_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  return coalesce((select jsonb_agg(get_trip(id) order by created_at) from trips), '[]'::jsonb);
end $$;

-- ---------- 함수 권한 ----------
revoke execute on function public._owner_ok(text), public._require_owner(text), public._require_trip(uuid),
  public._clean_budget(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.trip_exists(text), public.init_owner(text), public.list_trips(text), public.create_trip(text, jsonb),
  public.import_trip(text, jsonb, jsonb), public.delete_trip(text, uuid), public.get_trip(uuid),
  public.set_check(uuid, text, boolean, text), public.set_actual(uuid, text, bigint, text),
  public.add_entry(uuid, text, text, text, text), public.delete_entry(uuid, uuid),
  public.request_revision(uuid, text), public.cancel_job(uuid), public.set_bookings(uuid, text),
  public.set_budget(uuid, jsonb), public.trip_status(uuid),
  public.reset_stuck(text), public.claim_job(text), public.set_progress(text, uuid, text),
  public.complete_job(text, uuid, jsonb), public.fail_job(text, uuid, text), public.export_all(text)
  to anon, authenticated;

-- ---------- 사진 저장소 ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

drop policy if exists "trip photos read" on storage.objects;
create policy "trip photos read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'photos' and public.trip_exists((storage.foldername(name))[1]));

drop policy if exists "trip photos upload" on storage.objects;
create policy "trip photos upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'photos' and public.trip_exists((storage.foldername(name))[1]));

drop policy if exists "trip photos delete" on storage.objects;
create policy "trip photos delete" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'photos' and public.trip_exists((storage.foldername(name))[1]));
