"""记录每次 LLM 调用的 token 用量与估算费用。"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone

from src.platform.observability.log_context import get_log_context

logger = logging.getLogger(__name__)

persist_enabled = True

_scene_var: ContextVar[str] = ContextVar("llm_scene", default="")

CST = timezone(timedelta(hours=8))

# 美元 / 百万 token。未知模型走兜底价。
_PRICING: dict[str, tuple[float, float]] = {
    "deepseek-chat": (0.14, 0.28),
    "deepseek-reasoner": (0.55, 2.19),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.00),
    "claude-sonnet-4": (3.00, 15.00),
    "glm-4-flash": (0.05, 0.20),
    "glm-4-plus": (0.70, 0.70),
    "qwen-turbo": (0.05, 0.20),
    "qwen-plus": (0.40, 1.20),
    "qwen-max": (1.60, 6.40),
    "qwen-vl-plus": (0.21, 0.63),
    "qwen-vl-max": (0.40, 1.20),
    "qwen2.5-vl": (0.21, 0.63),
}

SCENE_LABELS: dict[str, str] = {
    "assistant": "助手对话",
    "screenshot_scan": "截图导入",
    "tradingagents": "深度分析",
    "model_test": "模型测试",
    "portfolio_checkup": "组合体检",
    "daily_report": "收盘复盘",
    "premarket_outlook": "盘前分析",
    "intraday_monitor": "盘中监测",
    "news_digest": "新闻速递",
    "chart_analyst": "技术分析",
    "llm": "其他",
}

_DEFAULT_PRICE = (0.14, 0.28)


def scene_label(scene: str) -> str:
    key = (scene or "llm").strip() or "llm"
    return SCENE_LABELS.get(key, key)


@contextmanager
def llm_scene(scene: str):
    token = _scene_var.set((scene or "").strip())
    try:
        yield
    finally:
        _scene_var.reset(token)


def current_scene() -> str:
    return (_scene_var.get() or "").strip()


def resolve_scene(explicit: str | None = None) -> str:
    if explicit and explicit.strip():
        return explicit.strip()
    scene = current_scene()
    if scene:
        return scene
    agent = (get_log_context().get("agent_name") or "").strip()
    return agent or "llm"


def estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    key = (model or "").strip().lower()
    rates = _PRICING.get(key)
    if rates is None:
        for name, price in _PRICING.items():
            if name in key:
                rates = price
                break
    if rates is None:
        rates = _DEFAULT_PRICE
    inp, out = rates
    return round(
        (max(prompt_tokens, 0) / 1_000_000 * inp)
        + (max(completion_tokens, 0) / 1_000_000 * out),
        6,
    )


def estimate_tokens_from_text(text: str) -> int:
    if not text:
        return 0
    return max(1, len(text) // 4)


def record_llm_usage(
    *,
    model: str,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    scene: str | None = None,
    operation: str = "chat",
    source: str = "api",
) -> None:
    """写入一条调用记录。失败不影响主流程。"""
    if not persist_enabled:
        return
    prompt = int(prompt_tokens or 0)
    completion = int(completion_tokens or 0)
    if prompt < 0 or completion < 0:
        return
    if prompt == 0 and completion == 0 and source == "api":
        # 供应商没回 usage 时由调用方改 source=estimated 再记
        return
    try:
        _persist(
            model=model or "",
            prompt_tokens=prompt,
            completion_tokens=completion,
            scene=resolve_scene(scene),
            operation=operation or "chat",
            source=source or "api",
        )
    except Exception:
        logger.debug("写入 LLM 用量失败", exc_info=True)


def _persist(
    *,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    scene: str,
    operation: str,
    source: str,
) -> None:
    from src.platform.persistence.database import SessionLocal
    from src.platform.persistence.models import LlmUsageRecord

    ctx = get_log_context()
    now = datetime.now(CST)
    total = prompt_tokens + completion_tokens
    row = LlmUsageRecord(
        day=now.strftime("%Y-%m-%d"),
        scene=scene,
        operation=operation,
        model=model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total,
        cost_usd=estimate_cost_usd(model, prompt_tokens, completion_tokens),
        source=source,
        agent_name=(ctx.get("agent_name") or "")[:64],
        trace_id=(ctx.get("trace_id") or "")[:64],
        created_at=now.replace(tzinfo=None),
    )
    db = SessionLocal()
    try:
        db.add(row)
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
