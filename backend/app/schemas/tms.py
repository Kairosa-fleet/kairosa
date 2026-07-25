"""Schemas for the transport-management domain."""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    field_validator,
    model_validator,
)

from app.models.consignment import ConsignmentStatus, FreightTerms, TrackingParty, TripStatus
from app.models.customer import CustomerRole
from app.models.driver_documents import DriverDocType
from app.models.vehicle import VehicleDocType, VehicleType

Camel = ConfigDict(populate_by_name=True, extra="forbid")
FromORM = ConfigDict(from_attributes=True)


def _normalise_reg(value: str) -> str:
    """"GJ 06 AB 1234" and "gj06ab1234" are the same vehicle."""
    return re.sub(r"[^A-Za-z0-9]", "", value).upper()


# --- Vehicles --------------------------------------------------------------


# The documents every commercial goods vehicle must carry. Kept beside the
# schema so the API and the compliance engine cannot drift apart.
MANDATORY_VEHICLE_DOCS = (
    VehicleDocType.RC,
    VehicleDocType.INSURANCE,
    VehicleDocType.PUC,
    VehicleDocType.FITNESS,
)

_DOC_LABELS = {
    "rc": "Registration Certificate",
    "insurance": "Insurance",
    "puc": "PUC certificate",
    "fitness": "Fitness certificate",
}


class VehicleDocIn(BaseModel):
    model_config = Camel
    doc_type: VehicleDocType = Field(alias="docType")
    # Free-form on purpose. An RC number, a policy number and a PUC serial
    # follow different formats across states and insurers, and every one of
    # them mixes letters with digits — validating a shape here would reject
    # perfectly valid paperwork.
    number: str | None = Field(default=None, max_length=80)
    issuer: str | None = Field(default=None, max_length=120)
    issued_on: date | None = Field(default=None, alias="issuedOn")
    expires_on: date | None = Field(default=None, alias="expiresOn")
    file_url: str | None = Field(default=None, alias="fileUrl", max_length=500)
    file_name: str | None = Field(default=None, alias="fileName", max_length=200)
    notes: str | None = None

    @model_validator(mode="after")
    def _scan_accompanies_number(self) -> "VehicleDocIn":
        """A recorded document must have its scan attached.

        Half a record is worse than none: a number with no scan looks complete
        on the dashboard right up to the moment someone needs to produce the
        certificate.
        """
        if self.number and not self.file_url:
            raise ValueError(
                f"{self.doc_type.value}: attach the PDF for this document"
            )
        if self.file_url and not self.number:
            raise ValueError(
                f"{self.doc_type.value}: enter the document number to go with the PDF"
            )
        return self


class VehicleImageIn(BaseModel):
    model_config = Camel
    file_url: str = Field(alias="fileUrl", max_length=500)
    file_name: str | None = Field(default=None, alias="fileName", max_length=200)
    caption: str | None = Field(default=None, max_length=200)
    is_primary: bool = Field(default=False, alias="isPrimary")
    sort_order: int = Field(default=0, alias="sortOrder", ge=0, le=100)


class VehicleImageOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    file_url: str = Field(serialization_alias="fileUrl")
    file_name: str | None = Field(default=None, serialization_alias="fileName")
    caption: str | None = None
    is_primary: bool = Field(serialization_alias="isPrimary")
    sort_order: int = Field(serialization_alias="sortOrder")


class VehicleDocOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    doc_type: VehicleDocType = Field(serialization_alias="docType")
    number: str | None = None
    issuer: str | None = None
    issued_on: date | None = Field(default=None, serialization_alias="issuedOn")
    expires_on: date | None = Field(default=None, serialization_alias="expiresOn")
    file_url: str | None = Field(default=None, serialization_alias="fileUrl")
    file_name: str | None = Field(default=None, serialization_alias="fileName")
    notes: str | None = None


