# 모바일 주식 재무정보 웹앱

GitHub Pages에서 바로 실행할 수 있는 정적 웹앱입니다.

## 파일 구조

```text
index.html
style.css
app.js
data/stocks.json
```

## 실행 방법

1. GitHub에서 새 Repository를 만듭니다.
2. 이 폴더 안의 파일들을 Repository 루트에 업로드합니다.
3. GitHub Repository에서 Settings > Pages로 이동합니다.
4. Branch를 `main`, Folder를 `/root`로 선택합니다.
5. 생성된 GitHub Pages 주소를 핸드폰에서 엽니다.
6. 핸드폰 브라우저에서 "홈 화면에 추가"를 누르면 앱처럼 사용할 수 있습니다.

## 데이터 수정 방법

`data/stocks.json` 파일을 열어서 종목, PER, PBR, ROE, EPS, BPS, 실적 데이터를 바꾸면 됩니다.

## 실시간 API 연동

이 버전은 API 키 노출을 막기 위해 정적 JSON 조회 방식입니다.
실시간 API를 붙이려면 다음 중 하나가 필요합니다.

- API 키가 필요 없는 공개 API를 브라우저에서 직접 호출
- CORS가 허용된 API 사용
- API 키가 필요한 경우 작은 백엔드 서버 또는 GitHub Actions 배치 사용

## 추천 운영 방식

처음에는 `stocks.json`을 수동으로 수정해 사용하고,
나중에 GitHub Actions로 하루 1회 자동 갱신하도록 확장하는 것을 추천합니다.
