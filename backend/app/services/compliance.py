"""Document expiry and dispatch-readiness checks.

This is the part of the system that earns its keep daily. An expired insurance
or PUC certificate means the vehicle is detained at a checkpoint, the
consignment is late, and the penalty lands on the transporter — not the
driver. Catching it 30 days early is worth more than any map feature.

Two levels:
  * ``document_alerts`` — the ongoing watchlist for the dashboard.
  * ``check_dispatch`` — a hard gate answered at booking time, for a specific
    vehicle/driver on a specific date.

Deliberately advisory, not blocking, at the API layer: a dispatcher sometimes
has to move a vehicle knowing a document lapses tomorrow, and software that
refuses outright gets worked around with a second spreadsheet. It warns
loudly, records the decision, and lets a human own it — except for genuinely
expired documents on the travel date, which are reported as blocking.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from app.core.config import settings
from app.models.consignment import Consignment
from app.models.driver import Driver
from app.models.driver_documents import DriverDocType
from app.models.vehicle import Vehicle, VehicleDocType

# Documents that must be valid for a commercial goods vehicle to be on the
# road. RC has no expiry, so it is required-to-exist rather than required-valid.
REQUIRED_VEHICLE_DOCS = {
    VehicleDocType.INSURANCE,
    VehicleDocType.PUC,
    VehicleDocType.FITNESS,
}

DOC_LABELS = {
    "rc": "Registration Certificate",
    "insurance": "Insurance",
    "puc": "PUC certificate",
    "fitness": "Fitness certificate",
    "permit_national": "National permit",
    "permit_state": "State permit",
    "road_tax": "Road tax",
    "driving_licence": "Driving licence",
    "police_verification": "Police verification",
    "medical_certificate": "Medical certificate",
    "other": "Document",
}


class Severity(str, enum.Enum):
    EXPIRED = "expired"      # already invalid — dispatching is an offence
    CRITICAL = "critical"    # expires within 7 days
    WARNING = "warning"      # expires within the configured window
    MISSING = "missing"      # required document not on file at all


@dataclass
class Alert:
    severity: Severity
    subject_type: str          # "vehicle" | "driver" | "consignment"
    subject_id: str
    subject_label: str
    document: str
    message: str
    expires_on: date | None = None
    days_remaining: int | None = None

    @property
    def blocking(self) -> bool:
        return self.severity in (Severity.EXPIRED, Severity.MISSING)


@dataclass
class DispatchCheck:
    ok: bool
    blocking: list[Alert] = field(default_factory=list)
    warnings: list[Alert] = field(default_factory=list)


def _label(doc_type: str) -> str:
    return DOC_LABELS.get(doc_type, doc_type.replace("_", " ").title())


def _classify(expires_on: date | None, on: date) -> tuple[Severity, int] | None:
    """Severity of a document expiry relative to a reference date."""
    if expires_on is None:
        return None
    days = (expires_on - on).days
    if days < 0:
        return Severity.EXPIRED, days
    if days <= 7:
        return Severity.CRITICAL, days
    if days <= settings.DOC_EXPIRY_WARN_DAYS:
        return Severity.WARNING, days
    return None


def vehicle_alerts(vehicle: Vehicle, on: date | None = None) -> list[Alert]:
    """Expiry and missing-document alerts for one vehicle."""
    on = on or datetime.now(timezone.utc).date()
    alerts: list[Alert] = []
    present = {d.doc_type for d in vehicle.documents}

    for required in REQUIRED_VEHICLE_DOCS:
        if required not in present:
            alerts.append(
                Alert(
                    severity=Severity.MISSING,
                    subject_type="vehicle",
                    subject_id=str(vehicle.id),
                    subject_label=vehicle.registration_number,
                    document=required.value,
                    message=f"{_label(required.value)} is not on file",
                )
            )

    for doc in vehicle.documents:
        verdict = _classify(doc.expires_on, on)
        if verdict is None:
            continue
        severity, days = verdict
        alerts.append(
            Alert(
                severity=severity,
                subject_type="vehicle",
                subject_id=str(vehicle.id),
                subject_label=vehicle.registration_number,
                document=doc.doc_type.value,
                expires_on=doc.expires_on,
                days_remaining=days,
                message=(
                    f"{_label(doc.doc_type.value)} expired {abs(days)} day(s) ago"
                    if days < 0
                    else f"{_label(doc.doc_type.value)} expires in {days} day(s)"
                ),
            )
        )
    return alerts


def driver_alerts(driver: Driver, on: date | None = None) -> list[Alert]:
    """Licence and document alerts for one driver."""
    on = on or datetime.now(timezone.utc).date()
    alerts: list[Alert] = []

    if not driver.licence_number:
        alerts.append(
            Alert(
                severity=Severity.MISSING,
                subject_type="driver",
                subject_id=str(driver.id),
                subject_label=driver.full_name,
                document="driving_licence",
                message="Driving licence number is not on file",
            )
        )

    verdict = _classify(driver.licence_expires_on, on)
    if verdict:
        severity, days = verdict
        alerts.append(
            Alert(
                severity=severity,
                subject_type="driver",
                subject_id=str(driver.id),
                subject_label=driver.full_name,
                document="driving_licence",
                expires_on=driver.licence_expires_on,
                days_remaining=days,
                message=(
                    f"Driving licence expired {abs(days)} day(s) ago"
                    if days < 0
                    else f"Driving licence expires in {days} day(s)"
                ),
            )
        )

    for doc in getattr(driver, "documents", []) or []:
        # The licence is already reported from driver.licence_expires_on above.
        # Reporting it again from the document row duplicates every alert,
        # which makes the compliance list untrustworthy.
        if doc.doc_type == DriverDocType.DRIVING_LICENCE:
            continue
        verdict = _classify(doc.expires_on, on)
        if verdict is None:
            continue
        severity, days = verdict
        alerts.append(
            Alert(
                severity=severity,
                subject_type="driver",
                subject_id=str(driver.id),
                subject_label=driver.full_name,
                document=doc.doc_type.value,
                expires_on=doc.expires_on,
                days_remaining=days,
                message=(
                    f"{_label(doc.doc_type.value)} expired {abs(days)} day(s) ago"
                    if days < 0
                    else f"{_label(doc.doc_type.value)} expires in {days} day(s)"
                ),
            )
        )
    return alerts


def consignment_alerts(
    consignment: Consignment, travel_on: datetime | None = None
) -> list[Alert]:
    """E-way bill checks.

    The e-way bill is the one that actually stops trucks: it is mandatory
    above ₹50,000 and it expires by distance and time, so a valid-looking bill
    issued three days ago may already be dead.
    """
    alerts: list[Alert] = []
    when = travel_on or datetime.now(timezone.utc)
    value = float(consignment.declared_value or 0)

    if value > 50_000 and not consignment.eway_bill_number:
        alerts.append(
            Alert(
                severity=Severity.MISSING,
                subject_type="consignment",
                subject_id=str(consignment.id),
                subject_label=consignment.lr_number,
                document="eway_bill",
                message=(
                    f"E-way bill is mandatory above ₹50,000 "
                    f"(declared value ₹{value:,.0f}) and is not on file"
                ),
            )
        )

    if consignment.eway_bill_number and consignment.eway_bill_valid_until:
        valid_until = consignment.eway_bill_valid_until
        if valid_until.tzinfo is None:
            valid_until = valid_until.replace(tzinfo=timezone.utc)
        remaining = valid_until - when
        if remaining < timedelta(0):
            alerts.append(
                Alert(
                    severity=Severity.EXPIRED,
                    subject_type="consignment",
                    subject_id=str(consignment.id),
                    subject_label=consignment.lr_number,
                    document="eway_bill",
                    expires_on=valid_until.date(),
                    days_remaining=remaining.days,
                    message="E-way bill has expired — the vehicle will be detained",
                )
            )
        elif remaining < timedelta(hours=24):
            hours = int(remaining.total_seconds() // 3600)
            alerts.append(
                Alert(
                    severity=Severity.CRITICAL,
                    subject_type="consignment",
                    subject_id=str(consignment.id),
                    subject_label=consignment.lr_number,
                    document="eway_bill",
                    expires_on=valid_until.date(),
                    days_remaining=0,
                    message=f"E-way bill expires in {hours} hour(s)",
                )
            )
    return alerts


def check_dispatch(
    vehicle: Vehicle | None,
    driver: Driver | None,
    consignment: Consignment | None,
    travel_on: datetime,
) -> DispatchCheck:
    """Can this vehicle + driver legally run this consignment on this date?

    Evaluated against the *travel* date, not today — booking a trip three
    weeks out must be checked against the document status on the day it runs.
    """
    on = travel_on.date()
    alerts: list[Alert] = []

    if vehicle is not None:
        alerts += vehicle_alerts(vehicle, on)
    if driver is not None:
        alerts += driver_alerts(driver, on)
    if consignment is not None:
        alerts += consignment_alerts(consignment, travel_on)

    blocking = [a for a in alerts if a.blocking]
    warnings = [a for a in alerts if not a.blocking]
    return DispatchCheck(ok=not blocking, blocking=blocking, warnings=warnings)
