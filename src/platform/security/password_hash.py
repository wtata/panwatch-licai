"""管理员密码哈希。只依赖标准库，登录和迁移共用这一份实现。"""

import hashlib


def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()
