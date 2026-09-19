"""持仓截图扫描：按列抽取 JSON，不用现价/可卖数量冒充成本和持仓。"""
import asyncio
from unittest.mock import AsyncMock

import pytest

from src.modules.portfolio.screenshot_scan import (
    decode_data_url,
    extract_json_array,
    normalize_vision_items,
)


def test_extract_json_array_from_fenced_markdown():
    text = """先看图
```json
[{"market":"CN","code":"600519","name":"贵州茅台","quantity":100,"avgCost":1423.56}]
```
"""
    assert extract_json_array(text)[0]["code"] == "600519"


def test_normalize_skips_last_price_shaped_invalid_rows_and_maps_markets():
    items = normalize_vision_items(
        [
            {"market": "a", "code": "600519", "name": "贵州茅台", "quantity": 100, "costPrice": 1423.56},
            {"market": "hk", "code": "700", "name": "腾讯", "quantity": 200, "avgCost": 320.1},
            {"market": "CN", "code": "000858", "name": "五粮液", "quantity": 80, "avgCost": 0},
            {"code": "AAPL", "name": "苹果", "quantity": "10", "avgCost": "189.2"},
        ]
    )
    assert [(row["market"], row["code"], row["quantity"], row["avgCost"]) for row in items] == [
        ("CN", "600519", 100.0, 1423.56),
        ("HK", "00700", 200.0, 320.1),
        ("US", "AAPL", 10.0, 189.2),
    ]


def test_normalize_keeps_name_only_app_rows_and_drops_overlay_tickers():
    items = normalize_vision_items(
        [
            {"market": "CN", "code": "", "name": "浙江鼎业", "quantity": 700, "avgCost": 5.362},
            {"market": "US", "code": "V", "name": "维萨", "quantity": 0, "avgCost": 0},
            {"market": "CN", "code": "", "name": "华宝证券", "quantity": 1, "avgCost": 1},
            {"market": "CN", "code": "沪电股份", "name": "沪电股份", "quantity": 500, "avgCost": 7.372},
        ]
    )
    assert [(row["name"], row["code"], row["quantity"], row["avgCost"]) for row in items] == [
        ("浙江鼎业", "", 700.0, 5.362),
        ("沪电股份", "", 500.0, 7.372),
    ]


def test_decode_data_url_rejects_empty_and_accepts_jpeg_header():
    with pytest.raises(ValueError, match="缺少截图"):
        decode_data_url("")
    payload = "aGVsbG8="
    data, ext = decode_data_url(f"data:image/jpeg;base64,{payload}")
    assert ext == "jpg"
    assert data == b"hello"


def test_screenshot_scan_endpoint_sends_image_to_vision_client(tmp_path, monkeypatch):
    from src.modules.portfolio.api import accounts
    from src.platform.ai import ai_failover

    client = AsyncMock()
    client.chat.return_value = (
        '[{"market":"CN","code":"000858","name":"五粮液","quantity":200,"avgCost":128.5}]'
    )
    monkeypatch.setattr(ai_failover, "get_configured_failover_client", lambda *a, **k: client)

    result = asyncio.run(
        accounts.portfolio_screenshot_scan(
            accounts.ScreenshotScanRequest(image="data:image/png;base64,aGVsbG8="),
            db=None,
        )
    )
    assert result["source"] == "vision"
    assert result["items"] == [
        {"market": "CN", "code": "000858", "name": "五粮液", "quantity": 200.0, "avgCost": 128.5}
    ]
    system, user = client.chat.call_args.args
    assert "可卖数量" in system and "成本价" in system
    assert client.chat.call_args.kwargs["images"]
