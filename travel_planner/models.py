"""AI(Claude)가 돌려주는 결과 구조.

앱의 실제 데이터(스팟·일정·사진·지출 등)는 Supabase 테이블에 항목별로 저장되고(supabase/schema.sql),
AI 결과는 작업기가 그 테이블에 '추가'만 한다. 사용자가 고친 내용을 AI가 덮어쓰지 않는다.

지도·이미지 검색 링크와 사진 썸네일은 AI가 만들지 않고 화면 코드가 이름·검색어로 만든다.
"""

from typing import Literal

from pydantic import BaseModel, Field

Category = Literal["photo", "food", "cafe", "place", "landmark", "activity", "bar"]
CATEGORY_DESC = (
    "photo=사진 명소, food=먹거리(식당·시장·길거리 음식), cafe=카페·디저트, "
    "place=가볼 곳(동네·거리·공원·시장 구경), landmark=랜드마크(대표 건축물·명소), activity=즐길거리(공연·체험·쇼핑·투어), bar=술집(바·이자카야·펍·루프탑 바·포차)"
)
VERIFIED_DESC = "이번 작업에서 웹 검색으로 직접 확인했으면 true. 기억·추측이면 false"
SOURCE_DESC = "verified가 true일 때 확인한 페이지 URL. 아니면 빈 문자열"


class Fact(BaseModel):
    text: str
    source_url: str = Field(description=SOURCE_DESC)
    verified: bool = Field(description=VERIFIED_DESC)


class Spot(BaseModel):
    category: Category = Field(description=CATEGORY_DESC)
    name: str = Field(description="지도에서 검색되는 이름. 한국어 표기 (필요하면 괄호에 현지어/영문)")
    area: str = Field(description="동네·지역 이름")
    date: str = Field(description="방문 추천 날짜 YYYY-MM-DD (여행 기간 안). 날짜를 정하기 어려우면 빈 문자열")
    time: str = Field(description="추천 시간대 (예: 해 질 녘, 오전 10시, 저녁). 없으면 빈 문자열")
    note: str = Field(description="한두 문장 설명: 무엇을 보고·먹고·하는지, 팁")
    price: str = Field(description="대략 가격 (예: 1인 1,500엔). 모르면 빈 문자열")
    reservation_needed: bool
    search_query_en: str = Field(description="구글맵·이미지 검색용 영문 장소명 + 도시")
    source_url: str = Field(description=SOURCE_DESC)
    verified: bool = Field(description=VERIFIED_DESC)


class ScheduleItem(BaseModel):
    """시간이 정해진 고정 일정 (항공·체크인·공연·예약 등)."""

    date: str = Field(description="YYYY-MM-DD")
    time: str = Field(description="HH:MM (현지 시간). 모르면 빈 문자열")
    text: str = Field(description="예: 홍콩공항 도착 / 호텔 체크인")


class DayTitle(BaseModel):
    date: str = Field(description="YYYY-MM-DD")
    title: str = Field(description="그날의 테마 (예: 홍콩 도착 · 침사추이 야경)")


class BudgetEstimate(BaseModel):
    item: str
    amount_krw: int = Field(description="원 단위 정수. 모르면 0")
    note: str


class Video(BaseModel):
    url: str = Field(description="웹 검색으로 찾은 실제 YouTube 영상 주소 (https://www.youtube.com/watch?v=... 또는 youtu.be/...). 지어내지 말 것")
    why: str = Field(description="이 영상을 추천하는 이유 한 줄")


class Source(BaseModel):
    title: str
    url: str


class PlanResult(BaseModel):
    """새 여행 자동 추천 결과."""

    researched_on: str = Field(description="웹 조사한 날짜 YYYY-MM-DD. 웹 조사를 안 했으면 빈 문자열")
    destination_en: str = Field(description="목적지 영문 이름 (예: Fukuoka, Japan / Osaka and Kyoto, Japan)")
    alerts: list[Fact] = Field(description="여행 기간의 주의·변경 사항 (행사 일정·휴무·운영 종료·혼잡 등)")
    basic_info: list[str] = Field(description="'항목: 내용' 형식. 시차, 통화, 전압, 날씨, 교통, 입국 등")
    must_eat: list[str] = Field(description="꼭 먹어볼 음식 이름")
    day_titles: list[DayTitle]
    schedule: list[ScheduleItem] = Field(description="입력된 예약·항공에서 나온 고정 일정만")
    spots: list[Spot] = Field(description="카테고리별로 고르게. 날짜가 있는 것은 같은 날 같은 지역끼리 묶기")
    todos: list[str] = Field(description="출발 전 할 일 (예약·환전·유심 등)")
    packing: list[str] = Field(description="챙길 짐")
    budget_estimate: list[BudgetEstimate]
    emergency: list[str] = Field(description="현지 긴급 연락처, 영사관 등")
    videos: list[Video] = Field(description="웹 검색 결과에 실제로 나온 YouTube 영상 주소만 (확실하지 않으면 빈 배열. 주소를 지어내지 말 것)")
    video_queries: list[str] = Field(description="이 여행에 도움이 될 YouTube 검색어 3~5개 (예: 후쿠오카 브이로그, 후쿠오카 맛집 추천, 다자이후 가는 법)")
    sources: list[Source] = Field(description="참고한 출처 전체")