class VehicleIn(BaseModel):
    model_config = Camel
    registration_number: str = Field(alias="registrationNumber", min_length=4, max_length=20)
    display_name: str | None = Field(default=None, alias="displayName", max_length=100)
    vehicle_type: VehicleType = Field(default=VehicleType.TRUCK, alias="vehicleType")
    make: str | None = Field(default=None, max_length=60)
    model: str | None = Field(default=None, max_length=60)
    manufacture_year: int | None = Field(default=None, alias="manufactureYear", ge=1950, le=2100)
    body_type: str | None = Field(default=None, alias="bodyType", max_length=60)
    capacity_kg: int | None = Field(default=None, alias="capacityKg", ge=0, le=100_000)
    chassis_number: str | None = Field(default=None, alias="chassisNumber", max_length=40)
    engine_number: str | None = Field(default=None, alias="engineNumber", max_length=40)
    fuel_type: str | None = Field(default=None, alias="fuelType", max_length=20)
    notes: str | None = None
    documents: list[VehicleDocIn] = Field(default_factory=list)
    images: list[VehicleImageIn] = Field(default_factory=list, max_length=12)

    @field_validator("registration_number")
    @classmethod
    def _reg(cls, v: str) -> str:
        return _normalise_reg(v)

    @model_validator(mode="after")
    def _mandatory_documents(self) -> "VehicleIn":
        """The four documents that keep a goods vehicle legal on the road.

        Permits and road tax are deliberately not in this set: a truck running
        only inside its home state has no national permit, and demanding one
        would block a legitimate vehicle from ever being added. These four
        apply to every commercial goods vehicle without exception, and each is
        something a checkpoint can detain the vehicle over.

        Enforced here as well as in the form because the API is reachable
        without it.
        """
        present = {
            doc.doc_type
            for doc in self.documents
            if doc.number and doc.file_url
        }
        missing = [d.value for d in MANDATORY_VEHICLE_DOCS if d not in present]
        if missing:
            labels = ", ".join(_DOC_LABELS.get(m, m) for m in missing)
            raise ValueError(
                f"These documents are required, each with its number and PDF: {labels}"
            )

        # Expiry matters for everything except the RC, which does not expire.
        undated = [
            doc.doc_type.value
            for doc in self.documents
            if doc.doc_type in MANDATORY_VEHICLE_DOCS
            and doc.doc_type != VehicleDocType.RC
            and doc.expires_on is None
        ]
        if undated:
            labels = ", ".join(_DOC_LABELS.get(u, u) for u in undated)
            raise ValueError(f"Expiry date is required for: {labels}")

        # Exactly one photo leads. Enforced here rather than in the form so a
        # payload built by hand cannot produce a vehicle whose card has two
        # cover images, or none while photos exist.
        if self.images:
            primaries = [i for i in self.images if i.is_primary]
            if not primaries:
                self.images[0].is_primary = True
            elif len(primaries) > 1:
                for image in primaries[1:]:
                    image.is_primary = False
        return self


class VehicleOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    registration_number: str = Field(serialization_alias="registrationNumber")
    display_name: str | None = Field(default=None, serialization_alias="displayName")
    vehicle_type: VehicleType = Field(serialization_alias="vehicleType")
    make: str | None = None
    model: str | None = None
    manufacture_year: int | None = Field(default=None, serialization_alias="manufactureYear")
    body_type: str | None = Field(default=None, serialization_alias="bodyType")
    capacity_kg: int | None = Field(default=None, serialization_alias="capacityKg")
    chassis_number: str | None = Field(default=None, serialization_alias="chassisNumber")
    engine_number: str | None = Field(default=None, serialization_alias="engineNumber")
    fuel_type: str | None = Field(default=None, serialization_alias="fuelType")
    is_active: bool = Field(serialization_alias="isActive")
    notes: str | None = None
    documents: list[VehicleDocOut] = Field(default_factory=list)
    images: list[VehicleImageOut] = Field(default_factory=list)


# --- Drivers ---------------------------------------------------------------


# What a commercial goods driver must have on file. The licence is not in this
# list because it lives on the driver record itself, and is checked separately.
MANDATORY_DRIVER_DOCS = (
    DriverDocType.POLICE_VERIFICATION,
    DriverDocType.MEDICAL_CERTIFICATE,
)

