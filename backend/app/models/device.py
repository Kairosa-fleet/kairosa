"""Device — a phone running the tracking app.

Lifecycle: an admin registers the device and receives a one-time enrollment
code. The app exchanges that code for a long-lived opaque device token.
Only hashes of both are ever stored.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.driver import Driver
    from app.models.organization import Organization


class DeviceStatus(str, enum.Enum):
    PENDING = "pending"      # registered, not yet provisioned
    ACTIVE = "active"        # provisioned and allowed to ingest
    REVOKED = "revoked"      # token invalidated; ingest refused


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    driver_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("drivers.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # A phone is an accessory to a vehicle, never an entity in its own right.
    # Without this a device can enrol and appear on the live map representing
    # nothing — no registration to act on, no driver to call.
    vehicle_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("vehicles.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )

    label: Mapped[str] = mapped_column(String(200), nullable=False)
    platform: Mapped[str | None] = mapped_column(String(20), nullable=True)
    app_version: Mapped[str | None] = mapped_column(String(20), nullable=True)
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    os_version: Mapped[str | None] = mapped_column(String(50), nullable=True)

    status: Mapped[DeviceStatus] = mapped_column(
        Enum(
            DeviceStatus,
            name="device_status",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=DeviceStatus.PENDING,
        index=True,
    )

    # Credentials — hashes only, never the plaintext.
    enrollment_code_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    enrollment_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    token_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True, unique=True, index=True
    )
    token_issued_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    token_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Duty state — tracking is only expected while on duty.
    is_on_duty: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Rolling integrity reputation, updated on ingest (0-100, higher = trusted).
    trust_score: Mapped[float] = mapped_column(nullable=False, default=100.0)

    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    organization: Mapped[Organization] = relationship(back_populates="devices")
    driver: Mapped[Driver | None] = relationship(back_populates="devices")

    __table_args__ = (
        Index("ix_devices_org_status", "organization_id", "status"),
    )
