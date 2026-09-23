"""GET /api/klines/{symbol}/trends 把分时点原样交给前端,并带上市场时区。"""

from src.modules.market.api import klines as api


class _Point:
    def __init__(self, time, ts, price, avg, volume):
        self.time = time
        self.ts = ts
        self.price = price
        self.avg = avg
        self.volume = volume


class _Bars(list):
    timezone = "Asia/Shanghai"
    prev_close = 10.5
    vendor = "eastmoney"


def test_trends_route_registered():
    paths = [getattr(r, "path", "") for r in api.router.routes]
    assert "/{symbol}/trends" in paths


def test_get_trends_serializes_shanghai_points(monkeypatch):
    bars = _Bars([
        _Point("2026-09-22 09:30", 1758504600, 10.2, 10.1, 100),
        _Point("2026-09-22 15:00", 1758524400, 10.4, 10.2, 60),
    ])

    class _Md:
        def trends(self, symbol, market):
            assert symbol == "300409"
            assert market == "CN"
            return bars

    import src.platform.marketdata.collectors.kline_collector as kc

    monkeypatch.setattr(kc, "get_market_data", lambda: _Md())
    payload = api.get_trends("300409", market="CN")
    assert payload["market"] == "CN"
    assert payload["timezone"] == "Asia/Shanghai"
    assert payload["source"] == "eastmoney"
    assert payload["prev_close"] == 10.5
    assert payload["date"] == "2026-09-22"
    assert payload["points"][0]["time"] == "2026-09-22 09:30"
    assert payload["points"][0]["price"] == 10.2
    assert payload["points"][0]["avg"] == 10.1
    assert payload["points"][0]["volume"] == 100
    assert payload["hint"] == ""


def test_us_trends_empty_explains_sina_path(monkeypatch):
    class _Md:
        def trends(self, symbol, market):
            assert symbol == "MRVL"
            assert market == "US"
            return []

    import src.platform.marketdata.collectors.kline_collector as kc

    monkeypatch.setattr(kc, "get_market_data", lambda: _Md())
    payload = api.get_trends("MRVL", market="US")
    assert payload["points"] == []
    assert payload["timezone"] == "America/New_York"
    assert "新浪美股分时" in payload["hint"]
    assert "Yahoo" in payload["hint"]


def test_cn_trends_empty_has_no_us_hint(monkeypatch):
    class _Md:
        def trends(self, symbol, market):
            return []

    import src.platform.marketdata.collectors.kline_collector as kc

    monkeypatch.setattr(kc, "get_market_data", lambda: _Md())
    payload = api.get_trends("600519", market="CN")
    assert payload["hint"] == ""
