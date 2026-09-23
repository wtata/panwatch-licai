"""LLM 用量落库与查询 API。"""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.modules.administration.api import llm_usage as llm_usage_mod
from src.platform.ai.usage_tracker import (
    estimate_cost_usd,
    llm_scene,
    persist_enabled,
    record_llm_usage,
)
from src.platform.persistence.database import Base, get_db
from src.platform.persistence.models import LlmUsageRecord  # noqa: F401


def test_estimate_cost_known_model():
    cost = estimate_cost_usd("qwen-plus", 1_000_000, 1_000_000)
    assert cost == 0.4 + 1.2


def test_record_and_query(monkeypatch):
    assert persist_enabled is True
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    monkeypatch.setattr("src.platform.persistence.database.SessionLocal", Session)

    with llm_scene("assistant"):
        record_llm_usage(model="qwen-plus", prompt_tokens=1000, completion_tokens=200)
    record_llm_usage(
        model="qwen-vl-plus",
        prompt_tokens=800,
        completion_tokens=120,
        scene="screenshot_scan",
    )

    app = FastAPI()
    app.include_router(llm_usage_mod.router, prefix="/api/llm-usage")

    def _db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _db
    client = TestClient(app)

    listed = client.get("/api/llm-usage").json()
    assert listed["total"] == 2
    scenes = {item["scene"] for item in listed["items"]}
    assert scenes == {"assistant", "screenshot_scan"}
    assert any(item["scene_label"] == "助手对话" for item in listed["items"])

    filtered = client.get("/api/llm-usage", params={"scene": "screenshot_scan"}).json()
    assert filtered["total"] == 1
    assert filtered["items"][0]["model"] == "qwen-vl-plus"

    summary = client.get("/api/llm-usage/summary").json()
    assert summary["today"]["calls"] == 2
    assert summary["today"]["total_tokens"] == 1000 + 200 + 800 + 120
    assert summary["month"]["calls"] == 2
    assert len(summary["by_scene"]) == 2
