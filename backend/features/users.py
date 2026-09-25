# features/users.py — 当前用户信息

from fastapi import APIRouter, Depends

from deps import get_current_user_obj
from models import User
from schemas import UserResponse

router = APIRouter(tags=["用户"])


@router.get("/api/user/me", response_model=UserResponse, tags=["用户"])
def get_current_user(current_user: User = Depends(get_current_user_obj)):
    """获取当前登录用户信息（需 Bearer Token）"""
    return UserResponse.model_validate(current_user)
