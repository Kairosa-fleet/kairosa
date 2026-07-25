"""Device and driver management, plus device provisioning."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select

from app.api.deps import (
    AdminUser,
    CurrentDevice,
    CurrentUser,
    DbSession,
    rate_limit_provision,
)
from app.core.config import settings
from app.core.redis_client import get_redis, revoked_key
from app.core.security import (
    generate_device_token,
    generate_enrollment_code,
    hash_device_token,
    hash_enrollment_code,
)
from app.models.consignment import Trip, TripStatus
from app.models.device import Device, DeviceStatus
from app.models.vehicle import Vehicle
from app.models.driver import Driver
from app.schemas.device import (
    DeviceCreateIn,
    DeviceOut,
    DeviceProvisionIn,
    DeviceProvisionOut,
    DeviceRegisteredOut,
    DriverCreateIn,
    DriverOut,
    DutyIn,
)

router = APIRouter(tags=["devices"])


# --- Drivers --------------------------------------------------------------


@router.post(
    "/drivers", response_model=DriverOut, status_code=status.HTTP_201_CREATED
)
async def create_driver(
    payload: DriverCreateIn, admin: AdminUser, db: DbSession
) -> Driver:
    driver = Driver(
        organization_id=admin.organization_id,
        full_name=payload.full_name,
        phone=payload.phone,
        employee_code=payload.employee_code,
    )
    db.add(driver)
    await db.commit()
    await db.refresh(driver)
    return driver


@router.get("/drivers", response_model=list[DriverOut])
async def list_drivers(user: CurrentUser, db: DbSession) -> list[Driver]:
    result = await db.execute(
        select(Driver)
        .where(Driver.organization_id == user.organization_id)
        .order_by(Driver.full_name)
    )
    return list(result.scalars().all())


# --- Devices --------------------------------------------------------------


@router.post(
    "/devices",
    response_model=DeviceRegisteredOut,
    status_code=status.HTTP_201_CREATED,
)
async def register_device(
    payload: DeviceCreateIn, admin: AdminUser, db: DbSession
) -> DeviceRegisteredOut:
    """Register a device and return a one-time enrollment code.

    The code is shown once and stored only as a hash.
    """
    # A phone with no vehicle is a phantom on the live map — no registration
    # to act on, no driver to call. Stage 2 of the flow cannot precede stage 1.
    vehicles = await db.execute(
        select(Vehicle).where(Vehicle.organization_id == admin.organization_id)
    )
    vehicle_list = list(vehicles.scalars().all())
    if not vehicle_list:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Add a vehicle first — a tracking phone must belong to one.",
        )

    if payload.vehicle_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="vehicleId is required: a tracking phone belongs to a vehicle.",
        )
    vehicle = next((v for v in vehicle_list if v.id == payload.vehicle_id), None)
    if vehicle is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vehicle not found")

    existing_device = await db.execute(
        select(Device).where(
            Device.vehicle_id == vehicle.id,
            Device.status != DeviceStatus.REVOKED,
        )
    )
    if existing_device.scalar_one_or_none() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{vehicle.registration_number} already has an active tracking "
                "phone. Revoke it before enrolling another."
            ),
        )

    if payload.driver_id is not None:
        driver = await db.get(Driver, payload.driver_id)
        if driver is None or driver.organization_id != admin.organization_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Driver not found"
            )

    code = generate_enrollment_code()
    expires = datetime.now(timezone.utc) + timedelta(
        hours=settings.ENROLLMENT_CODE_EXPIRE_HOURS
    )

    device = Device(
        organization_id=admin.organization_id,
        driver_id=payload.driver_id,
        vehicle_id=vehicle.id,
        # The label is the vehicle's identity, not free text — the map must
        # never show "some phone".
        label=vehicle.registration_number,
        status=DeviceStatus.PENDING,
        enrollment_code_hash=hash_enrollment_code(code),
        enrollment_expires_at=expires,
    )
    db.add(device)
    await db.commit()
    await db.refresh(device)

    return DeviceRegisteredOut(
        id=device.id,
        label=device.label,
        status=device.status,
        enrollment_code=code,
        enrollment_expires_at=expires,
    )


@router.post(
    "/devices/provision",
    response_model=DeviceProvisionOut,
    dependencies=[Depends(rate_limit_provision)],
)
async def provision_device(
    payload: DeviceProvisionIn, db: DbSession
) -> DeviceProvisionOut:
    """Exchange a one-time enrollment code for a long-lived device token.

    Unauthenticated by necessity — the device has no credential yet. The
    enrollment code is single-use, expiring, and rate limited per IP.
    """
    code_hash = hash_enrollment_code(payload.enrollment_code.strip())
    result = await db.execute(
        select(Device).where(Device.enrollment_code_hash == code_hash)
    )
    device = result.scalar_one_or_none()

    if device is None or device.status != DeviceStatus.PENDING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or already-used enrollment code",
        )
    if (
        device.enrollment_expires_at is not None
        and device.enrollment_expires_at < datetime.now(timezone.utc)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Enrollment code expired",
        )

    token = generate_device_token()
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=settings.DEVICE_TOKEN_EXPIRE_DAYS)

    device.token_hash = hash_device_token(token)
    device.token_issued_at = now
    device.token_expires_at = expires
    device.status = DeviceStatus.ACTIVE
    device.enrollment_code_hash = None  # single use
    device.enrollment_expires_at = None
    device.platform = payload.platform
    device.model = payload.model
    device.os_version = payload.os_version
    device.app_version = payload.app_version

    await db.commit()

    return DeviceProvisionOut(
        device_id=device.id,
        device_token=token,
        organization_id=device.organization_id,
        expires_at=expires,
    )


# --- Device self-service (must precede /devices/{device_id}) --------------
#
# Route order matters: FastAPI matches in declaration order, so if
# /devices/{device_id} were declared first it would swallow "me" as a path
# parameter and the request would be rejected before reaching these handlers.


@router.get("/devices/me", response_model=DeviceOut)
async def get_own_device(device: CurrentDevice) -> Device:
    return device


@router.post("/devices/me/duty", response_model=DeviceOut)
async def set_duty(payload: DutyIn, device: CurrentDevice, db: DbSession) -> Device:
    """On/off-duty toggle.

    Going on duty requires an assigned trip starting nearby in time. Tracking
    a driver with no job burns their battery, puts a meaningless dot on the
    dispatcher's map, and collects location data with no purpose — which is
    also the hardest kind to justify to the driver.

    Going OFF duty is always allowed: never trap someone in a tracked state.
    """
    if payload.on_duty:
        now = datetime.now(timezone.utc)
        window = timedelta(hours=12)
        result = await db.execute(
            select(Trip).where(
                Trip.device_id == device.id,
                Trip.status.in_(
                    [TripStatus.ASSIGNED, TripStatus.STARTED, TripStatus.IN_TRANSIT]
                ),
                Trip.scheduled_start >= now - window,
                Trip.scheduled_start <= now + window,
            )
        )
        trip = result.scalars().first()
        if trip is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "No trip is scheduled for this vehicle right now. "
                    "Dispatch must assign one before you can go on duty."
                ),
            )
        # Going on duty starts the trip — the two are the same event.
        if trip.status == TripStatus.ASSIGNED:
            trip.status = TripStatus.STARTED
            trip.actual_start = now

    device.is_on_duty = payload.on_duty
    await db.commit()
    await db.refresh(device)
    return device


# --- Admin/tracker device views -------------------------------------------


@router.get("/devices", response_model=list[DeviceOut])
async def list_devices(
    user: CurrentUser,
    db: DbSession,
    include_revoked: bool = Query(default=False, alias="includeRevoked"),
) -> list[Device]:
    """Devices in this organization. Revoked ones are excluded by default.

    A revoked handset is not part of the fleet — it is a record of one that
    used to be. Every driver who signs in on a new phone retires the old one,
    so including them made the live map accumulate a permanent dead row per
    phone swap, each counted as a vehicle needing attention. Device
    administration passes ``includeRevoked=true``, because that is the one
    screen where the history is the point.
    """
    stmt = select(Device).where(Device.organization_id == user.organization_id)
    if not include_revoked:
        stmt = stmt.where(Device.status != DeviceStatus.REVOKED)

    result = await db.execute(stmt.order_by(Device.label))
    devices = list(result.scalars().all())

    # The fleet panel is a list of vehicles, so it needs the registration —
    # a device labelled with the driver's name reads as a person, not a truck.
    vehicles = {
        v.id: v
        for v in (
            await db.execute(
                select(Vehicle).where(Vehicle.organization_id == user.organization_id)
            )
        ).scalars()
    }
    for device in devices:
        vehicle = vehicles.get(device.vehicle_id) if device.vehicle_id else None
        device.__dict__["vehicle_registration"] = (
            vehicle.registration_number if vehicle else None
        )
    return devices


async def _get_own_device(
    device_id: uuid.UUID, organization_id: uuid.UUID, db: DbSession
) -> Device:
    device = await db.get(Device, device_id)
    # Same 404 for "absent" and "another tenant's" — never leak existence.
    if device is None or device.organization_id != organization_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Device not found"
        )
    return device


@router.get("/devices/{device_id}", response_model=DeviceOut)
async def get_device(
    device_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> Device:
    return await _get_own_device(device_id, user.organization_id, db)


@router.post("/devices/{device_id}/revoke", response_model=DeviceOut)
async def revoke_device(
    device_id: uuid.UUID, admin: AdminUser, db: DbSession
) -> Device:
    """Revoke a device immediately.

    The token hash is cached in Redis so ingest is refused without waiting
    for a database lookup.
    """
    device = await _get_own_device(device_id, admin.organization_id, db)
    old_hash = device.token_hash

    device.status = DeviceStatus.REVOKED
    device.is_on_duty = False
    device.token_hash = None
    await db.commit()
    await db.refresh(device)

    if old_hash:
        try:
            redis = get_redis()
            await redis.setex(
                revoked_key(old_hash), settings.DEVICE_TOKEN_EXPIRE_DAYS * 86400, "1"
            )
        except Exception:
            pass  # DB status is authoritative; cache is an optimisation
    return device