_DRIVER_DOC_LABELS = {
    "police_verification": "Police verification",
    "medical_certificate": "Medical certificate",
    "pan": "PAN card",
    "address_proof": "Address proof",
    "aadhaar": "Aadhaar",
}


class DriverDocIn(BaseModel):
    model_config = Camel
    doc_type: DriverDocType = Field(alias="docType")
    number: str | None = Field(default=None, max_length=80)
    issuer: str | None = Field(default=None, max_length=120)
    issued_on: date | None = Field(default=None, alias="issuedOn")
    expires_on: date | None = Field(default=None, alias="expiresOn")
    file_url: str | None = Field(default=None, alias="fileUrl", max_length=500)
    file_name: str | None = Field(default=None, alias="fileName", max_length=200)
    notes: str | None = None

    @model_validator(mode="after")
    def _scan_accompanies_number(self) -> "DriverDocIn":
        """A recorded document must have its scan attached.

        Same rule as vehicle documents: a number with no scan looks complete
        until the moment someone has to produce the certificate.
        """
        if self.doc_type == DriverDocType.AADHAAR:
            # Deliberately never stored as a scan. The driver record keeps only
            # the last four digits, because holding a full Aadhaar — which a
            # scanned card contains, along with the address and photograph —
            # creates obligations under the Aadhaar Act this product does not
            # need and cannot discharge.
            if self.file_url:
                raise ValueError(
                    "Aadhaar scans are not stored — only the last four digits are kept"
                )
            return self
        if self.number and not self.file_url:
            raise ValueError(f"{self.doc_type.value}: attach the PDF for this document")
        if self.file_url and not self.number:
            raise ValueError(
                f"{self.doc_type.value}: enter the document number to go with the PDF"
            )
        return self


class DriverDocOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    doc_type: DriverDocType = Field(serialization_alias="docType")
    file_url: str | None = Field(default=None, serialization_alias="fileUrl")
    file_name: str | None = Field(default=None, serialization_alias="fileName")
    number: str | None = None
    issuer: str | None = None
    issued_on: date | None = Field(default=None, serialization_alias="issuedOn")
    expires_on: date | None = Field(default=None, serialization_alias="expiresOn")


