"""Customers (consignor / consignee) and their addresses.

Addresses are a separate table, not columns on the customer, because one
customer routinely has several pickup or delivery points — a factory, a
warehouse and a head office — and a consignment needs to name exactly one.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from geoalchemy2 import Geography
from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.organization import Organization


class CustomerRole(str, enum.Enum):
    CONSIGNOR = "consignor"
    CONSIGNEE = "consignee"
    BOTH = "both"


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    name: Mapped[str] = mapped_column(String(200), nullable=False)
    contact_person: Mapped[str | None] = mapped_column(String(150), nullable=True)
    phone: Mapped[str] = mapped_column(String(20), nullable=False)
    alt_phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)

    # Required on the consignment note when the party is GST-registered.
    gstin: Mapped[str | None] = mapped_column(String(15), nullable=True)
    role: Mapped[CustomerRole] = mapped_column(
        Enum(
            CustomerRole,
            name="customer_role",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=CustomerRole.BOTH,
    )

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    organization: Mapped[Organization] = relationship()
    addresses: Mapped[list[Address]] = relationship(
        back_populates="customer", cascade="all, delete-orphan", lazy="selectin"
    )


class Address(Base):
    __tablename__ = "addresses"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    customer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("customers.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )

    label: Mapped[str | None] = mapped_column(String(100), nullable=True)
    line1: Mapped[str] = mapped_column(String(250), nullable=False)
    line2: Mapped[str | None] = mapped_column(String(250), nullable=True)
    landmark: Mapped[str | None] = mapped_column(String(150), nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    state: Mapped[str | None] = mapped_column(String(100), nullable=True)
    pincode: Mapped[str | None] = mapped_column(String(10), nullable=True)
    country: Mapped[str] = mapped_column(String(60), nullable=False, default="India")

    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    geom: Mapped[str] = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False),
        nullable=False,
    )
    # What the geocoder called this place, kept so the operator can tell
    # whether the pin actually matches what they typed.
    place_name: Mapped[str | None] = mapped_column(String(400), nullable=True)
    # How the coordinates were arrived at: "pinned" (a human placed it),
    # "exact"/"street" (geocoded to a building or road) or "area" (a locality
    # centroid). Stored because routing a truck to the middle of an industrial
    # estate instead of its gate is a real failure, and the dispatcher should
    # be able to see which addresses have never been checked.
    precision: Mapped[str | None] = mapped_column(String(12), nullable=True)

    contact_person: Mapped[str | None] = mapped_column(String(150), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(String(20), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    customer: Mapped[Customer | None] = relationship(back_populates="addresses")

    __table_args__ = (Index("ix_addresses_geom", "geom", postgresql_using="gist"),)
