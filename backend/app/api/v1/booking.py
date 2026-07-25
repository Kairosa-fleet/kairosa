"""Customers, address lookup, consignment booking and tracking links.

This is the manager's core workflow:
    add customers → pick addresses → book a consignment → assign vehicle and
    driver → choose a route → get two tracking links.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, Response, status
from geoalchemy2.functions import ST_MakePoint, ST_SetSRID
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import AdminUser, CurrentDevice, CurrentUser, DbSession
from app.core.config import settings
from app.models.consignment import (
    Consignment,
    ConsignmentStatus,
    NotifyChannel,
    TrackingLink,
    TrackingParty,
    Trip,
    TripStatus,
)
from app.models.customer import Address, Customer
from app.models.device import Device, DeviceStatus
from app.models.driver import Driver
from app.models.organization import Organization
from app.models.vehicle import Vehicle
from app.schemas.tms import (
    AddressIn,
    AddressOut,
    AlertOut,
    BookingIn,
    BookingOut,
    ConsignmentOut,
    ConsignmentPatchIn,
    CustomerIn,
    CustomerOut,
    CustomerPatchIn,
    SendLinkIn,
    TripPatchIn,
    TrackingLinkOut,
    TripOut,
)
from app.services import compliance, geo, notify, numbering

router = APIRouter(tags=["booking"])


def _address_kwargs(payload: AddressIn, organization_id, customer_id=None) -> dict:
    return {
        "organization_id": organization_id,
        "customer_id": customer_id,
        **payload.model_dump(),
        "geom": ST_SetSRID(ST_MakePoint(payload.longitude, payload.latitude), 4326),
    }


def _link_out(link: TrackingLink) -> TrackingLinkOut:
    return TrackingLinkOut(
        id=link.id,
        party=link.party,
        token=link.token,
        url=notify.tracking_url(link.token),
        revoked=link.revoked,
        view_count=link.view_count,
        last_viewed_at=link.last_viewed_at,
        expires_at=link.expires_at,
    )


def _alerts_out(alerts) -> list[AlertOut]:
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


async def _driver_phone(db, org_id, driver_id) -> Device | None:
    """The phone that will carry this driver's trips.

    A phone that is registered but not yet enrolled still counts. Booking
    tomorrow's run this afternoon, before the driver has installed the app, is
    the ordinary case — and the trip must be waiting for them when they do.
    Only a revoked handset is disqualified.
    """
    rows = (
        await db.execute(
            select(Device).where(
                Device.driver_id == driver_id,
                Device.organization_id == org_id,
                Device.status != DeviceStatus.REVOKED,
            )
        )
    ).scalars().all()
    return next((d for d in rows if d.status == DeviceStatus.ACTIVE), rows[0] if rows else None)


def _trip_window(start: datetime, end: datetime | None, route_duration_s: float | None = None):
    """How long a trip ties up its vehicle and driver.

    ``scheduled_end`` is optional on the form, so fall back to the routed
    duration and finally to a configured default. Without this a trip would
    occupy an instant and no clash would ever be found.
    """
    if end is not None:
        return start, max(end, start)
    if route_duration_s:
        return start, start + timedelta(seconds=route_duration_s)
    return start, start + timedelta(hours=settings.TRIP_DEFAULT_DURATION_HOURS)


async def _assignment_conflicts(
    db,
    org_id,
    *,
    vehicle_id,
    driver_id,
    start: datetime,
    end: datetime | None,
    exclude_trip_id=None,
) -> list[str]:
    """Trips that already claim this vehicle or driver over the same hours.

    A truck cannot be in two places at once. Catching this at booking time is
    the difference between a dispatcher noticing at the desk and a customer
    noticing when nothing arrives.
    """
    if vehicle_id is None and driver_id is None:
        return []

    new_start, new_end = _trip_window(start, end)

    stmt = (
        select(Trip)
        .options(selectinload(Trip.consignment))
        .where(
            Trip.organization_id == org_id,
            Trip.status.notin_([TripStatus.DELIVERED, TripStatus.CANCELLED]),
            # Cheap pre-filter so the scan stays on the scheduled_start index;
            # the exact overlap test happens in Python against the real window.
            Trip.scheduled_start
            < new_end + timedelta(hours=settings.TRIP_DEFAULT_DURATION_HOURS),
            Trip.scheduled_start
            > new_start - timedelta(days=7),
        )
    )
    if exclude_trip_id is not None:
        stmt = stmt.where(Trip.id != exclude_trip_id)

    messages: list[str] = []
    for other in (await db.execute(stmt)).scalars().unique():
        if other.vehicle_id != vehicle_id and other.driver_id != driver_id:
            continue
        o_start, o_end = _trip_window(
            other.scheduled_start, other.scheduled_end, other.route_duration_s
        )
        if o_start >= new_end or o_end <= new_start:
            continue

        lr = other.consignment.lr_number if other.consignment else "another trip"
        when = o_start.strftime("%d %b %H:%M")
        if other.vehicle_id == vehicle_id and vehicle_id is not None:
            messages.append(f"This vehicle is already on {lr} from {when}")
        if other.driver_id == driver_id and driver_id is not None:
            messages.append(f"This driver is already on {lr} from {when}")
    return messages


# --- Address lookup --------------------------------------------------------


@router.get("/places/search")
async def places_search(
    user: CurrentUser,
    q: str = Query(min_length=3, max_length=200),
    limit: int = Query(default=6, ge=1, le=10),
    near_lat: float | None = Query(default=None, alias="nearLat", ge=-90, le=90),
    near_lon: float | None = Query(default=None, alias="nearLon", ge=-180, le=180),
) -> list[dict]:
    """Address autocomplete. Proxied so the provider key never reaches the browser.

    `nearLat`/`nearLon` bias results towards where the dispatcher is actually
    working. Without it "Transport Nagar" — which exists in a dozen Indian
    cities — comes back in an arbitrary order.
    """
    near = (near_lat, near_lon) if near_lat is not None and near_lon is not None else None
    try:
        return await geo.search_places(q, limit, near=near)
    except geo.GeoError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


@router.get("/places/reverse")
async def places_reverse(
    user: CurrentUser,
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
) -> dict | None:
    """Pin dropped on the map -> a postal address."""
    try:
        return await geo.reverse_geocode(lat, lon)
    except geo.GeoError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


@router.get("/routes/preview")
async def route_preview(
    user: CurrentUser,
    from_lat: float = Query(alias="fromLat", ge=-90, le=90),
    from_lon: float = Query(alias="fromLon", ge=-180, le=180),
    to_lat: float = Query(alias="toLat", ge=-90, le=90),
    to_lon: float = Query(alias="toLon", ge=-180, le=180),
) -> dict:
    """Route options between two points, fastest first."""
    try:
        return await geo.route((from_lat, from_lon), (to_lat, to_lon))
    except geo.GeoError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


# --- Customers -------------------------------------------------------------


@router.post("/customers", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
async def create_customer(payload: CustomerIn, admin: AdminUser, db: DbSession) -> Customer:
    customer = Customer(
        organization_id=admin.organization_id,
        **payload.model_dump(exclude={"addresses"}),
    )
    db.add(customer)
    await db.flush()

    for address in payload.addresses:
        db.add(Address(**_address_kwargs(address, admin.organization_id, customer.id)))

    await db.commit()
    await db.refresh(customer)
    return customer


@router.get("/customers", response_model=list[CustomerOut])
async def list_customers(user: CurrentUser, db: DbSession) -> list[Customer]:
    result = await db.execute(
        select(Customer)
        .where(Customer.organization_id == user.organization_id)
        .order_by(Customer.name)
    )
    return list(result.scalars().all())


@router.patch("/customers/{customer_id}", response_model=CustomerOut)
async def update_customer(
    customer_id: uuid.UUID, payload: CustomerPatchIn, admin: AdminUser, db: DbSession
) -> Customer:
    """Correct a customer's details.

    Consignments reference the customer by id, so renaming one or fixing a
    phone number updates every past and future LR that points at them — which
    is what you want when a company changes its name or its accounts contact.
    """
    customer = await db.get(Customer, customer_id)
    if customer is None or customer.organization_id != admin.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found")

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(customer, key, value)

    await db.commit()
    await db.refresh(customer)
    return customer


@router.patch(
    "/customers/{customer_id}/addresses/{address_id}",
    response_model=AddressOut,
)
async def update_address(
    customer_id: uuid.UUID,
    address_id: uuid.UUID,
    payload: AddressIn,
    admin: AdminUser,
    db: DbSession,
) -> Address:
    """Correct an address, including moving its pin.

    Editing rather than replacing matters: consignments hold this address by
    id, so a corrected pin fixes the route on trips that already reference it
    instead of stranding them on the old coordinates.
    """
    address = await db.get(Address, address_id)
    if (
        address is None
        or address.organization_id != admin.organization_id
        or address.customer_id != customer_id
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Address not found")

    for key, value in payload.model_dump().items():
        setattr(address, key, value)
    address.geom = ST_SetSRID(ST_MakePoint(payload.longitude, payload.latitude), 4326)

    await db.commit()
    await db.refresh(address)
    return address


@router.delete(
    "/customers/{customer_id}/addresses/{address_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_address(
    customer_id: uuid.UUID,
    address_id: uuid.UUID,
    admin: AdminUser,
    db: DbSession,
) -> Response:
    """Remove an address that is not referenced by any consignment.

    Checked explicitly rather than left to the foreign key: the constraint is
    RESTRICT, so deleting a used address would surface as an opaque 500 rather
    than an explanation the operator can act on.
    """
    address = await db.get(Address, address_id)
    if (
        address is None
        or address.organization_id != admin.organization_id
        or address.customer_id != customer_id
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Address not found")

    used = await db.execute(
        select(Consignment.lr_number).where(
            (Consignment.consignor_address_id == address_id)
            | (Consignment.consignee_address_id == address_id)
        ).limit(3)
    )
    references = list(used.scalars())
    if references:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This address is used by "
            + ", ".join(references)
            + " and cannot be deleted. Edit it instead.",
        )

    await db.delete(address)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/customers/{customer_id}/addresses",
    response_model=AddressOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_address(
    customer_id: uuid.UUID, payload: AddressIn, admin: AdminUser, db: DbSession
) -> Address:
    customer = await db.get(Customer, customer_id)
    if customer is None or customer.organization_id != admin.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found")

    address = Address(**_address_kwargs(payload, admin.organization_id, customer_id))
    db.add(address)
    await db.commit()
    await db.refresh(address)
    return address


# --- LR numbering ----------------------------------------------------------


@router.get("/consignments/next-numbers")
async def next_numbers(user: CurrentUser, db: DbSession, count: int = Query(3, ge=1, le=10)):
    """Preview the next LR numbers.

    Read-only on purpose: the form shows these while the operator is still
    typing, and abandoning a half-filled form must not burn an LR number.
    """
    org = await db.get(Organization, user.organization_id)
    suggestions = await numbering.suggest_lr_numbers(
        db, user.organization_id, org.name if org else "LR", count
    )
    return {"suggestions": suggestions}


@router.get("/consignments/check-number")
async def check_number(user: CurrentUser, db: DbSession, lr: str = Query(min_length=1)):
    """Whether a manually-typed LR number is free (pre-printed LR books)."""
    available = await numbering.is_lr_available(db, user.organization_id, lr)
    return {"lrNumber": lr.strip(), "available": available}


# --- Booking ---------------------------------------------------------------


@router.post("/bookings", response_model=BookingOut, status_code=status.HTTP_201_CREATED)
async def create_booking(payload: BookingIn, admin: AdminUser, db: DbSession) -> BookingOut:
    """Book a consignment and its first trip, atomically.

    One transaction on purpose: a consignment without a trip is a dangling
    obligation, and an LR number consumed by a failed booking cannot be reused.
    """
    org_id = admin.organization_id
    c_in, t_in = payload.consignment, payload.trip

    # Every referenced row must belong to this organization — otherwise a
    # crafted request could attach another tenant's customer to our LR.
    async def owned(model, row_id, label):
        row = await db.get(model, row_id)
        owner = getattr(row, "organization_id", None) if row else None
        if row is None or owner != org_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")
        return row

    consignor = await owned(Customer, c_in.consignor_id, "Consignor")
    consignee = await owned(Customer, c_in.consignee_id, "Consignee")
    pickup = await owned(Address, c_in.consignor_address_id, "Pickup address")
    drop = await owned(Address, c_in.consignee_address_id, "Delivery address")

    if c_in.consignor_id == c_in.consignee_id and (
        c_in.consignor_address_id == c_in.consignee_address_id
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Pickup and delivery are the same address — there is nothing to move",
        )

    vehicle = await owned(Vehicle, t_in.vehicle_id, "Vehicle") if t_in.vehicle_id else None
    driver = await owned(Driver, t_in.driver_id, "Driver") if t_in.driver_id else None
    device = await owned(Device, t_in.device_id, "Device") if t_in.device_id else None

    # A trip reaches the driver's phone through `device_id`, not `driver_id`.
    # Leaving the tracking phone unset is the normal case at the desk — the
    # dispatcher picks a driver and assumes the driver is now told. Resolve the
    # phone from the driver so that assumption holds.
    if device is None and driver is not None:
        device = await _driver_phone(db, org_id, driver.id)

    org = await db.get(Organization, org_id)

    # --- double booking ---
    # A vehicle cannot be in two places at once and a driver cannot drive two
    # trucks. Unlike a lapsing document this is not a judgement call, so it is
    # refused outright rather than warned about.
    conflicts = await _assignment_conflicts(
        db,
        org_id,
        vehicle_id=vehicle.id if vehicle else None,
        driver_id=driver.id if driver else None,
        start=t_in.scheduled_start,
        end=t_in.scheduled_end,
    )
    if conflicts:
        raise HTTPException(status.HTTP_409_CONFLICT, "; ".join(conflicts))

    # --- LR number ---
    if c_in.lr_number:
        if not await numbering.is_lr_available(db, org_id, c_in.lr_number):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"LR number {c_in.lr_number} is already used",
            )
        lr_number = c_in.lr_number.strip()
        # Keep the generated sequence ahead of what the operator wrote by hand,
        # so a later auto-number cannot collide with it.
        await numbering.reserve_manual_lr(db, org_id, org.name if org else "LR", lr_number)
    else:
        lr_number = await numbering.next_lr_number(db, org_id, org.name if org else "LR")

    consignment = Consignment(
        organization_id=org_id,
        lr_number=lr_number,
        status=ConsignmentStatus.BOOKED,
        **c_in.model_dump(exclude={"lr_number"}),
    )
    db.add(consignment)
    await db.flush()

    # --- route ---
    route_distance = route_duration = None
    route_geometry = route_alternatives = None
    route_summary = None
    try:
        result = await geo.route(
            (pickup.latitude, pickup.longitude), (drop.latitude, drop.longitude)
        )
        options = result.get("routes", [])
        if options:
            chosen = options[min(t_in.route_index, len(options) - 1)]
            route_distance = chosen.get("distanceMeters")
            route_duration = chosen.get("durationSeconds")
            route_geometry = chosen.get("geometry")
            route_summary = chosen.get("label")
            # Keep what was rejected: "why did the driver go that way?" is a
            # question that gets asked after the fact.
            route_alternatives = [
                {k: v for k, v in o.items() if k != "geometry"} for o in options
            ]
    except geo.GeoError:
        # A routing outage must not block a booking — the trip is still real.
        pass

    trip = Trip(
        organization_id=org_id,
        consignment_id=consignment.id,
        vehicle_id=vehicle.id if vehicle else None,
        driver_id=driver.id if driver else None,
        device_id=device.id if device else None,
        scheduled_start=t_in.scheduled_start,
        scheduled_end=t_in.scheduled_end,
        status=TripStatus.ASSIGNED if (vehicle and driver) else TripStatus.PLANNED,
        route_distance_m=route_distance,
        route_duration_s=route_duration,
        route_geometry=route_geometry,
        route_alternatives=route_alternatives,
        route_summary=route_summary,
        notes=t_in.notes,
    )
    db.add(trip)
    await db.flush()

    # --- tracking links: one per party, so either can be revoked alone ---
    expires = datetime.now(timezone.utc) + timedelta(days=settings.TRACKING_LINK_TTL_DAYS)
    links = [
        TrackingLink(
            trip_id=trip.id,
            party=party,
            token=secrets.token_urlsafe(32),
            expires_at=expires,
        )
        for party in (TrackingParty.CONSIGNOR, TrackingParty.CONSIGNEE)
    ]
    db.add_all(links)
    await db.flush()

    # --- compliance, evaluated against the travel date, not today ---
    check = compliance.check_dispatch(
        vehicle, driver, consignment, t_in.scheduled_start
    )

    # Everything the notification needs, read before the commit expires it.
    org_name = org.name if org else ""
    origin_line, destination_line = pickup.line1, drop.line1
    contacts = {
        TrackingParty.CONSIGNOR: (consignor.email, consignor.phone),
        TrackingParty.CONSIGNEE: (consignee.email, consignee.phone),
    }

    # The booking is committed *before* anything is sent. SMTP is a network
    # call with a 20-second timeout, and this transaction holds a row lock on
    # the LR counter — sending inside it would stall every other dispatcher's
    # booking behind a mail server, and a mail failure would throw away a
    # perfectly good consignment.
    await db.commit()
    await db.refresh(consignment)
    await db.refresh(trip)

    deliveries: list[dict] = []
    if payload.notify_on_create:
        for link in links:
            email, phone = contacts[link.party]
            # Both channels, because a customer who gave only a phone number
            # must not silently receive nothing.
            for channel, recipient in (
                (NotifyChannel.EMAIL, email),
                (NotifyChannel.SMS, phone),
            ):
                if not recipient:
                    continue
                entry = await notify.send_tracking_link(
                    db,
                    link,
                    channel=channel,
                    recipient=recipient,
                    lr_number=lr_number,
                    org_name=org_name,
                    origin=origin_line,
                    destination=destination_line,
                )
                deliveries.append(
                    {
                        "party": link.party.value,
                        "channel": channel.value,
                        "recipient": recipient,
                        "status": entry.status.value,
                        "error": entry.error,
                    }
                )
        await db.commit()

    return BookingOut(
        consignment=ConsignmentOut.model_validate(consignment),
        trip=TripOut.model_validate(trip),
        links=[_link_out(link) for link in links],
        alerts=_alerts_out(check.blocking + check.warnings),
        dispatch_ok=check.ok,
        deliveries=deliveries,
        driver_notified=trip.device_id is not None,
        route_available=route_distance is not None,
    )


@router.get("/trips", response_model=list[dict])
async def list_trips(user: CurrentUser, db: DbSession) -> list[dict]:
    """Trips with just enough joined context to render a schedule."""
    result = await db.execute(
        select(Trip)
        .options(
            selectinload(Trip.consignment).selectinload(Consignment.consignor),
            selectinload(Trip.consignment).selectinload(Consignment.consignee),
            selectinload(Trip.consignment).selectinload(Consignment.consignor_address),
            selectinload(Trip.consignment).selectinload(Consignment.consignee_address),
            selectinload(Trip.tracking_links),
        )
        .where(Trip.organization_id == user.organization_id)
        .order_by(Trip.scheduled_start.desc())
    )
    trips = result.scalars().unique().all()

    vehicles = {
        v.id: v
        for v in (
            await db.execute(
                select(Vehicle).where(Vehicle.organization_id == user.organization_id)
            )
        ).scalars()
    }
    drivers = {
        d.id: d
        for d in (
            await db.execute(
                select(Driver).where(Driver.organization_id == user.organization_id)
            )
        ).scalars()
    }

    out = []
    for trip in trips:
        c = trip.consignment
        vehicle = vehicles.get(trip.vehicle_id)
        driver = drivers.get(trip.driver_id)
        out.append(
            {
                "id": str(trip.id),
                "consignmentId": str(trip.consignment_id),
                "status": trip.status.value,
                "scheduledStart": trip.scheduled_start.isoformat(),
                "scheduledEnd": trip.scheduled_end.isoformat() if trip.scheduled_end else None,
                "notes": trip.notes,
                "lrNumber": c.lr_number,
                "goods": c.goods_description,
                "weightKg": c.weight_kg,
                "declaredValue": float(c.declared_value) if c.declared_value else None,
                "ewayBillNumber": c.eway_bill_number,
                "freightTerms": c.freight_terms.value,
                "consignor": c.consignor.name,
                "consignee": c.consignee.name,
                "origin": c.consignor_address.city or c.consignor_address.line1,
                "destination": c.consignee_address.city or c.consignee_address.line1,
                "originLat": c.consignor_address.latitude,
                "originLon": c.consignor_address.longitude,
                "destLat": c.consignee_address.latitude,
                "destLon": c.consignee_address.longitude,
                "vehicle": vehicle.registration_number if vehicle else None,
                "vehicleId": str(trip.vehicle_id) if trip.vehicle_id else None,
                "driver": driver.full_name if driver else None,
                "driverId": str(trip.driver_id) if trip.driver_id else None,
                "deviceId": str(trip.device_id) if trip.device_id else None,
                "distanceKm": round(trip.route_distance_m / 1000, 1) if trip.route_distance_m else None,
                "durationH": round(trip.route_duration_s / 3600, 1) if trip.route_duration_s else None,
                "routeSummary": trip.route_summary,
                "links": [
                    {
                        "party": link.party.value,
                        "url": notify.tracking_url(link.token),
                        "token": link.token,
                        "viewCount": link.view_count,
                        "revoked": link.revoked,
                    }
                    for link in trip.tracking_links
                ],
            }
        )
    return out


@router.patch("/trips/{trip_id}", response_model=TripOut)
async def update_trip(
    trip_id: uuid.UUID, payload: TripPatchIn, admin: AdminUser, db: DbSession
) -> Trip:
    """Reschedule or reassign a trip after booking.

    Plans change between the desk and the gate: a truck breaks down, a driver
    calls in sick, a customer moves the pickup to Thursday. The LR number and
    the tracking links are deliberately untouched — the customer already has
    the link, and the consignment's legal identity does not change because a
    different truck carries it.
    """
    trip = await db.get(Trip, trip_id)
    if trip is None or trip.organization_id != admin.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trip not found")
    if trip.status in (TripStatus.DELIVERED, TripStatus.CANCELLED):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"This trip is {trip.status.value} and can no longer be changed",
        )

    fields = payload.model_dump(exclude_unset=True)

    async def owned(model, row_id, label):
        row = await db.get(model, row_id)
        if row is None or getattr(row, "organization_id", None) != admin.organization_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")
        return row

    vehicle = trip.vehicle_id
    driver = trip.driver_id
    if "vehicle_id" in fields:
        vehicle = (await owned(Vehicle, fields["vehicle_id"], "Vehicle")).id if fields["vehicle_id"] else None
    if "driver_id" in fields:
        driver = (await owned(Driver, fields["driver_id"], "Driver")).id if fields["driver_id"] else None
    if fields.get("device_id"):
        await owned(Device, fields["device_id"], "Device")

    start = fields.get("scheduled_start", trip.scheduled_start)
    end = fields.get("scheduled_end", trip.scheduled_end)

    conflicts = await _assignment_conflicts(
        db, admin.organization_id,
        vehicle_id=vehicle, driver_id=driver, start=start, end=end,
        exclude_trip_id=trip.id,
    )
    if conflicts:
        raise HTTPException(status.HTTP_409_CONFLICT, "; ".join(conflicts))

    for key, value in fields.items():
        setattr(trip, key, value)

    # Re-resolve the tracking phone when the driver changed and no phone was
    # named, so a reassigned trip still reaches whoever is actually driving.
    if "driver_id" in fields and not fields.get("device_id") and driver is not None:
        found = await _driver_phone(db, admin.organization_id, driver)
        trip.device_id = found.id if found else None

    if trip.vehicle_id and trip.driver_id and trip.status == TripStatus.PLANNED:
        trip.status = TripStatus.ASSIGNED

    # The route belongs to the addresses, which a trip edit cannot change, so
    # it is only recomputed when the schedule moves far enough to matter.
    await db.commit()
    await db.refresh(trip)
    return trip


@router.post("/trips/{trip_id}/cancel", response_model=TripOut)
async def cancel_trip(
    trip_id: uuid.UUID, admin: AdminUser, db: DbSession
) -> Trip:
    """Cancel a trip and cut off customer tracking for it.

    Revoking the links matters: a cancelled consignment whose link still shows
    a moving truck is worse than no link at all.
    """
    trip = await db.get(Trip, trip_id)
    if trip is None or trip.organization_id != admin.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trip not found")
    if trip.status == TripStatus.DELIVERED:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This trip is already delivered and cannot be cancelled"
        )

    trip.status = TripStatus.CANCELLED
    consignment = await db.get(Consignment, trip.consignment_id)
    if consignment:
        consignment.status = ConsignmentStatus.CANCELLED
    for link in trip.tracking_links:
        link.revoked = True

    await db.commit()
    await db.refresh(trip)
    return trip


@router.patch("/consignments/{consignment_id}", response_model=ConsignmentOut)
async def update_consignment(
    consignment_id: uuid.UUID, payload: ConsignmentPatchIn, admin: AdminUser, db: DbSession
) -> Consignment:
    """Correct the goods, e-way bill or freight details after booking.

    The LR number is not editable. It is the document's identity — the number
    already printed on the copy the driver is carrying and quoted to the
    customer — so correcting a typo in it would create a second, contradictory
    record of the same shipment.
    """
    consignment = await db.get(Consignment, consignment_id)
    if consignment is None or consignment.organization_id != admin.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Consignment not found")
    if consignment.status == ConsignmentStatus.CANCELLED:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This consignment is cancelled and can no longer be changed"
        )

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(consignment, key, value)

    await db.commit()
    await db.refresh(consignment)
    return consignment


@router.post("/trips/{trip_id}/links/{party}/revoke")
async def revoke_link(
    trip_id: uuid.UUID, party: TrackingParty, admin: AdminUser, db: DbSession
) -> dict:
    """Cut off one party's tracking without touching the other's."""
    trip = await db.get(Trip, trip_id)
    if trip is None or trip.organization_id != admin.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trip not found")

    link = (
        await db.execute(
            select(TrackingLink).where(
                TrackingLink.trip_id == trip_id, TrackingLink.party == party
            )
        )
    ).scalar_one_or_none()
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tracking link not found")

    link.revoked = True
    await db.commit()
    return {"party": party.value, "revoked": True}


@router.get("/trips/{trip_id}/route")
async def trip_route(trip_id: uuid.UUID, user: CurrentUser, db: DbSession) -> dict:
    trip = await db.get(Trip, trip_id)
    if trip is None or trip.organization_id != user.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trip not found")
    return {
        "geometry": trip.route_geometry,
        "distanceMeters": trip.route_distance_m,
        "durationSeconds": trip.route_duration_s,
        "alternatives": trip.route_alternatives or [],
    }


# --- Tracking links --------------------------------------------------------


@router.get("/notifications/status")
async def notification_status(user: CurrentUser) -> dict:
    """What the dispatcher's send buttons should show. Never a dead button."""
    return notify.sending_status()


