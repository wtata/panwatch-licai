"""K 线 vendors:腾讯(全市场)/ 新浪(CN/US)/ Stooq(US)/ 东财(CN/HK)/ Yahoo(US/HK)。移植自 PanWatch kline_collector 抓取核。"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from marketdata.http import market_get
from marketdata.symbol import Market, Symbol
from marketdata.types import Bar
from marketdata.vendors.base import KlineVendor

logger = logging.getLogger(__name__)

# ifzq 在部分机房会直接 HTTP 501;qq 财经反代是同一份日K,主站失败时再试一次。
_TENCENT_KLINE_URLS = (
    "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get",
)
_EASTMONEY_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
_STOOQ_URL = "https://stooq.com/q/d/l/"
_YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/{sym}"
_SINA_CN_KLINE_URL = (
    "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData"
)
_SINA_US_KLINE_URL = "https://stock.finance.sina.com.cn/usstock/api/json.php/US_MinKService.getDailyK"
_SINA_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"}


def _days(config: dict, default: int = 60) -> int:
    try:
        return int(config.get("days") or default)
    except Exception:
        return default


# 腾讯 fqkline 对 count 有上限:实测 ≤800 正常返(800→801根),1000-2000 退化到 ~641,
# ≥3000 直接返空(0根)。上层 want 常放大到 3000(为长历史/回测),若原样透传腾讯会返 0
# → 每个标的都白白落到东财补全 → 东财一挂就没数据。故把请求 count 截到 800(取回最多)。
_TENCENT_MAX_COUNT = 800


def _parse_tencent_kline_text(text: str | None, tsym: str) -> list[Bar]:
    if not text or "=" not in text:
        return []
    js = text.split("=", 1)[1].strip().rstrip(";")
    try:
        data = json.loads(js)
    except Exception:
        return []
    raw = data.get("data", {}) if isinstance(data, dict) else {}
    day = []
    if isinstance(raw, dict):
        sd = raw.get(tsym, {})
        if isinstance(sd, dict):
            day = sd.get("day") or sd.get("qfqday") or []
    elif isinstance(raw, list):
        day = raw
    out: list[Bar] = []
    for it in day or []:
        if len(it) >= 5:
            try:
                out.append(Bar(date=it[0], open=float(it[1]), close=float(it[2]),
                               high=float(it[3]), low=float(it[4]),
                               volume=float(it[5]) if len(it) > 5 else 0.0))
            except Exception:
                continue
    return out


def fetch_tencent_kline_raw(tsym: str, days: int) -> list[Bar]:
    """按**原始腾讯符号**取日K(不经 Symbol 转换)。

    供指数等显式符号场景复用(sh000001/hkHSI/usDJI…;指数与个股的符号规则不同,
    必须显式传入)。个股路径请走 TencentKlineVendor。
    """
    days = min(max(int(days or 1), 1), _TENCENT_MAX_COUNT)
    params = {"param": f"{tsym},day,,,{days},qfq", "_var": "kline_dayqfq"}
    for url in _TENCENT_KLINE_URLS:
        host = url.split("/")[2]
        text = market_get(
            url, host_key=host, min_interval_s=0.15,
            params=params,
            timeout=10, retries=1, parse="text", log_label="腾讯K线", symbol=tsym,
        )
        bars = _parse_tencent_kline_text(text, tsym)
        if bars:
            return bars
    return []


# 腾讯美股日K必须带交易所后缀(usTSLA.OQ=纳斯达克 / usBABA.N=纽交所);裸 us{CODE}
# 只回"首日+最新"两根退化数据,错后缀只回 1 根。后缀无法从代码推断 → 依次试
# .OQ/.N/裸,根数达标即命中并进程内记忆(下次直达,不再多请求)。
_US_SUFFIX_CACHE: dict[str, str] = {}


def _fetch_tencent_us_kline(code: str, days: int) -> list[Bar]:
    want = min(max(int(days or 1), 1), _TENCENT_MAX_COUNT)
    ok_threshold = min(want, 5)  # 正常历史远多于 5 根;退化响应只有 1-2 根
    cached = _US_SUFFIX_CACHE.get(code)
    suffixes = ([cached] if cached is not None else []) + [
        s for s in (".OQ", ".N", "") if s != cached
    ]
    best: list[Bar] = []
    for suf in suffixes:
        bars = fetch_tencent_kline_raw(f"us{code}{suf}", want)
        if len(bars) >= ok_threshold:
            _US_SUFFIX_CACHE[code] = suf
            return bars
        if len(bars) > len(best):
            best = bars
    return best


class TencentKlineVendor(KlineVendor):
    name = "tencent"
    supports_markets = {"CN", "HK", "US"}

    _MAX_COUNT = _TENCENT_MAX_COUNT  # 兼容旧引用(测试/外部按类属性取)

    def fetch(self, symbols: list[Symbol], config: dict) -> list[Bar]:
        if not symbols:
            return []
        sym = symbols[0]
        if sym.market == Market.US:
            return _fetch_tencent_us_kline(sym.code, _days(config))
        return fetch_tencent_kline_raw(sym.to_tencent(), _days(config))


class StooqKlineVendor(KlineVendor):
    name = "stooq"
    supports_markets = {"US"}

    def fetch(self, symbols: list[Symbol], config: dict) -> list[Bar]:
        if not symbols:
            return []
        sym = symbols[0].code.strip().lower()
        if not sym:
            return []
        text = market_get(
            _STOOQ_URL, host_key="stooq.com", params={"s": f"{sym}.us", "i": "d"},
            headers={"User-Agent": "PanWatch/1.0 (+https://github.com/)"},
            timeout=12, retries=2, parse="text", log_label="Stooq K线", symbol=sym,
        )
        if not text:
            return []
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if len(lines) <= 1:
            return []
        out: list[Bar] = []
        for ln in lines[1:]:
            p = ln.split(",")
            if len(p) < 6 or not p[0] or p[0] == "Date":
                continue
            try:
                out.append(Bar(date=p[0], open=float(p[1]), close=float(p[4]),
                               high=float(p[2]), low=float(p[3]),
                               volume=float(p[5]) if p[5] else 0.0))
            except Exception:
                continue
        return out


def _em_secid(sym: Symbol) -> str:
    if sym.market == Market.HK:
        return f"116.{sym.code}"
    if sym.market == Market.US:
        return f"105.{sym.code}"
    from marketdata.symbol import _cn_exchange
    return f"{'1' if _cn_exchange(sym.code) == 'sh' else '0'}.{sym.code}"


def fetch_eastmoney_kline(secid: str, days: int) -> list[Bar]:
    """按显式 secid 取东财日K,不经个股 secid 推导规则(_em_secid)。

    供指数等显式符号场景复用(指数与个股 secid 前缀规则不同,必须显式映射)。
    """
    payload = market_get(
        _EASTMONEY_URL, host_key="push2his.eastmoney.com", min_interval_s=0.2,
        params={"secid": secid, "klt": "101", "fqt": "1",
                "lmt": str(min(max(int(days or 1), 1200), 20000)), "end": "20500101",
                "fields1": "f1,f2,f3,f4,f5,f6", "fields2": "f51,f52,f53,f54,f55,f56",
                "ut": "fa5fd1943c7b386f172d6893dbfba10b"},
        headers={"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"},
        timeout=12, retries=1, parse="json", log_label="东财K线", symbol=secid,
    )
    raw = (payload or {}).get("data", {}).get("klines", []) if isinstance(payload, dict) else []
    out: list[Bar] = []
    for row in raw or []:
        p = str(row).split(",")
        if len(p) < 6:
            continue
        try:
            out.append(Bar(date=p[0], open=float(p[1]), close=float(p[2]),
                           high=float(p[3]), low=float(p[4]), volume=float(p[5])))
        except Exception:
            continue
    return out


class EastmoneyKlineVendor(KlineVendor):
    name = "eastmoney"
    supports_markets = {"CN", "HK"}

    def fetch(self, symbols: list[Symbol], config: dict) -> list[Bar]:
        if not symbols:
            return []
        sym = symbols[0]
        if sym.market not in (Market.CN, Market.HK):
            return []
        days = _days(config)
        return fetch_eastmoney_kline(_em_secid(sym), days)


def parse_sina_kline(payload, *, market: str) -> list[Bar]:
    """新浪日K。CN 字段 day/open/high/low/close/volume;US 字段 d/o/h/l/c/v。"""
    if not isinstance(payload, list):
        return []
    cn = (market or "").upper() == "CN"
    out: list[Bar] = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        if cn:
            date, o, h, low, c, v = (
                row.get("day"), row.get("open"), row.get("high"),
                row.get("low"), row.get("close"), row.get("volume"),
            )
        else:
            date, o, h, low, c, v = (
                row.get("d"), row.get("o"), row.get("h"),
                row.get("l"), row.get("c"), row.get("v"),
            )
        if not date:
            continue
        try:
            out.append(Bar(
                date=str(date)[:10],
                open=float(o),
                close=float(c),
                high=float(h),
                low=float(low),
                volume=float(v) if v not in (None, "") else 0.0,
            ))
        except (TypeError, ValueError):
            continue
    return out


class SinaKlineVendor(KlineVendor):
    """新浪日K。腾讯 501、东财断连时给 A 股/美股一条还能返回的路。港股此接口无数据。"""

    name = "sina"
    supports_markets = {"CN", "US"}

    def fetch(self, symbols: list[Symbol], config: dict) -> list[Bar]:
        if not symbols:
            return []
        sym = symbols[0]
        days = _days(config)
        if sym.market == Market.CN:
            tsym = sym.to_tencent()
            payload = market_get(
                _SINA_CN_KLINE_URL, host_key="money.finance.sina.com.cn", min_interval_s=0.15,
                params={"symbol": tsym, "scale": "240", "ma": "no", "datalen": str(min(max(days, 1), 2000))},
                headers=_SINA_HEADERS,
                timeout=12, retries=1, parse="json", log_label="新浪K线", symbol=tsym,
            )
            bars = parse_sina_kline(payload, market="CN")
        elif sym.market == Market.US:
            code = sym.code.strip().upper()
            if not code:
                return []
            payload = market_get(
                _SINA_US_KLINE_URL, host_key="stock.finance.sina.com.cn", min_interval_s=0.15,
                params={"symbol": code},
                headers=_SINA_HEADERS,
                timeout=15, retries=1, parse="json", log_label="新浪K线", symbol=code,
            )
            bars = parse_sina_kline(payload, market="US")
        else:
            return []
        if days > 0 and len(bars) > days:
            bars = bars[-days:]
        return bars


def _yahoo_range(days: int) -> str:
    """days → Yahoo chart v8 的 range 枚举(不用 period1/period2,避免依赖当前时间)。"""
    if days <= 5:
        return "5d"
    if days <= 22:
        return "1mo"
    if days <= 66:
        return "3mo"
    if days <= 130:
        return "6mo"
    if days <= 260:
        return "1y"
    if days <= 520:
        return "2y"
    if days <= 1300:
        return "5y"
    return "max"


class YahooKlineVendor(KlineVendor):
    """Yahoo chart v8 日K,零 crumb / 零 cookie(crumb 只有 quoteSummary 基本面才需要)。"""

    name = "yahoo"
    supports_markets = {"US", "HK"}

    def fetch(self, symbols: list[Symbol], config: dict) -> list[Bar]:
        if not symbols:
            return []
        sym = symbols[0]
        if sym.market not in (Market.US, Market.HK):
            return []
        days = _days(config)
        ysym = sym.to_yfinance()
        proxy = config.get("proxy")
        payload = market_get(
            _YAHOO_CHART_URL.format(sym=ysym), host_key="query2.finance.yahoo.com",
            params={"interval": "1d", "range": _yahoo_range(days)},
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"},
            timeout=10, retries=2, parse="json", proxy=proxy,
            log_label="Yahoo K线", symbol=ysym,
        )
        if not isinstance(payload, dict):
            return []
        try:
            result = ((payload.get("chart") or {}).get("result")) or []
            if not result:
                return []
            r0 = result[0] or {}
            timestamps = r0.get("timestamp") or []
            indicators = r0.get("indicators") or {}
            quote = (indicators.get("quote") or [{}])[0] or {}
            adjcloses = (indicators.get("adjclose") or [{}])[0].get("adjclose") if indicators.get("adjclose") else None
        except Exception:
            return []
        opens = quote.get("open") or []
        highs = quote.get("high") or []
        lows = quote.get("low") or []
        closes = quote.get("close") or []
        volumes = quote.get("volume") or []
        out: list[Bar] = []
        for i, ts in enumerate(timestamps or []):
            try:
                o = opens[i] if i < len(opens) else None
                h = highs[i] if i < len(highs) else None
                low = lows[i] if i < len(lows) else None
                c = closes[i] if i < len(closes) else None
                if o is None or h is None or low is None or c is None:
                    continue
                if adjcloses is not None and i < len(adjcloses) and adjcloses[i] is not None:
                    c = adjcloses[i]
                v = volumes[i] if i < len(volumes) and volumes[i] is not None else 0
                date = datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
                out.append(Bar(date=date, open=float(o), close=float(c),
                               high=float(h), low=float(low), volume=float(v)))
            except Exception:
                continue
        if days > 0 and len(out) > days:
            out = out[-days:]
        return out