class DriverIn(BaseModel):
    model_config = Camel
    full_name: str = Field(alias="fullName", min_length=2, max_length=200)
    phone: str | None = Field(default=None, max_length=20)
    employee_code: str | None = Field(default=None, alias="employeeCode", max_length=50)

    licence_number: str | None = Field(default=None, alias="licenceNumber", max_length=30)
    licence_class: str | None = Field(default=None, alias="licenceClass", max_length=30)
    licence_issuing_rto: str | None = Field(default=None, alias="licenceIssuingRto", max_length=100)
    licence_expires_on: date | None = Field(default=None, alias="licenceExpiresOn")

    date_of_birth: date | None = Field(default=None, alias="dateOfBirth")
    blood_group: str | None = Field(default=None, alias="bloodGroup", max_length=5)
    address: str | None = Field(default=None, max_length=400)
    emergency_contact_name: str | None = Field(default=None, alias="emergencyContactName", max_length=150)
    emergency_contact_phone: str | None = Field(default=None, alias="emergencyContactPhone", max_length=20)

    # Full Aadhaar is deliberately not accepted — storing it creates
    # obligations under the Aadhaar Act this product does not need. Only the
    # last four digits are kept, which is enough to match a physical card.
    # No max_length here: field constraints run *before* validators, so a
    # pasted full Aadhaar would be rejected instead of trimmed to its last 4.
    aadhaar_last4: str | None = Field(default=None, alias="aadhaarLast4")
    pan_number: str | None = Field(default=None, alias="panNumber", max_length=10)
    photo_url: str | None = Field(default=None, alias="photoUrl", max_length=500)
    photo_name: str | None = Field(default=None, alias="photoName", max_length=200)
    licence_file_url: str | None = Field(default=None, alias="licenceFileUrl", max_length=500)
    licence_file_name: str | None = Field(default=None, alias="licenceFileName", max_length=200)
    joined_on: date | None = Field(default=None, alias="joinedOn")
    documents: list[DriverDocIn] = Field(default_factory=list)

    @model_validator(mode="after")
    def _mandatory_driver_paperwork(self) -> "DriverIn":
        """What a driver cannot legally be dispatched without.

        The licence is the first thing a traffic officer asks for, and for a
        goods vehicle its class and expiry decide whether the driver may be
        behind the wheel at all. Police verification and a medical certificate
        are what a transporter is expected to hold for an employed driver.

        PAN and address proof are employment records rather than roadside
        ones, so they stay optional — as with vehicle permits, demanding them
        would block a legitimate hire.
        """
        missing: list[str] = []
        if not self.licence_number:
            missing.append("Driving licence number")
        if not self.licence_class:
            missing.append("Licence class")
        if not self.licence_expires_on:
            missing.append("Licence expiry")
        if not self.licence_file_url:
            missing.append("Driving licence scan")
        if missing:
            raise ValueError("Required: " + ", ".join(missing))

        present = {
            doc.doc_type for doc in self.documents if doc.number and doc.file_url
        }
        absent = [d.value for d in MANDATORY_DRIVER_DOCS if d not in present]
        if absent:
            labels = ", ".join(_DRIVER_DOC_LABELS.get(a, a) for a in absent)
            raise ValueError(
                f"These documents are required, each with its number and PDF: {labels}"
            )

        undated = [
            doc.doc_type.value
            for doc in self.documents
            if doc.doc_type in MANDATORY_DRIVER_DOCS and doc.expires_on is None
        ]
        if undated:
            labels = ", ".join(_DRIVER_DOC_LABELS.get(u, u) for u in undated)
            raise ValueError(f"Expiry date is required for: {labels}")
        return self

    @field_validator("aadhaar_last4")
    @classmethod
    def _aadhaar(cls, v: str | None) -> str | None:
        if v is None:
            return None
        digits = re.sub(r"\D", "", v)
        if len(digits) == 12:
            return digits[-4:]  # a full number was pasted; keep only the tail
        if len(digits) != 4:
            raise ValueError("Provide the last 4 digits of Aadhaar only")
        return digits


class DriverCreatedOut(BaseModel):
    """Returned once, at creation. The temporary password is not recoverable."""

    model_config = FromORM

    id: uuid.UUID
    full_name: str = Field(serialization_alias="fullName")
    login_id: str | None = Field(default=None, serialization_alias="loginId")
    must_change_password: bool = Field(serialization_alias="mustChangePassword")
    temporary_password: str | None = Field(
        default=None, serialization_alias="temporaryPassword"
    )
    licence_number: str | None = Field(default=None, serialization_alias="licenceNumber")

    @classmethod
    def from_driver(cls, driver) -> "DriverCreatedOut":
        return cls(
            id=driver.id,
            full_name=driver.full_name,
            login_id=driver.login_id,
            must_change_password=driver.must_change_password,
            temporary_password=driver.__dict__.get("_temp_password"),
            licence_number=driver.licence_number,
        )


class DriverFullOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    full_name: str = Field(serialization_alias="fullName")
    phone: str | None = None
    employee_code: str | None = Field(default=None, serialization_alias="employeeCode")
    licence_number: str | None = Field(default=None, serialization_alias="licenceNumber")
    licence_class: str | None = Field(default=None, serialization_alias="licenceClass")
    licence_issuing_rto: str | None = Field(default=None, serialization_alias="licenceIssuingRto")
    licence_expires_on: date | None = Field(default=None, serialization_alias="licenceExpiresOn")
    licence_file_url: str | None = Field(default=None, serialization_alias="licenceFileUrl")
    licence_file_name: str | None = Field(default=None, serialization_alias="licenceFileName")
    date_of_birth: date | None = Field(default=None, serialization_alias="dateOfBirth")
    blood_group: str | None = Field(default=None, serialization_alias="bloodGroup")
    address: str | None = None
    emergency_contact_name: str | None = Field(default=None, serialization_alias="emergencyContactName")
    emergency_contact_phone: str | None = Field(default=None, serialization_alias="emergencyContactPhone")
    aadhaar_last4: str | None = Field(default=None, serialization_alias="aadhaarLast4")
    pan_number: str | None = Field(default=None, serialization_alias="panNumber")
    joined_on: date | None = Field(default=None, serialization_alias="joinedOn")
    login_id: str | None = Field(default=None, serialization_alias="loginId")
    must_change_password: bool = Field(
        default=False, serialization_alias="mustChangePassword"
    )
    is_active: bool = Field(serialization_alias="isActive")
    photo_url: str | None = Field(default=None, serialization_alias="photoUrl")
    photo_name: str | None = Field(default=None, serialization_alias="photoName")
    documents: list[DriverDocOut] = Field(default_factory=list)