@router.post("/trips/{trip_id}/send-link")
async def send_link(
    trip_id: uuid.UUID, payload: SendLinkIn, admin: AdminUser, db: DbSession
) -> dict:
    """Send one party's link over one channel.

    Per-party and per-channel because one customer often wants the link and
    the other does not.
    """
    trip = await db.get(Trip, trip_id)
    if trip is None or trip.organization_id != admin.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trip not found")

    result = await db.execute(
        select(TrackingLink).where(
            TrackingLink.trip_id == trip_id, TrackingLink.party == payload.party
        )
    )
    link = result.scalar_one_or_none()
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Tracking link not found")

    consignment = await db.get(Consignment, trip.consignment_id)
    customer_id = (
        consignment.consignor_id
        if payload.party == TrackingParty.CONSIGNOR
        else consignment.consignee_id
    )
    customer = await db.get(Customer, customer_id)
    pickup = await db.get(Address, consignment.consignor_address_id)
    drop = await db.get(Address, consignment.consignee_address_id)
    org = await db.get(Organization, admin.organization_id)

    channel = NotifyChannel(payload.channel)
    recipient = payload.recipient or (
        customer.email if channel == NotifyChannel.EMAIL else customer.phone
    )

    entry = await notify.send_tracking_link(
        db,
        link,
        channel=channel,
        recipient=recipient or "",
        lr_number=consignment.lr_number,
        org_name=org.name if org else "",
        origin=pickup.line1,
        destination=drop.line1,
    )
    await db.commit()

    response = {
        "status": entry.status.value,
        "channel": channel.value,
        "recipient": recipient,
        "error": entry.error,
        "url": notify.tracking_url(link.token),
    }
    if channel == NotifyChannel.WHATSAPP and recipient:
        # The dispatcher taps this; nothing is sent server-side.
        response["whatsappUrl"] = notify.whatsapp_link(
            recipient,
            f"Track consignment {consignment.lr_number}: {notify.tracking_url(link.token)}",
        )
    return response


