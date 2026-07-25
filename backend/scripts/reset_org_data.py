#!/usr/bin/env python
"""Empty an organization's operational data, keeping the tenant and its logins.

Used to get back to a genuinely empty system — the state a manager sees on day
one — without having to re-register and re-invite the admin.

    python scripts/reset_org_data.py --keep "Vediya Transport"

What survives: the organization row and its dashboard users.
What goes: vehicles, drivers, customers, consignments, trips, tracking links,
devices, pings, and the LR counter (so numbering restarts at 000001).

Any other organization is dropped whole — those are test tenants.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

sys.path.insert(0, ".")

from sqlalchemy import delete, select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.models.consignment import (  # noqa: E402
    Consignment,
    LrCounter,
    NotificationLog,
    ProofOfDelivery,
    TrackingLink,
    Trip,
)
from app.models.customer import Address, Customer  # noqa: E402
from app.models.device import Device  # noqa: E402
from app.models.driver import Driver  # noqa: E402
from app.models.driver_documents import DriverDocument  # noqa: E402
from app.models.organization import Organization  # noqa: E402
from app.models.ping import LocationPing  # noqa: E402
from app.models.vehicle import Vehicle, VehicleDocument  # noqa: E402


async def main(keep_name: str, drop_others: bool) -> None:
    engine = create_async_engine(settings.DATABASE_URL)
    async with AsyncSession(engine) as db:
        org = (
            await db.execute(select(Organization).where(Organization.name == keep_name))
        ).scalar_one_or_none()
        if org is None:
            raise SystemExit(f"No organization named {keep_name!r}")

        if drop_others:
            others = (
                await db.execute(select(Organization).where(Organization.id != org.id))
            ).scalars().all()
            for other in others:
                print(f"  dropping tenant: {other.name}")
                await db.delete(other)
            await db.flush()

        oid = org.id

        # Order matters: consignments hold RESTRICT foreign keys onto customers
        # and addresses, so the paperwork has to go before the parties do.
        trip_ids = (
            await db.execute(select(Trip.id).where(Trip.organization_id == oid))
        ).scalars().all()
        link_ids = (
            await db.execute(
                select(TrackingLink.id).where(TrackingLink.trip_id.in_(trip_ids))
            )
        ).scalars().all() if trip_ids else []
        driver_ids = (
            await db.execute(select(Driver.id).where(Driver.organization_id == oid))
        ).scalars().all()
        vehicle_ids = (
            await db.execute(select(Vehicle.id).where(Vehicle.organization_id == oid))
        ).scalars().all()

        steps = [
            ("location pings", delete(LocationPing).where(LocationPing.organization_id == oid)),
            ("notification log", delete(NotificationLog).where(NotificationLog.trip_id.in_(trip_ids)) if trip_ids else None),
            ("tracking links", delete(TrackingLink).where(TrackingLink.id.in_(link_ids)) if link_ids else None),
            ("proof of delivery", delete(ProofOfDelivery).where(ProofOfDelivery.trip_id.in_(trip_ids)) if trip_ids else None),
            ("trips", delete(Trip).where(Trip.organization_id == oid)),
            ("consignments", delete(Consignment).where(Consignment.organization_id == oid)),
            ("addresses", delete(Address).where(Address.organization_id == oid)),
            ("customers", delete(Customer).where(Customer.organization_id == oid)),
            ("devices", delete(Device).where(Device.organization_id == oid)),
            ("driver documents", delete(DriverDocument).where(DriverDocument.driver_id.in_(driver_ids)) if driver_ids else None),
            ("drivers", delete(Driver).where(Driver.organization_id == oid)),
            ("vehicle documents", delete(VehicleDocument).where(VehicleDocument.vehicle_id.in_(vehicle_ids)) if vehicle_ids else None),
            ("vehicles", delete(Vehicle).where(Vehicle.organization_id == oid)),
            # Reset so the first new consignment is .../000001 again.
            ("LR counters", delete(LrCounter).where(LrCounter.organization_id == oid)),
        ]

        for label, stmt in steps:
            if stmt is None:
                print(f"  {0:>5}  {label}")
                continue
            result = await db.execute(stmt)
            print(f"  {result.rowcount:>5}  {label}")

        await db.commit()
        print(f"\n{keep_name} is empty. Its login still works.")

    await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", required=True, help="Organization to empty but preserve")
    parser.add_argument(
        "--keep-other-tenants",
        action="store_true",
        help="Leave other organizations alone (default: drop them)",
    )
    args = parser.parse_args()
    asyncio.run(main(args.keep, drop_others=not args.keep_other_tenants))
