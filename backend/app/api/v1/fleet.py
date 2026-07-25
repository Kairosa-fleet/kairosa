"""Vehicles, drivers and their compliance documents."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import Integer, cast, func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import AdminUser, CurrentUser, DbSession
from app.models.driver import Driver
from app.models.driver_documents import DriverDocument
from app.core.security import (
    generate_driver_login_id,
    generate_temp_password,
    hash_password,
)
from app.models.vehicle import Vehicle, VehicleDocument, VehicleImage
from app.schemas.tms import (
    AlertOut,
    DriverCreatedOut,
    DriverFullOut,
    DriverIn,
    VehicleIn,
    VehicleOut,
)
from app.services import compliance

router = APIRouter(tags=["fleet"])


async def _own_vehicle(db: DbSession, vehicle_id: uuid.UUID, org_id) -> Vehicle:
    vehicle = await db.get(Vehicle, vehicle_id)
    # Same 404 for absent and other-tenant — never confirm existence.
    if vehicle is None or vehicle.organization_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vehicle not found")
    return vehicle


async def _own_driver(db: DbSession, driver_id: uuid.UUID, org_id) -> Driver:
    driver = await db.get(Driver, driver_id)
    if driver is None or driver.organization_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Driver not found")
    return driver


async def _next_driver_login_id(db: DbSession) -> str:
    """Allocate a driver login ID that is free across the whole installation.

    Drivers sign in with this ID alone — there is no tenant selector on the
    phone — so the column is globally unique. Numbering it from a per-tenant
    count therefore collides: the second organization to add its first driver
    would be handed a "DRV-0001" that already exists. Counting globally, and
    stepping over anything already taken, keeps the ID both unique and short
    enough to read off a slip of paper.
    """
    # Regex rather than LIKE: a hand-edited "DRV-TEMP" would make the cast
    # blow up on every driver created thereafter.
    numeric = Driver.login_id.op("~")("^DRV-[0-9]+$")
    highest = await db.scalar(
        select(func.max(cast(func.substr(Driver.login_id, 5), Integer))).where(numeric)
    )
    sequence = (highest or 0) + 1
    while True:
        candidate = generate_driver_login_id(sequence)
        taken = await db.scalar(select(Driver.id).where(Driver.login_id == candidate))
        if taken is None:
            return candidate
        sequence += 1


# --- Vehicles --------------------------------------------------------------


@router.post("/vehicles", response_model=VehicleOut, status_code=status.HTTP_201_CREATED)
async def create_vehicle(payload: VehicleIn, admin: AdminUser, db: DbSession) -> Vehicle:
    existing = await db.execute(
        select(Vehicle).where(
            Vehicle.organization_id == admin.organization_id,
            Vehicle.registration_number == payload.registration_number,
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Vehicle {payload.registration_number} is already registered",
        )

    data = payload.model_dump(exclude={"documents", "images"})
    vehicle = Vehicle(organization_id=admin.organization_id, **data)
    db.add(vehicle)
    await db.flush()

    for doc in payload.documents:
        db.add(VehicleDocument(vehicle_id=vehicle.id, **doc.model_dump()))
    for index, image in enumerate(payload.images):
        db.add(
            VehicleImage(
                vehicle_id=vehicle.id, **(image.model_dump() | {"sort_order": index})
            )
        )

    await db.commit()
    await db.refresh(vehicle)
    return vehicle


@router.get("/vehicles", response_model=list[VehicleOut])
async def list_vehicles(user: CurrentUser, db: DbSession) -> list[Vehicle]:
    result = await db.execute(
        select(Vehicle)
        .where(Vehicle.organization_id == user.organization_id)
        .order_by(Vehicle.registration_number)
    )
    return list(result.scalars().all())


@router.get("/vehicles/{vehicle_id}", response_model=VehicleOut)
async def get_vehicle(vehicle_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Vehicle:
    return await _own_vehicle(db, vehicle_id, user.organization_id)


@router.patch("/vehicles/{vehicle_id}", response_model=VehicleOut)
async def update_vehicle(
    vehicle_id: uuid.UUID, payload: VehicleIn, admin: AdminUser, db: DbSession
) -> Vehicle:
    vehicle = await _own_vehicle(db, vehicle_id, admin.organization_id)

    # A renewed certificate keeps the same registration, so a changed
    # registration is a different truck. Refuse rather than quietly reassign
    # every trip and document that already points at this row.
    if payload.registration_number != vehicle.registration_number:
        clash = await db.execute(
            select(Vehicle).where(
                Vehicle.organization_id == admin.organization_id,
                Vehicle.registration_number == payload.registration_number,
                Vehicle.id != vehicle.id,
            )
        )
        if clash.scalar_one_or_none() is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Vehicle {payload.registration_number} is already registered",
            )

    for key, value in payload.model_dump(exclude={"documents", "images"}).items():
        setattr(vehicle, key, value)

    # Documents and photos are replaced wholesale rather than merged: the form
    # sends the complete current set, and a partial merge would silently keep
    # a document the operator deleted. Renewing an expiring certificate is
    # therefore just an edit with a new number, expiry and PDF.
    if payload.documents:
        for old in list(vehicle.documents):
            await db.delete(old)
        await db.flush()
        for doc in payload.documents:
            db.add(VehicleDocument(vehicle_id=vehicle.id, **doc.model_dump()))

    for old_image in list(vehicle.images):
        await db.delete(old_image)
    await db.flush()
    for index, image in enumerate(payload.images):
        db.add(
            VehicleImage(
                vehicle_id=vehicle.id, **(image.model_dump() | {"sort_order": index})
            )
        )

    await db.commit()
    await db.refresh(vehicle)
    return vehicle


# --- Drivers ---------------------------------------------------------------


@router.post("/drivers/full", response_model=DriverCreatedOut, status_code=status.HTTP_201_CREATED)
async def create_driver_full(
    payload: DriverIn, admin: AdminUser, db: DbSession
) -> DriverCreatedOut:
    """Create a driver, and issue their login credentials.

    The login ID and a temporary password are returned **once** and never
    again — the password is stored only as a bcrypt hash. The driver must
    change it at first sign-in.
    """
    data = payload.model_dump(exclude={"documents"})
    driver = Driver(organization_id=admin.organization_id, **data)

    # Credentials are issued here, not later: a driver who cannot sign in is
    # a driver who cannot be dispatched. Sequential ID because it gets read
    # off a slip of paper and typed on a phone keypad.
    driver.login_id = await _next_driver_login_id(db)
    temp_password = generate_temp_password()
    driver.hashed_password = hash_password(temp_password)
    driver.must_change_password = True

    db.add(driver)
    try:
        await db.flush()
    except IntegrityError as exc:
        # Two admins adding a driver at the same instant can pick the same
        # free number between the SELECT and the INSERT. The unique index is
        # the real guard; retry once against it rather than failing the admin.
        await db.rollback()
        if "login_id" not in str(exc.orig):
            raise
        driver = Driver(organization_id=admin.organization_id, **data)
        driver.login_id = await _next_driver_login_id(db)
        driver.hashed_password = hash_password(temp_password)
        driver.must_change_password = True
        db.add(driver)
        await db.flush()

    for doc in payload.documents:
        db.add(DriverDocument(driver_id=driver.id, **doc.model_dump()))

    await db.commit()
    await db.refresh(driver)

    # Attached to the response object so the dashboard can show it once. It is
    # never stored in the clear and cannot be retrieved again.
    driver.__dict__["_temp_password"] = temp_password
    return DriverCreatedOut.from_driver(driver)


@router.get("/drivers/full", response_model=list[DriverFullOut])
async def list_drivers_full(user: CurrentUser, db: DbSession) -> list[Driver]:
    result = await db.execute(
        select(Driver)
        .where(Driver.organization_id == user.organization_id)
        .order_by(Driver.full_name)
    )
    return list(result.scalars().all())


@router.get("/drivers/{driver_id}/full", response_model=DriverFullOut)
async def get_driver_full(
    driver_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> Driver:
    return await _own_driver(db, driver_id, user.organization_id)


@router.patch("/drivers/{driver_id}", response_model=DriverFullOut)
async def update_driver(
    driver_id: uuid.UUID, payload: DriverIn, admin: AdminUser, db: DbSession
) -> Driver:
    driver = await _own_driver(db, driver_id, admin.organization_id)
    for key, value in payload.model_dump(exclude={"documents"}).items():
        setattr(driver, key, value)

    if payload.documents:
        for old in list(driver.documents):
            await db.delete(old)
        await db.flush()
        for doc in payload.documents:
            db.add(DriverDocument(driver_id=driver.id, **doc.model_dump()))

    await db.commit()
    await db.refresh(driver)
    return driver


# --- Compliance ------------------------------------------------------------


@router.get("/compliance/alerts", response_model=list[AlertOut])
async def compliance_alerts(user: CurrentUser, db: DbSession) -> list[AlertOut]:
    """Everything expiring or missing across the whole fleet.

    This is the screen a transport manager should open every morning: an
    expired PUC or insurance means the vehicle is detained at a checkpoint and
    the penalty lands on the company, not the driver.
    """
    today = datetime.now(timezone.utc).date()
    alerts: list[compliance.Alert] = []

    vehicles = (
        await db.execute(
            select(Vehicle).where(
                Vehicle.organization_id == user.organization_id,
                Vehicle.is_active.is_(True),
            )
        )
    ).scalars().all()
    for vehicle in vehicles:
        alerts += compliance.vehicle_alerts(vehicle, today)

    drivers = (
        await db.execute(
            select(Driver).where(
                Driver.organization_id == user.organization_id,
                Driver.is_active.is_(True),
            )
        )
    ).scalars().all()
    for driver in drivers:
        alerts += compliance.driver_alerts(driver, today)

    # Worst first — the manager should not have to scroll to find what is
    # already expired.
    order = {
        compliance.Severity.EXPIRED: 0,
        compliance.Severity.MISSING: 1,
        compliance.Severity.CRITICAL: 2,
        compliance.Severity.WARNING: 3,
    }
    alerts.sort(key=lambda a: (order[a.severity], a.days_remaining or 0))

    return [
        AlertOut(
            severity=a.severity.value,
            subject_type=a.subject_type,
            subject_id=a.subject_id,
            subject_label=a.subject_label,
            document=a.document,
            message=a.message,
            expires_on=a.expires_on,
            days_remaining=a.days_remaining,
        )
        for a in alerts
    ]
