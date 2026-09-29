import marketdata.vendors.kline as kv
from marketdata.symbol import Symbol
from marketdata.types import Bar


def test_tencent_kline_falls_back_when_primary_empty(monkeypatch):
    js = 'kline_dayqfq={"data":{"sh600519":{"qfqday":[["2026-07-01","1","3","4","0.5","100"]]}}};'
    calls = []

    def fake(url, **k):
        calls.append(url)
        if "proxy.finance.qq.com" in url:
            return js
        return None

    monkeypatch.setattr(kv, "market_get", fake)
    out = kv.TencentKlineVendor().fetch([Symbol.parse("600519")], {"days": 60})
    assert len(out) == 1 and out[0].close == 3.0
    assert calls[0].startswith("https://web.ifzq.gtimg.cn/")
    assert "proxy.finance.qq.com" in calls[1]


def test_sina_cn_and_us_kline_parse(monkeypatch):
    def fake(url, **k):
        if "CN_MarketData" in url:
            assert k["params"]["symbol"] == "sh600719"
            return [{"day": "2026-09-23", "open": "8.030", "high": "8.030", "low": "7.530", "close": "7.590", "volume": "28451824"}]
        return [
            {"d": "2026-09-21", "o": "1", "h": "2", "l": "0.5", "c": "1.5", "v": "10"},
            {"d": "2026-09-22", "o": "340.14", "h": "345.34", "l": "338.75", "c": "339.75", "v": "100"},
        ]

    monkeypatch.setattr(kv, "market_get", fake)
    cn = kv.SinaKlineVendor().fetch([Symbol.parse("600719")], {"days": 60})
    assert len(cn) == 1 and cn[0].date == "2026-09-23" and cn[0].close == 7.59
    us = kv.SinaKlineVendor().fetch([Symbol.parse("AAPL", market="US")], {"days": 1})
    assert len(us) == 1 and us[0].date == "2026-09-22" and us[0].close == 339.75
    assert kv.SinaKlineVendor().fetch([Symbol.parse("00700", market="HK")], {"days": 30}) == []


def test_tencent_kline_parses(monkeypatch):
    js = 'kline_dayqfq={"data":{"sh600519":{"day":[["2026-07-01","1","3","4","0.5","100"],["2026-07-02","3","5","6","2","200"]]}}};'
    monkeypatch.setattr(kv, "market_get", lambda *a, **k: js)
    out = kv.TencentKlineVendor().fetch([Symbol.parse("600519")], {"days": 60})
    assert len(out) == 2 and isinstance(out[0], Bar)
    assert out[0].date == "2026-07-01" and out[0].close == 3.0 and out[1].volume == 200.0


def test_eastmoney_kline_parses(monkeypatch):
    payload = {"data": {"klines": ["2026-07-01,1,3,4,0.5,100", "2026-07-02,3,5,6,2,200"]}}
    monkeypatch.setattr(kv, "market_get", lambda *a, **k: payload)
    out = kv.EastmoneyKlineVendor().fetch([Symbol.parse("600519")], {"days": 60})
    assert len(out) == 2 and out[1].high == 6.0


def test_stooq_kline_parses(monkeypatch):
    csv = "Date,Open,High,Low,Close,Volume\n2026-07-01,1,4,0.5,3,100\n2026-07-02,3,6,2,5,200\n"
    monkeypatch.setattr(kv, "market_get", lambda *a, **k: csv)
    out = kv.StooqKlineVendor().fetch([Symbol.parse("AAPL")], {})
    assert len(out) == 2 and out[0].close == 3.0 and out[1].close == 5.0


def test_tencent_us_kline_resolves_exchange_suffix(monkeypatch):
    """腾讯美股日K:裸符号只回退化数据(2根)→ 自动试 .OQ/.N 后缀并记忆命中,二次直达。"""
    import json as _j

    kv._US_SUFFIX_CACHE.clear()
    calls = []

    def fake(url, **k):
        param = k["params"]["param"]
        calls.append(param)
        tsym = param.split(",")[0]
        if tsym == "usBABA.N":  # 纽交所后缀才是对的
            days = [[f"2026-07-{i:02d}", "1", "2", "3", "0.5", "10"] for i in range(1, 11)]
        elif tsym in ("usBABA.OQ", "usBABA"):  # 错后缀/裸符号 → 退化 2 根
            days = [["2011-06-02", "1", "2", "3", "0.5", "10"],
                    ["2026-07-31", "1", "2", "3", "0.5", "10"]]
        else:
            days = []
        return "k=" + _j.dumps({"data": {tsym: {"day": days}}})

    monkeypatch.setattr(kv, "market_get", fake)
    v = kv.TencentKlineVendor()
    out = v.fetch([Symbol.parse("BABA", market="US")], {"days": 30})
    assert len(out) == 10
    assert calls[0].startswith("usBABA.OQ")  # 先试纳斯达克
    assert kv._US_SUFFIX_CACHE.get("BABA") == ".N"

    calls.clear()
    out2 = v.fetch([Symbol.parse("BABA", market="US")], {"days": 30})
    assert len(out2) == 10 and len(calls) == 1  # 记忆后缀后一次请求直达
    kv._US_SUFFIX_CACHE.clear()
