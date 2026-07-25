#!/usr/bin/env python
"""Seed a demo fleet with live data.

Idempotent: drops the demo organisation (cascading to its devices and pings)
and rebuilds it, so running it repeatedly gives a fresh, currently-live fleet
rather than accumulating duplicates.

    python scripts/seed_demo.py [--base-url http://localhost:8000]

Login afterwards with demo@example.com / correct-horse-battery-1
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, ".")

from sqlalchemy import delete, select  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.models.organization import Organization  # noqa: E402

DEMO_EMAIL = "demo@example.com"
DEMO_PASSWORD = "correct-horse-battery-1"
DEMO_ORG = "Vadodara Logistics"

# Vadodara, with routes radiating outwards so the fleet is visibly spread.
FLEET = [
    #  label,                        lat,     lon,      bearing, behaviour
    ("Truck 01 — GJ 06 AB 1234", 22.3072, 73.1812, 45, "clean"),
    ("Truck 02 — GJ 06 CD 5678", 22.3305, 73.1650, 180, "clean"),
    ("Van 03 — GJ 06 EF 9012", 22.2850, 73.2100, 90, "low_battery"),
    ("Truck 04 — GJ 06 GH 3456", 22.3500, 73.2300, 270, "spoofed"),
    ("Van 05 — GJ 06 IJ 7890", 22.2600, 73.1400, 0, "parked"),
]


def post(base: str, path: str, body: dict, headers: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


async def drop_demo_org() -> None:
    """Remove the previous demo tenant so the seed stays idempotent."""
    engine = create_async_engine(settings.DATABASE_URL)
    try:
        async with engine.begin() as conn:
            result = await conn.execute(
                select(Organization.id).where(Organization.name == DEMO_ORG)
            )
            ids = [row[0] for row in result]
            if ids:
                await conn.execute(
                    delete(Organization).where(Organization.id.in_(ids))
                )
                print(f"removed {len(ids)} previous demo organisation(s)")
    finally:
        await engine.dispose()


def seed(base: str) -> None:
    tokens = post(
        base,
        "/v1/auth/bootstrap",
        {
            "organization_name": DEMO_ORG,
            "email": DEMO_EMAIL,
            "password": DEMO_PASSWORD,
            "full_name": "Pritam Vediya",
        },
    )
    auth = {"Authorization": f"Bearer {tokens['accessToken']}"}
    print(f"created organisation '{DEMO_ORG}'")

    for name in ("Ramesh Patel", "Suresh Shah", "Imran Qureshi"):
        post(base, "/v1/drivers", {"fullName": name}, auth)
    print("created 3 drivers")

    now = datetime.now(timezone.utc)

    for label, lat, lon, bearing, behaviour in FLEET:
        device = post(base, "/v1/devices", {"label": label}, auth)
        provisioned = post(
            base,
            "/v1/devices/provision",
            {
                "enrollmentCode": device["enrollmentCode"],
                "platform": "android",
                "model": "Redmi Note 12",
                "osVersion": "14",
            },
        )
        dev_headers = {"X-Device-Token": provisioned["deviceToken"]}
        post(
            base,
            "/v1/devices/me/duty",
            {"onDuty": behaviour != "parked"},
            dev_headers,
        )

        pings = []
        count = 30
        for i in range(count):
            # Newest ping is only a few seconds old, so the fleet reads as live.
            seconds_ago = (count - 1 - i) * 12 + 3
            stamp = now - timedelta(seconds=seconds_ago)

            travelled = 0.0 if behaviour == "parked" else 0.0016 * i
            latitude = lat + travelled * math.cos(math.radians(bearing))
            longitude = lon + travelled * math.sin(math.radians(bearing)) / math.cos(
                math.radians(lat)
            )
            speed = 0.15 if behaviour == "parked" else random.uniform(9.0, 19.0)
            battery = 0.11 if behaviour == "low_battery" else max(0.2, 0.92 - i * 0.007)

            pings.append(
                {
                    "deviceId": provisioned["deviceId"],
                    "driverId": None,
                    "timestamp": stamp.isoformat(),
                    "clientSeq": i,
                    "location": {
                        "latitude": round(latitude, 6),
                        "longitude": round(longitude, 6),
                        "accuracy": round(random.uniform(3.2, 8.7), 1),
                        "altitude": round(random.uniform(28, 48), 1),
                        "altitudeAccuracy": 1.5,
                    },
                    "movement": {
                        "speed": round(speed, 2),
                        "bearing": float(bearing),
                        "activity": "still" if behaviour == "parked" else "driving",
                    },
                    "deviceState": {
                        "batteryLevel": round(battery, 3),
                        "isCharging": behaviour != "low_battery" and i % 11 == 0,
                        "networkStatus": "cellular",
                        # Only the final fix trips the mock-location flag, so the
                        # dashboard shows a device that has just gone suspect.
                        "isMockLocation": behaviour == "spoofed" and i == count - 1,
                    },
                }
            )

        result = post(base, "/v1/ingest/batch", {"pings": pings}, dev_headers)
        print(
            f"  {label:30} accepted={result['accepted']:3} "
            f"rejected={result['rejected']} ({behaviour})"
        )

    print(f"\nSign in at /login with {DEMO_EMAIL} / {DEMO_PASSWORD}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()

    try:
        asyncio.run(drop_demo_org())
        seed(args.base_url.rstrip("/"))
    except urllib.error.URLError as exc:
        print(f"Cannot reach the API at {args.base_url}: {exc}", file=sys.stderr)
        sys.exit(1)
