"""进程健康检查。

调用方传入版本号，避免本模块去依赖业务包。
数据库执行 SELECT 1 失败时 status 为 error。
"""

from __future__ import annotations

from sqlalchemy import text


def database_reachable() -> tuple[bool, str]:
    try:
        from src.platform.persistence.database import engine

        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True, ""
    except Exception:
        return False, "数据库连接失败"


def build_health_payload(version: str) -> dict:
    ok, message = database_reachable()
    if ok:
        return {"status": "ok", "version": version}
    return {"status": "error", "version": version, "message": message}
