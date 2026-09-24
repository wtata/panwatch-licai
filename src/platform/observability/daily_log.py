"""按天写入 logs/panwatch-YYYY-MM-DD.log。

保留天数默认 30，可用 LOG_RETENTION_DAYS 调整。目录默认 logs/，可用 LOG_DIR 调整。
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timedelta
from pathlib import Path


def resolve_log_dir() -> Path:
    raw = (os.environ.get("LOG_DIR") or "logs").strip() or "logs"
    return Path(raw)


def resolve_retention_days() -> int:
    raw = (os.environ.get("LOG_RETENTION_DAYS") or "30").strip()
    try:
        days = int(raw)
    except ValueError:
        days = 30
    return max(days, 1)


class DailyFileLogHandler(logging.Handler):
    """当天日志直接写到带日期的文件名，跨天自动换文件，并删掉过期文件。"""

    def __init__(
        self,
        log_dir: str | Path,
        retention_days: int = 30,
        level: int = logging.INFO,
        prefix: str = "panwatch",
    ):
        super().__init__(level=level)
        self.log_dir = Path(log_dir)
        self.retention_days = max(int(retention_days), 1)
        self.prefix = prefix
        self._current_date: str | None = None
        self._stream = None
        self._panwatch_file = True

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = self.format(record)
            self._write(message)
        except Exception:
            self.handleError(record)

    def _write(self, message: str) -> None:
        today = datetime.now().strftime("%Y-%m-%d")
        if self._stream is None or self._current_date != today:
            self._open(today)
        assert self._stream is not None
        self._stream.write(message + "\n")
        self._stream.flush()

    def _open(self, today: str) -> None:
        if self._stream is not None:
            self._stream.close()
            self._stream = None
        self.log_dir.mkdir(parents=True, exist_ok=True)
        path = self.log_dir / f"{self.prefix}-{today}.log"
        self._stream = open(path, "a", encoding="utf-8")
        self._current_date = today
        self._cleanup(datetime.now().date())

    def _cleanup(self, today) -> None:
        cutoff = today - timedelta(days=self.retention_days)
        pattern = re.compile(rf"{re.escape(self.prefix)}-(\d{{4}}-\d{{2}}-\d{{2}})\.log$")
        for path in self.log_dir.glob(f"{self.prefix}-*.log"):
            match = pattern.match(path.name)
            if not match:
                continue
            try:
                file_day = datetime.strptime(match.group(1), "%Y-%m-%d").date()
            except ValueError:
                continue
            if file_day < cutoff:
                try:
                    path.unlink()
                except OSError:
                    pass

    def close(self) -> None:
        if self._stream is not None:
            try:
                self._stream.close()
            except OSError:
                pass
            self._stream = None
        super().close()


def attach_daily_file_handler(root: logging.Logger, level: int) -> DailyFileLogHandler:
    """挂到 root logger。重复调用时先卸掉上一只按天文件 handler。"""
    for handler in list(root.handlers):
        if isinstance(handler, DailyFileLogHandler) or getattr(handler, "_panwatch_file", False):
            root.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass
    handler = DailyFileLogHandler(
        log_dir=resolve_log_dir(),
        retention_days=resolve_retention_days(),
        level=level,
    )
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)-5s [%(name)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    root.addHandler(handler)
    return handler
