"""Ingest payload schemas — the exact contract the mobile app sends.

Matches the agreed JSON shape (camelCase on the wire, snake_case internally).
Validation here is deliberately strict: rejecting garbage at the edge is far
cheaper than removing it from the database later.
"""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.ping import ActivityType, NetworkStatus


class LocationBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0, le=100_000)
    altitude: float | None = Field(default=None, ge=-500, le=20_000)
    altitude_accuracy: float | None = Field(
        default=None, ge=0, le=100_000, alias="altitudeAccuracy"
    )


class MovementBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speed: float | None = Field(default=None, ge=0, le=1_000)
    bearing: float | None = Field(default=None, ge=0, le=360)
    activity: ActivityType = ActivityType.UNKNOWN


class DeviceStateBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    battery_level: float | None = Field(default=None, ge=0, le=1, alias="batteryLevel")
    is_charging: bool | None = Field(default=None, alias="isCharging")
    network_status: NetworkStatus = Field(
        default=NetworkStatus.UNKNOWN, alias="networkStatus"
    )
    is_mock_location: bool = Field(default=False, alias="isMockLocation")


class LocationPingIn(BaseModel):
    """One GPS fix as sent by the device."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    device_id: str | None = Field(default=None, alias="deviceId")
    driver_id: str | None = Field(default=None, alias="driverId")
    timestamp: datetime
    client_seq: int | None = Field(default=None, alias="clientSeq", ge=0)

    location: LocationBlock
    movement: MovementBlock = Field(default_factory=MovementBlock)
    device_state: DeviceStateBlock = Field(
        default_factory=DeviceStateBlock, alias="deviceState"
    )

    @field_validator("timestamp")
    @classmethod
    def _require_timezone(cls, v: datetime) -> datetime:
        # A naive timestamp is ambiguous; assume UTC rather than guessing local.
        if v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v.astimezone(timezone.utc)


class IngestBatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    pings: list[LocationPingIn] = Field(min_length=1, max_length=100)


# --- Responses ------------------------------------------------------------


class PingResult(BaseModel):
    """Per-item outcome so the app knows exactly what to purge from its outbox."""

    client_seq: int | None = Field(default=None, serialization_alias="clientSeq")
    accepted: bool
    ping_id: int | None = Field(default=None, serialization_alias="pingId")
    reason: str | None = None
    trust_score: int | None = Field(default=None, serialization_alias="trustScore")
    integrity_flags: list[str] = Field(
        default_factory=list, serialization_alias="integrityFlags"
    )


class IngestBatchOut(BaseModel):
    accepted: int
    rejected: int
    duplicates: int
    results: list[PingResult]
