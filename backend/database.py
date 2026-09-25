# database.py — 数据库连接与会话管理

import os
from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import URL
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from constants import BOOTSTRAP_ADMIN_USERNAME, ROLE_ADMIN

# 优先使用项目根目录的 .env，回退到 backend/.env
_root_dotenv = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
_local_dotenv = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
_dotenv_path = _root_dotenv if os.path.exists(_root_dotenv) else _local_dotenv
load_dotenv(dotenv_path=_dotenv_path, override=True)

# ============================================
# 数据库配置（从 .env 读取）
# ============================================
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = os.getenv("DB_PORT", "3306")
DB_NAME = os.getenv("DB_NAME", "unveil_anticraft")

# ── 自动检测可用的 MySQL 驱动 ──
DRIVER = None
for candidate, module_name in [
    ("mysql+mysqlconnector", "mysql.connector"),
    ("mysql+pymysql", "pymysql"),
]:
    try:
        __import__(module_name)
        DRIVER = candidate
        break
    except ImportError:
        continue

if DRIVER is None:
    raise ImportError(
        "找不到可用的 MySQL 驱动。请安装 mysql-connector-python 或 pymysql：\n"
        "  pip install mysql-connector-python==8.4.0\n"
        "  或 pip install pymysql"
    )

DATABASE_URL = URL.create(
    drivername=DRIVER,
    username=DB_USER,
    password=DB_PASSWORD,
    host=DB_HOST,
    port=int(DB_PORT),
    database=DB_NAME,
    query={"charset": "utf8mb4"},
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """FastAPI 依赖注入 —— 每次请求获取一个数据库会话"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """创建所有表（首次运行调用）"""
    Base.metadata.create_all(bind=engine)


def run_migrations():
    """自动迁移：为已有表补充新增字段（init_db 只建表不迁移）"""
    import secrets as _secrets
    insp = inspect(engine)
    with engine.connect() as conn:
        # users 表新增 role / token_version 列
        if insp.has_table("users"):
            columns = {c["name"] for c in insp.get_columns("users")}
            if "role" not in columns:
                conn.execute(text(
                    "ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'user'"
                ))
                conn.commit()
            if "token_version" not in columns:
                conn.execute(text(
                    "ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0"
                ))
                conn.commit()
        # invite_codes 表新增 is_reusable / owner_user_id 列
        if insp.has_table("invite_codes"):
            columns = {c["name"] for c in insp.get_columns("invite_codes")}
            if "is_reusable" not in columns:
                conn.execute(text(
                    "ALTER TABLE invite_codes ADD COLUMN is_reusable TINYINT(1) NOT NULL DEFAULT 0"
                ))
                conn.commit()
            if "owner_user_id" not in columns:
                conn.execute(text(
                    "ALTER TABLE invite_codes ADD COLUMN owner_user_id INT NULL"
                ))
                conn.execute(text(
                    "ALTER TABLE invite_codes ADD CONSTRAINT fk_invite_owner "
                    "FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE"
                ))
                conn.commit()

    # 为所有没有专属邀请码的已存在用户分配一个邀请码
    from sqlalchemy.orm import Session
    from models import User, InviteCode
    with Session(engine) as db:
        existing_owner_ids = {
            row[0] for row in db.query(InviteCode.owner_user_id)
            .filter(InviteCode.owner_user_id.isnot(None))
            .all()
        }
        users_without_code = (
            db.query(User)
            .filter(~User.id.in_(existing_owner_ids) if existing_owner_ids else True)
            .all()
        )
        for u in users_without_code:
            code = _secrets.token_urlsafe(8).upper().replace("-", "").replace("_", "")[:12]
            db.add(InviteCode(
                code=code,
                created_by=u.id,
                owner_user_id=u.id,
                is_reusable=True,
            ))
        if users_without_code:
            db.commit()

        # 初始化管理员：仅当系统当前没有任何管理员、且用户数 > 1 时才提升
        admin_count = db.query(User).filter(User.role == ROLE_ADMIN).count()
        total = db.query(User).count()
        bootstrap = db.query(User).filter(User.username == BOOTSTRAP_ADMIN_USERNAME).first()
        if bootstrap and admin_count == 0 and total > 1 and bootstrap.role != ROLE_ADMIN:
            bootstrap.role = ROLE_ADMIN
            db.commit()
            print(f"[migrations] user '{BOOTSTRAP_ADMIN_USERNAME}' promoted to admin")
