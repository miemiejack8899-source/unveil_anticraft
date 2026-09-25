# constants.py — 全站可调常量（字符串集中维护，改这里即可生效）

# 用户角色
ROLE_USER = "user"
ROLE_ADMIN = "admin"

# 初始化管理员用户名（数据库迁移时提升为管理员的目标账号，见 run_migrations）
BOOTSTRAP_ADMIN_USERNAME = "admin"

# 本地开发 CORS 默认来源（环境变量 CORS_ORIGINS 可覆盖）
DEFAULT_CORS_ORIGINS = (
    "http://localhost:3100,http://127.0.0.1:3100,"
    "http://localhost:3000,http://127.0.0.1:3000"
)
