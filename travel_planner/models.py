"""여행 계획 데이터 구조.

Claude는 이 구조에 맞춘 JSON만 돌려주고(구조화 출력),
앱 화면(docs/app.js)이 이 구조를 그린다.
확정 예약 원문·총예산·통화는 AI 결과가 아니라 사용자가 입력한 별도 데이터로 저장한다(schema.sql).
지도·이미지 검색 링크는 Claude가 만들지 않고 화면 코드가 *_query 필드로 생성한다
(잘못된 URL이 들어가는 것을 막기 위해).
"""

from pydantic import BaseModel, Field

VERIFIED_DESC = "이번 작업에서 웹 검색으로 직접 확인했으면 true. 기억·추측이면 false"
SOURCE_DESC = "verified가 true일 때 확인한 페이지 URL. 아니면 빈 문자열"


class Fact(BaseModel):
    """출처를 붙일 수 있는 사실 한 줄 (행사 일정, 휴무, 운영 종료 등)."""

    text: str
    source_url: str = Field(description=SOURCE_DESC)
    verified: bool = Field(description=VERIFIED_DESC)


class Todo(BaseModel):
    text: str
    done: bool = Field(description="입력에서 이미 완료됐다고 한 것만 true")


class Flight(BaseModel):
    direction: str = Field(description="가는편 / 오는편 등")
    airline: str
    date: str = Field(description="예: 11/26")
    time: str = Field(description="예: 08:10~11:20 (현지 시간)")
    flight_no: str
    price: str
    booked_via: str
    status: str = Field(description="예약완료 / 미예약 / 후보")


class Lodging(BaseModel):
    name: str
    area: str
    check_in: str
    check_out: str
    price: str
    booked_via: str
    address: str
    map_query: str = Field(description="구글맵 검색어 (영문 장소명 + 지역)")
    status: str


class Reservation(BaseModel):
    """공연·투어·페리 등 시간이 정해진 예약."""

    category: str = Field(description="공연 / 페리 / 투어 / 기차 등")
    name: str
    place: str
    date: str
    time: str
    price: str
    booked_via: str
    status: str
    notes: list[str]
    source_url: str = Field(description="운영 요일·시간을 확인한 페이지 URL. 확인 안 했으면 빈 문자열")
    verified: bool = Field(description="운영 요일·시간을 " + VERIFIED_DESC)


class Day(BaseModel):
    title: str = Field(description="예: Day 1 - 11/26 (목) 홍콩 도착 · 침사추이")
    fixed_schedule: list[str] = Field(
        description="시간이 정해진 일정만. 예: '11:20 ✅ 홍콩공항 도착'. 확정은 ✅, 미예약은 ❌"
    )
    stay: str = Field(description="그날 숙소. 마지막 날이면 빈 문자열")
    places: list[str] = Field(
        description="같은 지역끼리 묶은 갈 곳 (방문 추천 순서대로). '장소 — 한 줄 팁' 형식. 장소명은 지도에서 검색되는 이름으로"
    )
    foods: list[str] = Field(description="같은 지역끼리 묶은 먹을 곳. '식당 — 메뉴' 형식")


class PhotoSpot(BaseModel):
    name: str
    area: str
    best_time: str
    point: str
    search_query_en: str = Field(description="구글 검색용 영문 장소명 + 도시")
    source_url: str = Field(description=SOURCE_DESC)
    verified: bool = Field(description=VERIFIED_DESC)


class Activity(BaseModel):
    name: str
    area: str
    duration: str
    price: str
    reservation_needed: bool
    priority: int = Field(description="1~3, 3이 가장 높음")
    note: str
    source_url: str = Field(description="가격·운영 정보를 확인한 페이지 URL. 아니면 빈 문자열")
    verified: bool = Field(description="가격·운영 정보를 " + VERIFIED_DESC)


class Restaurant(BaseModel):
    name: str
    area: str
    menu: str
    feature: str
    price_range: str
    reservation_needed: bool
    meal_type: str = Field(description="아침·점심 / 식사 / 간식 / 카페 / 분위기 디너 등")
    search_query_en: str = Field(description="구글맵 검색용 영문 식당명 + 지역")
    source_url: str = Field(description="영업 중인지·메뉴·가격을 확인한 페이지 URL. 아니면 빈 문자열")
    verified: bool = Field(description="영업 중인지·메뉴·가격을 " + VERIFIED_DESC)


class BudgetItem(BaseModel):
    item: str
    amount_krw: int = Field(description="원 단위 정수. 모르면 0")
    note: str


class Source(BaseModel):
    title: str
    url: str


class TripPlan(BaseModel):
    page_title: str
    heading: str = Field(description="예: ✈️ 해외여행 계획 - [홍콩·마카오]")
    researched_on: str = Field(description="웹 조사한 날짜 YYYY-MM-DD. 웹 조사를 안 했으면 빈 문자열")
    confirmed: list[str] = Field(description="이미 예약·확정된 사항 요약 (사용자 입력 원문은 앱이 따로 보여 주므로 요약만)")
    alerts: list[Fact] = Field(description="여행 기간에 해당하는 주의·변경 사항 (휴무, 행사 일정·종료 등), 각각 출처와 확인 여부")
    basic_info: list[str] = Field(description="기간, 동행, 예산, 시차, 통화, 전압, 날씨 등 '항목: 내용'")
    todos: list[Todo] = Field(description="출발 전 할 일, 우선순위 순")
    flights: list[Flight]
    lodgings: list[Lodging]
    reservations: list[Reservation]
    days: list[Day]
    photo_spots: list[PhotoSpot]
    activities: list[Activity]
    must_eat: list[str]
    restaurants: list[Restaurant]
    budget: list[BudgetItem]
    checklist_before: list[str]
    packing: list[str]
    emergency: list[str]
    memo: list[str]
    sources: list[Source] = Field(description="웹 검색에서 실제로 참고한 출처만 (항목별 source_url과 별개로 전체 참고 자료)")
