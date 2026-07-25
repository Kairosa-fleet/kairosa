"""Ingest pipeline: validate -> score -> persist -> broadcast.

Each ping in a batch succeeds or fails independently, so one bad fix never
costs the app a whole batch. The per-item result tells the device exactly
what it may purge from its outbox.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from geoalchemy2.functions import ST_MakePoint, ST_SetSRID
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.device import Device
from app.models.ping import LocationPing
from app.schemas.ingest import IngestBatchOut, LocationPingIn, PingResult
from app.services import integrity
from app.services.broadcast import manager

logger = logging.getLogger(__name__)


def _validate(ping: LocationPingIn) -> str | None:
    """Return a rejection reason, or None if the ping is acceptable."""
    now = datetime.now(timezone.utc)
    age = (now - ping.timestamp).total_seconds()

    if age > settings.MAX_PING_AGE_SECONDS:
        return "timestamp_too_old"
    if age < -settings.MAX_PING_FUTURE_SKEW_SECONDS:
        return "timestamp_in_future"
    if (
        ping.location.accuracy is not None
        and ping.location.accuracy > settings.MAX_ACCURACY_METERS
    ):
        return "accuracy_too_poor"
    # Null Island — almost always a sentinel value rather than a real fix.
    if ping.location.latitude == 0 and ping.location.longitude == 0:
        return "null_island"
    return None


async def _load_previous_fix(
    db: AsyncSession, device_id
) -> integrity.PreviousFix | None:
    result = await db.execute(
        select(
            LocationPing.latitude,
            LocationPing.longitude,
            LocationPing.recorded_at,
            LocationPing.battery_level,
            LocationPing.accuracy_m,
        )
        .where(LocationPing.device_id == device_id)
        .order_by(LocationPing.recorded_at.desc())
        .limit(1)
    )
    row = result.first()
    if row is None:
        return None
    return integrity.PreviousFix(
        latitude=row.latitude,
        longitude=row.longitude,
        recorded_at=row.recorded_at,
        battery_level=row.battery_level,
        accuracy_m=row.accuracy_m,
    )


async def ingest_batch(
    db: AsyncSession,
    device: Device,
    pings: list[LocationPingIn],
    source_ip: str | None = None,
) -> IngestBatchOut:
    results: list[PingResult] = []
    accepted = rejected = duplicates = 0

    previous = await _load_previous_fix(db, device.id)
    # Process oldest-first so the integrity baseline advances correctly.
    ordered = sorted(pings, key=lambda p: p.timestamp)
    latest_broadcast: dict | None = None

    for ping in ordered:
        reason = _validate(ping)
        if reason is not None:
            rejected += 1
            results.append(
                PingResult(client_seq=ping.client_seq, accepted=False, reason=reason)
            )
            continue

        verdict = integrity.evaluate(ping, previous, platform=device.platform)

        row = LocationPing(
            organization_id=device.organization_id,
            device_id=device.id,
            driver_id=device.driver_id,
            recorded_at=ping.timestamp,
            client_seq=ping.client_seq,
            geom=ST_SetSRID(
                ST_MakePoint(ping.location.longitude, ping.location.latitude), 4326
            ),
            latitude=ping.location.latitude,
            longitude=ping.location.longitude,
            accuracy_m=ping.location.accuracy,
            altitude_m=ping.location.altitude,
            altitude_accuracy_m=ping.location.altitude_accuracy,
            speed_mps=ping.movement.speed,
            bearing_deg=ping.movement.bearing,
            activity=ping.movement.activity,
            battery_level=ping.device_state.battery_level,
            is_charging=ping.device_state.is_charging,
            network_status=ping.device_state.network_status,
            is_mock_location=ping.device_state.is_mock_location,
            trust_score=verdict.score,
            integrity_flags=verdict.flags,
            source_ip=source_ip,
        )

        # Savepoint per row: a duplicate must not poison the whole batch.
        try:
            async with db.begin_nested():
                db.add(row)
                await db.flush()
        except IntegrityError:
            duplicates += 1
            results.append(
                PingResult(
                    client_seq=ping.client_seq,
                    accepted=True,  # already stored — safe for the app to purge
                    reason="duplicate",
                )
            )
            continue

        accepted += 1
        results.append(
            PingResult(
                client_seq=ping.client_seq,
                accepted=True,
                ping_id=row.id,
                trust_score=verdict.score,
                integrity_flags=verdict.flags,
            )
        )

        previous = integrity.PreviousFix(
            latitude=ping.location.latitude,
            longitude=ping.location.longitude,
            recorded_at=ping.timestamp,
            battery_level=ping.device_state.battery_level,
            accuracy_m=ping.location.accuracy,
        )
        device.trust_score = integrity.blend_device_trust(
            device.trust_score, verdict.score
        )
        device.last_seen_at = datetime.now(timezone.utc)

        latest_broadcast = {
            "type": "position",
            "deviceId": str(device.id),
            "label": device.label,
            "latitude": ping.location.latitude,
            "longitude": ping.location.longitude,
            "accuracy": ping.location.accuracy,
            "speed": ping.movement.speed,
            "bearing": ping.movement.bearing,
            "activity": ping.movement.activity.value,
            "batteryLevel": ping.device_state.battery_level,
            "isCharging": ping.device_state.is_charging,
            "trustScore": verdict.score,
            "integrityFlags": verdict.flags,
            "recordedAt": ping.timestamp.isoformat(),
        }

    await db.commit()

    # Broadcast only the newest position — viewers want the current dot, not
    # a replay of a backlog that just drained from an offline outbox.
    if latest_broadcast is not None:
        await manager.publish(str(device.organization_id), latest_broadcast)

    return IngestBatchOut(
        accepted=accepted,
        rejected=rejected,
        duplicates=duplicates,
        results=results,
    )
