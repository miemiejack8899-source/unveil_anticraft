# deps.py — 跨域共享依赖与助手（与 anticraft 保持一致的鉴权实现，去掉无关模块）

import ipaddress
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from auth import decode_access_token
from constants import ROLE_ADMIN
from database import get_db
from models import User


def _log(msg: str):
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/login")
# 可选鉴权 —— 未携带 token 时不报错，返回 None（用于公开接口附带当前用户信息）
oauth2_scheme_optional = OAuth2PasswordBearer(tokenUrl="/api/login", auto_error=False)


def _is_trusted_proxy(ip: str) -> bool:
    """直连方是否为本机/内网（可信反向代理），只有可信代理才采信其携带的 X-Forwarded-For"""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved


def _client_ip(request: Request) -> str:
    """获取客户端 IP：仅当直连方是可信代理（本机/内网）时采信 X-Forwarded-For 末段"""
    client = request.client.host if request.client else None
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded and client and _is_trusted_proxy(client):
        return forwarded.split(",")[-1].strip()
    return client or "unknown"


def _escape_like(s: str) -> str:
    """转义 LIKE 通配符，防止搜索词里的 % _ \\ 被当作模式匹配"""
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def generate_invite_code() -> str:
    """生成 12 位大写字母数字邀请码（token_urlsafe 去掉 - _ 后截取）"""
    import secrets
    return secrets.token_urlsafe(8).upper().replace("-", "").replace("_", "")[:12]


def _verify_token(token: str, db: Session) -> Optional[User]:
    """校验 JWT 并返回用户；令牌无效 / 用户不存在 / 已禁用 / 令牌版本号不匹配时返回 None"""
    payload = decode_access_token(token)
    if payload is None:
        return None
    # 身份检测签发的“学生本人”令牌不是账号令牌，绝不能被当成用户使用
    if payload.get("kind") == "student":
        return None
    try:
        user_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        return None
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return None
    if not user.is_active:
        return None
    if payload.get("ver") != user.token_version:
        return None
    return user


def get_current_user_obj(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    """获取当前用户对象（含令牌版本校验）"""
    user = _verify_token(token, db)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="无效的令牌")
    return user


def require_admin(current_user: User = Depends(get_current_user_obj)) -> User:
    """管理员权限依赖 —— 非管理员返回 403"""
    if current_user.role != ROLE_ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return current_user
