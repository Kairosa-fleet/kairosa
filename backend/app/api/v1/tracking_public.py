"""Public, no-login tracking for customers.

Everything here is reachable by anyone holding the token, so the rule is:
**expose only what that party legitimately needs to see.**

Deliberately NOT exposed, even though the data exists:
  * the driver's licence, phone, or personal details
  * the vehicle's chassis/engine numbers or document scans
  * freight amounts, the other party's contact details
  * the device's integrity score and raw ping history

A consignee needs to know where their goods are and when they will arrive.
They do not need the driver's licence number.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, _check_rate_limit, client_ip
from app.core.config import settings
from app.models.consignment import (
    Consignment,
    TrackingLink,
    TrackingParty,
    Trip,
    TripStatus,
)
from app.models.driver import Driver
from app.models.organization import Organization
from app.models.ping import LocationPing
from app.models.vehicle import Vehicle

router = APIRouter(prefix="/track", tags=["public-tracking"])


def _mask_phone(phone: str | None) -> str | None:
    """Show enough to recognise the driver, not enough to harvest."""
    if not phone:
        return None
    digits = "".join(c for c in phone if c.isdigit())
    return f"••••••{digits[-4:]}" if len(digits) >= 4 else None


@router.get("/{token}")
async def public_tracking(token: str, request: Request, db: DbSession) -> dict:
    """The customer-facing shipment view."""
    # Rate limited by IP: the token is the only credential, so a leaked link
    # should not also be a free scraping endpoint.
    await _check_rate_limit(client_ip(request), "track", 60, 60)

    result = await db.execute(
        select(TrackingLink)
        .options(
            selectinload(TrackingLink.trip)
            .selectinload(Trip.consignment)
            .selectinload(Consignment.consignor_address),
            selectinload(TrackingLink.trip)
            .selectinload(Trip.consignment)
            .selectinload(Consignment.consignee_address),
            selectinload(TrackingLink.trip)
            .selectinload(Trip.consignment)
            .selectinload(Consignment.consignor),
            selectinload(TrackingLink.trip)
            .selectinload(Trip.consignment)
            .selectinload(Consignment.consignee),
        )
        .where(TrackingLink.token == token)
    )
    link = result.scalar_one_or_none()

    # One generic 404 for missing, revoked and expired alike — distinguishing
    # them would let someone probe which tokens ever existed.
    if link is None or link.revoked:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This tracking link is not valid")
    if link.expires_at and link.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This tracking link has expired")

    trip = link.trip
    consignment = trip.consignment
    pickup = consignment.consignor_address
    drop = consignment.consignee_address

    org = await db.get(Organization, trip.organization_id)
    vehicle = await db.get(Vehicle, trip.vehicle_id) if trip.vehicle_id else None
    driver = await db.get(Driver, trip.driver_id) if trip.driver_id else None

    # Latest position, only if a device is actually attached to this trip.
    #
    # Bounded to the trip's own window on purpose. The same phone goes out on
    # the next customer's run tomorrow, and this link stays valid for weeks —
    # without the bound, yesterday's consignor would keep watching the truck
    # drive somebody else's route.
    position = None
    trip_over = trip.status in (TripStatus.DELIVERED, TripStatus.CANCELLED)
    if trip.device_id and not trip_over:
        row = (
            await db.execute(
                select(LocationPing)
                .where(
                    LocationPing.device_id == trip.device_id,
                    # A grace margin before the scheduled time: drivers
                    # routinely leave early, and the customer should see that
                    # rather than an empty map.
                    LocationPing.recorded_at
                    >= (trip.actual_start or trip.scheduled_start - timedelta(hours=2)),
                )
                .order_by(LocationPing.recorded_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if row:
            age = (datetime.now(timezone.utc) - row.recorded_at).total_seconds()
            position = {
                "latitude": row.latitude,
                "longitude": row.longitude,
                "speedKmh": round((row.speed_mps or 0) * 3.6),
                "bearing": row.bearing_deg,
                "recordedAt": row.recorded_at.isoformat(),
                "isLive": age < settings.DEVICE_OFFLINE_AFTER_SECONDS,
            }

    link.view_count += 1
    link.last_viewed_at = datetime.now(timezone.utc)
    await db.commit()

    is_consignor = link.party == TrackingParty.CONSIGNOR

    return {
        "transporter": org.name if org else None,
        "party": link.party.value,
        "lrNumber": consignment.lr_number,
        "status": trip.status.value,
        "goods": consignment.goods_description,
        "packages": consignment.package_count,
        "weightKg": consignment.weight_kg,
        "scheduledStart": trip.scheduled_start.isoformat(),
        "scheduledEnd": trip.scheduled_end.isoformat() if trip.scheduled_end else None,
        "actualStart": trip.actual_start.isoformat() if trip.actual_start else None,
        "deliveredAt": trip.actual_end.isoformat() if trip.actual_end else None,
        "origin": {
            "label": pickup.city or pickup.line1,
            "address": pickup.line1,
            "latitude": pickup.latitude,
            "longitude": pickup.longitude,
        },
        "destination": {
            "label": drop.city or drop.line1,
            "address": drop.line1,
            "latitude": drop.latitude,
            "longitude": drop.longitude,
        },
        # The counterparty's *name* is legitimate on a consignment note; their
        # phone and email are not.
        "counterparty": (
            consignment.consignee.name if is_consignor else consignment.consignor.name
        ),
        "vehicle": {"registrationNumber": vehicle.registration_number} if vehicle else None,
        # Name and a masked phone only — enough to identify the driver at the
        # gate, not enough to harvest.
        "driver": (
            {"name": driver.full_name, "phone": _mask_phone(driver.phone)}
            if driver
            else None
        ),
        "route": {
            "geometry": trip.route_geometry,
            "distanceKm": round(trip.route_distance_m / 1000, 1)
            if trip.route_distance_m
            else None,
            "durationH": round(trip.route_duration_s / 3600, 1)
            if trip.route_duration_s
            else None,
        },
        "position": position,
    }
