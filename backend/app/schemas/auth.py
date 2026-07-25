"""Auth and user schemas."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models.user import UserRole


class OrganizationBootstrapIn(BaseModel):
    """Creates an organization and its first admin. Used once per tenant."""

    model_config = ConfigDict(extra="forbid")

    organization_name: str = Field(min_length=2, max_length=200)
    email: EmailStr
    password: str = Field(min_length=12, max_length=72)
    full_name: str = Field(min_length=2, max_length=200)

    @field_validator("password")
    @classmethod
    def _password_strength(cls, v: str) -> str:
        # bcrypt truncates past 72 bytes; reject rather than silently truncate.
        if len(v.encode()) > 72:
            raise ValueError("password must be at most 72 bytes")
        if not any(c.isalpha() for c in v) or not any(c.isdigit() for c in v):
            raise ValueError("password must contain both letters and digits")
        return v


class UserCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    password: str = Field(min_length=12, max_length=72)
    full_name: str = Field(min_length=2, max_length=200)
    role: UserRole = UserRole.TRACKER


class LoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    password: str = Field(min_length=1, max_length=72)


class RefreshIn(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    refresh_token: str = Field(alias="refreshToken")


class TokenOut(BaseModel):
    access_token: str = Field(serialization_alias="accessToken")
    refresh_token: str = Field(serialization_alias="refreshToken")
    token_type: str = Field(default="bearer", serialization_alias="tokenType")
    expires_in: int = Field(serialization_alias="expiresIn")


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str = Field(serialization_alias="fullName")
    role: UserRole
    organization_id: uuid.UUID = Field(serialization_alias="organizationId")
    is_active: bool = Field(serialization_alias="isActive")
    created_at: datetime = Field(serialization_alias="createdAt")
