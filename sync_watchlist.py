"""키움 미국주식 관심종목과 국내 지정 관심그룹을 구글 시트(Apps Script 웹앱)로 보낸다.

PC 로그온 시 작업 스케줄러가 pythonw.exe로 창 없이 실행한다.
결과는 같은 폴더의 sync.log에 남긴다. 키 값은 기록하지 않는다.
"""

import json
import logging
import urllib.request
from logging.handlers import RotatingFileHandler
from pathlib import Path

from sources import Kiwoom, dart_corp_codes, kiwoom_domestic_group, kiwoom_watchlist, load_env

LOG_PATH = Path(__file__).with_name("sync.log")


def setup_logging() -> None:
    handlers: list[logging.Handler] = [
        RotatingFileHandler(LOG_PATH, maxBytes=200_000, backupCount=1, encoding="utf-8")
    ]
    # pythonw.exe로 실행하면 콘솔이 없으므로 파일에만 기록한다.
    import sys
    if sys.stdout is not None:
        sys.stdout.reconfigure(encoding="utf-8")
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)


def main() -> None:
    env = load_env()
    kiwoom = Kiwoom(env)
    symbols = kiwoom_watchlist(env, kiwoom)

    # 국내는 지정한 관심그룹만 보내고, 실적 공시가 있는 상장사(고유번호가 있는 종목)만 남긴다.
    kr_stocks = []
    group_name = env.get("KR_WATCHLIST_GROUP", "")
    if group_name and env.get("OPENDART_API_KEY"):
        stocks = kiwoom_domestic_group(env, group_name, kiwoom)
        corp_codes = dart_corp_codes(env, [s["code"] for s in stocks])
        kr_stocks = [{**s, "corpCode": corp_codes[s["code"]]} for s in stocks if s["code"] in corp_codes]

    request = urllib.request.Request(
        env["APPS_SCRIPT_URL"],
        data=json.dumps(
            {"token": env["APPS_SCRIPT_TOKEN"], "symbols": symbols, "krStocks": kr_stocks}
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # Apps Script 웹앱은 결과를 리디렉션으로 돌려주며, urllib이 이를 자동으로 따라간다.
    with urllib.request.urlopen(request, timeout=60) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not result.get("ok"):
        raise RuntimeError(f"동기화 실패: {result.get('error')}")
    logging.info("미국 관심종목 %d개를 시트에 저장했습니다: %s", result["count"], ", ".join(symbols))
    logging.info(
        "국내 '%s' 그룹 %d개를 시트에 저장했습니다: %s",
        group_name, result.get("krCount", 0), ", ".join(s["name"] for s in kr_stocks),
    )


if __name__ == "__main__":
    setup_logging()
    try:
        main()
    except Exception:
        logging.exception("관심종목 동기화 중 오류")
        raise SystemExit(1)