class RecommendResult(BaseModel):
    """카테고리별 AI 추천 더 받기 결과."""

    spots: list[Spot]
    videos: list[Video] = Field(description="웹 검색 결과에 실제로 나온 YouTube 영상 주소만 (확실하지 않으면 빈 배열)")
    video_queries: list[str] = Field(description="이 추천과 관련된 YouTube 검색어 1~2개")


class BlogSection(BaseModel):
    heading: str
    body: str = Field(description="본문 (여러 문단 가능, 줄바꿈은 \\n). 블로그 말투(~했어요)")
    photo_ids: list[str] = Field(description="이 단락에 넣을 사진·영상 id (주어진 목록에서만 고르기)")


class BlogResult(BaseModel):
    title: str
    intro: str
    sections: list[BlogSection]
    outro: str
    tags: list[str] = Field(description="해시태그용 키워드 (# 없이)")


# ---------- 스팟 사진·정보 모으기 ----------
class MenuItem(BaseModel):
    name: str = Field(description="메뉴 이름 (한국어, 필요하면 괄호에 현지어)")
    price: str = Field(description="금액만 짧게 (예: 980엔, 1,200~1,500엔). 기준 연도·세금 여부·설명은 쓰지 말 것. 확인 못 했으면 빈 문자열")
    desc: str = Field(description="어떤 메뉴인지 짧게 (15자 안팎). 없으면 빈 문자열")
    signature: bool = Field(description="이 집의 대표·인기 메뉴면 true")


class Point(BaseModel):
    title: str = Field(description="짧은 소제목 (12자 안팎)")
    body: str = Field(description="한두 문장")


class Cost(BaseModel):
    item: str = Field(description="예: 성인 입장료, 케이블카 왕복, 체험 1회")
    price: str = Field(description="현지 통화 금액 (원화 대략값을 괄호에). 모르면 빈 문자열")


class SpotDetail(BaseModel):
    id: str = Field(description="입력으로 받은 스팟 id 그대로")
    headline: str = Field(description="카드에 들어갈 한 줄 소개. 18~32자, 명사형으로 끝맺기 (예: '빅토리아 하버를 정면에서 담는 야경 명당')")
    intro: str = Field(description="상세 페이지 첫 문단. 2~3문장, '~해요'체")
    area: str = Field(description="동네·지역 (예: 침사추이, 하카타)")
    address: str = Field(description="주소 (현지 표기 또는 영문). 모르면 빈 문자열")
    hours: str = Field(description="운영·영업시간. 요일별로 다르면 함께 (예: 11:00–22:00 (L.O. 21:30))")
    closed: str = Field(description="휴무일. 연중무휴면 '연중무휴', 모르면 빈 문자열")
    price_range: str = Field(description="1인 기준 실제로 많이 쓰는 금액 범위 (예: 1인 1,200~2,000엔 · 약 1.1~1.8만 원)")
    menu: list[MenuItem] = Field(description="먹거리·카페만: 대표·인기 메뉴 4~8개와 최신 가격. 그 외 카테고리는 빈 배열")
    highlights: list[Point] = Field(description=(
        "3~5개. 사진 명소=촬영 포인트·구도, 먹거리·카페=이 집의 특징, 즐길거리=사람들이 주로 즐기는 것, "
        "랜드마크=왜 랜드마크인지·왜 가 봐야 하는지, 가볼 곳=둘러볼 것"))
    costs: list[Cost] = Field(description="즐길거리·랜드마크·사진 명소의 입장료·체험비·교통비. 무료면 '입장료'·'무료'. 먹거리·카페는 빈 배열")
    best_time: str = Field(description="가기 좋은 시간·시기 (예: 해 지기 30분 전, 평일 오전). 없으면 빈 문자열")
    how_to_get: str = Field(description="가는 법 (가까운 역·출구·도보 시간). 확인 못 했으면 빈 문자열")
    reservation: str = Field(description="예약 필요 여부와 방법 (예: 구글맵 예약 가능, 웨이팅 30분 안팎). 없으면 빈 문자열")
    tips: list[str] = Field(description="알아 두면 좋은 팁 2~4개 (한 문장씩)")
    cautions: list[str] = Field(description="주의할 점 1~4개 (휴무·현금만·드레스코드·소매치기·우천 시 운영 등)")
    image_queries: list[str] = Field(description=(
        "사진 검색어 2~4개. 먹거리·카페는 '가게 이름 + 대표 메뉴 이름', 그 외는 '장소 이름 + 도시' 위주. 한국어·현지어 섞어도 됨"))
    sources: list[Source] = Field(description="실제로 열어 보거나 검색 결과에서 확인한 페이지만")


