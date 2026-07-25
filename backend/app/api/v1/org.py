"""Organization settings and the consignment-note (LR) generator.

The LR — Lorry Receipt, also called the GC (Goods Consignment) note — is the
core legal document of road transport in India. The transporter issues it when
they take goods into their custody; it travels with the shipment, is produced
at checkpoints, and is the instrument a court looks at in a dispute. For
"To-Pay" freight it doubles as the bill the consignee settles on delivery.

This module assembles everything one needs, in one defined format, from data
the system already holds — so the operator does not re-key a single field.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import AdminUser, CurrentUser, DbSession
from app.models.consignment import Consignment, Trip
from app.models.customer import Address, Customer
from app.models.driver import Driver
from app.models.organization import Organization
from app.models.vehicle import Vehicle
from app.schemas.tms import OrgSettingsIn, OrgSettingsOut

router = APIRouter(tags=["organization"])


# The header fields a consignment note is not valid without. Used to tell the
# operator their letterhead is incomplete *before* they print a bill that an
# auditor would reject.
_LETTERHEAD_REQUIRED = ("legal_name", "gstin", "address_line", "city", "state")


def _letterhead_ready(org: Organization) -> bool:
    return all(getattr(org, field, None) for field in _LETTERHEAD_REQUIRED)


def _org_out(org: Organization) -> OrgSettingsOut:
    out = OrgSettingsOut.model_validate(org)
    out.letterhead_ready = _letterhead_ready(org)
    return out


@router.get("/org/settings", response_model=OrgSettingsOut)
async def get_org_settings(user: CurrentUser, db: DbSession) -> OrgSettingsOut:
    org = await db.get(Organization, user.organization_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organization not found")
    return _org_out(org)


@router.patch("/org/settings", response_model=OrgSettingsOut)
async def update_org_settings(
    payload: OrgSettingsIn, admin: AdminUser, db: DbSession
) -> OrgSettingsOut:
    org = await db.get(Organization, admin.organization_id)
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Organization not found")

    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(org, key, value)

    await db.commit()
    await db.refresh(org)
    return _org_out(org)


def _party_block(customer: Customer, address: Address) -> dict:
    """A consignor/consignee block, exactly as it prints on the note."""
    return {
        "name": customer.name,
        "gstin": customer.gstin,
        "phone": address.contact_phone or customer.phone,
        "contactPerson": address.contact_person or customer.contact_person,
        "address": ", ".join(
            part
            for part in [
                address.line1,
                address.line2,
                address.landmark,
                address.city,
                address.state,
                address.pincode,
            ]
            if part
        ),
        "city": address.city,
        "state": address.state,
        "pincode": address.pincode,
    }


@router.get("/consignments/{consignment_id}/lr")
async def consignment_lr(
    consignment_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> dict:
    """Everything the consignment note prints, assembled in one payload.

    Read-only: generating the LR must never mutate the consignment, so it can
    be reprinted any number of times and always shows the same document.
    """
    result = await db.execute(
        select(Consignment)
        .options(
            selectinload(Consignment.consignor),
            selectinload(Consignment.consignee),
            selectinload(Consignment.consignor_address),
            selectinload(Consignment.consignee_address),
            selectinload(Consignment.trips),
        )
        .where(Consignment.id == consignment_id)
    )
    consignment = result.scalar_one_or_none()
    if consignment is None or consignment.organization_id != user.organization_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Consignment not found")

    org = await db.get(Organization, user.organization_id)

    # The first trip carries the vehicle and driver actually running it. A
    # consignment can be re-assigned after a breakdown, so the *latest* trip is
    # the one whose vehicle is on the note.
    trip: Trip | None = None
    if consignment.trips:
        trip = sorted(consignment.trips, key=lambda t: t.scheduled_start)[-1]

    vehicle = await db.get(Vehicle, trip.vehicle_id) if trip and trip.vehicle_id else None
    driver = await db.get(Driver, trip.driver_id) if trip and trip.driver_id else None

    # Freight arithmetic, computed here so the document and the app can never
    # disagree. "Balance" is what the consignee actually pays on To-Pay.
    freight = float(consignment.freight_amount or 0)
    advance = float(consignment.advance_amount or 0)
    balance = max(freight - advance, 0)

    missing = [f for f in _LETTERHEAD_REQUIRED if not getattr(org, f, None)]

    return {
        "lrNumber": consignment.lr_number,
        "status": consignment.status.value,
        "createdAt": consignment.created_at.isoformat(),
        "transporter": {
            "name": (org.legal_name or org.name) if org else "",
            "tradeName": org.name if org else "",
            "gstin": org.gstin if org else None,
            "pan": org.pan if org else None,
            "transporterId": org.transporter_id if org else None,
            "address": ", ".join(
                part
                for part in [
                    org.address_line, org.city, org.state, org.pincode,
                ]
                if org and part
            ) if org else "",
            "phone": org.phone if org else None,
            "email": org.email if org else None,
            "logoUrl": org.logo_url if org else None,
            "terms": org.lr_terms if org else None,
        },
        # Never block printing — a transporter sometimes must issue an LR before
        # the office has finished filling in the letterhead — but say plainly
        # what is missing so nobody hands a checkpoint an invalid note unaware.
        "letterheadReady": org is not None and not missing,
        "letterheadMissing": missing,
        "consignor": _party_block(consignment.consignor, consignment.consignor_address),
        "consignee": _party_block(consignment.consignee, consignment.consignee_address),
        "goods": {
            "description": consignment.goods_description,
            "hsnCode": consignment.hsn_code,
            "packageCount": consignment.package_count,
            "packageType": consignment.package_type,
            "weightKg": consignment.weight_kg,
            "declaredValue": float(consignment.declared_value) if consignment.declared_value else None,
            "isFragile": consignment.is_fragile,
            "isHazardous": consignment.is_hazardous,
        },
        "statutory": {
            "ewayBillNumber": consignment.eway_bill_number,
            "ewayBillValidUntil": consignment.eway_bill_valid_until.isoformat()
            if consignment.eway_bill_valid_until else None,
            "invoiceNumber": consignment.invoice_number,
            "invoiceDate": consignment.invoice_date.isoformat()
            if consignment.invoice_date else None,
        },
        "freight": {
            "terms": consignment.freight_terms.value,
            "amount": freight or None,
            "advance": advance or None,
            "balance": balance or None,
            # Who settles the freight, spelled out — this is the single most
            # disputed line on a transport document.
            "payableBy": {
                "paid": "Consignor (paid)",
                "to_pay": "Consignee (to pay)",
                "tbb": "To be billed to account",
            }.get(consignment.freight_terms.value, consignment.freight_terms.value),
        },
        "carriage": {
            "vehicleNumber": vehicle.registration_number if vehicle else None,
            "vehicleType": vehicle.vehicle_type.value if vehicle else None,
            "driverName": driver.full_name if driver else None,
            "driverPhone": driver.phone if driver else None,
            "scheduledStart": trip.scheduled_start.isoformat() if trip else None,
            "distanceKm": round(trip.route_distance_m / 1000, 1)
            if trip and trip.route_distance_m else None,
        },
        "specialInstructions": consignment.special_instructions,
    }
