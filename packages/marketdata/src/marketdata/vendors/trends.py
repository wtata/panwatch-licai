"""当日分时 vendors:东财(CN/HK/US)、腾讯(CN/HK)、Yahoo(US/HK,含美股盘前盘后)。

time 一律写成市场本地钟面,ts 为真实 Unix 秒。图表用 ts + 时区格式化,
不能把 Unix 秒当 UTC 钟面直接画(否则 A 股 09:30 会显示成 01:30)。

东财美股 trends2 的时间字符串是北京时间,不是美东。先按上海时区得到绝对时间,
再写成美东钟面(含夏令时)。否则 09:30 会画成 21:30,过了北京零点还会被裁成从 00:00 起算。
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from marketdata.http import market_get
from marketdata.symbol import Market, Symbol
from marketdata.types import TrendPoint
from marketdata.vendors.base import TrendsVendor

_EASTMONEY_TRENDS_URLS = (
    "https://push2delay.eastmoney.com/api/qt/stock/trends2/get",
    "https://push2.eastmoney.com/api/qt/stock/trends2/get",
)
_TENCENT_MINUTE_URL = "https://web.ifzq.gtimg.cn/appstock/app/minute/query"
_YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/{sym}"

# CN/HK 分时钟面用上海时区(与香港无夏令时,钟面一致)。美股用美东,含夏令时。
MARKET_TZ = {
    "CN": "Asia/Shanghai",
    "HK": "Asia/Shanghai",
    "US": "America/New_York",
}


class TrendBars(list):
    """list[TrendPoint],附带昨收与时区,Engine 仍按长度择优。"""

    def __init__(
        self,
        points: list[TrendPoint] | None = None,
        *,
        prev_close: float | None = None,
        timezone: str = "Asia/Shanghai",
        vendor: str = "",
    ):
        super().__init__(points or [])
        self.prev_close = prev_close
        self.timezone = timezone
        self.vendor = vendor


def market_timezone(market: str) -> str:
    return MARKET_TZ.get((market or "CN").upper(), "Asia/Shanghai")


def _f(value) -> float | None:
    try:
        if value is None or value == "" or value == "-":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _keep_latest_session(points: list[TrendPoint]) -> list[TrendPoint]:
    """只留最新交易日,避免 Yahoo 1d 把上一交易日尾盘混进当日分时。

    time 必须已经是市场本地钟面。美股用美东日期:东财原文跨过北京零点,
    若按北京日期截断,会把 09:30 到中午的上午段丢掉。
    """
    if not points:
        return []
    latest = max(p.time[:10] for p in points if p.time)
    kept = [p for p in points if p.time.startswith(latest)]
    kept.sort(key=lambda p: p.ts)
    dedup: dict[int, TrendPoint] = {}
    for p in kept:
        dedup[p.ts] = p
    return [dedup[k] for k in sorted(dedup)]


def _local_ts(text: str, tz_name: str) -> tuple[str, int] | None:
    raw = (text or "").strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            dt = datetime.strptime(raw, fmt).replace(tzinfo=ZoneInfo(tz_name))
        except ValueError:
            continue
        return dt.strftime("%Y-%m-%d %H:%M"), int(dt.timestamp())
    return None


def _eastmoney_wall_clock(text: str, market: str) -> tuple[str, int] | None:
    """东财分时原文按北京时间理解,输出该市场的本地钟面和 Unix 秒。

    美股夏令时:北京 21:30 = 美东 09:30,北京次日 04:00 = 美东 16:00。
    美股标准时差 13 小时:北京 22:30 = 美东 09:30,北京次日 05:00 = 美东 16:00。
    CN/HK 原文本身就是上海钟面,往返后不变。
    """
    parsed = _local_ts(text, "Asia/Shanghai")
    if parsed is None:
        return None
    _, ts = parsed
    display_tz = market_timezone(market)
    wall = datetime.fromtimestamp(ts, tz=ZoneInfo(display_tz)).strftime("%Y-%m-%d %H:%M")
    return wall, ts


def parse_eastmoney_trends(payload: dict | None, *, market: str) -> TrendBars:
    """东财 trends2:「时间,价格,均价,成交量,...」。美股原文是北京时间。"""
    tz_name = market_timezone(market)
    bars = TrendBars(timezone=tz_name, vendor="eastmoney")
    data = (payload or {}).get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return bars
    pre = _f(data.get("preClose"))
    if pre is None:
        pre = _f(data.get("prePrice"))
    bars.prev_close = pre
    points: list[TrendPoint] = []
    for row in data.get("trends") or []:
        parts = str(row).split(",")
        if len(parts) < 3:
            continue
        parsed = _eastmoney_wall_clock(parts[0], market)
        price = _f(parts[1])
        if parsed is None or price is None:
            continue
        avg = _f(parts[2]) if len(parts) > 2 else None
        volume = _f(parts[3]) if len(parts) > 3 else 0.0
        time_text, ts = parsed
        points.append(
            TrendPoint(
                time=time_text,
                ts=ts,
                price=price,
                avg=price if avg is None else avg,
                volume=volume or 0.0,
            )
        )
    bars.extend(_keep_latest_session(points))
    return bars


def _tencent_prev_close(block: dict, tsym: str) -> float | None:
    qt = block.get("qt")
    row = None
    if isinstance(qt, dict):
        row = qt.get(tsym)
    elif isinstance(qt, list):
        row = qt
    if isinstance(row, list) and len(row) > 4:
        return _f(row[4])
    return None


def parse_tencent_trends(payload: dict | None, *, tsym: str, market: str) -> TrendBars:
    """腾讯 minute/query。每条「HHMM 价格 成交量 均价或成交额」。"""
    tz_name = market_timezone(market)
    bars = TrendBars(timezone=tz_name, vendor="tencent")
    data = (payload or {}).get("data") if isinstance(payload, dict) else None
    block = data.get(tsym) if isinstance(data, dict) else None
    if not isinstance(block, dict):
        return bars
    inner = block.get("data") if isinstance(block.get("data"), dict) else {}
    date_raw = str(inner.get("date") or "").strip()
    if len(date_raw) == 8 and date_raw.isdigit():
        date_text = f"{date_raw[0:4]}-{date_raw[4:6]}-{date_raw[6:8]}"
    elif len(date_raw) >= 10:
        date_text = date_raw[:10]
    else:
        return bars
    bars.prev_close = _tencent_prev_close(block, tsym)
    points: list[TrendPoint] = []
    cum_pv = 0.0
    cum_v = 0.0
    for row in inner.get("data") or []:
        parts = str(row).split()
        if len(parts) < 3:
            continue
        hhmm = parts[0].strip()
        if len(hhmm) == 4 and hhmm.isdigit():
            clock = f"{hhmm[:2]}:{hhmm[2:]}"
        elif len(hhmm) >= 5 and ":" in hhmm:
            clock = hhmm[:5]
        else:
            continue
        parsed = _local_ts(f"{date_text} {clock}", tz_name)
        price = _f(parts[1])
        third = _f(parts[2])
        if parsed is None or price is None or third is None:
            continue
        fourth = _f(parts[3]) if len(parts) > 3 else None
        volume = third
        avg = price
        if fourth is not None and price > 0 and abs(fourth - price) / price < 0.5:
            avg = fourth
        elif fourth is not None and fourth > 0 and third > 0:
            # 第四列是成交额时用累计 VWAP 作为均价。
            cum_pv += fourth
            cum_v += third
            avg = cum_pv / cum_v if cum_v else price
        time_text, ts = parsed
        points.append(TrendPoint(time=time_text, ts=ts, price=price, avg=avg, volume=volume))
    bars.extend(_keep_latest_session(points))
    return bars


def parse_yahoo_trends(payload: dict | None, *, market: str) -> TrendBars:
    """Yahoo chart 1m。timestamp 为 Unix 秒;includePrePost 时含美股盘前盘后。"""
    tz_name = market_timezone(market)
    bars = TrendBars(timezone=tz_name, vendor="yahoo")
    if not isinstance(payload, dict):
        return bars
    try:
        result = ((payload.get("chart") or {}).get("result")) or []
        if not result:
            return bars
        r0 = result[0] or {}
        timestamps = r0.get("timestamp") or []
        quote = ((r0.get("indicators") or {}).get("quote") or [{}])[0] or {}
        meta = r0.get("meta") or {}
    except Exception:
        return bars
    bars.prev_close = _f(meta.get("chartPreviousClose") or meta.get("previousClose"))
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []
    tz = ZoneInfo(tz_name)
    points: list[TrendPoint] = []
    cum_pv = 0.0
    cum_v = 0.0
    for i, raw_ts in enumerate(timestamps or []):
        price = _f(closes[i]) if i < len(closes) else None
        if price is None or raw_ts is None:
            continue
        try:
            ts = int(raw_ts)
            dt = datetime.fromtimestamp(ts, tz=tz)
        except (TypeError, ValueError, OSError):
            continue
        volume = _f(volumes[i]) if i < len(volumes) else 0.0
        volume = volume or 0.0
        if volume > 0:
            cum_pv += price * volume
            cum_v += volume
            avg = cum_pv / cum_v
        else:
            avg = cum_pv / cum_v if cum_v else price
        points.append(
            TrendPoint(
                time=dt.strftime("%Y-%m-%d %H:%M"),
                ts=ts,
                price=price,
                avg=avg,
                volume=volume,
            )
        )
    bars.extend(_keep_latest_session(points))
    return bars


def _eastmoney_params(secid: str) -> dict:
    return {
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
        "iscr": "0",
        "iscca": "0",
        "ndays": "1",
        "ut": "fa5fd1943c7b386f172d6893dbfba10b",
    }


class EastmoneyTrendsVendor(TrendsVendor):
    name = "eastmoney"
    supports_markets = {"CN", "HK", "US"}

    def fetch(self, symbols: list[Symbol], config: dict) -> TrendBars:
        if not symbols:
            return TrendBars()
        sym = symbols[0]
        secid = sym.to_eastmoney_secid()
        headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"}
        payload = None
        for url in _EASTMONEY_TRENDS_URLS:
            host = url.split("/")[2]
            payload = market_get(
                url, host_key=host, min_interval_s=0.15,
                params=_eastmoney_params(secid), headers=headers,
                timeout=10, retries=1, parse="json",
                log_label="东财分时", symbol=secid,
            )
            bars = parse_eastmoney_trends(payload, market=sym.market.value)
            if bars:
                return bars
        return parse_eastmoney_trends(payload, market=sym.market.value)


class TencentTrendsVendor(TrendsVendor):
    name = "tencent"
    supports_markets = {"CN", "HK"}

    def fetch(self, symbols: list[Symbol], config: dict) -> TrendBars:
        if not symbols:
            return TrendBars()
        sym = symbols[0]
        if sym.market not in (Market.CN, Market.HK):
            return TrendBars(timezone=market_timezone(sym.market.value))
        tsym = sym.to_tencent()
        payload = market_get(
            _TENCENT_MINUTE_URL, host_key="web.ifzq.gtimg.cn", min_interval_s=0.15,
            params={"code": tsym},
            timeout=10, retries=1, parse="json",
            log_label="腾讯分时", symbol=tsym,
        )
        return parse_tencent_trends(payload, tsym=tsym, market=sym.market.value)


class YahooTrendsVendor(TrendsVendor):
    """1 分钟线,includePrePost=true,美股盘前盘后在同一条分时里。"""

    name = "yahoo"
    supports_markets = {"US", "HK"}

    def fetch(self, symbols: list[Symbol], config: dict) -> TrendBars:
        if not symbols:
            return TrendBars()
        sym = symbols[0]
        if sym.market not in (Market.US, Market.HK):
            return TrendBars(timezone=market_timezone(sym.market.value))
        ysym = sym.to_yfinance()
        proxy = (config or {}).get("proxy") or None
        payload = market_get(
            _YAHOO_CHART_URL.format(sym=ysym), host_key="query2.finance.yahoo.com",
            params={"interval": "1m", "range": "1d", "includePrePost": "true"},
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"},
            timeout=10, retries=1, parse="json", proxy=proxy,
            log_label="Yahoo分时", symbol=ysym,
        )
        return parse_yahoo_trends(payload, market=sym.market.value)
