-- ---------- 일정 알림 (웹 푸시) ----------
-- 휴대폰이 알림을 켜면 구독 정보(endpoint·키)를 여행에 저장하고, 소유자 PC 작업기가 시간에 맞춰 보낸다.
-- 보내는 곳은 브라우저 푸시 서버로만 제한 (작업기가 아무 주소로나 요청하지 않게)
create table if not exists public.push_subs (
  endpoint   text primary key,
  trip_id    uuid not null references public.trips on delete cascade,
  p256dh     text not null,
  auth       text not null,
  tz         text,                -- 휴대폰 시간대 (예: Asia/Hong_Kong). 일정 시각을 이 시간대로 해석
  label      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subs_trip_idx on public.push_subs (trip_id);
alter table public.push_subs enable row level security;
revoke all on public.push_subs from anon, authenticated;

create or replace function public.add_push_sub(p_trip uuid, p_sub jsonb, p_tz text default null, p_label text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_ep text := p_sub->>'endpoint';
begin
  perform _require_trip(p_trip);
  if v_ep is null or v_ep !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/'
     or length(v_ep) > 1000 then
    raise exception '지원하지 않는 알림 주소예요';
  end if;
  if coalesce(p_sub#>>'{keys,p256dh}', '') = '' or coalesce(p_sub#>>'{keys,auth}', '') = '' then
    raise exception '알림 키가 없어요';
  end if;
  if (select count(*) from push_subs where trip_id = p_trip and endpoint <> v_ep) >= 10 then
    raise exception '알림을 켠 기기가 너무 많아요 (최대 10대)';
  end if;
  insert into push_subs (endpoint, trip_id, p256dh, auth, tz, label)
  values (v_ep, p_trip, left(p_sub#>>'{keys,p256dh}', 200), left(p_sub#>>'{keys,auth}', 100), left(p_tz, 60), left(p_label, 40))
  on conflict (endpoint) do update set trip_id = excluded.trip_id, p256dh = excluded.p256dh, auth = excluded.auth,
    tz = coalesce(excluded.tz, push_subs.tz), label = coalesce(excluded.label, push_subs.label), updated_at = now();
end $$;

create or replace function public.remove_push_sub(p_trip uuid, p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from push_subs where trip_id = p_trip and endpoint = p_endpoint;
$$;

-- 작업기용: 알림 켠 기기 목록 / 만료된 구독 지우기
create or replace function public.list_push_subs(p_owner_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  return coalesce((select jsonb_agg(to_jsonb(s)) from push_subs s), '[]'::jsonb);
end $$;

create or replace function public.drop_push_sub(p_owner_key text, p_endpoint text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner(p_owner_key);
  delete from push_subs where endpoint = p_endpoint;
end $$;

grant execute on function public.add_push_sub(uuid, jsonb, text, text), public.remove_push_sub(uuid, text),
  public.list_push_subs(text), public.drop_push_sub(text, text) to anon, authenticated;
