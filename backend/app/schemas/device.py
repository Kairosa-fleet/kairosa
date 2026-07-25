"""Device, driver, and tracking-view schemas."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.device import DeviceStatus


class DriverCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    full_name: str = Field(min_length=2, max_length=200, alias="fullName")
    phone: str | None = Field(default=None, max_length=20)
    employee_code: str | None = Field(
        default=None, max_length=50, alias="employeeCode"
    )


class DriverOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    full_name: str = Field(serialization_alias="fullName")
    phone: str | None = None
    employee_code: str | None = Field(
        default=None, serialization_alias="employeeCode"
    )
    is_active: bool = Field(serialization_alias="isActive")


class DeviceCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    # Required: a tracking phone belongs to a vehicle. The label is derived
    # from the vehicle's registration rather than typed.
    vehicle_id: uuid.UUID = Field(alias="vehicleId")
    label: str | None = Field(default=None, max_length=200)
    driver_id: uuid.UUID | None = Field(default=None, alias="driverId")


class DeviceRegisteredOut(BaseModel):
    """Returned once, at registration. The enrollment code is not recoverable."""

    id: uuid.UUID
    label: str
    status: DeviceStatus
    enrollment_code: str = Field(serialization_alias="enrollmentCode")
    enrollment_expires_at: datetime = Field(
        serialization_alias="enrollmentExpiresAt"
    )


class DeviceProvisionIn(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    enrollment_code: str = Field(min_length=4, max_length=32, alias="enrollmentCode")
    platform: str | None = Field(default=None, max_length=20)
    model: str | None = Field(default=None, max_length=100)
    os_version: str | None = Field(default=None, max_length=50, alias="osVersion")
    app_version: str | None = Field(default=None, max_length=20, alias="appVersion")


class DeviceProvisionOut(BaseModel):
    """Returned once, at provisioning. The token is not recoverable afterwards."""

    device_id: uuid.UUID = Field(serialization_alias="deviceId")
    device_token: str = Field(serialization_alias="deviceToken")
    organization_id: uuid.UUID = Field(serialization_alias="organizationId")
    expires_at: datetime = Field(serialization_alias="expiresAt")


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    label: str
    status: DeviceStatus
    platform: str | None = None
    model: str | None = None
    driver_id: uuid.UUID | None = Field(default=None, serialization_alias="driverId")
    # The vehicle this phone rides in, so a fleet list can show the
    # registration rather than whatever the handset happens to be called.
    vehicle_registration: str | None = Field(
        default=None, serialization_alias="vehicleRegistration"
    )
    is_on_duty: bool = Field(serialization_alias="isOnDuty")
    trust_score: float = Field(serialization_alias="trustScore")
    last_seen_at: datetime | None = Field(
        default=None, serialization_alias="lastSeenAt"
    )
    created_at: datetime = Field(serialization_alias="createdAt")


class DutyIn(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    on_duty: bool = Field(alias="onDuty")


class PositionOut(BaseModel):
    """A single position, as shown on a map."""

    device_id: uuid.UUID = Field(serialization_alias="deviceId")
    label: str | None = None
    latitude: float
    longitude: float
    accuracy_m: float | None = Field(default=None, serialization_alias="accuracy")
    speed_mps: float | None = Field(default=None, serialization_alias="speed")
    bearing_deg: float | None = Field(default=None, serialization_alias="bearing")
    activity: str | None = None
    battery_level: float | None = Field(
        default=None, serialization_alias="batteryLevel"
    )
    is_charging: bool | None = Field(default=None, serialization_alias="isCharging")
    trust_score: int | None = Field(default=None, serialization_alias="trustScore")
    integrity_flags: list[str] = Field(
        default_factory=list, serialization_alias="integrityFlags"
    )
    recorded_at: datetime = Field(serialization_alias="recordedAt")
    is_online: bool | None = Field(default=None, serialization_alias="isOnline")
