"""키움 관심종목, OpenDART 고유번호, Finnhub 실적 일정을 가져오는 함수 모음.

키 값은 화면에 출력하지 않는다. 표준 라이브러리만 사용한다.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, time as dtime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ENV_PATH = Path(__file__).with_name(".env")
NEW_YORK = ZoneInfo("America/New_York")
SEOUL = ZoneInfo("Asia/Seoul")

# Finnhub hour 값별 대략적인 발표 시각(미국 동부 기준)
HOUR_LABELS = {"bmo": "장전", "amc": "장후", "dmh": "장중"}
HOUR_TIMES = {"bmo": dtime(7, 0), "amc": dtime(16, 0), "dmh": dtime(12, 0)}


def load_env(path: Path = ENV_PATH) -> dict[str, str]:
    env = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def _post_json(url: str, body: dict, headers: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json;charset=UTF-8", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code}: {error.read().decode('utf-8', 'replace')[:300]}")


class Kiwoom:
    """토큰 하나로 여러 TR을 호출하는 키움 REST API 클라이언트."""

    def __init__(self, env: dict[str, str]):
        self.base = env.get("KIWOOM_BASE_URL", "https://api.kiwoom.com").rstrip("/")
        token_data = _post_json(
            f"{self.base}/oauth2/token",
            {
                "grant_type": "client_credentials",
                "appkey": env["KIWOOM_APP_KEY"],
                "secretkey": env["KIWOOM_SECRET_KEY"],
            },
            {},
        )
        self.token = token_data.get("token")
        if not self.token:
            raise RuntimeError(f"키움 토큰 발급 실패: {token_data.get('return_code')} {token_data.get('return_msg')}")

    def call(self, path: str, api_id: str, body: dict) -> dict:
        time.sleep(0.3)  # TR별 호출 제한 대비
        result = _post_json(
            f"{self.base}{path}",
            body,
            {"api-id": api_id, "authorization": f"Bearer {self.token}"},
        )
        if result.get("return_code") not in (None, 0):
            raise RuntimeError(f"{api_id} 실패: {result.get('return_code')} {result.get('return_msg')}")
        return result


def kiwoom_watchlist(env: dict[str, str], kiwoom: Kiwoom | None = None) -> list[str]:
    """미국주식 관심그룹 전체의 종목코드를 중복 없이 순서대로 반환한다."""
    kiwoom = kiwoom or Kiwoom(env)
    symbols: list[str] = []
    for group in kiwoom.call("/api/us/watchlist", "usa20200", {}).get("nofi", []):
        detail = kiwoom.call("/api/us/watchlist", "usa20201", {"arn_grp_id": group.get("gcod")})
        for item in detail.get("nofj", []):
            symbol = item.get("cod2", "").strip()
            if symbol and symbol not in symbols:
                symbols.append(symbol)
    return symbols


def kiwoom_domestic_group(env: dict[str, str], group_name: str, kiwoom: Kiwoom | None = None) -> list[dict]:
    """국내 관심그룹 중 이름이 group_name인 그룹의 종목코드와 종목명을 반환한다."""
    kiwoom = kiwoom or Kiwoom(env)
    groups = kiwoom.call("/api/dostk/watchlist", "ka01300", {}).get("nofi", [])
    group = next((g for g in groups if g.get("name", "").strip() == group_name), None)
    if group is None:
        names = ", ".join(g.get("name", "").strip() for g in groups)
        raise RuntimeError(f"국내 관심그룹 '{group_name}'을 찾을 수 없습니다. 있는 그룹: {names}")
    detail = kiwoom.call("/api/dostk/watchlist", "ka01301", {"arn_grp_id": group.get("gcod")})
    stocks = []
    for item in detail.get("nofj", []):
        code = item.get("cod2", "").strip()
        if not code:
            continue
        info = kiwoom.call("/api/dostk/stkinfo", "ka10001", {"stk_cd": code})
        stocks.append({"code": code, "name": (info.get("stk_nm") or code).strip()})
    return stocks


CORP_CODE_CACHE = Path(__file__).with_name("corp_codes.json")


def dart_corp_codes(env: dict[str, str], stock_codes: list[str]) -> dict[str, str]:
    """종목코드를 OpenDART 고유번호(corp_code)로 바꾼다. 상장사가 아니면(ETF 등) 결과에서 빠진다.

    전체 목록(zip)은 크기가 커서 corp_codes.json에 캐시하고, 없는 종목이 있을 때만 다시 받는다.
    """
    import io
    import xml.etree.ElementTree as ET
    import zipfile

    cache = json.loads(CORP_CODE_CACHE.read_text(encoding="utf-8")) if CORP_CODE_CACHE.exists() else {}
    if any(code not in cache for code in stock_codes):
        query = urllib.parse.urlencode({"crtfc_key": env["OPENDART_API_KEY"]})
        with urllib.request.urlopen(f"https://opendart.fss.or.kr/api/corpCode.xml?{query}", timeout=120) as response:
            raw = response.read()
        if raw[:2] != b"PK":
            raise RuntimeError(f"OpenDART 고유번호 조회 실패: {raw[:200].decode('utf-8', 'replace')}")
        archive = zipfile.ZipFile(io.BytesIO(raw))
        root = ET.fromstring(archive.read(archive.namelist()[0]))
        cache = {}
        for item in root.iter("list"):
            stock_code = (item.findtext("stock_code") or "").strip()
            if stock_code:
                cache[stock_code] = item.findtext("corp_code")
        CORP_CODE_CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return {code: cache[code] for code in stock_codes if code in cache}


@dataclass
class Earnings:
    symbol: str
    date: date  # 미국 현지 발표일
    hour: str  # bmo, amc, dmh 또는 빈 값
    year: int
    quarter: int
    eps_estimate: float | None
    revenue_estimate: float | None

    @property
    def hour_label(self) -> str:
        return HOUR_LABELS.get(self.hour, "시간 미정")

    @property
    def seoul_time(self) -> datetime | None:
        """발표 시각을 한국 시간으로 바꾼다. 시간이 정해지지 않았으면 None."""
        if self.hour not in HOUR_TIMES:
            return None
        local = datetime.combine(self.date, HOUR_TIMES[self.hour], tzinfo=NEW_YORK)
        return local.astimezone(SEOUL)


def finnhub_earnings(env: dict[str, str], symbol: str, start: date, end: date) -> list[Earnings]:
    query = urllib.parse.urlencode({"from": start.isoformat(), "to": end.isoformat(), "symbol": symbol})
    request = urllib.request.Request(
        f"https://finnhub.io/api/v1/calendar/earnings?{query}",
        headers={"X-Finnhub-Token": env["FINNHUB_API_KEY"]},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        rows = json.loads(response.read().decode("utf-8")).get("earningsCalendar", [])
    return [
        Earnings(
            symbol=symbol,  # ADR은 Finnhub이 원래 상장 종목 코드로 돌려주므로 요청 티커를 쓴다
            date=date.fromisoformat(row["date"]),
            hour=row.get("hour") or "",
            year=row.get("year"),
            quarter=row.get("quarter"),
            eps_estimate=row.get("epsEstimate"),
            revenue_estimate=row.get("revenueEstimate"),
        )
        for row in rows
    ]


def upcoming_earnings(env: dict[str, str], symbols: list[str], days: int) -> list[Earnings]:
    start = date.today()
    end = start + timedelta(days=days)
    results: list[Earnings] = []
    for symbol in symbols:
        results.extend(finnhub_earnings(env, symbol, start, end))
        time.sleep(1.1)  # 무료 등급 분당 60회 제한
    return sorted(results, key=lambda e: (e.seoul_time or datetime.combine(e.date, dtime(0), tzinfo=SEOUL)))
