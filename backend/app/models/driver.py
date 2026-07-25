"""Driver — the person operating a tracked vehicle."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.device import Device
    from app.models.organization import Organization


class Driver(Base):
    __tablename__ = "drivers"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    employee_code: Mapped[str | None] = mapped_column(String(50), nullable=True)

    # --- licence: the first thing a traffic officer asks for ---
    licence_number: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # HMV/HTV are what matter for goods vehicles; an LMV licence on a truck is
    # an offence and invalidates insurance.
    licence_class: Mapped[str | None] = mapped_column(String(30), nullable=True)
    licence_issuing_rto: Mapped[str | None] = mapped_column(String(100), nullable=True)
    licence_expires_on: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    # The scan itself. Kept on the driver rather than as a document row so the
    # licence has one source of truth — its number, class and expiry already
    # live here, and a second copy in the documents table would drift.
    licence_file_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    licence_file_name: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # --- personal / safety ---
    date_of_birth: Mapped[date | None] = mapped_column(Date, nullable=True)
    blood_group: Mapped[str | None] = mapped_column(String(5), nullable=True)
    address: Mapped[str | None] = mapped_column(String(400), nullable=True)
    emergency_contact_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    emergency_contact_phone: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Only the last 4 digits of Aadhaar are kept — storing the full number
    # creates obligations under the Aadhaar Act that this product does not need.
    aadhaar_last4: Mapped[str | None] = mapped_column(String(4), nullable=True)
    pan_number: Mapped[str | None] = mapped_column(String(10), nullable=True)
    photo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    photo_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    joined_on: Mapped[date | None] = mapped_column(Date, nullable=True)

    # --- login credentials ---
    # Issued automatically when the driver is created. A driver identity that
    # lives on the driver — not on a phone — means they can change handset,
    # borrow one, or recover a lost password without a dispatcher re-issuing
    # enrolment codes.
    login_id: Mapped[str | None] = mapped_column(
        String(20), nullable=True, unique=True, index=True
    )
    hashed_password: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # The first password is system-generated and shown once, so the driver is
    # forced to replace it with something only they know.
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    password_reset_token_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    password_reset_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    organization: Mapped[Organization] = relationship(back_populates="drivers")
    devices: Mapped[list[Device]] = relationship(back_populates="driver")
    documents = relationship(
        "DriverDocument", back_populates="driver", cascade="all, delete-orphan",
        lazy="selectin",
    )
