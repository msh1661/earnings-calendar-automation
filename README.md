# 실적발표 캘린더 자동화

키움증권 관심종목의 실적발표 일정을 매일 자동으로 조회해 구글 캘린더(노션 캘린더)에 기록한다.

![구조도](docs/architecture.png)

## 동작 방식

- **PC (로그온 시):** `sync_watchlist.py`가 키움 REST API로 미국 관심그룹 전체와 국내 지정 그룹을 읽어 구글 시트로 보낸다. 키움 API는 등록한 IP에서만 호출되므로 이 단계만 PC에 둔다.
- **구글 (매일 오전 7시):** Apps Script `syncEarnings`가 시트의 종목으로 실적 일정을 조회해 캘린더에 반영하고, 결과를 '운영기록' 시트에 남긴다. PC가 꺼져 있어도 동작한다.
  - 미국: Finnhub 실적 캘린더 (장전 07:00 · 장후 16:00 ET 대표 시각)
  - 국내 확정: OpenDART '기업설명회(IR) 개최' 공시 중 개최목적에 '실적'이 있는 것
  - 국내 예상: 작년 같은 시기 분기 실적 공시일 + 364일

## 파일

| 파일 | 역할 |
|---|---|
| `sources.py` | 키움 · OpenDART · Finnhub 조회 함수 |
| `sync_watchlist.py` | 관심종목을 Apps Script 웹앱으로 전송 |
| `check_connection.py` | 키움 · Finnhub 연결 점검 |
| `preview_earnings.py` | 미국 실적 일정 미리보기 |
| `apps_script/Code.gs` | 웹앱, 매일 실적 동기화, 운영기록 |
| `.env.example` | 설정 템플릿 |

## 설정 요약

1. `.env.example`을 `.env`로 복사하고 키를 채운다.
2. 구글 시트 > 확장 프로그램 > Apps Script에 `Code.gs`를 붙여넣고, 시간대를 서울로 설정한다.
3. 스크립트 속성에 `FINNHUB_API_KEY`, `SYNC_TOKEN`, `CALENDAR_ID`, `OPENDART_API_KEY`를 넣는다.
4. 웹앱으로 배포하고 URL을 `.env`의 `APPS_SCRIPT_URL`에 넣는다.
5. `python sync_watchlist.py` 실행 → Apps Script에서 `syncEarnings`, `setupDailyTrigger` 실행.
6. Windows 작업 스케줄러에 로그온 시 `pythonw.exe sync_watchlist.py` 실행을 등록한다.

표준 라이브러리만 사용한다(Python 3.11).

자세한 과정과 판단 근거는 [과정 정리 문서](실적발표%20캘린더%20자동화_과정정리_2026-10-29.md)에 있다.
