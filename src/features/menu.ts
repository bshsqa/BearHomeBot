export type FeatureCategoryId =
  "recommended" | "daily" | "business" | "property" | "writing" | "research";

export interface FeatureEntry {
  skillId: string;
  description: string;
}

export interface FeatureCategory {
  id: FeatureCategoryId;
  label: string;
  features: readonly FeatureEntry[];
}

export const FEATURE_CATEGORIES: readonly FeatureCategory[] = [
  {
    id: "recommended",
    label: "너한테 바로 쓸만한 것",
    features: [
      {
        skillId: "ktx-booking",
        description:
          "KTX 조회, 좌석 상세, 예약과 취소를 처리한다. 결제는 제외한다.",
      },
      {
        skillId: "srt-booking",
        description:
          "수서 출발·도착 SRT 조회와 예약을 처리하고 예약 대기와 매진 재시도를 지원한다.",
      },
      {
        skillId: "express-bus-booking",
        description: "고속버스 시간표와 좌석을 조회하고 예매 단계로 연결한다.",
      },
      {
        skillId: "intercity-bus-booking",
        description: "시외버스 시간표와 좌석을 조회하고 예매 단계로 연결한다.",
      },
      {
        skillId: "flight-ticket-search",
        description: "항공권 가격과 일정 후보를 찾아 비교한다.",
      },
      {
        skillId: "myrealtrip-search",
        description: "숙소, 투어와 여행 상품 가격 후보를 찾는다.",
      },
      {
        skillId: "foresttrip-vacancy",
        description:
          "숲나들e 자연휴양림의 빈 객실을 조회하고 취소 객실을 찾는다.",
      },
      {
        skillId: "catchtable-sniper",
        description:
          "캐치테이블의 빈 예약 슬롯을 감시하고 예약을 시도한다. 로그인된 브라우저가 필요할 수 있다.",
      },
    ],
  },
  {
    id: "daily",
    label: "생활 편의 쪽",
    features: [
      {
        skillId: "delivery-tracking",
        description: "CJ대한통운과 우체국 등 택배 배송 상태를 추적한다.",
      },
      {
        skillId: "daiso-product-search",
        description: "다이소 매장의 상품과 재고를 확인한다.",
      },
      {
        skillId: "olive-young-search",
        description: "올리브영 매장, 상품과 재고를 조회한다.",
      },
      {
        skillId: "market-kurly-search",
        description: "마켓컬리 상품과 가격을 검색한다.",
      },
      {
        skillId: "coupang-product-search",
        description: "쿠팡 상품과 가격 후보를 검색한다.",
      },
      {
        skillId: "naver-shopping-search",
        description: "네이버쇼핑 상품과 판매처 가격을 비교한다.",
      },
      {
        skillId: "danawa-price-search",
        description: "다나와에서 배송비를 포함한 실구매가를 비교한다.",
      },
      {
        skillId: "ohou-today-deal",
        description: "오늘의집 오늘의딜 상품과 가격을 찾는다.",
      },
      {
        skillId: "cheap-gas-nearby",
        description: "현재 위치 주변의 저렴한 주유소를 찾는다.",
      },
      {
        skillId: "parking-lot-search",
        description: "주변 주차장과 이용 정보를 찾는다.",
      },
      {
        skillId: "public-restroom-nearby",
        description: "주변 공중화장실을 찾는다.",
      },
      {
        skillId: "seoul-bike",
        description: "서울 따릉이 대여소와 실시간 대여 가능 수를 조회한다.",
      },
      {
        skillId: "seoul-subway-arrival",
        description: "서울 지하철 실시간 도착 정보를 조회한다.",
      },
      {
        skillId: "seoul-density",
        description: "서울 주요 장소의 실시간 혼잡도를 조회한다.",
      },
      {
        skillId: "korea-weather",
        description: "한국 지역별 날씨와 예보를 조회한다.",
      },
      {
        skillId: "fine-dust-location",
        description: "현재 위치의 미세먼지 상태를 조회한다.",
      },
      {
        skillId: "han-river-water-level",
        description: "한강 관측소의 수위 정보를 조회한다.",
      },
    ],
  },
  {
    id: "business",
    label: "돈·사업·법인/실사 쪽",
    features: [
      {
        skillId: "biz-health-check",
        description:
          "사업자 상태, 국민연금 사업장, 체납, 법인개요, 조달 제재와 인허가 상태를 교차 확인한다.",
      },
      {
        skillId: "nts-business-registration",
        description: "사업자등록 상태와 진위를 확인한다.",
      },
      {
        skillId: "localdata-business-status",
        description:
          "식당, 카페, 약국과 학원 등의 인허가 영업·폐업 상태를 확인한다.",
      },
      {
        skillId: "fsc-corporate-info",
        description: "금융위원회 데이터로 법인 개요와 상태를 조회한다.",
      },
      {
        skillId: "national-pension-workplace",
        description: "국민연금 사업장 정보로 회사 규모 단서를 확인한다.",
      },
      {
        skillId: "nts-tax-delinquency",
        description: "고액·상습 체납 공개 정보에서 리스크 단서를 확인한다.",
      },
      {
        skillId: "g2b-sanctioned-supplier",
        description: "나라장터 부정당업자 제재 정보를 조회한다.",
      },
      {
        skillId: "popbill",
        description:
          "전자세금계산서, 현금영수증, 문자, 카카오와 팩스 업무를 처리한다. 별도 credential이 필요하다.",
      },
      {
        skillId: "korean-jangbu-for",
        description:
          "1인 법인, 프리랜서와 스타트업의 장부·세무자료 정리를 보조한다.",
      },
    ],
  },
  {
    id: "property",
    label: "부동산·공문서",
    features: [
      {
        skillId: "real-estate-search",
        description:
          "아파트, 오피스텔, 빌라와 단독주택의 실거래가·전월세를 조회한다.",
      },
      {
        skillId: "building-register-search",
        description: "주소로 건축물대장 표제부를 조회한다.",
      },
      {
        skillId: "housing-official-price",
        description: "주택과 공동주택의 공시가격을 조회한다.",
      },
      {
        skillId: "court-auction-notice-search",
        description: "법원경매 매각공고와 사건 정보를 조회한다.",
      },
      {
        skillId: "iros-registry-automation",
        description:
          "인터넷등기소 등기부등본 발급을 보조한다. 로그인과 결제는 사용자가 직접 진행한다.",
      },
      {
        skillId: "lh-notice-search",
        description: "LH 청약과 임대 공고를 검색한다.",
      },
      {
        skillId: "sh-notice-search",
        description: "SH 청약과 임대 공고를 검색한다.",
      },
    ],
  },
  {
    id: "writing",
    label: "문서/글쓰기",
    features: [
      {
        skillId: "hwp",
        description: "HWP와 HWPX 문서를 읽고 변환한다.",
      },
      {
        skillId: "rhwp-edit",
        description: "HWPX 문서의 내용을 편집한다.",
      },
      {
        skillId: "rhwp-advanced",
        description: "HWPX 문서의 고급 구조와 서식을 다룬다.",
      },
      {
        skillId: "korean-spell-check",
        description: "한국어 맞춤법과 문장을 점검한다.",
      },
      {
        skillId: "korean-humanizer",
        description: "AI 티가 나는 한국어 문장을 자연스럽게 다듬는다.",
      },
      {
        skillId: "korean-character-count",
        description: "글자 수, 줄 수와 입력란 기준 바이트를 계산한다.",
      },
      {
        skillId: "korean-privacy-terms",
        description:
          "Next.js 프로젝트용 개인정보처리방침, 약관과 동의 UI를 만든다.",
      },
    ],
  },
  {
    id: "research",
    label: "정보 탐색/리서치",
    features: [
      {
        skillId: "k-dart",
        description: "DART 공시, 재무제표와 기업개황을 조회한다.",
      },
      {
        skillId: "korean-stock-search",
        description: "한국 주식 종목과 시장 정보를 조회한다.",
      },
      {
        skillId: "toss-securities",
        description: "토스증권 CLI로 종목과 투자 정보를 조회한다.",
      },
      {
        skillId: "daishin-report-search",
        description: "대신증권 리서치 보고서를 검색한다.",
      },
      {
        skillId: "bok-ecos-stats",
        description: "한국은행 ECOS 경제통계를 조회한다.",
      },
      {
        skillId: "kosis-stats",
        description: "KOSIS 국가통계를 조회한다.",
      },
      {
        skillId: "korean-law-search",
        description: "대한민국 법령과 조문을 검색한다.",
      },
      {
        skillId: "korean-patent-search",
        description: "한국 특허와 출원 정보를 검색한다.",
      },
      {
        skillId: "keris-academic-search",
        description: "KERIS/RISS 학술자료를 검색한다.",
      },
      {
        skillId: "library-book-search",
        description: "도서관 소장 도서와 대출 가능 여부를 검색한다.",
      },
      {
        skillId: "naver-news-search",
        description: "네이버 뉴스에서 한국 기사와 원문을 검색한다.",
      },
      {
        skillId: "naver-blog-research",
        description: "네이버 블로그 자료를 수집해 주제별로 조사한다.",
      },
      {
        skillId: "geeknews-search",
        description: "GeekNews의 한국 기술 트렌드와 글을 검색한다.",
      },
    ],
  },
];

export function findFeatureCategory(
  categoryId: string,
): FeatureCategory | undefined {
  return FEATURE_CATEGORIES.find((category) => category.id === categoryId);
}

export function formatFeatureCategory(category: FeatureCategory): string {
  const lines = [category.label, ""];
  for (const feature of category.features) {
    lines.push(feature.skillId, feature.description, "");
  }
  return lines.join("\n").trimEnd();
}
