"""Driver authentication.

Why drivers log in rather than the phone being enrolled:

The earlier design bound identity to the *handset* via a one-time enrolment
code. That breaks in all the ordinary ways — a driver changes phone, borrows a
colleague's, factory-resets, or the device record is removed and the phone is
stranded with no self-service recovery. Every one of those needed a dispatcher
to mint a new code.

Binding identity to the *driver* fixes it: they sign in anywhere, and the
vehicle comes from whichever trip is assigned to them, not from which phone
they happen to be holding.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.api.deps import AdminUser, CurrentDriver, DbSession, rate_limit_login
from app.core.config import settings
from app.core.security import (
    create_token,
    generate_device_token,
    generate_reset_token,
    generate_temp_password,
    hash_device_token,
    hash_password,
    hash_reset_token,
    verify_password,
)
from app.models.consignment import Trip, TripStatus
from app.models.device import Device, DeviceStatus
from app.models.driver import Driver

router = APIRouter(prefix="/auth/driver", tags=["driver-auth"])

Camel = ConfigDict(extra="forbid", populate_by_name=True)


class DriverLoginIn(BaseModel):
    model_config = Camel
    login_id: str = Field(alias="loginId", min_length=3, max_length=20)
    password: str = Field(min_length=1, max_length=72)


class DriverTokenOut(BaseModel):
    access_token: str = Field(serialization_alias="accessToken")
    refresh_token: str = Field(serialization_alias="refreshToken")
    token_type: str = Field(default="bearer", serialization_alias="tokenType")
    expires_in: int = Field(serialization_alias="expiresIn")
    must_change_password: bool = Field(serialization_alias="mustChangePassword")
    driver_id: str = Field(serialization_alias="driverId")
    full_name: str = Field(serialization_alias="fullName")


class ForgotPasswordIn(BaseModel):
    model_config = Camel
    login_id: str = Field(alias="loginId", min_length=3, max_length=20)


def _issue(driver: Driver) -> DriverTokenOut:
    common = {
        "subject": str(driver.id),
        "organization_id": str(driver.organization_id),
        "role": "driver",
    }
    return DriverTokenOut(
        access_token=create_token(token_type="access", **common),
        refresh_token=create_token(token_type="refresh", **common),
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        must_change_password=driver.must_change_password,
        driver_id=str(driver.id),
        full_name=driver.full_name,
    )


@router.post("/login", response_model=DriverTokenOut, dependencies=[Depends(rate_limit_login)])
async def driver_login(payload: DriverLoginIn, db: DbSession) -> DriverTokenOut:
    result = await db.execute(
        select(Driver).where(func.upper(Driver.login_id) == payload.login_id.upper())
    )
    driver = result.scalar_one_or_none()

    # One message for unknown-ID and wrong-password alike, and a dummy hash on
    # the miss so timing does not reveal which driver IDs exist.
    if driver is None or not driver.hashed_password or not verify_password(
        payload.password, driver.hashed_password
    ):
        if driver is None:
            hash_password(payload.password)
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Incorrect driver ID or password"
        )
    if not driver.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account is disabled")

    driver.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    return _issue(driver)


class SetPasswordIn(BaseModel):
    model_config = Camel
    login_id: str = Field(alias="loginId", min_length=3, max_length=20)
    current_password: str = Field(alias="currentPassword", min_length=1, max_length=72)
    new_password: str = Field(alias="newPassword", min_length=8, max_length=72)


@router.post("/set-password", response_model=DriverTokenOut)
async def set_password(payload: SetPasswordIn, db: DbSession) -> DriverTokenOut:
    result = await db.execute(
        select(Driver).where(func.upper(Driver.login_id) == payload.login_id.upper())
    )
    driver = result.scalar_one_or_none()
    if driver is None or not driver.hashed_password or not verify_password(
        payload.current_password, driver.hashed_password
    ):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Incorrect driver ID or password"
        )

    driver.hashed_password = hash_password(payload.new_password)
    driver.must_change_password = False
    driver.password_reset_token_hash = None
    driver.password_reset_expires_at = None
    await db.commit()
    return _issue(driver)


@router.post("/forgot-password")
async def forgot_password(payload: ForgotPasswordIn, db: DbSession) -> dict:
    """Start a reset.

    With no SMS or email provider enabled, the reset code cannot be delivered
    to the driver directly — so the request is *recorded* and a dispatcher
    completes it from the dashboard. That is honest: a driver stranded at a
    loading dock needs a phone call to the office, not a silent failure.
    """
    result = await db.execute(
        select(Driver).where(func.upper(Driver.login_id) == payload.login_id.upper())
    )
    driver = result.scalar_one_or_none()

    if driver is not None and driver.is_active:
        token = generate_reset_token()
        driver.password_reset_token_hash = hash_reset_token(token)
        driver.password_reset_expires_at = datetime.now(timezone.utc) + timedelta(hours=24)
        await db.commit()

    # Same response either way — never reveal which driver IDs exist.
    return {
        "status": "requested",
        "message": (
            "Ask your transport office to reset the password. They can see "
            "the request on the dashboard."
        ),
    }


class ClaimDeviceIn(BaseModel):
    model_config = Camel
    platform: str | None = Field(default=None, max_length=20)
    model: str | None = Field(default=None, max_length=100)
    os_version: str | None = Field(default=None, alias="osVersion", max_length=50)
    app_version: str | None = Field(default=None, alias="appVersion", max_length=20)


class ClaimDeviceOut(BaseModel):
    device_id: str = Field(serialization_alias="deviceId")
    device_token: str = Field(serialization_alias="deviceToken")
    label: str
    expires_at: datetime | None = Field(serialization_alias="expiresAt")


@router.post("/claim-device", response_model=ClaimDeviceOut)
async def claim_device(
    payload: ClaimDeviceIn, driver: CurrentDriver, db: DbSession
) -> ClaimDeviceOut:
    """Bind the handset the driver just signed in on, and issue its token.

    This is what makes the login flow whole. Tracking still authenticates with
    an opaque device token — an admin revoking a phone has to take effect
    immediately, and a JWT would stay valid until it expired — but the driver
    should never have to type a one-time code to get one. Signing in *is* the
    proof of identity; the phone is just the handset they happen to be holding.

    Signing in on a new phone retires the old one. A driver who changed
    handsets must not leave a second device able to report their position, and
    two phones reporting for one driver is a contradiction the map cannot show.
    """
    existing = await db.execute(
        select(Device).where(
            Device.driver_id == driver.id,
            Device.status != DeviceStatus.REVOKED,
        )
    )
    for old in existing.scalars():
        old.status = DeviceStatus.REVOKED
        old.token_hash = None
        old.is_on_duty = False

    # The vehicle comes from whatever is assigned to them, not from which
    # phone they picked up — it is re-read per trip, so a null here is fine.
    latest = await db.execute(
        select(Trip)
        .where(
            Trip.driver_id == driver.id,
            Trip.status.notin_([TripStatus.DELIVERED, TripStatus.CANCELLED]),
        )
        .order_by(Trip.scheduled_start)
        .limit(1)
    )
    trip = latest.scalar_one_or_none()

    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=settings.DEVICE_TOKEN_EXPIRE_DAYS)
    token = generate_device_token()

    device = Device(
        organization_id=driver.organization_id,
        driver_id=driver.id,
        vehicle_id=trip.vehicle_id if trip else None,
        label=f"{driver.full_name} — {payload.model or payload.platform or 'phone'}",
        platform=payload.platform,
        model=payload.model,
        os_version=payload.os_version,
        app_version=payload.app_version,
        status=DeviceStatus.ACTIVE,
        token_hash=hash_device_token(token),
        token_issued_at=now,
        token_expires_at=expires,
    )
    db.add(device)
    await db.flush()

    # Point the driver's open trips at the handset they are actually carrying,
    # so a phone swap does not silently strand every already-booked run.
    open_trips = await db.execute(
        select(Trip).where(
            Trip.driver_id == driver.id,
            Trip.status.notin_([TripStatus.DELIVERED, TripStatus.CANCELLED]),
        )
    )
    for t in open_trips.scalars():
        t.device_id = device.id

    await db.commit()

    return ClaimDeviceOut(
        device_id=str(device.id),
        device_token=token,
        label=device.label,
        expires_at=expires,
    )


@router.post("/{driver_id}/reset-password")
async def admin_reset_password(
    driver_id: str, admin: AdminUser, db: DbSession
) -> dict:
    """Dispatcher-issued reset: returns a new temporary password, shown once."""
    driver = await db.get(Driver, driver_id)
    if driver is None or driver.organization_id != admin.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Driver not found")

    temp = generate_temp_password()
    driver.hashed_password = hash_password(temp)
    driver.must_change_password = True
    driver.password_reset_token_hash = None
    driver.password_reset_expires_at = None
    await db.commit()

    return {
        "loginId": driver.login_id,
        "temporaryPassword": temp,
        "note": "Shown once. The driver must change it at next sign-in.",
    }
