"""当日分时解析:A 股钟面是上海时区的 Unix 秒,美股盘前保留在美东日期内。"""

from datetime import datetime
from zoneinfo import ZoneInfo

from marketdata.defaults import StaticConfigProvider
from marketdata.client import MarketData
from marketdata.ports import SourceConfig
from marketdata.vendors.trends import (
    EastmoneyTrendsVendor,
    SinaTrendsVendor,
    TencentTrendsVendor,
    infer_us_regular_session_date,
    parse_eastmoney_trends,
    parse_sina_us_minline,
    parse_sina_us_quote_meta,
    parse_tencent_trends,
    parse_yahoo_trends,
    resolve_us_minline_session_date,
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


def test_tencent_cn_turnover_avg_converts_lots_to_shares():
    """A股主板腾讯分时:成交量是累计手、成交额是累计元。均价=成交额/(成交量×100),应贴近现价。"""
    payload = {
        "data": {
            "sh600719": {
                "data": {
                    "date": "20260923",
                    "data": [
                        "0930 8.03 1028 825484.00",
                        "0931 7.88 10748 8538684.00",
                    ],
                },
                "qt": {"sh600719": ["1", "大连热电", "600719", "7.88", "8.07"]},
            }
        }
    }
    bars = parse_tencent_trends(payload, tsym="sh600719", market="CN")
    assert len(bars) == 2
    assert abs(bars[0].avg - 8.03) < 0.02
    assert abs(bars[0].avg - bars[0].price) / bars[0].price < 0.05
    assert abs(bars[1].avg - (8538684.00 / (10748 * 100))) < 0.02
    assert bars[1].avg < 20
    assert bars[0].volume == 1028
    assert bars[1].volume == 9720


def test_tencent_star_and_hk_turnover_already_in_shares():
    """科创板和港股成交量已是股,不能再除以 100。"""
    star = {
        "data": {
            "sh688981": {
                "data": {
                    "date": "20260923",
                    "data": ["0930 122.40 96754 11842689.60"],
                }
            }
        }
    }
    bars = parse_tencent_trends(star, tsym="sh688981", market="CN")
    assert abs(bars[0].avg - 122.40) < 0.05
    assert bars[0].avg > 50

    hk = {
        "data": {
            "hk00700": {
                "data": {
                    "date": "20260923",
                    "data": ["0930 453.400 992543 448890209.730"],
                }
            }
        }
    }
    hk_bars = parse_tencent_trends(hk, tsym="hk00700", market="HK")
    assert abs(hk_bars[0].avg - (448890209.730 / 992543)) < 0.05
    assert hk_bars[0].avg > 400


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


def test_eastmoney_us_beijing_clock_becomes_eastern_unix():
    """东财美股原文是北京时间。夏令时 21:30=美东 09:30,跨过北京零点仍是同一交易日。"""
    payload = {
        "data": {
            "preClose": 257.38,
            "trends": [
                # 上一美东交易日收盘,应被最新交易日过滤掉。
                "2026-09-22 04:00,250.00,250.00,250.00,250.00,1,1,250",
                # 夏令时开盘:北京 21:30 = 美东 09:30。
                "2026-09-22 21:30,255.25,255.47,255.89,255.09,100,1000,256.03",
                # 北京零点 = 美东 12:00,不能当成新的一天从 00:00 起算。
                "2026-09-23 00:15,262.25,262.30,262.40,262.10,80,800,262.20",
                "2026-09-23 04:00,262.36,262.36,262.60,262.17,90,900,262.46",
            ],
        }
    }
    bars = parse_eastmoney_trends(payload, market="US")
    assert [p.time for p in bars] == [
        "2026-09-22 09:30",
        "2026-09-22 12:15",
        "2026-09-22 16:00",
    ]
    assert bars.timezone == "America/New_York"
    open_ts = int(datetime(2026, 9, 22, 9, 30, tzinfo=ZoneInfo("America/New_York")).timestamp())
    noon_ts = int(datetime(2026, 9, 22, 12, 15, tzinfo=ZoneInfo("America/New_York")).timestamp())
    assert bars[0].ts == open_ts
    assert bars[1].ts == noon_ts
    assert datetime.fromtimestamp(bars[0].ts, tz=ZoneInfo("America/New_York")).strftime("%H:%M") == "09:30"
    assert datetime.fromtimestamp(bars[0].ts, tz=ZoneInfo("Asia/Shanghai")).strftime("%H:%M") == "21:30"
    assert datetime.fromtimestamp(bars[1].ts, tz=ZoneInfo("Asia/Shanghai")).strftime("%H:%M") == "00:15"
    assert bars[0].price == 255.25
    assert bars.prev_close == 257.38


def test_eastmoney_us_standard_time_is_13_hours():
    """冬令时美东比北京慢 13 小时,不能固定减 12 小时。"""
    payload = {
        "data": {
            "preClose": 100,
            "trends": [
                "2026-01-15 22:30,100,100,100,100,1,1,100",
                "2026-01-16 05:00,101,101,101,101,1,1,101",
            ],
        }
    }
    bars = parse_eastmoney_trends(payload, market="US")
    assert [p.time for p in bars] == ["2026-01-15 09:30", "2026-01-15 16:00"]
    assert bars[0].ts == int(datetime(2026, 1, 15, 9, 30, tzinfo=ZoneInfo("America/New_York")).timestamp())
    assert datetime.fromtimestamp(bars[0].ts, tz=ZoneInfo("Asia/Shanghai")).strftime("%H:%M") == "22:30"
    assert datetime.fromtimestamp(bars[-1].ts, tz=ZoneInfo("America/New_York")).strftime("%H:%M") == "16:00"


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


def test_sina_us_minline_uses_vendor_avg_and_eastern_clock():
    payload = "09:30:00,402350,255.659,257.3250;09:31:00,126555,256.302,259.2600;16:00:00,2568405,262.463,262.3750"
    bars = parse_sina_us_minline(payload, session_date="2026-09-22", prev_close=257.38)
    assert [p.time for p in bars] == [
        "2026-09-22 09:30",
        "2026-09-22 09:31",
        "2026-09-22 16:00",
    ]
    assert bars.timezone == "America/New_York"
    assert bars.vendor == "sina"
    assert bars.prev_close == 257.38
    assert bars[0].volume == 402350
    assert bars[0].avg == 255.659
    assert bars[0].price == 257.325
    assert bars[-1].price == 262.375
    # 均价是源给的,不能被成交量放大成另一根价格。
    assert abs(bars[0].avg - bars[0].price) / bars[0].price < 0.02
    open_ts = int(datetime(2026, 9, 22, 9, 30, tzinfo=ZoneInfo("America/New_York")).timestamp())
    assert bars[0].ts == open_ts


def test_sina_us_minline_rejects_error_payload():
    assert parse_sina_us_minline({"__ERROR": "42S02"}, session_date="2026-09-22") == []
    assert parse_sina_us_minline("", session_date="2026-09-22") == []
    assert parse_sina_us_minline(None, session_date="2026-09-22") == []


def test_sina_us_quote_meta_reads_prev_close_and_session_stamp():
    text = (
        'var hq_str_gb_mrvl="迈威尔科技,262.36,1.93,2026-09-23 19:34:33,'
        + ",".join(["0"] * 20)
        + ',Sep 23 07:34AM EDT,Sep 22 04:00PM EDT,257.3800";'
    )
    now = datetime(2026, 9, 23, 7, 34, tzinfo=ZoneInfo("America/New_York"))
    prev, stamp = parse_sina_us_quote_meta(text, now)
    assert prev == 257.38
    assert stamp is not None
    assert stamp.date().isoformat() == "2026-09-22"


def test_us_minline_date_uses_close_stamp_when_curve_is_finished():
    now = datetime(2026, 9, 24, 11, 0, tzinfo=ZoneInfo("America/New_York"))
    stamp = datetime(2026, 9, 23, 16, 0, tzinfo=ZoneInfo("America/New_York"))
    # 假日白天:曲线已在 16:00 收完,不能标成今天。
    assert resolve_us_minline_session_date(now, "16:00", stamp) == "2026-09-23"


def test_us_minline_early_close_stays_on_previous_session_next_morning():
    now = datetime(2026, 9, 24, 10, 0, tzinfo=ZoneInfo("America/New_York"))
    stamp = datetime(2026, 9, 23, 13, 0, tzinfo=ZoneInfo("America/New_York"))
    # 上一场 13:00 就收完,次日 10:00 这根比钟面还晚,不能标成今天。
    assert resolve_us_minline_session_date(now, "13:00", stamp) == "2026-09-23"


def test_us_minline_date_uses_today_while_session_is_printing():
    now = datetime(2026, 9, 23, 10, 15, tzinfo=ZoneInfo("America/New_York"))
    stamp = datetime(2026, 9, 22, 16, 0, tzinfo=ZoneInfo("America/New_York"))
    assert resolve_us_minline_session_date(now, "10:14", stamp) == "2026-09-23"


def test_infer_us_session_date_rolls_weekends_and_premarket():
    premarket = datetime(2026, 9, 23, 7, 34, tzinfo=ZoneInfo("America/New_York"))
    assert infer_us_regular_session_date(premarket) == "2026-09-22"
    saturday = datetime(2026, 9, 26, 11, 0, tzinfo=ZoneInfo("America/New_York"))
    assert infer_us_regular_session_date(saturday) == "2026-09-25"
    after_close = datetime(2026, 9, 25, 18, 0, tzinfo=ZoneInfo("America/New_York"))
    assert infer_us_regular_session_date(after_close) == "2026-09-25"
    monday_morning = datetime(2026, 9, 21, 8, 0, tzinfo=ZoneInfo("America/New_York"))
    assert infer_us_regular_session_date(monday_morning) == "2026-09-18"


def test_sina_fetch_attaches_session_date_without_network(monkeypatch):
    payload = "09:30:00,10,100.5,101.0;10:15:00,12,100.8,102.0"

    def _fake_get(url, **kwargs):
        if "getMinline" in url:
            return payload
        return (
            'var hq_str_gb_mrvl="' + ",".join(["x"] * 25)
            + ',Sep 22 04:00PM EDT,99.5";'
        )

    monkeypatch.setattr("marketdata.vendors.trends.market_get", _fake_get)
    monkeypatch.setattr(
        "marketdata.vendors.trends._now_ny",
        lambda: datetime(2026, 9, 23, 10, 20, tzinfo=ZoneInfo("America/New_York")),
    )
    bars = SinaTrendsVendor().fetch([__import__("marketdata").Symbol.parse("MRVL", "US")], {})
    assert bars.vendor == "sina"
    assert bars.prev_close == 99.5
    assert bars[0].time == "2026-09-23 09:30"
    assert bars[-1].price == 102.0
    assert bars[-1].avg == 100.8


def test_eastmoney_trends_falls_through_to_push2his(monkeypatch):
    seen = []

    def _get(url, **kwargs):
        seen.append(url)
        if "push2his" not in url:
            return None
        return {"data": {"preClose": 10, "trends": ["2026-09-22 09:30,10.2,10.1,100,1"]}}

    monkeypatch.setattr("marketdata.vendors.trends.market_get", _get)
    from marketdata.symbol import Symbol

    bars = EastmoneyTrendsVendor().fetch([Symbol.parse("600519", "CN")], {})
    assert [u.split("/")[2] for u in seen] == [
        "push2delay.eastmoney.com",
        "push2.eastmoney.com",
        "push2his.eastmoney.com",
    ]
    assert len(bars) == 1
    assert bars[0].price == 10.2
    assert bars.vendor == "eastmoney"


def test_us_trends_keeps_eastmoney_when_it_has_bars(monkeypatch):
    sina_calls = []
    tencent_calls = []

    def _sina(self, symbols, config):
        sina_calls.append(symbols[0].code)
        return parse_sina_us_minline(
            "09:30:00,10,10.1,10.2",
            session_date="2026-09-22",
        )

    def _eastmoney(self, symbols, config):
        return parse_eastmoney_trends(
            {"data": {"preClose": 1, "trends": ["2026-09-22 09:30,2,2,1,2"]}},
            market=symbols[0].market.value,
        )

    def _tencent(self, symbols, config):
        tencent_calls.append(symbols[0].code)
        return parse_tencent_trends(
            {"data": {"sh600519": {"data": {"date": "20260922", "data": ["0930 10 100 10"]}}}},
            tsym="sh600519",
            market="CN",
        )

    monkeypatch.setattr(SinaTrendsVendor, "fetch", _sina)
    monkeypatch.setattr(EastmoneyTrendsVendor, "fetch", _eastmoney)
    monkeypatch.setattr(TencentTrendsVendor, "fetch", _tencent)
    md = MarketData(
        config=StaticConfigProvider(
            {
                "trends": [
                    SourceConfig(vendor="eastmoney", priority=0, enabled=True),
                    SourceConfig(vendor="tencent", priority=5, enabled=True),
                    SourceConfig(vendor="sina", priority=8, enabled=True),
                ]
            }
        )
    )
    us = md.trends("MRVL", market="US")
    assert us.vendor == "eastmoney"
    assert sina_calls == []

    cn = md.trends("600519", market="CN")
    assert cn.vendor == "eastmoney"
    assert cn[0].time.endswith("09:30")
    assert tencent_calls == []
    assert sina_calls == []


def test_us_trends_uses_sina_only_after_eastmoney_is_empty(monkeypatch):
    def _sina(self, symbols, config):
        return parse_sina_us_minline("09:30:00,10,10.1,10.2", session_date="2026-09-22")

    def _eastmoney(self, symbols, config):
        return parse_eastmoney_trends({"data": {"trends": []}}, market="US")

    monkeypatch.setattr(SinaTrendsVendor, "fetch", _sina)
    monkeypatch.setattr(EastmoneyTrendsVendor, "fetch", _eastmoney)
    md = MarketData(
        config=StaticConfigProvider(
            {
                "trends": [
                    SourceConfig(vendor="eastmoney", priority=0, enabled=True),
                    SourceConfig(vendor="sina", priority=8, enabled=True),
                ]
            }
        )
    )
    out = md.trends("MRVL", market="US")
    assert out.vendor == "sina"
    assert out[0].time == "2026-09-22 09:30"
    assert out[0].price == 10.2


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
