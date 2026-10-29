"""관심종목의 다가오는 실적발표일을 한국 시간 기준으로 출력한다."""

import sys

from sources import load_env, kiwoom_watchlist, upcoming_earnings

sys.stdout.reconfigure(encoding="utf-8")

WEEKDAYS = "월화수목금토일"


def main() -> None:
    env = load_env()
    days = int(env.get("LOOKAHEAD_DAYS", "30"))
    symbols = kiwoom_watchlist(env)
    print(f"관심종목 {len(symbols)}개, 오늘부터 {days}일 조회 중...\n")

    earnings = upcoming_earnings(env, symbols, days)
    for e in earnings:
        seoul = e.seoul_time
        when = (
            f"{seoul:%m/%d}({WEEKDAYS[seoul.weekday()]}) {seoul:%H:%M}경"
            if seoul
            else f"{e.date:%m/%d} 미국 현지, 시간 미정"
        )
        eps = f"{e.eps_estimate:.2f}" if e.eps_estimate is not None else "-"
        revenue = f"{e.revenue_estimate / 1e9:,.1f}B" if e.revenue_estimate else "-"
        print(f"{when:<22} {e.symbol:<6} {e.year} Q{e.quarter} {e.hour_label:<4} EPS 예상 {eps:>6} 매출 예상 {revenue:>8}")

    found = {e.symbol for e in earnings}
    missing = [s for s in symbols if s not in found]
    print(f"\n일정 없음 {len(missing)}개: {', '.join(missing)}")


if __name__ == "__main__":
    main()
