"""券商持仓截图扫描：按列抽取代码/名称/持仓数量/成本价。

同花顺等桌面持仓表从左到右通常是：
证券代码、证券名称、持仓数量、可卖数量、成本价、现价、最新市值、盈亏。
数量必须取「持仓数量」而不是「可卖数量」；成本必须取「成本价」而不是现价或市值。
"""
from __future__ import annotations

import base64
import json
import re
from typing import Any

MAX_IMAGE_BYTES = 5 * 1024 * 1024

VISION_SYSTEM_PROMPT = """你是持仓表格提取器。用户会给你一张券商 App 或同花顺持仓截图。

只提取持仓列表里的股票明细，忽略页面装饰和浮窗。

【必须忽略】
- 顶栏券商名（如华宝证券）、买入/卖出/持仓/查询按钮
- 总资产、持仓/可用/市值汇总、当日盈亏、持仓份额
- 会议共享浮窗、浏览器、桌面窗口里出现的美股代码（V/A/O/AAPL 等）
- 名称下方单独一行的市值（带千分位逗号的大数，如 3,696.05）

【同花顺 App 常见列（无证券代码）】
从左到右通常是：名称 | 盈亏 | 持仓 | 成本/现价
- name：左侧中文简称，如浙江鼎业、沪电股份
- quantity：只取「持仓」列整数（700/500/100）。不要用盈亏、不要用可卖、不要用市值
- avgCost：只取最右侧「成本/现价」列（如 5.362、7.372）。不要用盈亏（-82.23、-303.86），不要用市值
- code：App 截图经常没有代码。没有就填空字符串，不要编造，不要把持仓数量/盈亏数字当成代码
- 持仓为 0 的行跳过
- 港股成本可能带 HK$，只保留数字

【桌面同花顺表】
列通常是：证券代码、证券名称、持仓数量、可卖数量、成本价、现价、最新市值、盈亏。
quantity 用持仓数量不是可卖；avgCost 用成本价不是现价/市值。

【输出】
只输出 JSON 数组，不要 markdown，不要解释。每个元素：
{"market":"CN|HK|US","code":"证券代码或空字符串","name":"简称","quantity":数字,"avgCost":数字}

市场：A 股 6 位 → CN；港股 → HK；美股字母 → US。看不清市场且名称是中文时用 CN。
没有持仓时输出 []。
"""

VISION_USER_PROMPT = (
    "这是持仓截图。按列提取每一只股票的名称、持仓数量、成本价；"
    "没有代码就留空。不要提取券商名、汇总数字、会议浮窗。只输出 JSON 数组。"
)

_CN_CODE = re.compile(r"^\d{6}$")
_HK_CODE = re.compile(r"^\d{4,5}$")
_US_CODE = re.compile(r"^[A-Z]{1,5}(?:\.[A-Z])?$")
_CN_PREFIX = re.compile(
    r"^(00[0-3]|002|003|1[35689]|20[0-4]|30[013]|39[09]|43|50[0-9]|51[0-9]|52[0-9]|56[0-3]|58[08]|60[0135]|68[89]|83|87|88|920|9[02])"
)


def decode_data_url(image: str) -> tuple[bytes, str]:
    raw = (image or "").strip()
    if not raw:
        raise ValueError("缺少截图")
    mime = "png"
    if raw.startswith("data:"):
        header, _, payload = raw.partition(",")
        if not payload:
            raise ValueError("截图编码无效")
        if "image/jpeg" in header or "image/jpg" in header:
            mime = "jpg"
        raw = payload
    try:
        data = base64.b64decode(raw, validate=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("截图编码无效") from exc
    if not data:
        raise ValueError("截图为空")
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片超过 5MB，请裁切持仓表格后再试")
    return data, mime


def extract_json_array(text: str) -> list[Any] | None:
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\[[\s\S]*?\])\s*```", text)
    candidate = fenced.group(1) if fenced else _first_array(text)
    if not candidate:
        return None
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, list) else None


def _first_array(text: str) -> str | None:
    start = text.find("[")
    if start < 0:
        return None
    depth = 0
    for i, char in enumerate(text[start:], start):
        if char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def infer_market(code: str, hinted: str = "") -> str:
    hint = (hinted or "").upper()
    if hint in {"CN", "HK", "US"}:
        return hint
    if hint in {"A", "ETF", "FUND"}:
        return "CN"
    if _CN_CODE.match(code) and _CN_PREFIX.match(code):
        return "CN"
    if _HK_CODE.match(code):
        return "HK"
    if _US_CODE.match(code):
        return "US"
    return "CN"


def normalize_code(code: str, market: str) -> str:
    token = re.sub(r"[^A-Z0-9.]", "", code.upper())
    if market == "HK" and token.isdigit():
        return token.zfill(5)
    if market == "CN" and token.isdigit():
        return token.zfill(6)
    return token


_CHROME_RE = re.compile(
    r"华宝证券|正在共享|总资产|当日盈亏|可用资金|持仓份额|资金余额|持仓管理|"
    r"配号买入|资产分析|Realty|Visa|Agilent|BHEM|^买入$|^卖出$|^持仓$|^查询$"
)
_CN_NAME_RE = re.compile(r"[\u4e00-\u9fa5]{2,}")


def _is_chrome_text(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if _CHROME_RE.search(t):
        return True
    return bool(re.search(r"可用|成本/现|正在共享", t))


def normalize_vision_items(items: list[Any] | None) -> list[dict]:
    validated: list[dict] = []
    seen: set[str] = set()
    for item in items or []:
        if not isinstance(item, dict):
            continue
        raw_code = str(item.get("code") or item.get("symbol") or "").strip()
        name = str(item.get("name") or "").strip()
        if _is_chrome_text(raw_code) or _is_chrome_text(name):
            continue
        if re.search(r"证券-?\d|正在共享", name):
            continue
        quantity = _to_number(item.get("quantity"))
        avg_cost = _to_number(item.get("avgCost") or item.get("costPrice") or item.get("cost_price"))
        if quantity is None or quantity <= 0 or avg_cost is None or avg_cost <= 0:
            continue
        code_token = re.sub(r"[^A-Z0-9.]", "", raw_code.upper())
        if code_token and _US_CODE.match(code_token) and len(code_token) <= 2:
            continue
        if not code_token and not _CN_NAME_RE.search(name):
            continue
        market = infer_market(code_token, str(item.get("market") or ""))
        if not code_token:
            market = "HK" if str(item.get("market") or "").upper() == "HK" else "CN"
        code = normalize_code(raw_code, market) if code_token else ""
        if market == "CN" and code.isdigit() and not _CN_PREFIX.match(code):
            code = ""
        if market == "HK" and code.isdigit():
            n = int(code)
            if n >= 1000 and n % 100 == 0:
                code = ""
        if market == "US" and not _CN_NAME_RE.search(name):
            continue
        if not code and not _CN_NAME_RE.search(name):
            continue
        key = f"{market}:{code}" if code else f"NAME:{name}"
        if key in seen:
            continue
        seen.add(key)
        validated.append(
            {
                "market": market,
                "code": code,
                "name": name or code,
                "quantity": quantity,
                "avgCost": avg_cost,
            }
        )
    return validated


def _to_number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        return number if number == number else None
    cleaned = re.sub(r"[,%％\s]", "", str(value).replace(",", ""))
    cleaned = re.sub(r"(?i)HK\$|USD|CNY|[￥¥$]", "", cleaned)
    try:
        number = float(cleaned)
    except ValueError:
        return None
    return number if number == number else None
