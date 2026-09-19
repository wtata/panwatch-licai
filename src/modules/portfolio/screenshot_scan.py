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

只提取持仓明细行，忽略合计、可用资金、总资产、当日盈亏汇总。

【列规则，必须遵守】
- quantity：只取「持仓数量」「持股」「份额」，不要用「可卖数量」
- avgCost：只取「成本价」「持仓成本」「摊薄成本」，不要用「现价」「最新价」「最新市值」「浮动盈亏」
- 看不清的字段不要猜，那条记录跳过

【输出】
只输出 JSON 数组，不要 markdown，不要解释。每个元素：
{"market":"CN|HK|US","code":"证券代码","name":"简称","quantity":数字,"avgCost":数字}

市场：
- A 股/ETF/场内基金 6 位数字 → CN
- 港股 4-5 位数字 → HK（不足 5 位左侧补 0）
- 美股字母代码 → US

没有持仓时输出 []。
"""

VISION_USER_PROMPT = "提取这张持仓截图里每一行的证券代码、名称、持仓数量、成本价。只输出 JSON 数组。"

_CN_CODE = re.compile(r"^\d{6}$")
_HK_CODE = re.compile(r"^\d{4,5}$")
_US_CODE = re.compile(r"^[A-Z]{1,5}(?:\.[A-Z])?$")
_CN_PREFIX = re.compile(
    r"^(00[0-3]|002|003|1[35689]|20[0-4]|30[013]|39[09]|4[3-9]|50[0-9]|51[0-9]|52[0-9]|56[0-3]|58[08]|60[0135]|68[89]|8[0-9]|9[02])"
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


def normalize_vision_items(items: list[Any] | None) -> list[dict]:
    validated: list[dict] = []
    seen: set[str] = set()
    for item in items or []:
        if not isinstance(item, dict):
            continue
        raw_code = str(item.get("code") or item.get("symbol") or "").strip()
        if not raw_code:
            continue
        quantity = _to_number(item.get("quantity"))
        avg_cost = _to_number(item.get("avgCost") or item.get("costPrice") or item.get("cost_price"))
        if quantity is None or quantity <= 0 or avg_cost is None or avg_cost <= 0:
            continue
        market = infer_market(re.sub(r"[^A-Z0-9.]", "", raw_code.upper()), str(item.get("market") or ""))
        code = normalize_code(raw_code, market)
        if not code:
            continue
        key = f"{market}:{code}"
        if key in seen:
            continue
        seen.add(key)
        name = str(item.get("name") or "").strip() or code
        validated.append(
            {
                "market": market,
                "code": code,
                "name": name,
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
    try:
        number = float(cleaned)
    except ValueError:
        return None
    return number if number == number else None
