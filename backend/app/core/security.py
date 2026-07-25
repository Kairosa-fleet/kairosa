"""Password hashing, JWT issuance/verification, and device-token handling.

Two distinct credential types:
  * Users (web)   -> bcrypt password  -> short-lived access JWT + refresh JWT
  * Devices (app) -> opaque random token, stored only as a SHA-256 hash

Device tokens are opaque rather than JWTs so they can be revoked instantly;
a JWT would remain valid until expiry no matter what the database says.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

# bcrypt has a hard 72-byte input limit; longer passwords are rejected in schemas.
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)

TokenType = Literal["access", "refresh"]


# --- Passwords ------------------------------------------------------------


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return pwd_context.verify(plain, hashed)
    except ValueError:
        # Malformed hash in the DB — treat as a failed login, never a 500.
        return False


# --- JWT ------------------------------------------------------------------


def create_token(
    subject: str,
    token_type: TokenType,
    organization_id: str,
    role: str,
    expires_delta: timedelta | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    if expires_delta is None:
        expires_delta = (
            timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
            if token_type == "access"
            else timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
        )
    payload: dict[str, Any] = {
        "sub": subject,
        "typ": token_type,
        "org": organization_id,
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + expires_delta).timestamp()),
        "jti": secrets.token_urlsafe(16),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str, expected_type: TokenType | None = None) -> dict[str, Any]:
    """Decode and validate a JWT. Raises JWTError on any problem."""
    payload = jwt.decode(
        token,
        settings.JWT_SECRET,
        algorithms=[settings.JWT_ALGORITHM],
    )
    if expected_type is not None and payload.get("typ") != expected_type:
        # Stops a refresh token being replayed as an access token.
        raise JWTError(f"expected {expected_type} token, got {payload.get('typ')}")
    return payload


# --- Device tokens --------------------------------------------------------


def generate_device_token() -> str:
    """Opaque, high-entropy bearer token handed to a provisioned device."""
    return f"dev_{secrets.token_urlsafe(40)}"


def hash_device_token(token: str) -> str:
    """SHA-256 of the token. We never store the token itself.

    SHA-256 rather than bcrypt because this is verified on every ingest
    request and the input is already 40 bytes of CSPRNG entropy — there is
    no dictionary attack to slow down.
    """
    return hashlib.sha256(token.encode()).hexdigest()


def verify_device_token(token: str, token_hash: str) -> bool:
    return hmac.compare_digest(hash_device_token(token), token_hash)


# --- Enrollment codes -----------------------------------------------------


def generate_enrollment_code() -> str:
    """Short, human-transcribable one-time code for device provisioning."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no I/O/0/1 lookalikes
    return "-".join(
        "".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3)
    )


def hash_enrollment_code(code: str) -> str:
    return hashlib.sha256(code.upper().encode()).hexdigest()


# --- Driver credentials ---------------------------------------------------


def generate_driver_login_id(sequence: int) -> str:
    """Stable, readable driver ID, e.g. ``DRV-0007``.

    Sequential rather than random because a driver has to read it off a slip
    of paper and type it on a phone keypad, sometimes in poor light.
    """
    return f"DRV-{sequence:04d}"


def generate_temp_password() -> str:
    """First-login password: readable aloud, typed once, then replaced.

    Avoids characters that are ambiguous when handwritten or spoken over a
    phone (0/O, 1/l/I), because that is exactly how this gets communicated.
    """
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ"
    digits = "23456789"
    return (
        "".join(secrets.choice(alphabet) for _ in range(4))
        + "-"
        + "".join(secrets.choice(digits) for _ in range(4))
    )


def generate_reset_token() -> str:
    return secrets.token_urlsafe(32)


def hash_reset_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
