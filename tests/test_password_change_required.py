"""内置管理员首次登录（或仍使用初始密码）必须修改密码。"""

from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.modules.administration import password_policy
from src.modules.administration.api import auth
from src.platform.security.password_hash import hash_password
from src.platform.persistence.database import Base, get_db
from src.platform.persistence.migrations import _m130_auth_must_change_password
from src.platform.persistence.models import AppSettings  # noqa: F401
from src.web.response import ResponseWrapperMiddleware


def _app(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    monkeypatch.setattr(auth, "get_jwt_secret", lambda: "test-secret-placeholder-32bytes!")

    app = FastAPI()
    app.add_middleware(ResponseWrapperMiddleware)
    app.include_router(auth.router, prefix="/api/auth")

    @app.get("/api/protected")
    def protected(_user=Depends(auth.get_current_user)):
        return {"ok": True}

    def _db():
        session = Session()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _db
    return TestClient(app), Session


def _login(client: TestClient, username: str, password: str) -> tuple[str, bool]:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    body = response.json()
    return body["data"]["token"], body["data"]["must_change_password"]


def test_env_account_must_change_password_before_using_api(monkeypatch):
    monkeypatch.setenv("AUTH_USERNAME", "admin")
    monkeypatch.setenv("AUTH_PASSWORD", "init-placeholder")
    client, Session = _app(monkeypatch)
    db = Session()
    assert auth.init_auth_from_env(db) is True
    db.close()

    token, must_change = _login(client, "admin", "init-placeholder")
    assert must_change is True
    headers = {"Authorization": f"Bearer {token}"}

    blocked = client.get("/api/protected", headers=headers)
    assert blocked.status_code == 403
    assert blocked.json()["code"] == password_policy.PASSWORD_CHANGE_REQUIRED_CODE
    assert "初始密码" in blocked.json()["message"]

    me = client.get("/api/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["data"]["must_change_password"] is True

    rejected = client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"password": "init-placeholder"},
    )
    assert rejected.status_code == 400

    changed = client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"password": "replaced-placeholder"},
    )
    assert changed.status_code == 200
    assert changed.json()["data"]["must_change_password"] is False

    allowed = client.get("/api/protected", headers=headers)
    assert allowed.status_code == 200
    assert allowed.json()["data"]["ok"] is True


def test_existing_custom_password_is_not_forced(monkeypatch):
    monkeypatch.delenv("AUTH_USERNAME", raising=False)
    monkeypatch.delenv("AUTH_PASSWORD", raising=False)
    client, Session = _app(monkeypatch)
    db = Session()
    db.add(AppSettings(key="auth_username", value="admin", description=""))
    db.add(AppSettings(key="auth_password_hash", value=hash_password("already-set"), description=""))
    db.commit()
    assert auth.init_auth_from_env(db) is False
    assert password_policy.is_password_change_required(db) is False
    db.close()

    token, must_change = _login(client, "admin", "already-set")
    assert must_change is False
    allowed = client.get("/api/protected", headers={"Authorization": f"Bearer {token}"})
    assert allowed.status_code == 200


def test_existing_account_still_on_initial_password_is_forced(monkeypatch):
    monkeypatch.setenv("AUTH_PASSWORD", "init-placeholder")
    client, Session = _app(monkeypatch)
    db = Session()
    db.add(AppSettings(key="auth_username", value="admin", description=""))
    db.add(
        AppSettings(
            key="auth_password_hash",
            value=hash_password("init-placeholder"),
            description="",
        )
    )
    db.commit()
    assert auth.init_auth_from_env(db) is False
    assert password_policy.is_password_change_required(db) is True
    db.close()

    _token, must_change = _login(client, "admin", "init-placeholder")
    assert must_change is True


def _settings_engine(tmp_path, rows: list[tuple[str, str]]):
    engine = create_engine(f"sqlite:///{tmp_path / 'auth.db'}")
    with engine.begin() as conn:
        conn.execute(
            text(
                """
CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY,
  key TEXT,
  value TEXT,
  description TEXT
)
"""
            )
        )
        for key, value in rows:
            conn.execute(
                text("INSERT INTO app_settings (key, value, description) VALUES (:key, :value, '')"),
                {"key": key, "value": value},
            )
    return engine


def test_migration_does_not_force_changed_password(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_PASSWORD", "init-placeholder")
    engine = _settings_engine(
        tmp_path,
        [("auth_password_hash", hash_password("already-changed"))],
    )
    with engine.begin() as conn:
        _m130_auth_must_change_password(conn)
        _m130_auth_must_change_password(conn)
        flag = conn.execute(
            text("SELECT value FROM app_settings WHERE key = 'auth_must_change_password'")
        ).scalar()
        count = conn.execute(
            text("SELECT COUNT(*) FROM app_settings WHERE key = 'auth_must_change_password'")
        ).scalar()
    engine.dispose()
    assert flag == "0"
    assert count == 1


def test_migration_flags_account_still_using_initial_password(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_PASSWORD", "init-placeholder")
    engine = _settings_engine(
        tmp_path,
        [("auth_password_hash", hash_password("init-placeholder"))],
    )
    with engine.begin() as conn:
        _m130_auth_must_change_password(conn)
        flag = conn.execute(
            text("SELECT value FROM app_settings WHERE key = 'auth_must_change_password'")
        ).scalar()
    engine.dispose()
    assert flag == "1"


def test_migration_without_env_password_does_not_force(tmp_path, monkeypatch):
    monkeypatch.delenv("AUTH_PASSWORD", raising=False)
    engine = _settings_engine(
        tmp_path,
        [("auth_password_hash", hash_password("whatever"))],
    )
    with engine.begin() as conn:
        _m130_auth_must_change_password(conn)
        flag = conn.execute(
            text("SELECT value FROM app_settings WHERE key = 'auth_must_change_password'")
        ).scalar()
    engine.dispose()
    assert flag == "0"
