"""内置管理员是否必须修改初始密码。

标记存在 app_settings，不新增表。已有标记不会被改写：
迁移和启动补标记都只在「还没有这个键」时写一次，避免把已经改过密码的部署重新锁住。
"""

from __future__ import annotations

import os

from sqlalchemy.orm import Session

from src.platform.security.password_hash import hash_password
from src.platform.persistence.models import AppSettings

MUST_CHANGE_KEY = "auth_must_change_password"
PASSWORD_CHANGE_REQUIRED_CODE = 4031
PASSWORD_CHANGE_REQUIRED_MESSAGE = "请先修改初始密码"


def is_password_change_required(db: Session) -> bool:
    setting = db.query(AppSettings).filter(AppSettings.key == MUST_CHANGE_KEY).first()
    return bool(setting and setting.value == "1")


def set_password_change_required(db: Session, required: bool) -> None:
    value = "1" if required else "0"
    setting = db.query(AppSettings).filter(AppSettings.key == MUST_CHANGE_KEY).first()
    if setting:
        setting.value = value
    else:
        db.add(
            AppSettings(
                key=MUST_CHANGE_KEY,
                value=value,
                description="内置管理员是否仍需修改初始密码（1=需要）",
            )
        )
    db.commit()


def initial_password_still_in_use(password_hash: str | None) -> bool:
    """库存哈希与当前环境变量里的初始密码一致时，视为还在用初始密码。"""
    env_password = os.getenv("AUTH_PASSWORD") or ""
    if not password_hash or not env_password:
        return False
    return hash_password(env_password) == password_hash


def ensure_password_change_flag(db: Session, password_hash: str | None) -> None:
    """标记缺失时补一次。已有标记、或还没有密码时不写。

    已有密码且仍等于 AUTH_PASSWORD：必须修改。
    其他已有密码（含没配 AUTH_PASSWORD）：视为已经改过，不强制。
    """
    existing = db.query(AppSettings).filter(AppSettings.key == MUST_CHANGE_KEY).first()
    if existing is not None or not password_hash:
        return
    set_password_change_required(db, initial_password_still_in_use(password_hash))
