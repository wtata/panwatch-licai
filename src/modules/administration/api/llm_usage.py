"""大模型调用与 token 消费记录。"""

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from src.platform.ai.usage_tracker import CST, SCENE_LABELS, scene_label
from src.platform.persistence.database import get_db
from src.platform.persistence.models import LlmUsageRecord

router = APIRouter()


class UsageItem(BaseModel):
    id: int
    day: str
    scene: str
    scene_label: str
    operation: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float
    source: str
    agent_name: str
    trace_id: str
    created_at: str


class UsageListResponse(BaseModel):
    items: list[UsageItem]
    total: int


class SceneBreakdown(BaseModel):
    scene: str
    scene_label: str
    calls: int
    total_tokens: int
    cost_usd: float


class DayBreakdown(BaseModel):
    day: str
    calls: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float


class UsageSummaryResponse(BaseModel):
    today: SceneBreakdown
    month: SceneBreakdown
    by_day: list[DayBreakdown]
    by_scene: list[SceneBreakdown]
    scenes: list[dict]


def _iso(dt) -> str:
    if not dt:
        return ""
    if dt.tzinfo is None:
        # 落库时写入的是 Asia/Shanghai 墙钟，去掉 tz 后仍按东八区理解。
        dt = dt.replace(tzinfo=CST)
    return dt.isoformat()


def _item(row: LlmUsageRecord) -> UsageItem:
    return UsageItem(
        id=row.id,
        day=row.day or "",
        scene=row.scene or "llm",
        scene_label=scene_label(row.scene or "llm"),
        operation=row.operation or "chat",
        model=row.model or "",
        prompt_tokens=int(row.prompt_tokens or 0),
        completion_tokens=int(row.completion_tokens or 0),
        total_tokens=int(row.total_tokens or 0),
        cost_usd=float(row.cost_usd or 0),
        source=row.source or "api",
        agent_name=row.agent_name or "",
        trace_id=row.trace_id or "",
        created_at=_iso(row.created_at),
    )


@router.get("", response_model=UsageListResponse)
def list_usage(
    scene: str = "",
    day: str = "",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    query = db.query(LlmUsageRecord)
    if scene.strip():
        query = query.filter(LlmUsageRecord.scene == scene.strip())
    if day.strip():
        query = query.filter(LlmUsageRecord.day == day.strip())
    total = query.count()
    rows = (
        query.order_by(LlmUsageRecord.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return UsageListResponse(items=[_item(r) for r in rows], total=total)


@router.get("/summary", response_model=UsageSummaryResponse)
def usage_summary(days: int = Query(30, ge=1, le=90), db: Session = Depends(get_db)):
    today = datetime.now(CST).strftime("%Y-%m-%d")
    month_prefix = today[:7]

    def _agg(query) -> tuple[int, int, float]:
        row = query.with_entities(
            func.count(LlmUsageRecord.id),
            func.coalesce(func.sum(LlmUsageRecord.total_tokens), 0),
            func.coalesce(func.sum(LlmUsageRecord.cost_usd), 0.0),
        ).one()
        return int(row[0] or 0), int(row[1] or 0), round(float(row[2] or 0), 6)

    today_q = db.query(LlmUsageRecord).filter(LlmUsageRecord.day == today)
    month_q = db.query(LlmUsageRecord).filter(LlmUsageRecord.day.like(f"{month_prefix}-%"))
    t_calls, t_tokens, t_cost = _agg(today_q)
    m_calls, m_tokens, m_cost = _agg(month_q)

    day_rows = (
        db.query(
            LlmUsageRecord.day,
            func.count(LlmUsageRecord.id),
            func.coalesce(func.sum(LlmUsageRecord.prompt_tokens), 0),
            func.coalesce(func.sum(LlmUsageRecord.completion_tokens), 0),
            func.coalesce(func.sum(LlmUsageRecord.total_tokens), 0),
            func.coalesce(func.sum(LlmUsageRecord.cost_usd), 0.0),
        )
        .group_by(LlmUsageRecord.day)
        .order_by(LlmUsageRecord.day.desc())
        .limit(days)
        .all()
    )
    scene_rows = (
        db.query(
            LlmUsageRecord.scene,
            func.count(LlmUsageRecord.id),
            func.coalesce(func.sum(LlmUsageRecord.total_tokens), 0),
            func.coalesce(func.sum(LlmUsageRecord.cost_usd), 0.0),
        )
        .filter(LlmUsageRecord.day.like(f"{month_prefix}-%"))
        .group_by(LlmUsageRecord.scene)
        .order_by(func.coalesce(func.sum(LlmUsageRecord.cost_usd), 0).desc())
        .all()
    )

    return UsageSummaryResponse(
        today=SceneBreakdown(
            scene="today",
            scene_label="今日",
            calls=t_calls,
            total_tokens=t_tokens,
            cost_usd=t_cost,
        ),
        month=SceneBreakdown(
            scene="month",
            scene_label="本月",
            calls=m_calls,
            total_tokens=m_tokens,
            cost_usd=m_cost,
        ),
        by_day=[
            DayBreakdown(
                day=r[0] or "",
                calls=int(r[1] or 0),
                prompt_tokens=int(r[2] or 0),
                completion_tokens=int(r[3] or 0),
                total_tokens=int(r[4] or 0),
                cost_usd=round(float(r[5] or 0), 6),
            )
            for r in day_rows
        ],
        by_scene=[
            SceneBreakdown(
                scene=r[0] or "llm",
                scene_label=scene_label(r[0] or "llm"),
                calls=int(r[1] or 0),
                total_tokens=int(r[2] or 0),
                cost_usd=round(float(r[3] or 0), 6),
            )
            for r in scene_rows
        ],
        scenes=[{"value": k, "label": v} for k, v in SCENE_LABELS.items()],
    )
