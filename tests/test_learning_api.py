"""学习卡片 API。"""

from src.modules.licai.learning_cards import LEARNING_CARDS, list_learning_cards


def test_learning_cards_cover_core_topics():
    ids = [card["id"] for card in list_learning_cards()]
    assert ids == ["valuation", "sizing", "t-trading", "overnight", "review"]
    assert len(LEARNING_CARDS) == 5
    for card in list_learning_cards():
        assert card["title"]
        assert card["points"]


def test_learning_cards_endpoint_shape():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from src.modules.licai.api import learning as learning_mod

    app = FastAPI()
    app.include_router(learning_mod.router, prefix="/api/learning")
    data = TestClient(app).get("/api/learning/cards").json()
    assert len(data["items"]) == 5
    assert data["items"][0]["kicker"] == "估值"
