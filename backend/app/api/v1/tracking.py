"""Tracking read APIs — fleet snapshot and per-device history."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.models.device import Device
from app.models.ping import LocationPing
from app.schemas.device import PositionOut

router = APIRouter(prefix="/tracking", tags=["tracking"])


@router.get("/latest", response_model=list[PositionOut])
async def latest_positions(user: CurrentUser, db: DbSession) -> list[PositionOut]:
    """Newest fix per device for the whole fleet.

    DISTINCT ON is a Postgres-specific one-query solution; the portable
    alternative is a correlated subquery per device, which does not scale.
    """
    stmt = (
        select(LocationPing, Device.label)
        .join(Device, Device.id == LocationPing.device_id)
        .where(LocationPing.organization_id == user.organization_id)
        .order_by(LocationPing.device_id, LocationPing.recorded_at.desc())
        .distinct(LocationPing.device_id)
    )
    rows = (await db.execute(stmt)).all()

    now = datetime.now(timezone.utc)
    cutoff = timedelta(seconds=settings.DEVICE_OFFLINE_AFTER_SECONDS)

    return [
        PositionOut(
            device_id=ping.device_id,
            label=label,
            latitude=ping.latitude,
            longitude=ping.longitude,
            accuracy_m=ping.accuracy_m,
            speed_mps=ping.speed_mps,
            bearing_deg=ping.bearing_deg,
            activity=ping.activity.value,
            battery_level=ping.battery_level,
            is_charging=ping.is_charging,
            trust_score=ping.trust_score,
            integrity_flags=list(ping.integrity_flags or []),
            recorded_at=ping.recorded_at,
            is_online=(now - ping.recorded_at) < cutoff,
        )
        for ping, label in rows
    ]


@router.get("/devices/{device_id}/history", response_model=list[PositionOut])
async def device_history(
    device_id: uuid.UUID,
    user: CurrentUser,
    db: DbSession,
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=10_000),
) -> list[PositionOut]:
    """Ordered track for one device, for replay on the dashboard."""
    device = await db.get(Device, device_id)
    if device is None or device.organization_id != user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Device not found"
        )

    if end is None:
        # Ingest tolerates up to MAX_PING_FUTURE_SKEW_SECONDS of device clock
        # skew, so a plain `now` upper bound would accept a ping and then hide
        # it from the default history view. Extend the window to match.
        end = datetime.now(timezone.utc) + timedelta(
            seconds=settings.MAX_PING_FUTURE_SKEW_SECONDS
        )
    if start is None:
        start = end - timedelta(hours=24)
    if start >= end:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="start must be before end",
        )

    stmt = (
        select(LocationPing)
        .where(
            LocationPing.device_id == device_id,
            LocationPing.recorded_at >= start,
            LocationPing.recorded_at <= end,
        )
        .order_by(LocationPing.recorded_at)
        .limit(limit)
    )
    pings = (await db.execute(stmt)).scalars().all()

    return [
        PositionOut(
            device_id=p.device_id,
            label=device.label,
            latitude=p.latitude,
            longitude=p.longitude,
            accuracy_m=p.accuracy_m,
            speed_mps=p.speed_mps,
            bearing_deg=p.bearing_deg,
            activity=p.activity.value,
            battery_level=p.battery_level,
            is_charging=p.is_charging,
            trust_score=p.trust_score,
            integrity_flags=list(p.integrity_flags or []),
            recorded_at=p.recorded_at,
        )
        for p in pings
    ]