# --- Customers & addresses -------------------------------------------------


class AddressIn(BaseModel):
    model_config = Camel
    label: str | None = Field(default=None, max_length=100)
    line1: str = Field(min_length=3, max_length=250)
    line2: str | None = Field(default=None, max_length=250)
    landmark: str | None = Field(default=None, max_length=150)
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    pincode: str | None = Field(default=None, max_length=10)
    country: str = "India"
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    place_name: str | None = Field(default=None, alias="placeName", max_length=400)
    precision: str | None = Field(default=None, max_length=12)
    contact_person: str | None = Field(default=None, alias="contactPerson", max_length=150)
    contact_phone: str | None = Field(default=None, alias="contactPhone", max_length=20)


class AddressOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    label: str | None = None
    line1: str
    line2: str | None = None
    landmark: str | None = None
    city: str | None = None
    state: str | None = None
    pincode: str | None = None
    country: str
    latitude: float
    longitude: float
    place_name: str | None = Field(default=None, serialization_alias="placeName")
    precision: str | None = None
    contact_person: str | None = Field(default=None, serialization_alias="contactPerson")
    contact_phone: str | None = Field(default=None, serialization_alias="contactPhone")


class CustomerIn(BaseModel):
    model_config = Camel
    name: str = Field(min_length=2, max_length=200)
    contact_person: str | None = Field(default=None, alias="contactPerson", max_length=150)
    phone: str = Field(min_length=6, max_length=20)
    alt_phone: str | None = Field(default=None, alias="altPhone", max_length=20)
    email: EmailStr | None = None
    gstin: str | None = Field(default=None, max_length=15)
    role: CustomerRole = CustomerRole.BOTH
    notes: str | None = None
    addresses: list[AddressIn] = Field(default_factory=list)

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v: str | None) -> str | None:
        if not v:
            return None
        value = v.strip().upper()
        # 2-digit state code, 10-char PAN, entity digit, 'Z', checksum.
        if not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z\d]", value):
            raise ValueError("GSTIN is not in a valid format")
        return value


class CustomerPatchIn(BaseModel):
    """Partial update. Addresses are managed through their own endpoints —
    a customer edit must not be able to silently drop a pickup point that a
    booked consignment still points at."""

    model_config = Camel
    name: str | None = Field(default=None, min_length=2, max_length=200)
    contact_person: str | None = Field(default=None, alias="contactPerson", max_length=150)
    phone: str | None = Field(default=None, min_length=6, max_length=20)
    alt_phone: str | None = Field(default=None, alias="altPhone", max_length=20)
    email: EmailStr | None = None
    gstin: str | None = Field(default=None, max_length=15)
    role: CustomerRole | None = None
    notes: str | None = None
    is_active: bool | None = Field(default=None, alias="isActive")

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v: str | None) -> str | None:
        if not v:
            return None
        value = v.strip().upper()
        if not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z\d]", value):
            raise ValueError("GSTIN is not in a valid format")
        return value


class CustomerOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    name: str
    contact_person: str | None = Field(default=None, serialization_alias="contactPerson")
    phone: str
    alt_phone: str | None = Field(default=None, serialization_alias="altPhone")
    email: str | None = None
    gstin: str | None = None
    role: CustomerRole
    is_active: bool = Field(serialization_alias="isActive")
    addresses: list[AddressOut] = Field(default_factory=list)


# --- Consignment & trip ----------------------------------------------------