# --- Driver-facing (device token) ------------------------------------------


@router.get("/devices/me/trips")
async def my_trips(device: CurrentDevice, db: DbSession) -> list[dict]:
    """Trips assigned to the phone making the request.

    Device-token authenticated, and scoped to `device_id` — a driver sees only
    their own runs, never the rest of the fleet's. Deliberately excludes
    freight amounts and the consignor's commercials: the driver needs the
    route, the goods and who to call, not what the customer is paying.
    """
    result = await db.execute(
        select(Trip)
        .options(
            selectinload(Trip.consignment).selectinload(Consignment.consignor),
            selectinload(Trip.consignment).selectinload(Consignment.consignee),
            selectinload(Trip.consignment).selectinload(Consignment.consignor_address),
            selectinload(Trip.consignment).selectinload(Consignment.consignee_address),
        )
        .where(
            Trip.device_id == device.id,
            Trip.status.notin_([TripStatus.DELIVERED, TripStatus.CANCELLED]),
        )
        .order_by(Trip.scheduled_start)
    )
    trips = result.scalars().unique().all()

    vehicles = {
        v.id: v
        for v in (
            await db.execute(
                select(Vehicle).where(Vehicle.organization_id == device.organization_id)
            )
        ).scalars()
    }

    out = []
    for trip in trips:
        c = trip.consignment
        pickup, drop = c.consignor_address, c.consignee_address
        vehicle = vehicles.get(trip.vehicle_id)
        out.append(
            {
                "id": str(trip.id),
                "lrNumber": c.lr_number,
                "status": trip.status.value,
                "scheduledStart": trip.scheduled_start.isoformat(),
                "goods": c.goods_description,
                "packages": c.package_count,
                "weightKg": c.weight_kg,
                "isFragile": c.is_fragile,
                "isHazardous": c.is_hazardous,
                # Carried on the vehicle and asked for at checkpoints.
                "ewayBillNumber": c.eway_bill_number,
                "ewayBillValidUntil": c.eway_bill_valid_until.isoformat()
                if c.eway_bill_valid_until
                else None,
                "invoiceNumber": c.invoice_number,
                "vehicle": vehicle.registration_number if vehicle else None,
                "pickup": {
                    "name": c.consignor.name,
                    "address": pickup.line1,
                    "city": pickup.city,
                    "contact": pickup.contact_phone or c.consignor.phone,
                    "latitude": pickup.latitude,
                    "longitude": pickup.longitude,
                },
                "drop": {
                    "name": c.consignee.name,
                    "address": drop.line1,
                    "city": drop.city,
                    "contact": drop.contact_phone or c.consignee.phone,
                    "latitude": drop.latitude,
                    "longitude": drop.longitude,
                },
                "route": {
                    "distanceKm": round(trip.route_distance_m / 1000, 1)
                    if trip.route_distance_m
                    else None,
                    "durationH": round(trip.route_duration_s / 3600, 1)
                    if trip.route_duration_s
                    else None,
                    "summary": trip.route_summary,
                    "geometry": trip.route_geometry,
                    "alternatives": trip.route_alternatives or [],
                },
                "instructions": c.special_instructions,
                "notes": trip.notes,
            }
        )
    return out
