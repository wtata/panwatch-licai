"""当日分时 vendors:东财(CN/HK/US)、腾讯(CN/HK)、新浪(US 常规时段)、Yahoo(US/HK,含盘前盘后)。

time 一律写成市场本地钟面,ts 为真实 Unix 秒。图表用 ts + 时区格式化,
不能把 Unix 秒当 UTC 钟面直接画(否则 A 股 09:30 会显示成 01:30)。

东财美股 trends2 的时间字符串是北京时间,不是美东。先按上海时区得到绝对时间,
再写成美东钟面(含夏令时)。否则 09:30 会画成 21:30,过了北京零点还会被裁成从 00:00 起算。

新浪美股分时是国内可直连的常规交易时段曲线(09:30–16:00 美东),不含盘前盘后。
腾讯 minute/query 对美股只给一个收盘点,不能当成分时。
"""
from __future__ import annotations

import re
from datetime import datetime, time, timedelta
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
# 新浪美股当日分时。整段是 JSON 字符串:「HH:MM:SS,成交量,均价,价格;...」。
# 国内可直连,只覆盖常规交易时段。盘前盘后仍走 Yahoo(通常要代理)。
_SINA_US_MINLINE_URL = (
    "https://stock.finance.sina.com.cn/usstock/api/json.php/US_MinlineNService.getMinline"
)
_SINA_US_QUOTE_URL = "https://hq.sinajs.cn/list="
_SINA_TRENDS_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"}
_EN_MONTH = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

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


def _fourth_is_avg(price: float, fourth: float) -> bool:
    """第四列贴近现价时,它就是均价;否则是成交额。"""
    return price > 0 and abs(fourth - price) / price < 0.5


def _turnover_share_scale(price: float, volume: float, amount: float) -> float:
    """把腾讯成交量换成股数的乘数。

    成交额是元。主板/创业板成交量是手(1手=100股),直接 amount/volume 会把均价放大约 100 倍。
    科创板和港股成交量已经是股,amount/volume 就在现价附近。用第一笔的量纲锁定,避免误伤。
    """
    if price <= 0 or volume <= 0 or amount <= 0:
        return 1.0
    per_unit = amount / volume
    if abs(per_unit - price) / price < 0.5:
        return 1.0
    per_lot = per_unit / 100.0
    if abs(per_lot - price) / price < 0.5:
        return 100.0
    return 100.0 if abs(per_lot - price) < abs(per_unit - price) else 1.0


def _volume_series_is_cumulative(volumes: list[float]) -> bool:
    """腾讯 minute/query 的成交量和成交额是从开盘起的累计值,不是这一分钟的增量。"""
    if len(volumes) < 2:
        return True
    return all(cur >= prev for prev, cur in zip(volumes, volumes[1:]))


def parse_tencent_trends(payload: dict | None, *, tsym: str, market: str) -> TrendBars:
    """腾讯 minute/query。每条「HHMM 价格 成交量 均价或成交额」。

    成交额路径的均价 = 累计成交额 / 累计股数。A 股主板股数 = 成交量(手) × 100。
    """
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

    parsed_rows: list[tuple[str, int, float, float, float | None]] = []
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
        time_text, ts = parsed
        parsed_rows.append((time_text, ts, price, third, fourth))

    turnover_vols = [
        vol for _, _, price, vol, fourth in parsed_rows
        if fourth is not None and fourth > 0 and vol > 0 and not _fourth_is_avg(price, fourth)
    ]
    cumulative = _volume_series_is_cumulative(turnover_vols) if turnover_vols else False
    scale = 1.0
    scale_locked = False
    cum_amt = 0.0
    cum_shares = 0.0
    prev_vol = 0.0
    points: list[TrendPoint] = []
    for time_text, ts, price, third, fourth in parsed_rows:
        volume = third
        avg = price
        if fourth is not None and _fourth_is_avg(price, fourth):
            avg = fourth
        elif fourth is not None and fourth > 0 and third > 0:
            if not scale_locked:
                scale = _turnover_share_scale(price, third, fourth)
                scale_locked = True
            if cumulative:
                # 列里已经是当日累计,再把累计值加总会把均价算偏。
                shares = third * scale
                avg = fourth / shares if shares else price
                delta = third - prev_vol
                volume = delta if delta > 0 else 0.0
                prev_vol = third
            else:
                shares = third * scale
                cum_amt += fourth
                cum_shares += shares
                avg = cum_amt / cum_shares if cum_shares else price
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


def _now_ny() -> datetime:
    return datetime.now(ZoneInfo("America/New_York"))


def _as_ny(now: datetime) -> datetime:
    tz = ZoneInfo("America/New_York")
    if now.tzinfo is None:
        return now.replace(tzinfo=tz)
    return now.astimezone(tz)


def infer_us_regular_session_date(now: datetime) -> str:
    """没有收盘戳时,用美东钟面推断新浪分时属于哪一个常规交易日。

    开盘前和周末回退到上一工作日。不含交易所假日表;假日靠报价里的收盘日期修正。
    """
    current = _as_ny(now)
    session = current.date()
    if current.time() < time(9, 30):
        session -= timedelta(days=1)
    while session.weekday() >= 5:
        session -= timedelta(days=1)
    return session.isoformat()


