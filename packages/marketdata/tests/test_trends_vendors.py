"""当日分时解析:A 股钟面是上海时区的 Unix 秒,美股盘前保留在美东日期内。"""

from datetime import datetime
from zoneinfo import ZoneInfo

from marketdata.defaults import StaticConfigProvider
from marketdata.client import MarketData
from marketdata.ports import SourceConfig
from marketdata.vendors.trends import (
    EastmoneyTrendsVendor,
    parse_eastmoney_trends,
    parse_tencent_trends,
    parse_yahoo_trends,
)


def test_eastmoney_cn_clock_is_shanghai_unix():
    payload = {
        "data": {
            "preClose": 10.0,
            "trends": [
                "2026-09-22 09:30,10.20,10.10,100,1020",
                "2026-09-22 10:00,10.25,10.12,90,922",
                "2026-09-22 11:30,10.30,10.15,80,824",
                "2026-09-22 13:00,10.28,10.16,50,514",
                "2026-09-22 15:00,10.40,10.20,60,624",
            ],
        }
    }
    bars = parse_eastmoney_trends(payload, market="CN")
    assert [p.time[11:] for p in bars] == ["09:30", "10:00", "11:30", "13:00", "15:00"]
    expect = int(datetime(2026, 9, 22, 9, 30, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp())
    assert bars[0].ts == expect
    # 同一时刻若按 UTC 钟面读会是 01:30,这里必须是上海 09:30 的绝对时间。
    utc_clock = datetime.fromtimestamp(bars[0].ts, tz=ZoneInfo("UTC")).strftime("%H:%M")
    assert utc_clock == "01:30"
    sh_clock = datetime.fromtimestamp(bars[0].ts, tz=ZoneInfo("Asia/Shanghai")).strftime("%H:%M")
    assert sh_clock == "09:30"
    assert bars[0].price == 10.20
    assert bars[0].avg == 10.10
    assert bars[0].volume == 100
    assert bars.prev_close == 10.0
    assert bars.timezone == "Asia/Shanghai"


def test_tencent_minute_uses_market_local_clock():
    payload = {
        "data": {
            "sz300409": {
                "data": {
                    "date": "20260922",
                    "data": ["0930 10.20 100 10.10", "1500 10.40 60 10.20"],
                },
                "qt": {"sz300409": ["1", "道氏技术", "300409", "10.40", "10.00"]},
            }
        }
    }
    bars = parse_tencent_trends(payload, tsym="sz300409", market="CN")
    assert bars[0].time == "2026-09-22 09:30"
    assert bars[-1].time == "2026-09-22 15:00"
    assert bars.prev_close == 10.0
    assert bars[0].avg == 10.10


def test_yahoo_us_premarket_stays_on_eastern_session_date():
    pre_ts = int(datetime(2026, 9, 22, 8, 0, tzinfo=ZoneInfo("America/New_York")).timestamp())
    open_ts = int(datetime(2026, 9, 22, 9, 30, tzinfo=ZoneInfo("America/New_York")).timestamp())
    prev_ts = int(datetime(2026, 9, 21, 16, 0, tzinfo=ZoneInfo("America/New_York")).timestamp())
    payload = {
        "chart": {
            "result": [
                {
                    "timestamp": [prev_ts, pre_ts, open_ts],
                    "meta": {"previousClose": 99.0},
                    "indicators": {
                        "quote": [
                            {
                                "close": [98.0, 100.5, 101.0],
                                "volume": [10, 20, 30],
                            }
                        ]
                    },
                }
            ]
        }
    }
    bars = parse_yahoo_trends(payload, market="US")
    assert [p.time for p in bars] == ["2026-09-22 08:00", "2026-09-22 09:30"]
    assert bars.timezone == "America/New_York"
    assert bars.prev_close == 99.0
    assert bars[0].price == 100.5
    assert bars[0].ts == pre_ts


def test_trends_engine_returns_vendor_points(monkeypatch):
    sample = parse_eastmoney_trends(
        {"data": {"preClose": 1, "trends": ["2026-09-22 09:30,2,2,1,2"]}},
        market="CN",
    )

    def _fake_fetch(self, symbols, config):
        return sample

    monkeypatch.setattr(EastmoneyTrendsVendor, "fetch", _fake_fetch)
    md = MarketData(
        config=StaticConfigProvider(
            {"trends": [SourceConfig(vendor="eastmoney", priority=0, enabled=True)]}
        )
    )
    out = md.trends("300409", market="CN")
    assert len(out) == 1
    assert out[0].time.endswith("09:30")
    assert out.timezone == "Asia/Shanghai"
