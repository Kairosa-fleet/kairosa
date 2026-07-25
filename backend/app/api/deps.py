"""Shared FastAPI dependencies: authentication, authorization, rate limiting."""

from __future__ import annotations

import time
import uuid
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.redis_client import get_redis, rate_limit_key, revoked_key
from app.core.security import decode_token, hash_device_token
from app.models.device import Device, DeviceStatus
from app.models.driver import Driver
from app.models.user import User, UserRole

bearer_scheme = HTTPBearer(auto_error=False)

DbSession = Annotated[AsyncSession, Depends(get_db)]
BearerCreds = Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)]

_UNAUTHENTICATED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


# --- User authentication --------------------------------------------------


async def get_current_user(creds: BearerCreds, db: DbSession) -> User:
    if creds is None or not creds.credentials:
        raise _UNAUTHENTICATED
    try:
        payload = decode_token(creds.credentials, expected_type="access")
    except JWTError:
        raise _UNAUTHENTICATED from None

    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise _UNAUTHENTICATED from None

    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise _UNAUTHENTICATED
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def require_admin(user: CurrentUser) -> User:
    if user.role != UserRole.ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator role required",
        )
    return user


AdminUser = Annotated[User, Depends(require_admin)]


# --- Driver authentication ------------------------------------------------


async def get_current_driver(creds: BearerCreds, db: DbSession) -> Driver:
    """Authenticate a driver by their own JWT.

    Separate from ``get_current_user``: drivers live in their own table and
    must never satisfy a dependency that expects a dashboard user, or a driver
    token would reach admin endpoints.
    """
    if creds is None or not creds.credentials:
        raise _UNAUTHENTICATED
    try:
        payload = decode_token(creds.credentials, expected_type="access")
    except JWTError:
        raise _UNAUTHENTICATED from None

    if payload.get("role") != "driver":
        raise _UNAUTHENTICATED

    try:
        driver_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise _UNAUTHENTICATED from None

    driver = await db.get(Driver, driver_id)
    if driver is None or not driver.is_active:
        raise _UNAUTHENTICATED
    return driver


CurrentDriver = Annotated["Driver", Depends(get_current_driver)]


# --- Device authentication ------------------------------------------------


async def get_current_device(
    db: DbSession,
    x_device_token: Annotated[str | None, Header(alias="X-Device-Token")] = None,
    creds: BearerCreds = None,
) -> Device:
    """Authenticate a device by opaque token.

    Accepts either ``X-Device-Token`` or a bearer token, so the mobile client
    can use whichever is more convenient.
    """
    token = x_device_token or (creds.credentials if creds else None)
    if not token:
        raise _UNAUTHENTICATED

    token_hash = hash_device_token(token)

    # Redis revocation check first — an admin revoking a device must take
    # effect immediately, without waiting on a database round trip.
    redis = get_redis()
    try:
        if await redis.get(revoked_key(token_hash)):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Device access revoked",
            )
    except HTTPException:
        raise
    except Exception:
        # Redis being down must not fail closed on ingest; the database
        # status check below is authoritative anyway.
        pass

    result = await db.execute(select(Device).where(Device.token_hash == token_hash))
    device = result.scalar_one_or_none()
    if device is None:
        raise _UNAUTHENTICATED
    if device.status != DeviceStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Device is {device.status.value}",
        )
    if device.token_expires_at is not None:
        from datetime import datetime, timezone

        if device.token_expires_at < datetime.now(timezone.utc):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Device token expired",
            )
    return device


CurrentDevice = Annotated[Device, Depends(get_current_device)]


# --- Rate limiting --------------------------------------------------------


async def _check_rate_limit(identity: str, scope: str, limit: int, window: int) -> None:
    """Fixed-window counter in Redis. Fails open if Redis is unavailable."""
    redis = get_redis()
    bucket = int(time.time() // window)
    key = f"{rate_limit_key(scope, identity)}:{bucket}"
    try:
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, window * 2)
    except Exception:
        return  # availability over enforcement
    if count > limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded",
            headers={"Retry-After": str(window)},
        )


def client_ip(request: Request) -> str:
    """Best-effort client IP.

    NOTE: X-Forwarded-For is only trustworthy behind a proxy that overwrites
    it. Do not deploy this directly on a public interface.
    """
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def rate_limit_login(request: Request) -> None:
    await _check_rate_limit(
        client_ip(request), "login", settings.RATE_LIMIT_LOGIN_PER_MINUTE, 60
    )


async def rate_limit_provision(request: Request) -> None:
    await _check_rate_limit(
        client_ip(request), "provision", settings.RATE_LIMIT_PROVISION_PER_HOUR, 3600
    )


async def rate_limit_ingest(device: CurrentDevice) -> Device:
    await _check_rate_limit(
        str(device.id), "ingest", settings.RATE_LIMIT_INGEST_PER_MINUTE, 60
    )
    return device


RateLimitedDevice = Annotated[Device, Depends(rate_limit_ingest)]