def _us_minline_in_progress(now_et: datetime, last_hhmm: str) -> bool:
    """曲线还在往前印,才是「今天」这场;已经收到 16:00 就是上一场完整分时。"""
    if now_et.weekday() >= 5 or len(last_hhmm) < 5:
        return False
    clock = now_et.time()
    if clock < time(9, 30) or clock > time(16, 10):
        return False
    if last_hhmm >= "16:00":
        return False
    # 最后一根比当前钟面还晚,说明这是上一场提前收盘的完整曲线,不是今天。
    return last_hhmm <= now_et.strftime("%H:%M")


def parse_sina_us_close_stamp(text: str, now: datetime) -> datetime | None:
    """新浪美股报价第 26 列:「Sep 22 04:00PM EDT」。只要日期,不依赖系统 locale。"""
    match = re.match(r"([A-Za-z]{3})\s+(\d{1,2})", (text or "").strip())
    if not match:
        return None
    month = _EN_MONTH.get(match.group(1).lower())
    if month is None:
        return None
    current = _as_ny(now)
    try:
        stamp = datetime(current.year, month, int(match.group(2)), tzinfo=ZoneInfo("America/New_York"))
    except ValueError:
        return None
    if stamp.date() > current.date() + timedelta(days=1):
        stamp = stamp.replace(year=current.year - 1)
    return stamp


def parse_sina_us_quote_meta(text: str | None, now: datetime) -> tuple[float | None, datetime | None]:
    """昨收在第 27 列(下标 26),常规收盘戳在第 26 列(下标 25)。与 sina 行情 vendor 对齐。"""
    if not text:
        return None, None
    matched = re.search(r'="(.*)"', text)
    body = matched.group(1) if matched else text
    parts = body.split(",")
    if len(parts) <= 26:
        return None, None
    return _f(parts[26]), parse_sina_us_close_stamp(parts[25], now)


def resolve_us_minline_session_date(
    now: datetime,
    last_clock: str,
    close_stamp: datetime | None = None,
) -> str:
    """给没有日期的新浪分时补上交易日。

    盘中曲线用当天。已经走到 16:00 的完整曲线用报价里的收盘日,
    这样节假日白天不会把上一交易日画成今天。报价缺失时退回钟面推断。
    """
    current = _as_ny(now)
    if _us_minline_in_progress(current, (last_clock or "")[:5]):
        return current.date().isoformat()
    if close_stamp is not None:
        return _as_ny(close_stamp).date().isoformat()
    return infer_us_regular_session_date(current)


def _sina_minline_text(payload) -> str:
    if isinstance(payload, str):
        return payload.strip().strip('"')
    return ""


def _minline_last_clock(payload) -> str:
    last = ""
    for row in _sina_minline_text(payload).split(";"):
        parts = row.split(",")
        if len(parts) >= 4 and ":" in parts[0]:
            last = parts[0].strip()[:5]
    return last


def parse_sina_us_minline(
    payload,
    *,
    session_date: str,
    prev_close: float | None = None,
) -> TrendBars:
    """新浪 US_MinlineNService:「HH:MM:SS,成交量,均价,价格」,分号分隔。

    时间为美东钟面,没有日期,由 session_date 补上。成交量是这一分钟的量,不是累计。
    均价是源给的当日均价,不要再用成交额重算。
    """
    bars = TrendBars(timezone="America/New_York", vendor="sina", prev_close=prev_close)
    text = _sina_minline_text(payload)
    if not text or text.startswith("{"):
        return bars
    points: list[TrendPoint] = []
    for row in text.split(";"):
        parts = row.split(",")
        if len(parts) < 4:
            continue
        clock = parts[0].strip()
        if len(clock) < 5 or clock[2] != ":":
            continue
        price = _f(parts[3])
        avg = _f(parts[2])
        volume = _f(parts[1])
        if price is None:
            continue
        parsed = _local_ts(f"{session_date} {clock[:5]}", "America/New_York")
        if parsed is None:
            continue
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


def _fetch_sina_us_quote_meta(code: str, now: datetime) -> tuple[float | None, datetime | None]:
    text = market_get(
        _SINA_US_QUOTE_URL + f"gb_{code.lower()}",
        host_key="hq.sinajs.cn",
        headers=_SINA_TRENDS_HEADERS,
        parse="text",
        encoding="gbk",
        timeout=8,
        retries=1,
        min_interval_s=0.0,
        log_label="新浪美股昨收",
        symbol=code,
    )
    return parse_sina_us_quote_meta(text, now)


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


class SinaTrendsVendor(TrendsVendor):
    """美股常规时段分时。国内直连,不覆盖 A 股/港股,也不含盘前盘后。"""

    name = "sina"
    supports_markets = {"US"}

    def fetch(self, symbols: list[Symbol], config: dict) -> TrendBars:
        if not symbols:
            return TrendBars()
        sym = symbols[0]
        if sym.market != Market.US:
            return TrendBars(timezone=market_timezone(sym.market.value))
        code = sym.code.strip().upper()
        bars = TrendBars(timezone="America/New_York", vendor="sina")
        if not code:
            return bars
        payload = market_get(
            _SINA_US_MINLINE_URL,
            host_key="stock.finance.sina.com.cn",
            min_interval_s=0.15,
            params={"symbol": code, "day": "1"},
            headers=_SINA_TRENDS_HEADERS,
            timeout=12,
            retries=1,
            parse="json",
            log_label="新浪美股分时",
            symbol=code,
        )
        if not _sina_minline_text(payload):
            return bars
        now = _now_ny()
        prev_close, close_stamp = _fetch_sina_us_quote_meta(code, now)
        session_date = resolve_us_minline_session_date(now, _minline_last_clock(payload), close_stamp)
        return parse_sina_us_minline(payload, session_date=session_date, prev_close=prev_close)