class ConsignmentIn(BaseModel):
    model_config = Camel

    # Omit to have one generated. Supplied only when the transporter uses
    # their own pre-printed LR book.
    lr_number: str | None = Field(default=None, alias="lrNumber", max_length=40)

    consignor_id: uuid.UUID = Field(alias="consignorId")
    consignor_address_id: uuid.UUID = Field(alias="consignorAddressId")
    consignee_id: uuid.UUID = Field(alias="consigneeId")
    consignee_address_id: uuid.UUID = Field(alias="consigneeAddressId")

    goods_description: str = Field(alias="goodsDescription", min_length=2, max_length=500)
    hsn_code: str | None = Field(default=None, alias="hsnCode", max_length=12)
    package_count: int | None = Field(default=None, alias="packageCount", ge=0)
    package_type: str | None = Field(default=None, alias="packageType", max_length=50)
    weight_kg: float | None = Field(default=None, alias="weightKg", ge=0)
    declared_value: float | None = Field(default=None, alias="declaredValue", ge=0)
    is_fragile: bool = Field(default=False, alias="isFragile")
    is_hazardous: bool = Field(default=False, alias="isHazardous")

    eway_bill_number: str | None = Field(default=None, alias="ewayBillNumber", max_length=20)
    eway_bill_valid_until: datetime | None = Field(default=None, alias="ewayBillValidUntil")
    eway_bill_file_url: str | None = Field(default=None, alias="ewayBillFileUrl", max_length=500)
    eway_bill_file_name: str | None = Field(default=None, alias="ewayBillFileName", max_length=200)
    invoice_number: str | None = Field(default=None, alias="invoiceNumber", max_length=50)
    invoice_date: date | None = Field(default=None, alias="invoiceDate")
    invoice_file_url: str | None = Field(default=None, alias="invoiceFileUrl", max_length=500)
    invoice_file_name: str | None = Field(default=None, alias="invoiceFileName", max_length=200)

    freight_terms: FreightTerms = Field(default=FreightTerms.TO_PAY, alias="freightTerms")
    freight_amount: float | None = Field(default=None, alias="freightAmount", ge=0)
    advance_amount: float | None = Field(default=None, alias="advanceAmount", ge=0)
    special_instructions: str | None = Field(default=None, alias="specialInstructions")


class TripIn(BaseModel):
    model_config = Camel
    vehicle_id: uuid.UUID | None = Field(default=None, alias="vehicleId")
    driver_id: uuid.UUID | None = Field(default=None, alias="driverId")
    device_id: uuid.UUID | None = Field(default=None, alias="deviceId")
    scheduled_start: datetime = Field(alias="scheduledStart")
    scheduled_end: datetime | None = Field(default=None, alias="scheduledEnd")
    route_index: int = Field(default=0, alias="routeIndex", ge=0, le=5)
    notes: str | None = None


class BookingIn(BaseModel):
    """Create the consignment and its first trip in one call.

    Booking is atomic on purpose: a consignment without a trip is a dangling
    obligation, and an LR number burned on a failed booking cannot be reused.
    """

    model_config = Camel
    consignment: ConsignmentIn
    trip: TripIn
    # The checkbox: send both tracking links immediately on submit.
    notify_on_create: bool = Field(default=False, alias="notifyOnCreate")


class AlertOut(BaseModel):
    severity: str
    subject_type: str = Field(serialization_alias="subjectType")
    subject_id: str = Field(serialization_alias="subjectId")
    subject_label: str = Field(serialization_alias="subjectLabel")
    document: str
    message: str
    expires_on: date | None = Field(default=None, serialization_alias="expiresOn")
    days_remaining: int | None = Field(default=None, serialization_alias="daysRemaining")


class TrackingLinkOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    party: TrackingParty
    token: str
    url: str
    revoked: bool
    view_count: int = Field(serialization_alias="viewCount")
    last_viewed_at: datetime | None = Field(default=None, serialization_alias="lastViewedAt")
    expires_at: datetime | None = Field(default=None, serialization_alias="expiresAt")


