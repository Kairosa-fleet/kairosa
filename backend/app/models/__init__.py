"""ORM models. Importing this package registers every table on Base.metadata."""

from app.models.consignment import (
    Consignment,
    ConsignmentStatus,
    FreightTerms,
    LrCounter,
    NotificationLog,
    NotifyChannel,
    NotifyStatus,
    ProofOfDelivery,
    TrackingLink,
    TrackingParty,
    Trip,
    TripStatus,
)
from app.models.customer import Address, Customer, CustomerRole
from app.models.device import Device, DeviceStatus
from app.models.driver import Driver
from app.models.driver_documents import DriverDocType, DriverDocument
from app.models.organization import Organization
from app.models.ping import ActivityType, LocationPing, NetworkStatus
from app.models.user import User, UserRole
from app.models.vehicle import Vehicle, VehicleDocType, VehicleDocument, VehicleType

__all__ = [
    "ActivityType", "Address", "Consignment", "ConsignmentStatus", "Customer",
    "CustomerRole", "Device", "DeviceStatus", "Driver", "DriverDocType",
    "DriverDocument", "FreightTerms", "LocationPing", "LrCounter",
    "NetworkStatus", "NotificationLog", "NotifyChannel", "NotifyStatus",
    "Organization", "ProofOfDelivery", "TrackingLink", "TrackingParty", "Trip",
    "TripStatus", "User", "UserRole", "Vehicle", "VehicleDocType",
    "VehicleDocument", "VehicleType",
]
