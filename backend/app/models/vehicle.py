"""Vehicle and its compliance documents.

A *vehicle* is the truck. A *device* is the phone riding in it. They are
separate because phones get swapped between vehicles, break, and get
re-enrolled — binding trips to the phone would lose history every time.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.organization import Organization


class VehicleType(str, enum.Enum):
    TRUCK = "truck"
    TEMPO = "tempo"
    TRAILER = "trailer"
    CONTAINER = "container"
    TANKER = "tanker"
    TIPPER = "tipper"
    PICKUP = "pickup"
    OTHER = "other"


class VehicleDocType(str, enum.Enum):
    """Documents a driver may be asked for at a checkpoint."""

    RC = "rc"                       # Registration Certificate
    INSURANCE = "insurance"
    PUC = "puc"                     # Pollution Under Control
    FITNESS = "fitness"             # mandatory for commercial vehicles
    PERMIT_NATIONAL = "permit_national"
    PERMIT_STATE = "permit_state"
    ROAD_TAX = "road_tax"
    OTHER = "other"


class Vehicle(Base):
    __tablename__ = "vehicles"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Stored without spaces/dashes so "GJ 06 AB 1234" and "GJ06AB1234" are the
    # same vehicle — operators type it inconsistently.
    registration_number: Mapped[str] = mapped_column(String(20), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    vehicle_type: Mapped[VehicleType] = mapped_column(
        Enum(VehicleType, name="vehicle_type", values_callable=lambda e: [m.value for m in e]),
        nullable=False,
        default=VehicleType.TRUCK,
    )
    make: Mapped[str | None] = mapped_column(String(60), nullable=True)
    model: Mapped[str | None] = mapped_column(String(60), nullable=True)
    manufacture_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    body_type: Mapped[str | None] = mapped_column(String(60), nullable=True)

    capacity_kg: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chassis_number: Mapped[str | None] = mapped_column(String(40), nullable=True)
    engine_number: Mapped[str | None] = mapped_column(String(40), nullable=True)
    fuel_type: Mapped[str | None] = mapped_column(String(20), nullable=True)

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    organization: Mapped[Organization] = relationship()
    documents: Mapped[list[VehicleDocument]] = relationship(
        back_populates="vehicle", cascade="all, delete-orphan", lazy="selectin"
    )
    images: Mapped[list[VehicleImage]] = relationship(
        back_populates="vehicle",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="VehicleImage.sort_order",
    )

    __table_args__ = (
        UniqueConstraint(
            "organization_id", "registration_number", name="uq_vehicle_reg_per_org"
        ),
    )


class VehicleImage(Base):
    """A photograph of the vehicle.

    Separate from ``VehicleDocument`` because the two answer different
    questions. A document is a certificate with a number and an expiry that
    something legal depends on; a photo has neither. Forcing them into one
    table would mean a nullable number and expiry on every image, and an image
    with no expiry silently counting as "compliant" in the alerts query.

    Kept for the ordinary reasons a transporter photographs a truck: proving
    what condition it left the yard in, identifying it in an insurance claim,
    and showing a customer what is turning up at their gate.
    """

    __tablename__ = "vehicle_images"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    vehicle_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vehicles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_url: Mapped[str] = mapped_column(String(500), nullable=False)
    file_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    caption: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # The one shown in lists and on the vehicle card. Exactly one per vehicle
    # is enforced in the API rather than by constraint, because "no primary
    # yet" is a legitimate intermediate state while a form is being filled.
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    vehicle: Mapped[Vehicle] = relationship(back_populates="images")


class VehicleDocument(Base):
    __tablename__ = "vehicle_documents"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    vehicle_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vehicles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    doc_type: Mapped[VehicleDocType] = mapped_column(
        Enum(
            VehicleDocType,
            name="vehicle_doc_type",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    number: Mapped[str | None] = mapped_column(String(80), nullable=True)
    issuer: Mapped[str | None] = mapped_column(String(120), nullable=True)
    issued_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Nullable because an RC has no expiry, but insurance/PUC/fitness do — and
    # those are what get a vehicle detained.
    expires_on: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    file_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # The name the operator's file had when they uploaded it. Display only —
    # the stored file is named by UUID, and this is never used to build a path.
    file_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    vehicle: Mapped[Vehicle] = relationship(back_populates="documents")
