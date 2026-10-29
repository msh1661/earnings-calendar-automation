"""sources.py 검증. 실행: python -m unittest discover -s tests

외부 API 호출은 가짜 응답으로 바꿔서 키 없이 돌아간다.
"""

import io
import json
import sys
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sources  # noqa: E402


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeKiwoom:
    """TR 이름별로 정해 둔 응답을 돌려주는 키움 클라이언트."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def call(self, path, api_id, body):
        self.calls.append((api_id, body))
        value = self.responses[api_id]
        return value(body) if callable(value) else value


class LoadEnvTest(unittest.TestCase):
    def test_ignores_comments_and_keeps_equals_in_value(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text("﻿# 주석\nA=1\n\nB = x=y \nC=\n", encoding="utf-8")
            self.assertEqual(sources.load_env(path), {"A": "1", "B": "x=y", "C": ""})


class DomesticGroupTest(unittest.TestCase):
    def test_returns_codes_and_names_of_named_group(self):
        kiwoom = FakeKiwoom({
            "ka01300": {"nofi": [{"gcod": "000", "name": "반도체"}, {"gcod": "013", "name": "국장"}]},
            "ka01301": {"nofj": [{"cod2": "005930 "}, {"cod2": "0198B0"}]},
            "ka10001": lambda body: {"stk_nm": {"005930": "삼성전자", "0198B0": "1Q 레버리지"}[body["stk_cd"]]},
        })
        stocks = sources.kiwoom_domestic_group({}, "국장", kiwoom)
        self.assertEqual(stocks, [{"code": "005930", "name": "삼성전자"}, {"code": "0198B0", "name": "1Q 레버리지"}])
        self.assertIn(("ka01301", {"arn_grp_id": "013"}), kiwoom.calls)

    def test_missing_group_lists_existing_names(self):
        kiwoom = FakeKiwoom({"ka01300": {"nofi": [{"gcod": "000", "name": "반도체"}]}})
        with self.assertRaisesRegex(RuntimeError, "'국장'.*반도체"):
            sources.kiwoom_domestic_group({}, "국장", kiwoom)


def corp_code_zip(entries):
    items = "".join(
        f"<list><corp_code>{c}</corp_code><corp_name>회사</corp_name><stock_code>{s}</stock_code></list>"
        for c, s in entries
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("CORPCODE.xml", f"<result>{items}</result>")
    return buffer.getvalue()


class CorpCodeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "corp_codes.json"
        patcher = mock.patch.object(sources, "CORP_CODE_CACHE", self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_uses_cache_without_download(self):
        self.cache.write_text(json.dumps({"005930": "00126380"}), encoding="utf-8")
        with mock.patch.object(sources.urllib.request, "urlopen", side_effect=AssertionError("다운로드하면 안 됨")):
            self.assertEqual(sources.dart_corp_codes({}, ["005930"]), {"005930": "00126380"})

    def test_downloads_when_missing_and_drops_unlisted_codes(self):
        payload = corp_code_zip([("00126380", "005930"), ("99999999", " ")])
        with mock.patch.object(sources.urllib.request, "urlopen", return_value=FakeResponse(payload)):
            result = sources.dart_corp_codes({"OPENDART_API_KEY": "test"}, ["005930", "0198B0"])
        self.assertEqual(result, {"005930": "00126380"})
        self.assertEqual(json.loads(self.cache.read_text(encoding="utf-8")), {"005930": "00126380"})

    def test_error_response_is_reported(self):
        error = b'<?xml version="1.0"?><result><status>010</status><message>unregistered key</message></result>'
        with mock.patch.object(sources.urllib.request, "urlopen", return_value=FakeResponse(error)):
            with self.assertRaisesRegex(RuntimeError, "010"):
                sources.dart_corp_codes({"OPENDART_API_KEY": "bad"}, ["005930"])


class FinnhubTest(unittest.TestCase):
    def test_adr_keeps_requested_symbol(self):
        body = json.dumps({"earningsCalendar": [{
            "symbol": "2330.TW", "date": "2027-01-13", "hour": "bmo", "year": 2026, "quarter": 4,
            "epsEstimate": 32.2, "revenueEstimate": 1.6e12,
        }]}).encode()
        with mock.patch.object(sources.urllib.request, "urlopen", return_value=FakeResponse(body)):
            rows = sources.finnhub_earnings({"FINNHUB_API_KEY": "test"}, "TSM", date(2026, 10, 29), date(2027, 1, 27))
        self.assertEqual(rows[0].symbol, "TSM")

    def test_seoul_time_follows_daylight_saving(self):
        def make(day, hour):
            return sources.Earnings("AAPL", day, hour, 2026, 4, None, None)
        self.assertEqual(make(date(2026, 10, 29), "amc").seoul_time.strftime("%m/%d %H:%M"), "10/30 05:00")
        self.assertEqual(make(date(2026, 11, 2), "amc").seoul_time.strftime("%m/%d %H:%M"), "11/03 06:00")
        self.assertEqual(make(date(2026, 11, 2), "bmo").seoul_time.strftime("%m/%d %H:%M"), "11/02 21:00")
        self.assertIsNone(make(date(2026, 12, 8), "").seoul_time)


if __name__ == "__main__":
    unittest.main()
