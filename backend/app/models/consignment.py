"""Consignment (the LR / GC note) and the Trip that carries it.

Two separate things on purpose:
  * A **consignment** is the commercial and legal object — who is sending
    what to whom, under which e-way bill, at what freight. It is the document
    a GST officer or a court cares about.
  * A **trip** is the physical execution — this vehicle, this driver, on this
    date, along this route.

Keeping them apart means a consignment can be re-assigned to a different
vehicle after a breakdown without rewriting its legal identity, and the LR
number stays stable for the customer.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.customer import Address, Customer


class FreightTerms(str, enum.Enum):
    PAID = "paid"        # consignor pays at booking
    TO_PAY = "to_pay"    # consignee pays on delivery
    TBB = "tbb"          # to be billed to a monthly account


class ConsignmentStatus(str, enum.Enum):
    DRAFT = "draft"
    BOOKED = "booked"
    IN_TRANSIT = "in_transit"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"


class TripStatus(str, enum.Enum):
    PLANNED = "planned"            # created, nothing assigned yet
    ASSIGNED = "assigned"          # vehicle + driver set, not started
    STARTED = "started"            # driver went on duty
    IN_TRANSIT = "in_transit"      # moving
    AT_DESTINATION = "at_destination"  # inside the delivery geofence
    DELIVERED = "delivered"        # POD captured
    CANCELLED = "cancelled"


class TrackingParty(str, enum.Enum):
    CONSIGNOR = "consignor"
    CONSIGNEE = "consignee"


class NotifyChannel(str, enum.Enum):
    EMAIL = "email"
    SMS = "sms"
    WHATSAPP = "whatsapp"
    MANUAL = "manual"


class NotifyStatus(str, enum.Enum):
    QUEUED = "queued"
    SENT = "sent"
    FAILED = "failed"
    SKIPPED = "skipped"


class Consignment(Base):
    __tablename__ = "consignments"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Human-facing identity, e.g. "VT/2026/000001". Generated server-side from
    # a per-organization counter so it is unique and never reused — a repeated
    # LR number makes two shipments indistinguishable in a dispute.
    lr_number: Mapped[str] = mapped_column(String(40), nullable=False)

    # --- parties ---
    consignor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False
    )
    consignor_address_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("addresses.id", ondelete="RESTRICT"), nullable=False
    )
    consignee_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False
    )
    consignee_address_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("addresses.id", ondelete="RESTRICT"), nullable=False
    )

    # --- goods ---
    goods_description: Mapped[str] = mapped_column(String(500), nullable=False)
    hsn_code: Mapped[str | None] = mapped_column(String(12), nullable=True)
    package_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    package_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    weight_kg: Mapped[float | None] = mapped_column(Float, nullable=True)
    declared_value: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    is_fragile: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_hazardous: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # --- statutory ---
    # Mandatory in India for consignments above ₹50,000. Its validity expires
    # by distance/time, and an expired e-way bill means detention — which is
    # why the expiry is stored and checked, not just the number.
    eway_bill_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    eway_bill_valid_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # The scans a checkpoint actually asks the driver to produce. Kept beside
    # the numbers, exactly like a vehicle's insurance certificate — a number
    # with no document is not something you can show at a naka.
    eway_bill_file_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    eway_bill_file_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    invoice_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    invoice_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    invoice_file_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    invoice_file_name: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # --- money ---
    freight_terms: Mapped[FreightTerms] = mapped_column(
        Enum(FreightTerms, name="freight_terms", values_callable=lambda e: [m.value for m in e]),
        nullable=False,
        default=FreightTerms.TO_PAY,
    )
    freight_amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    advance_amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)

    status: Mapped[ConsignmentStatus] = mapped_column(
        Enum(
            ConsignmentStatus,
            name="consignment_status",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=ConsignmentStatus.BOOKED,
        index=True,
    )
    special_instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    consignor: Mapped[Customer] = relationship(foreign_keys=[consignor_id])
    consignee: Mapped[Customer] = relationship(foreign_keys=[consignee_id])
    consignor_address: Mapped[Address] = relationship(foreign_keys=[consignor_address_id])
    consignee_address: Mapped[Address] = relationship(foreign_keys=[consignee_address_id])
    trips: Mapped[list[Trip]] = relationship(
        back_populates="consignment", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("organization_id", "lr_number", name="uq_lr_per_org"),
    )


class Trip(Base):
    __tablename__ = "trips"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    consignment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("consignments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    vehicle_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("vehicles.id", ondelete="SET NULL"), nullable=True
    )
    driver_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("drivers.id", ondelete="SET NULL"), nullable=True
    )
    # The phone that will actually report position for this trip.
    device_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("devices.id", ondelete="SET NULL"), nullable=True
    )

    scheduled_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    scheduled_end: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    actual_start: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    actual_end: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    status: Mapped[TripStatus] = mapped_column(
        Enum(TripStatus, name="trip_status", values_callable=lambda e: [m.value for m in e]),
        nullable=False,
        default=TripStatus.PLANNED,
        index=True,
    )

    # Chosen route. Alternatives are kept so a dispatcher can see what was
    # rejected, and so "driver went a different way" is answerable.
    route_distance_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    route_duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    route_geometry: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    route_alternatives: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    route_summary: Mapped[str | None] = mapped_column(String(200), nullable=True)

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    consignment: Mapped[Consignment] = relationship(back_populates="trips")
    tracking_links: Mapped[list[TrackingLink]] = relationship(
        back_populates="trip", cascade="all, delete-orphan", lazy="selectin"
    )
    pod: Mapped[ProofOfDelivery | None] = relationship(
        back_populates="trip", cascade="all, delete-orphan", uselist=False
    )

    __table_args__ = (
        Index("ix_trips_org_scheduled", "organization_id", "scheduled_start"),
    )


class TrackingLink(Base):
    """A public, no-login tracking URL for one party.

    One row per party rather than a single shared link, so the consignor's
    access can be revoked without cutting off the consignee — and so views can
    be attributed.
    """

    __tablename__ = "tracking_links"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    trip_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("trips.id", ondelete="CASCADE"), nullable=False, index=True
    )
    party: Mapped[TrackingParty] = mapped_column(
        Enum(
            TrackingParty,
            name="tracking_party",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    # High-entropy and unguessable: this is the only thing protecting the
    # link, since there is no login.
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_viewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    trip: Mapped[Trip] = relationship(back_populates="tracking_links")
    notifications: Mapped[list[NotificationLog]] = relationship(
        back_populates="link", cascade="all, delete-orphan"
    )

    __table_args__ = (
        UniqueConstraint("trip_id", "party", name="uq_tracking_link_party"),
    )


class NotificationLog(Base):
    """Every send attempt, so "we told the customer" is provable."""

    __tablename__ = "notification_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tracking_link_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tracking_links.id", ondelete="CASCADE"), nullable=True
    )
    trip_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("trips.id", ondelete="CASCADE"), nullable=True, index=True
    )
    channel: Mapped[NotifyChannel] = mapped_column(
        Enum(
            NotifyChannel,
            name="notify_channel",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    recipient: Mapped[str] = mapped_column(String(320), nullable=False)
    status: Mapped[NotifyStatus] = mapped_column(
        Enum(
            NotifyStatus,
            name="notify_status",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=NotifyStatus.QUEUED,
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    link: Mapped[TrackingLink | None] = relationship(back_populates="notifications")


class ProofOfDelivery(Base):
    """Closes the trip. For To-Pay freight this is also the billing trigger."""

    __tablename__ = "proof_of_delivery"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    trip_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("trips.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    receiver_name: Mapped[str] = mapped_column(String(150), nullable=False)
    receiver_phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Hashed, never stored in the clear — it is a one-time secret shared with
    # the consignee.
    otp_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    otp_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    signature_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    photo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    delivered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    trip: Mapped[Trip] = relationship(back_populates="pod")


class LrCounter(Base):
    """Per-organization LR sequence.

    A dedicated counter row rather than a global sequence: LR numbers restart
    each financial year per organization, and must be gapless-ish and never
    reused. Incremented under a row lock inside the booking transaction.
    """

    __tablename__ = "lr_counters"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    year: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_value: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
