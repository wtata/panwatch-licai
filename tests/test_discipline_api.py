"""纪律笔记 / 规则 API 与路由挂载。"""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.platform.persistence.database import Base, get_db
from src.platform.persistence.models import DisciplineJournal, DisciplineRule  # noqa: F401
from src.modules.licai.api import discipline as discipline_mod


def _setup():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    app = FastAPI()
    app.include_router(discipline_mod.router, prefix="/api/discipline")

    def _db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _db
    return TestClient(app), Session


def test_journal_crud_roundtrip():
    client, _ = _setup()
    created = client.post(
        "/api/discipline/journal",
        json={"date": "2026-09-18", "symbol": "688195", "type": "buy", "text": "假设估值仍便宜"},
    )
    assert created.status_code == 200
    body = created.json()
    assert body["symbol"] == "688195"
    assert body["type"] == "buy"
    assert body["text"] == "假设估值仍便宜"

    listed = client.get("/api/discipline/journal").json()
    assert len(listed["items"]) == 1
    entry_id = listed["items"][0]["id"]

    deleted = client.delete(f"/api/discipline/journal/{entry_id}")
    assert deleted.status_code == 200
    assert client.get("/api/discipline/journal").json()["items"] == []


def test_journal_rejects_unknown_type():
    client, _ = _setup()
    resp = client.post(
        "/api/discipline/journal",
        json={"date": "2026-09-18", "type": "yolo", "text": "nope"},
    )
    assert resp.status_code == 400


def test_rules_toggle_appears_in_summary():
    client, Session = _setup()
    session = Session()
    session.add(DisciplineRule(body="单票不超过 25%", enabled=True))
    session.add(DisciplineRule(body="关掉的规则", enabled=False))
    session.add(
        DisciplineJournal(entry_date="2026-09-18", symbol="", entry_type="review", body="今日复盘")
    )
    session.commit()
    session.close()

    rules = client.get("/api/discipline/rules").json()["items"]
    assert len(rules) == 2

    enabled_id = next(r["id"] for r in rules if r["enabled"])
    disabled_id = next(r["id"] for r in rules if not r["enabled"])
    client.patch(f"/api/discipline/rules/{enabled_id}", json={"enabled": False})
    client.patch(f"/api/discipline/rules/{disabled_id}", json={"enabled": True, "text": "打开后出现在总览"})

    summary = client.get("/api/discipline/summary").json()
    assert [r["text"] for r in summary["rules"]] == ["打开后出现在总览"]
    assert summary["journal"][0]["text"] == "今日复盘"


def test_delete_missing_rule_is_404():
    client, _ = _setup()
    resp = client.delete("/api/discipline/rules/999")
    assert resp.status_code == 404


def test_create_rule_then_delete():
    client, _ = _setup()
    created = client.post("/api/discipline/rules", json={"text": "先写假设再下单"}).json()
    assert created["enabled"] is True
    deleted = client.delete(f"/api/discipline/rules/{created['id']}")
    assert deleted.status_code == 200
    assert client.get("/api/discipline/rules").json()["items"] == []


def test_discipline_and_learning_routers_are_jwt_protected():
    from src.bootstrap.application import app
    from src.modules.administration.api.auth import get_current_user

    paths = set(app.openapi().get("paths", {}).keys())
    assert "/api/discipline/journal" in paths
    assert "/api/discipline/rules" in paths
    assert "/api/discipline/summary" in paths
    assert "/api/learning/cards" in paths

    protected = [
        r
        for r in app.routes
        if getattr(r, "path", "").startswith("/api/discipline")
        or getattr(r, "path", "").startswith("/api/learning")
    ]
    assert protected
    for route in protected:
        dep_fns = [d.dependency for d in (route.dependencies or [])]
        assert get_current_user in dep_fns


def test_m127_creates_discipline_tables_and_seeds_rules(tmp_path):
    from src.platform.persistence.migrations import _m127_discipline_tables
    from sqlalchemy import create_engine, text

    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-discipline.db'}")
    with engine.begin() as conn:
        _m127_discipline_tables(conn)
        _m127_discipline_tables(conn)
        tables = {row[0] for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))}
        count = conn.execute(text("SELECT COUNT(*) FROM discipline_rules")).scalar()
        journal_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(discipline_journal)"))}
    engine.dispose()

    assert {"discipline_journal", "discipline_rules"} <= tables
    assert count == 5
    assert {"entry_date", "symbol", "entry_type", "body"} <= journal_cols


def test_orm_models_register_discipline_tables():
    tables = inspect(Base).get_table_names()
    assert "discipline_journal" in tables
    assert "discipline_rules" in tables
