"""LocationPing — one GPS fix. The hot table.

Mirrors the client payload one-to-one, plus server-side additions:
received_at (clock-skew detection), trust_score / integrity_flags
(anti-spoofing), and client_seq (idempotency).
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from geoalchemy2 import Geography
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ActivityType(str, enum.Enum):
    STILL = "still"
    WALKING = "walking"
    RUNNING = "running"
    CYCLING = "cycling"
    DRIVING = "driving"
    UNKNOWN = "unknown"


class NetworkStatus(str, enum.Enum):
    WIFI = "wifi"
    CELLULAR = "cellular"
    OFFLINE = "offline"
    UNKNOWN = "unknown"


class LocationPing(Base):
    __tablename__ = "location_pings"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)

    organization_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
    )
    device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("devices.id", ondelete="CASCADE"),
        nullable=False,
    )
    driver_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("drivers.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Nullable because a fix can arrive moments before a trip is marked
    # started, but ingest attaches the device's active trip whenever there is
    # one — a position with no trip is a position with no purpose.
    trip_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("trips.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # Both clocks: the device's and ours. Divergence is itself a signal.
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Idempotency: a retried batch cannot double-insert.
    client_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    # --- location ---
    # geography(Point,4326) gives true metre distances without projecting.
    geom: Mapped[str] = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False),
        nullable=False,
    )
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    accuracy_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    altitude_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    altitude_accuracy_m: Mapped[float | None] = mapped_column(Float, nullable=True)

    # --- movement ---
    speed_mps: Mapped[float | None] = mapped_column(Float, nullable=True)
    bearing_deg: Mapped[float | None] = mapped_column(Float, nullable=True)
    activity: Mapped[ActivityType] = mapped_column(
        Enum(
            ActivityType,
            name="activity_type",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=ActivityType.UNKNOWN,
    )

    # --- device state ---
    battery_level: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_charging: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    network_status: Mapped[NetworkStatus] = mapped_column(
        Enum(
            NetworkStatus,
            name="network_status",
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
        default=NetworkStatus.UNKNOWN,
    )
    is_mock_location: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )

    # --- integrity (server-computed; never client-supplied) ---
    trust_score: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    integrity_flags: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )

    source_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)

    __table_args__ = (
        # Idempotency guard — the reason a retried batch is safe.
        UniqueConstraint("device_id", "client_seq", name="uq_ping_device_seq"),
        # Latest-position and history queries.
        Index("ix_pings_device_recorded", "device_id", "recorded_at"),
        Index("ix_pings_org_recorded", "organization_id", "recorded_at"),
        # Geofencing / spatial search.
        Index("ix_pings_geom", "geom", postgresql_using="gist"),
    )
