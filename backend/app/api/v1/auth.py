"""Authentication: bootstrap, login, refresh, current user."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from jose import JWTError
from sqlalchemy import func, select

from app.api.deps import AdminUser, CurrentUser, DbSession, rate_limit_login
from app.core.config import settings
from app.core.security import (
    create_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.models.organization import Organization
from app.models.user import User, UserRole
from app.schemas.auth import (
    LoginIn,
    OrganizationBootstrapIn,
    RefreshIn,
    TokenOut,
    UserCreateIn,
    UserOut,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _issue_tokens(user: User) -> TokenOut:
    common = {
        "subject": str(user.id),
        "organization_id": str(user.organization_id),
        "role": user.role.value,
    }
    return TokenOut(
        access_token=create_token(token_type="access", **common),
        refresh_token=create_token(token_type="refresh", **common),
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@router.post(
    "/bootstrap",
    response_model=TokenOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit_login)],
)
async def bootstrap(payload: OrganizationBootstrapIn, db: DbSession) -> TokenOut:
    """Create an organization and its first admin.

    Open by design so a new tenant can self-register. Rate limited per IP.
    In production, gate this behind an invite or disable it entirely.
    """
    existing = await db.execute(
        select(User).where(func.lower(User.email) == payload.email.lower())
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    org = Organization(name=payload.organization_name)
    db.add(org)
    await db.flush()

    user = User(
        organization_id=org.id,
        email=payload.email.lower(),
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
        role=UserRole.ADMIN,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return _issue_tokens(user)


@router.post("/login", response_model=TokenOut, dependencies=[Depends(rate_limit_login)])
async def login(payload: LoginIn, db: DbSession) -> TokenOut:
    result = await db.execute(
        select(User).where(func.lower(User.email) == payload.email.lower())
    )
    user = result.scalar_one_or_none()

    # Same error and comparable timing whether the user exists or not, so the
    # endpoint cannot be used to enumerate registered addresses.
    if user is None or not verify_password(payload.password, user.hashed_password):
        if user is None:
            hash_password(payload.password)  # equalise timing
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Account disabled"
        )

    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    return _issue_tokens(user)


@router.post("/refresh", response_model=TokenOut)
async def refresh(payload: RefreshIn, db: DbSession) -> TokenOut:
    try:
        claims = decode_token(payload.refresh_token, expected_type="refresh")
        user_id = uuid.UUID(claims["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid refresh token",
        ) from None

    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )
    return _issue_tokens(user)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: UserCreateIn, admin: AdminUser, db: DbSession
) -> User:
    """Add a user to the admin's own organization."""
    existing = await db.execute(
        select(User).where(func.lower(User.email) == payload.email.lower())
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Email already registered"
        )

    user = User(
        organization_id=admin.organization_id,  # never client-supplied
        email=payload.email.lower(),
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
        role=payload.role,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user
