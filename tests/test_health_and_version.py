"""健康检查与版本号：唯一来源是仓库根目录 VERSION。"""

from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def test_version_file_is_semver_and_matches_frontend_package():
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    package = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    assert SEMVER.match(version)
    assert version == "0.14.0"
    assert package["version"] == version


def test_health_and_api_health_report_version_file(monkeypatch):
    monkeypatch.delenv("APP_VERSION", raising=False)
    from src.bootstrap.application import app

    client = TestClient(app)
    expected = (ROOT / "VERSION").read_text(encoding="utf-8").strip()

    bare = client.get("/health")
    assert bare.status_code == 200
    assert bare.json() == {"status": "ok", "version": expected}

    wrapped = client.get("/api/health")
    assert wrapped.status_code == 200
    body = wrapped.json()
    assert body["success"] is True
    assert body["data"]["status"] == "ok"
    assert body["data"]["version"] == expected

    version = client.get("/api/version")
    assert version.status_code == 200
    assert version.json()["data"]["version"] == expected
    assert app.version == expected


def test_health_reports_database_error_without_wrapper(monkeypatch):
    monkeypatch.setattr(
        "src.platform.observability.health.database_reachable",
        lambda: (False, "数据库连接失败"),
    )
    from src.bootstrap.application import app

    client = TestClient(app)
    bare = client.get("/health")
    assert bare.status_code == 503
    payload = bare.json()
    assert payload["status"] == "error"
    assert payload["message"] == "数据库连接失败"
    assert "version" in payload
    assert "success" not in payload

    wrapped = client.get("/api/health")
    assert wrapped.status_code == 200
    assert wrapped.json()["data"]["status"] == "error"
    assert wrapped.json()["data"]["message"] == "数据库连接失败"
