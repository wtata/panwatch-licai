"""按天日志文件。"""

from __future__ import annotations

import logging
from datetime import datetime

from src.platform.observability.daily_log import DailyFileLogHandler, attach_daily_file_handler


def test_daily_handler_writes_dated_file_and_drops_old_ones(tmp_path):
    stale = tmp_path / "panwatch-2000-01-01.log"
    stale.write_text("old\n", encoding="utf-8")
    future = tmp_path / "panwatch-2099-01-01.log"
    future.write_text("keep\n", encoding="utf-8")

    handler = DailyFileLogHandler(tmp_path, retention_days=30)
    logger = logging.getLogger("panwatch.test.daily")
    logger.handlers.clear()
    logger.setLevel(logging.INFO)
    logger.propagate = False
    logger.addHandler(handler)
    logger.info("今天的日志")
    handler.close()

    today = datetime.now().strftime("%Y-%m-%d")
    current = tmp_path / f"panwatch-{today}.log"
    assert current.is_file()
    assert "今天的日志" in current.read_text(encoding="utf-8")
    assert not stale.exists()
    assert future.read_text(encoding="utf-8") == "keep\n"


def test_attach_daily_file_handler_uses_env_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("LOG_DIR", str(tmp_path))
    monkeypatch.setenv("LOG_RETENTION_DAYS", "14")
    logger = logging.getLogger("panwatch.test.daily.attach")
    logger.handlers.clear()
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = attach_daily_file_handler(logger, logging.INFO)
    logger.info("环境变量目录")
    handler.close()

    files = list(tmp_path.glob("panwatch-*.log"))
    assert len(files) == 1
    assert "环境变量目录" in files[0].read_text(encoding="utf-8")
    assert handler.retention_days == 14
