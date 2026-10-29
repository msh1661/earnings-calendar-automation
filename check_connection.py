"""키움 REST API와 Finnhub 연결을 확인하는 점검 스크립트.

키 값은 화면에 출력하지 않는다. 표준 라이브러리만 사용한다.
"""

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ENV_PATH = Path(__file__).with_name(".env")


def load_env(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def post_json(url: str, body: dict, headers: dict) -> tuple[int, dict]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json;charset=UTF-8", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", errors="replace")
        try:
            return error.code, json.loads(text)
        except json.JSONDecodeError:
            return error.code, {"raw": text[:300]}


def check_finnhub(env: dict[str, str]) -> None:
    key = env.get("FINNHUB_API_KEY", "")
    print("[Finnhub]")
    if not re.fullmatch(r"[a-z0-9]{40}", key):
        print(f"  키 형식이 예상과 다릅니다(길이 {len(key)}). 키 외의 글자가 섞였는지 확인하세요.")
    request = urllib.request.Request(
        "https://finnhub.io/api/v1/quote?symbol=AAPL",
        headers={"X-Finnhub-Token": key},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
            print(f"  연결 성공: AAPL 현재가 {data.get('c')}")
    except urllib.error.HTTPError as error:
        print(f"  연결 실패: HTTP {error.code}")


def check_kiwoom(env: dict[str, str]) -> None:
    base = env.get("KIWOOM_BASE_URL", "https://api.kiwoom.com").rstrip("/")
    print("[키움 REST API]")

    status, data = post_json(
        f"{base}/oauth2/token",
        {
            "grant_type": "client_credentials",
            "appkey": env.get("KIWOOM_APP_KEY", ""),
            "secretkey": env.get("KIWOOM_SECRET_KEY", ""),
        },
        {},
    )
    token = data.get("token")
    if not token:
        print(f"  토큰 발급 실패: HTTP {status}, 코드 {data.get('return_code')}, {data.get('return_msg') or data}")
        return
    print(f"  토큰 발급 성공 (만료 {data.get('expires_dt')})")

    def call(api_id: str, body: dict) -> dict:
        _, result = post_json(
            f"{base}/api/us/watchlist",
            body,
            {"api-id": api_id, "authorization": f"Bearer {token}"},
        )
        return result

    groups = call("usa20200", {})
    if groups.get("return_code") not in (None, 0):
        print(f"  관심그룹 조회 실패: 코드 {groups.get('return_code')}, {groups.get('return_msg')}")
        return
    group_list = groups.get("nofi", [])
    print(f"  미국주식 관심그룹 {len(group_list)}개")
    for group in group_list:
        detail = call("usa20201", {"arn_grp_id": group.get("gcod")})
        items = detail.get("nofj", [])
        symbols = ", ".join(item.get("cod2", "").strip() for item in items)
        print(f"  - [{group.get('gcod')}] {group.get('name')}: {len(items)}종목 {symbols}")
        if detail.get("return_code") not in (None, 0):
            print(f"    상세 조회 메시지: {detail.get('return_msg')}")


if __name__ == "__main__":
    env = load_env(ENV_PATH)
    check_finnhub(env)
    check_kiwoom(env)
