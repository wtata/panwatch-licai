"""学习短文卡片（v1 内置静态内容）。"""

from fastapi import APIRouter

from src.modules.licai.learning_cards import list_learning_cards

router = APIRouter()


@router.get("/cards")
def list_cards():
    return {"items": list_learning_cards()}