class RouteOption(BaseModel):
    index: int
    label: str
    distance_meters: float | None = Field(default=None, serialization_alias="distanceMeters")
    duration_seconds: float | None = Field(default=None, serialization_alias="durationSeconds")
    summary: str | None = None
    geometry: dict | None = None


class TripOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    status: TripStatus
    scheduled_start: datetime = Field(serialization_alias="scheduledStart")
    scheduled_end: datetime | None = Field(default=None, serialization_alias="scheduledEnd")
    actual_start: datetime | None = Field(default=None, serialization_alias="actualStart")
    actual_end: datetime | None = Field(default=None, serialization_alias="actualEnd")
    vehicle_id: uuid.UUID | None = Field(default=None, serialization_alias="vehicleId")
    driver_id: uuid.UUID | None = Field(default=None, serialization_alias="driverId")
    device_id: uuid.UUID | None = Field(default=None, serialization_alias="deviceId")
    route_distance_m: float | None = Field(default=None, serialization_alias="routeDistanceM")
    route_duration_s: float | None = Field(default=None, serialization_alias="routeDurationS")
    route_summary: str | None = Field(default=None, serialization_alias="routeSummary")
    notes: str | None = None


class ConsignmentOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    lr_number: str = Field(serialization_alias="lrNumber")
    status: ConsignmentStatus
    goods_description: str = Field(serialization_alias="goodsDescription")
    weight_kg: float | None = Field(default=None, serialization_alias="weightKg")
    declared_value: float | None = Field(default=None, serialization_alias="declaredValue")
    eway_bill_number: str | None = Field(default=None, serialization_alias="ewayBillNumber")
    eway_bill_valid_until: datetime | None = Field(default=None, serialization_alias="ewayBillValidUntil")
    eway_bill_file_url: str | None = Field(default=None, serialization_alias="ewayBillFileUrl")
    invoice_number: str | None = Field(default=None, serialization_alias="invoiceNumber")
    invoice_file_url: str | None = Field(default=None, serialization_alias="invoiceFileUrl")
    freight_terms: FreightTerms = Field(serialization_alias="freightTerms")
    freight_amount: float | None = Field(default=None, serialization_alias="freightAmount")
    created_at: datetime = Field(serialization_alias="createdAt")


class BookingOut(BaseModel):
    consignment: ConsignmentOut
    trip: TripOut
    links: list[TrackingLinkOut]
    alerts: list[AlertOut]
    dispatch_ok: bool = Field(serialization_alias="dispatchOk")
    # What actually went out, per party and channel. Reported rather than
    # assumed: "we sent the link" is exactly the claim that gets disputed.
    deliveries: list[dict] = Field(default_factory=list)
    # False when no tracking phone could be resolved — the trip exists but the
    # driver's app will not show it, and the dispatcher must be told.
    driver_notified: bool = Field(default=False, serialization_alias="driverNotified")
    # False when the routing provider was unreachable; the trip is saved but
    # carries no distance, ETA or line on the map.
    route_available: bool = Field(default=True, serialization_alias="routeAvailable")


class TripPatchIn(BaseModel):
    """Partial update. Only the fields actually sent are applied, so an edit
    form that omits a field leaves it alone rather than blanking it."""

    model_config = Camel
    vehicle_id: uuid.UUID | None = Field(default=None, alias="vehicleId")
    driver_id: uuid.UUID | None = Field(default=None, alias="driverId")
    device_id: uuid.UUID | None = Field(default=None, alias="deviceId")
    scheduled_start: datetime | None = Field(default=None, alias="scheduledStart")
    scheduled_end: datetime | None = Field(default=None, alias="scheduledEnd")
    notes: str | None = None


