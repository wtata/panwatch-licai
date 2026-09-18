"""交易纪律：笔记 + 个人规则 CRUD。"""

from __future__ import annotations

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from src.platform.persistence.database import get_db
from src.platform.persistence.models import DisciplineJournal, DisciplineRule

router = APIRouter()

JOURNAL_TYPES = ("buy", "reduce", "watch", "review")
DATE_LEN = 10


def _today() -> str:
    return date.today().isoformat()


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    aware = dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
    return aware.isoformat(timespec="seconds")


def _journal_dict(row: DisciplineJournal) -> dict:
    return {
        "id": row.id,
        "date": row.entry_date,
        "symbol": row.symbol or "",
        "type": row.entry_type,
        "text": row.body,
        "created_at": _iso(row.created_at),
    }


def _rule_dict(row: DisciplineRule) -> dict:
    return {
        "id": row.id,
        "text": row.body,
        "enabled": bool(row.enabled),
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def _validate_date(value: str) -> str:
    text = (value or "").strip()
    if len(text) != DATE_LEN:
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD")
    try:
        date.fromisoformat(text)
    except ValueError as exc:
        raise HTTPException(400, "日期格式应为 YYYY-MM-DD") from exc
    return text


def _validate_type(value: str) -> str:
    entry_type = (value or "").strip().lower()
    if entry_type not in JOURNAL_TYPES:
        raise HTTPException(400, f"类型须为 {', '.join(JOURNAL_TYPES)}")
    return entry_type


class JournalCreate(BaseModel):
    date: str | None = None
    symbol: str = ""
    type: str = "review"
    text: str = Field(..., min_length=1, max_length=8000)


class RuleCreate(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    enabled: bool = True


class RuleUpdate(BaseModel):
    text: str | None = Field(None, min_length=1, max_length=2000)
    enabled: bool | None = None


@router.get("/journal")
def list_journal(limit: int = 100, db: Session = Depends(get_db)):
    cap = max(1, min(int(limit or 100), 200))
    rows = (
        db.query(DisciplineJournal)
        .order_by(DisciplineJournal.entry_date.desc(), DisciplineJournal.id.desc())
        .limit(cap)
        .all()
    )
    return {"items": [_journal_dict(row) for row in rows]}


@router.post("/journal")
def create_journal(payload: JournalCreate, db: Session = Depends(get_db)):
    body = payload.text.strip()
    if not body:
        raise HTTPException(400, "内容不能为空")
    row = DisciplineJournal(
        entry_date=_validate_date(payload.date or _today()),
        symbol=(payload.symbol or "").strip().upper(),
        entry_type=_validate_type(payload.type),
        body=body,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _journal_dict(row)


@router.delete("/journal/{entry_id}")
def delete_journal(entry_id: int, db: Session = Depends(get_db)):
    row = db.query(DisciplineJournal).filter(DisciplineJournal.id == entry_id).first()
    if not row:
        raise HTTPException(404, "笔记不存在")
    db.delete(row)
    db.commit()
    return {"success": True, "id": entry_id}


@router.get("/rules")
def list_rules(db: Session = Depends(get_db)):
    rows = db.query(DisciplineRule).order_by(DisciplineRule.id.asc()).all()
    return {"items": [_rule_dict(row) for row in rows]}


@router.post("/rules")
def create_rule(payload: RuleCreate, db: Session = Depends(get_db)):
    body = payload.text.strip()
    if not body:
        raise HTTPException(400, "规则不能为空")
    row = DisciplineRule(body=body, enabled=bool(payload.enabled))
    db.add(row)
    db.commit()
    db.refresh(row)
    return _rule_dict(row)


@router.patch("/rules/{rule_id}")
def update_rule(rule_id: int, payload: RuleUpdate, db: Session = Depends(get_db)):
    row = db.query(DisciplineRule).filter(DisciplineRule.id == rule_id).first()
    if not row:
        raise HTTPException(404, "规则不存在")
    if payload.text is not None:
        body = payload.text.strip()
        if not body:
            raise HTTPException(400, "规则不能为空")
        row.body = body
    if payload.enabled is not None:
        row.enabled = bool(payload.enabled)
    db.commit()
    db.refresh(row)
    return _rule_dict(row)


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int, db: Session = Depends(get_db)):
    row = db.query(DisciplineRule).filter(DisciplineRule.id == rule_id).first()
    if not row:
        raise HTTPException(404, "规则不存在")
    db.delete(row)
    db.commit()
    return {"success": True, "id": rule_id}


@router.get("/summary")
def discipline_summary(db: Session = Depends(get_db)):
    """总览用：已启用规则 + 最近笔记。"""
    rules = (
        db.query(DisciplineRule)
        .filter(DisciplineRule.enabled == True)
        .order_by(DisciplineRule.id.asc())
        .all()
    )
    notes = (
        db.query(DisciplineJournal)
        .order_by(DisciplineJournal.entry_date.desc(), DisciplineJournal.id.desc())
        .limit(3)
        .all()
    )
    return {
        "rules": [_rule_dict(row) for row in rules],
        "journal": [_journal_dict(row) for row in notes],
    }