class EnrichResult(BaseModel):
    spots: list[SpotDetail]


# ---------- YouTube 영상 정리 ----------
class VideoNote(BaseModel):
    id: str = Field(description="입력으로 받은 영상 id 그대로")
    summary: str = Field(description="영상 요약 3~4문장. 어떤 코스·분위기인지, 누구에게 도움이 되는지. '~해요'체")
    points: list[str] = Field(description="영상의 핵심 정보 3~6개 (코스 순서, 가격, 이동 방법, 시간대 등 구체적으로)")
    tips: list[str] = Field(description="영상에서 말한 꿀팁·주의사항 0~5개")


class VideoSpot(Spot):
    video_id: str = Field(description="이 장소가 나온 영상 id")
    said: str = Field(description="영상에서 이 장소에 대해 말한 내용 한두 문장 (먹은 메뉴·가격·분위기·팁). 영상에 없는 내용은 쓰지 말 것")


class YoutubeResult(BaseModel):
    videos: list[VideoNote]
    spots: list[VideoSpot] = Field(description="영상에 실제로 나오거나 언급된 장소만. 숙소·공항·역처럼 '가 볼 곳'이 아닌 곳은 빼기")


# ---------- 예약·바우처 읽기 ----------
VoucherKind = Literal["flight", "hotel", "ticket", "tour", "restaurant", "transport", "other"]


class VoucherSegment(BaseModel):
    title: str = Field(description="일정 이름 (예: 'KE2001 인천 → 홍콩', '더 럭스 매너 체크인', '하우스 오브 댄싱 워터 16:30 회차')")
    date: str = Field(description="YYYY-MM-DD (현지 날짜). 모르면 빈 문자열")
    time: str = Field(description="HH:MM 24시간 (현지 시간, 항공은 그 공항 현지 시각). 모르면 빈 문자열")
    end_time: str = Field(description="HH:MM 끝나는 시간 (항공은 도착 시각, 공연은 종료). 모르면 빈 문자열")
    place: str = Field(description="가야 하는 곳 (공항·터미널·호텔 주소·공연장). 항공은 여행지 쪽 공항 (가는 편=도착 공항, 오는 편=출발 공항). 지도 검색이 되도록 영문·현지 표기 우선")
    note: str = Field(description="이 일정에 필요한 한 줄 (터미널·게이트·좌석·체크인 시간 등). 없으면 빈 문자열")


class VoucherResult(BaseModel):
    kind: VoucherKind = Field(description="flight=항공, hotel=숙소, ticket=입장권·공연, tour=투어·체험, restaurant=식당 예약, transport=페리·기차·버스·공항철도, other=그 외")
    title: str = Field(description="짧은 이름 (예: '대한항공 KE2001/KE2006', '더 럭스 매너 호텔 2박', '하우스 오브 댄싱 워터')")
    provider: str = Field(description="예약처·발권처 (예: 클룩, 야놀자, 대한항공). 모르면 빈 문자열")
    booking_no: str = Field(description="예약번호·확인번호·바우처 번호 (문서에 적힌 그대로). 없으면 빈 문자열")
    people: str = Field(description="이용자·인원 (예: '성인 2', '조성희 외 1명'). 없으면 빈 문자열")
    amount: str = Field(description="결제 금액 원문 그대로 (예: 'KRW 264,000', 'HKD 1,850'). 없으면 빈 문자열")
    amount_krw: int = Field(description="원화 금액이 문서에 있으면 그 정수, 없으면 0 (환산하지 말 것)")
    segments: list[VoucherSegment] = Field(description=(
        "일정에 넣을 시간 단위. 항공=편마다 1개(출발 시각=time, 도착=end_time), 숙소=체크인 1개 + 체크아웃 1개, "
        "공연·입장권·투어·식당=1개. 날짜·시간이 없으면 빈 배열"))
    key_info: list[str] = Field(description="현장에서 필요한 정보 2~8개 (좌석·객실·포함 사항·수하물·취소 규정·준비물·집합 장소 등)")
    has_qr: bool = Field(description="QR코드·바코드가 보이면 true")
    unclear: list[str] = Field(description="흐리거나 잘려서 확실하지 않은 부분 (없으면 빈 배열)")
