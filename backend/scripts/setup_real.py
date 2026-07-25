#!/usr/bin/env python
"""Set up a clean, real fleet: one organisation, one driver, one device.

Unlike seed_demo.py this inserts **no location data at all** — every ping in
the system will come from the actual phone. That is the point: what you see on
the dashboard is real, not fabricated.

Wipes any previous organisation with the same name so it can be re-run.

    python scripts/setup_real.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, ".")

from sqlalchemy import delete, select  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.models.organization import Organization  # noqa: E402

ORG_NAME = "Vediya Transport"
ADMIN_EMAIL = "pritam@example.com"
ADMIN_PASSWORD = "correct-horse-battery-1"
ADMIN_NAME = "Pritam Vediya"

DRIVER_NAME = "Pritam Vediya"
DRIVER_PHONE = "+91 98000 00000"
VEHICLE_LABEL = "Vehicle 01"


def post(base: str, path: str, body: dict, headers: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


async def wipe() -> None:
    """Remove every previous organisation, demo or real.

    Cascades to users, drivers, devices and pings, so the dashboard starts
    genuinely empty rather than showing leftovers.
    """
    engine = create_async_engine(settings.DATABASE_URL)
    try:
        async with engine.begin() as conn:
            result = await conn.execute(select(Organization.id, Organization.name))
            rows = list(result)
            if rows:
                await conn.execute(delete(Organization))
                for _, name in rows:
                    print(f"  removed organisation: {name}")
    finally:
        await engine.dispose()


def main(base: str) -> None:
    print("Clearing existing data…")
    asyncio.run(wipe())

    tokens = post(
        base,
        "/v1/auth/bootstrap",
        {
            "organization_name": ORG_NAME,
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD,
            "full_name": ADMIN_NAME,
        },
    )
    auth = {"Authorization": f"Bearer {tokens['accessToken']}"}
    print(f"\nOrganisation : {ORG_NAME}")

    driver = post(
        base, "/v1/drivers", {"fullName": DRIVER_NAME, "phone": DRIVER_PHONE}, auth
    )
    print(f"Driver       : {driver['fullName']}")

    device = post(
        base,
        "/v1/devices",
        {"label": VEHICLE_LABEL, "driverId": driver["id"]},
        auth,
    )
    print(f"Vehicle      : {device['label']}")

    print("\n" + "=" * 46)
    print("  ENROLMENT CODE FOR THE PHONE")
    print(f"      {device['enrollmentCode']}")
    print("=" * 46)
    print("\nDashboard login:")
    print(f"  {ADMIN_EMAIL}")
    print(f"  {ADMIN_PASSWORD}")
    print("\nNo location data exists yet — every point on the map will come")
    print("from the phone.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    try:
        main(args.base_url.rstrip("/"))
    except urllib.error.URLError as exc:
        print(f"Cannot reach the API at {args.base_url}: {exc}", file=sys.stderr)
        sys.exit(1)
