"""Driver compliance documents.

Separate table rather than columns on `drivers` because a driver accumulates
documents over time (renewed licence, new medical), and the history matters
in a dispute.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
    Date,
    DateTime,
    Enum,
    ForeignKey,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class DriverDocType(str, enum.Enum):
    DRIVING_LICENCE = "driving_licence"
    AADHAAR = "aadhaar"
    PAN = "pan"
    POLICE_VERIFICATION = "police_verification"
    MEDICAL_CERTIFICATE = "medical_certificate"
    ADDRESS_PROOF = "address_proof"
    PHOTO = "photo"
    OTHER = "other"


class DriverDocument(Base):
    __tablename__ = "driver_documents"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    driver_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("drivers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    doc_type: Mapped[DriverDocType] = mapped_column(
        Enum(
            DriverDocType,
            name="driver_doc_type",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    # Identity numbers are stored as given except Aadhaar — see the schema
    # layer, which keeps only the last 4 digits. Storing full Aadhaar creates
    # a legal obligation under the Aadhaar Act that this product does not need.
    number: Mapped[str | None] = mapped_column(String(80), nullable=True)
    issuer: Mapped[str | None] = mapped_column(String(120), nullable=True)
    issued_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    expires_on: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    file_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Display only — the stored file is named by UUID and this never builds a path.
    file_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    driver = relationship("Driver", back_populates="documents")
