-- 예약·바우처 마무리 (SQL Editor에서 한 번 실행). 여러 번 실행해도 안전합니다.
-- 1) 바우처 지우기 함수 (지운 파일 경로를 돌려줘서 화면이 저장소 파일도 지움)
create or replace function public.delete_voucher(p_trip uuid, p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_path text;
begin
  perform _require_trip(p_trip);
  delete from vouchers where id = p_id and trip_id = p_trip returning file_path into v_path;
  return v_path;
end $$;
grant execute on function public.delete_voucher(uuid, uuid) to anon, authenticated;

-- 2) 사진 저장소에 PDF(예약 확인서) 올리기 허용
update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm', 'application/pdf']
where id = 'photos';