class ConsignmentPatchIn(BaseModel):
    """Partial update. The LR number is absent on purpose — it is the
    document's identity, not a mutable field."""

    model_config = Camel
    goods_description: str | None = Field(
        default=None, alias="goodsDescription", min_length=2, max_length=500
    )
    hsn_code: str | None = Field(default=None, alias="hsnCode", max_length=12)
    package_count: int | None = Field(default=None, alias="packageCount", ge=0)
    package_type: str | None = Field(default=None, alias="packageType", max_length=50)
    weight_kg: float | None = Field(default=None, alias="weightKg", ge=0)
    declared_value: float | None = Field(default=None, alias="declaredValue", ge=0)
    is_fragile: bool | None = Field(default=None, alias="isFragile")
    is_hazardous: bool | None = Field(default=None, alias="isHazardous")
    eway_bill_number: str | None = Field(default=None, alias="ewayBillNumber", max_length=20)
    eway_bill_valid_until: datetime | None = Field(default=None, alias="ewayBillValidUntil")
    eway_bill_file_url: str | None = Field(default=None, alias="ewayBillFileUrl", max_length=500)
    eway_bill_file_name: str | None = Field(default=None, alias="ewayBillFileName", max_length=200)
    invoice_number: str | None = Field(default=None, alias="invoiceNumber", max_length=50)
    invoice_date: date | None = Field(default=None, alias="invoiceDate")
    invoice_file_url: str | None = Field(default=None, alias="invoiceFileUrl", max_length=500)
    invoice_file_name: str | None = Field(default=None, alias="invoiceFileName", max_length=200)
    freight_terms: FreightTerms | None = Field(default=None, alias="freightTerms")
    freight_amount: float | None = Field(default=None, alias="freightAmount", ge=0)
    advance_amount: float | None = Field(default=None, alias="advanceAmount", ge=0)
    special_instructions: str | None = Field(default=None, alias="specialInstructions")


class SendLinkIn(BaseModel):
    model_config = Camel
    party: TrackingParty
    channel: str = Field(pattern="^(email|sms|whatsapp)$")
    # Override the stored contact when the customer gives a different one.
    recipient: str | None = None


class PodIn(BaseModel):
    model_config = Camel
    receiver_name: str = Field(alias="receiverName", min_length=2, max_length=150)
    receiver_phone: str | None = Field(default=None, alias="receiverPhone", max_length=20)
    otp: str | None = Field(default=None, max_length=8)
    notes: str | None = None


# --- Organization letterhead & settings ------------------------------------


class OrgSettingsIn(BaseModel):
    """Everything a valid consignment note or freight bill needs in its header.

    All optional so a tenant can fill it in over time, but the LR generator
    warns when the statutory fields (legal name, GSTIN, address) are missing —
    a bill without them is not a document a checkpoint will accept.
    """

    model_config = Camel
    name: str | None = Field(default=None, min_length=2, max_length=200)
    legal_name: str | None = Field(default=None, alias="legalName", max_length=200)
    gstin: str | None = Field(default=None, max_length=15)
    pan: str | None = Field(default=None, max_length=10)
    address_line: str | None = Field(default=None, alias="addressLine", max_length=300)
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    pincode: str | None = Field(default=None, max_length=10)
    phone: str | None = Field(default=None, max_length=20)
    email: EmailStr | None = None
    transporter_id: str | None = Field(default=None, alias="transporterId", max_length=20)
    logo_url: str | None = Field(default=None, alias="logoUrl", max_length=500)
    lr_terms: str | None = Field(default=None, alias="lrTerms", max_length=2000)

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v: str | None) -> str | None:
        if not v:
            return None
        value = v.strip().upper()
        if not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z\d]", value):
            raise ValueError("GSTIN is not in a valid format")
        return value


class OrgSettingsOut(BaseModel):
    model_config = FromORM
    id: uuid.UUID
    name: str
    legal_name: str | None = Field(default=None, serialization_alias="legalName")
    gstin: str | None = None
    pan: str | None = None
    address_line: str | None = Field(default=None, serialization_alias="addressLine")
    city: str | None = None
    state: str | None = None
    pincode: str | None = None
    phone: str | None = None
    email: str | None = None
    transporter_id: str | None = Field(default=None, serialization_alias="transporterId")
    logo_url: str | None = Field(default=None, serialization_alias="logoUrl")
    lr_terms: str | None = Field(default=None, serialization_alias="lrTerms")
    # True once the fields a legal consignment note requires are present.
    letterhead_ready: bool = Field(default=False, serialization_alias="letterheadReady")
