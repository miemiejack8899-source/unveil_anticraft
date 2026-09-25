# main.py — FastAPI 应用入口（应用初始化 + 中间件 + 路由自动发现）

import os
import time as _time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from constants import DEFAULT_CORS_ORIGINS
from database import init_db, run_migrations
from deps import _log

# ============================================
# 应用初始化
# ============================================

app = FastAPI(title="unveil_anticraft API", version="1.0.0")

_cors_origins = [
    o.strip() for o in os.getenv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================
# 运行日志（启动 banner + 错误请求记录）
# ============================================

@app.middleware("http")
async def _log_requests(request: Request, call_next):
    start = _time.time()
    response = await call_next(request)
    dur = (_time.time() - start) * 1000
    path = request.url.path
    if path.startswith("/api/tools") or response.status_code >= 400:
        _log(f"req {request.method} {path} -> {response.status_code} ({dur:.0f}ms)")
    return response


@app.on_event("startup")
def on_startup():
    """首次启动自动建表 + 迁移新字段"""
    _log("=" * 50)
    _log("班级团组织信息管理系统 API 启动")
    _log(f"端口 {os.getenv('PORT', '8000')} · HOST={os.getenv('HOST', '127.0.0.1')}")
    _log("=" * 50)
    init_db()
    run_migrations()
    _log("启动完成：数据库就绪")


# ============================================
# API 路由
# ============================================

@app.get("/api/health", tags=["系统"])
def health_check():
    """健康检查"""
    return {"status": "ok", "message": "unveil_anticraft API is running"}


# ============================================
# 路由自动发现：backend/features/ 下暴露 router 变量的模块自动挂载
# ============================================

import importlib, pkgutil
import features as _features
for _m in sorted(pkgutil.iter_modules(_features.__path__), key=lambda m: m.name):
    _mod = importlib.import_module(f"features.{_m.name}")
    _router = getattr(_mod, "router", None)
    if _router is not None:
        app.include_router(_router)


# ============================================
# 启动入口
# ============================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=os.getenv("HOST", "127.0.0.1"),
                port=int(os.getenv("PORT", "8000")), reload=False)
