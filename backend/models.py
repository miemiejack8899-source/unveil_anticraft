# models.py — 数据库模型（班级团组织信息管理系统：账号 + 邀请码）

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import relationship

from database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    username = Column(String(50), unique=True, nullable=False, index=True, comment="用户名")
    hashed_password = Column(String(255), nullable=False, comment="加密后的密码")
    nickname = Column(String(50), nullable=True, comment="昵称")
    avatar_url = Column(String(500), nullable=True, comment="头像 URL")
    is_active = Column(Boolean, default=True, comment="是否激活")
    # 角色：user 普通用户 / admin 管理员
    role = Column(String(20), nullable=False, default="user", server_default="user", comment="角色：user/admin")
    token_version = Column(Integer, nullable=False, default=0, server_default="0", comment="令牌版本号：改密/重置时+1，用于吊销旧 JWT")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="注册时间")
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="更新时间"
    )

    def __repr__(self):
        return f"<User(id={self.id}, username='{self.username}')>"


class InviteCode(Base):
    """邀请码 —— 用户专属可重复使用；注册时必须携带"""
    __tablename__ = "invite_codes"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    code = Column(String(64), unique=True, nullable=False, index=True, comment="邀请码")
    created_by = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, comment="生成者ID")
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, comment="专属用户ID")
    used_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, comment="使用者ID")
    is_used = Column(Boolean, default=False, nullable=False, comment="是否已使用")
    is_reusable = Column(Boolean, default=False, nullable=False, server_default="0", comment="是否可重复使用")
    created_at = Column(DateTime(timezone=True), server_default=func.now(), comment="生成时间")
    used_at = Column(DateTime(timezone=True), nullable=True, comment="使用时间")

    creator = relationship("User", foreign_keys=[created_by])
    owner = relationship("User", foreign_keys=[owner_user_id])

    def __repr__(self):
        return f"<InviteCode(id={self.id}, code='{self.code}', used={self.is_used}, reusable={self.is_reusable})>"
