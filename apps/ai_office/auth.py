"""Login: members sign up, an admin approves them, and they log in with a code sent by SMS.

Members, codes and sessions live in Supabase (``multiAi_*`` tables) behind the
``multiai-auth`` Edge Function; this module only calls it with the public key and
keeps the session token in an httpOnly cookie.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

COOKIE = "office_session"
SESSION_DAYS = 30
CACHE_SECONDS = 60  # how long a checked session is trusted before asking Supabase again
# Reachable without logging in: the login page and the auth API.
PUBLIC_PATHS = {"/login.html", "/login.js", "/style.css", "/favicon.ico"}

_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _config() -> tuple[str, str]:
    url = os.getenv("SUPABASE_URL") or os.getenv("VITE_SUPABASE_URL")
    key = (
        os.getenv("SUPABASE_ANON_KEY")
        or os.getenv("VITE_SUPABASE_ANON_KEY")
        or os.getenv("VITE_SUPABASE_PUBLISHABLE_KEY")
    )
    if not url or not key:
        raise HTTPException(500, "Supabase 설정(.env의 SUPABASE_URL/ANON_KEY)이 없습니다.")
    return url.rstrip("/"), key


async def call(action: str, **body: Any) -> dict[str, Any]:
    """Run one ``multiai-auth`` action; raise its error message as an HTTPException."""
    url, key = _config()
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.post(
            f"{url}/functions/v1/multiai-auth",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            json={"action": action, **body},
        )
    data = res.json() if res.headers.get("content-type", "").startswith("application/json") else {}
    if res.status_code >= 400:
        raise HTTPException(res.status_code, data.get("error") or f"인증 서버 오류 ({res.status_code})")
    return data


async def session_user(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    hit = _cache.get(token)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        user = (await call("session", token=token))["user"]
    except HTTPException:
        _cache.pop(token, None)
        return None
    _cache[token] = (time.monotonic(), user)
    return user


async def require_login(request: Request, call_next: Any) -> Response:
    """Middleware: everything but the login page and auth API needs a session."""
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith("/api/auth/"):
        return await call_next(request)
    user = await session_user(request.cookies.get(COOKIE))
    if not user:
        if path.startswith("/api/"):
            return JSONResponse({"detail": "로그인이 필요합니다."}, status_code=401)
        return RedirectResponse("/login.html")
    request.state.user = user
    return await call_next(request)


def _admin_token(request: Request) -> str:
    if not request.state.user.get("is_admin"):
        raise HTTPException(403, "관리자만 할 수 있습니다.")
    return request.cookies[COOKIE]


router = APIRouter()


class Signup(BaseModel):
    phone: str
    name: str
    note: str = ""


class Phone(BaseModel):
    phone: str


class Verify(BaseModel):
    phone: str
    code: str


class UserPatch(BaseModel):
    status: str | None = None
    is_admin: bool | None = None


@router.post("/api/auth/signup")
async def signup(req: Signup) -> dict[str, Any]:
    return await call("signup", phone=req.phone, name=req.name, note=req.note)


@router.post("/api/auth/code")
async def request_code(req: Phone) -> dict[str, Any]:
    return await call("request_code", phone=req.phone)


@router.post("/api/auth/verify")
async def verify(req: Verify, response: Response) -> dict[str, Any]:
    data = await call("verify_code", phone=req.phone, code=req.code)
    response.set_cookie(
        COOKIE, data["token"], max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax"
    )
    return {"user": data["user"]}


@router.post("/api/auth/logout")
async def logout(request: Request, response: Response) -> dict[str, Any]:
    token = request.cookies.get(COOKIE)
    if token:
        _cache.pop(token, None)
        await call("logout", token=token)
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/api/me")
async def me(request: Request) -> dict[str, Any]:
    return request.state.user


@router.get("/api/admin/users")
async def users(request: Request) -> list[dict[str, Any]]:
    return (await call("users", token=_admin_token(request)))["users"]


@router.patch("/api/admin/users/{user_id}")
async def set_user(user_id: str, req: UserPatch, request: Request) -> dict[str, Any]:
    patch = req.model_dump(exclude_none=True)
    data = await call("set_user", token=_admin_token(request), id=user_id, **patch)
    _cache.clear()  # a rejected member must lose access now, not in a minute
    return data["user"]
