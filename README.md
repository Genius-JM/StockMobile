# 모바일 주식 재무정보 웹앱

GitHub Pages에서 실행되는 정적 웹앱입니다.

데이터 갱신은 GitHub Actions가 담당합니다.

- 네이버 금융: 현재가, 등락률, PER, PBR, 시가총액 등
- OpenDART: 재무제표 기반 매출액, 영업이익, 당기순이익, ROE, EPS 등
- Kiwoom API: 전체 종목 목록(코스피/코스닥) 및 시세 항목(가능 항목 우선 적용)

## 설정 방법

### 1. OpenDART API Key 발급

OpenDART에서 인증키를 발급받습니다.

### 2. GitHub Secret 등록

Repository에서 아래 경로로 이동합니다.

```text
Settings > Secrets and variables > Actions > New repository secret
```

이름은 아래처럼 입력합니다.

```text
OPENDART_API_KEY
```

값에는 발급받은 OpenDART 인증키를 넣습니다.

### 3. GitHub Actions 권한 설정

Repository에서 아래 경로로 이동합니다.

```text
Settings > Actions > General > Workflow permissions
```

아래 옵션을 선택합니다.

```text
Read and write permissions
```

### 4. 수동 실행

Repository 상단의 `Actions` 메뉴로 이동합니다.

`Update stock data` 워크플로우를 선택한 뒤 `Run workflow`를 누릅니다.

성공하면 `data/stocks.json`이 자동으로 갱신됩니다.

## 종목 추가

`data/stock-list.json`에 종목을 추가합니다.

```json
{
  "code": "005930",
  "name": "삼성전자",
  "corpCode": "00126380",
  "description": "설명",
  "peers": ["000660"]
}
```

`corpCode`를 모르면 비워둘 수도 있지만, 매번 OpenDART 고유번호 ZIP을 조회하므로 느려질 수 있습니다.

## 주의

네이버 금융은 공식 Open API가 아니라 화면 HTML을 읽는 방식입니다. 네이버 화면 구조가 바뀌면 일부 값이 비어 있을 수 있습니다.

OpenDART 재무제표 계정명은 회사별로 다를 수 있어서 일부 항목은 `-`로 표시될 수 있습니다.
키움 연동을 사용하려면 아래 secret/variable도 추가합니다.

```text
KIWOOM_APP_KEY
KIWOOM_APP_SECRET
```

선택적으로 엔드포인트가 다르면 아래를 Actions variable 또는 env로 지정할 수 있습니다.

```text
KIWOOM_BASE_URL
KIWOOM_TOKEN_PATH
KIWOOM_STOCK_LIST_PATH
KIWOOM_QUOTE_PATH
```
