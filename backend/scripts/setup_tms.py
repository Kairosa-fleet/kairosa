#!/usr/bin/env python
"""Set up a realistic transport company end to end.

Mirrors exactly what a new manager would do on day one:
  1. wipe everything (empty system)
  2. add 3 vehicles with their compliance documents
  3. add 3 drivers with licences and documents
  4. add customers with geocoded addresses
  5. book 2 consignments on different days, with routes and tracking links

Every address is geocoded live and every route comes from the router — none
of the coordinates are hardcoded, so the map data is real.

    python scripts/setup_tms.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, ".")

from sqlalchemy import delete  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.models.organization import Organization  # noqa: E402

ORG = "Vediya Transport"
EMAIL = "pritam@example.com"
PASSWORD = "correct-horse-battery-1"

BASE = "http://127.0.0.1:8000"
AUTH: dict[str, str] = {}


def call(method: str, path: str, body: dict | None = None, auth: bool = True):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if auth:
        headers.update(AUTH)
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp) if resp.status != 204 else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()[:300]
        raise SystemExit(f"\n{method} {path} -> {exc.code}\n{detail}") from exc


def today_plus(days: int, hour: int = 8) -> str:
    d = datetime.now(timezone.utc) + timedelta(days=days)
    return d.replace(hour=hour, minute=0, second=0, microsecond=0).isoformat()


def iso(d: date) -> str:
    return d.isoformat()


async def wipe() -> None:
    engine = create_async_engine(settings.DATABASE_URL)
    try:
        async with engine.begin() as conn:
            await conn.execute(delete(Organization))
    finally:
        await engine.dispose()
    print("  wiped all existing data")


def geocode(query: str) -> dict:
    """Resolve an address through the app's own search endpoint."""
    from urllib.parse import quote

    results = call("GET", f"/v1/places/search?q={quote(query)}&limit=1")
    if not results:
        raise SystemExit(f"Could not geocode: {query}")
    return results[0]


def main() -> None:
    global AUTH
    print("Clearing…")
    asyncio.run(wipe())

    tokens = call(
        "POST",
        "/v1/auth/bootstrap",
        {
            "organization_name": ORG,
            "email": EMAIL,
            "password": PASSWORD,
            "full_name": "Pritam Vediya",
        },
        auth=False,
    )
    AUTH = {"Authorization": f"Bearer {tokens['accessToken']}"}
    print(f"\nOrganisation: {ORG}")

    # ---------- letterhead ----------
    # Filled so a demo consignment note prints as a valid document from the
    # first booking, with the transporter's GSTIN and registered address.
    call("PATCH", "/v1/org/settings", {
        "legalName": "Vediya Transport Company",
        "gstin": "24ABCDE1234F1Z5",
        "pan": "ABCDE1234F",
        "addressLine": "Plot 44, Transport Nagar",
        "city": "Vadodara",
        "state": "Gujarat",
        "pincode": "390019",
        "phone": "+91 98250 12345",
        "email": "office@vediyatransport.example",
        "transporterId": "88AABBCC1234D5",
        "lrTerms": (
            "Goods carried entirely at owner's risk. The company is not "
            "responsible for leakage, breakage, or loss by fire, accident or "
            "theft in transit. Disputes subject to Vadodara jurisdiction only."
        ),
    })
    print("  letterhead set (GSTIN, address, terms)")

    # ---------- vehicles ----------
    today = datetime.now(timezone.utc).date()
    vehicles_spec = [
        # One vehicle deliberately has a PUC expiring in 12 days, so the
        # compliance dashboard has something real to show on day one.
        ("RJ14GA5623", "Tata LPT 1618", "truck", 16000, 400, 300, 12),
        ("RJ14GB7788", "Ashok Leyland 1920", "truck", 19000, 250, 180, 220),
        ("RJ14GC2211", "Eicher Pro 2049", "tempo", 4500, 320, 210, 150),
    ]
    vehicles = []
    for reg, model, vtype, capacity, ins_days, fit_days, puc_days in vehicles_spec:
        v = call(
            "POST",
            "/v1/vehicles",
            {
                "registrationNumber": reg,
                "displayName": model,
                "vehicleType": vtype,
                "make": model.split()[0],
                "model": " ".join(model.split()[1:]),
                "manufactureYear": 2021,
                "bodyType": "Closed body",
                "capacityKg": capacity,
                "chassisNumber": f"MAT{reg[-6:]}CHS{capacity}",
                "engineNumber": f"ENG{reg[-4:]}{capacity}",
                "fuelType": "Diesel",
                "documents": [
                    {"docType": "rc", "number": f"RC-{reg}", "issuer": "RTO Jaipur",
                     "issuedOn": iso(today - timedelta(days=1200))},
                    {"docType": "insurance", "number": f"POL/{reg}/2026",
                     "issuer": "ICICI Lombard",
                     "expiresOn": iso(today + timedelta(days=ins_days))},
                    {"docType": "fitness", "number": f"FIT-{reg}", "issuer": "RTO Jaipur",
                     "expiresOn": iso(today + timedelta(days=fit_days))},
                    {"docType": "puc", "number": f"PUC-{reg}",
                     "expiresOn": iso(today + timedelta(days=puc_days))},
                    {"docType": "permit_national", "number": f"NP/{reg}",
                     "expiresOn": iso(today + timedelta(days=500))},
                ],
            },
        )
        vehicles.append(v)
        print(f"  vehicle: {v['registrationNumber']}  ({model})")

    # ---------- drivers ----------
    drivers_spec = [
        ("Ramesh Patel", "+919812345601", "RJ1420110012345", "HMV", 900, "B+"),
        ("Suresh Meena", "+919812345602", "RJ1420150067890", "HMV", 20, "O+"),
        ("Imran Qureshi", "+919812345603", "RJ1420180054321", "HTV", 640, "A+"),
    ]
    drivers = []
    for name, phone, dl, dl_class, dl_days, blood in drivers_spec:
        d = call(
            "POST",
            "/v1/drivers/full",
            {
                "fullName": name,
                "phone": phone,
                "employeeCode": f"EMP-{len(drivers) + 1:03d}",
                "licenceNumber": dl,
                "licenceClass": dl_class,
                "licenceIssuingRto": "RTO Jaipur (RJ14)",
                "licenceExpiresOn": iso(today + timedelta(days=dl_days)),
                "dateOfBirth": iso(date(1988, 6, 14)),
                "bloodGroup": blood,
                "address": "Jaipur, Rajasthan",
                "emergencyContactName": "Family contact",
                "emergencyContactPhone": "+919812300000",
                "aadhaarLast4": f"{4000 + len(drivers)}",
                "panNumber": f"ABCDE{1000 + len(drivers)}F",
                "joinedOn": iso(today - timedelta(days=500)),
                "documents": [
                    {"docType": "driving_licence", "number": dl,
                     "expiresOn": iso(today + timedelta(days=dl_days))},
                    {"docType": "police_verification", "number": f"PV-{len(drivers) + 1}",
                     "expiresOn": iso(today + timedelta(days=400))},
                    {"docType": "medical_certificate", "number": f"MED-{len(drivers) + 1}",
                     "expiresOn": iso(today + timedelta(days=300))},
                ],
            },
        )
        drivers.append(d)
        print(f"  driver : {d['fullName']}  (DL {dl_class}, expires in {dl_days}d)")

    # ---------- tracking phones ----------
    # One per vehicle, bound to that vehicle's driver. Without this a booked
    # trip never reaches anybody's phone: the driver's app lists trips by
    # device, so a fleet with no enrolled handsets shows every driver an empty
    # schedule and every customer a tracking page with no vehicle on it.
    for vehicle, driver in zip(vehicles, drivers):
        device = call(
            "POST",
            "/v1/devices",
            {
                "vehicleId": vehicle["id"],
                "driverId": driver["id"],
                "label": f"{vehicle['registrationNumber']} — {driver['fullName']}",
            },
        )
        # Provision it immediately so the demo fleet is live rather than
        # sitting in "pending" forever.
        call(
            "POST",
            "/v1/devices/provision",
            {
                "enrollmentCode": device["enrollmentCode"],
                "platform": "android",
                "model": "Redmi Note 12",
            },
            auth=False,
        )
        print(f"  phone  : {device['label']}")

    # ---------- customers, with live geocoding ----------
    def make_customer(name, person, phone, email, gstin, query, label):
        place = geocode(query)
        c = call(
            "POST",
            "/v1/customers",
            {
                "name": name,
                "contactPerson": person,
                "phone": phone,
                "email": email,
                "gstin": gstin,
                "role": "both",
                "addresses": [
                    {
                        "label": label,
                        "line1": place["placeName"][:240],
                        "city": place.get("city"),
                        "state": place.get("state"),
                        "pincode": place.get("pincode"),
                        "latitude": place["latitude"],
                        "longitude": place["longitude"],
                        "placeName": place["placeName"][:390],
                        "contactPerson": person,
                        "contactPhone": phone,
                    }
                ],
            },
        )
        print(f"  customer: {c['name']:26} @ {place['placeName'][:44]}")
        return c

    sender = make_customer(
        "Rajasthan Marble Works", "Mahesh Sharma", "+919810000001",
        "mahesh@rajmarble.example.com", "08AAACR1234A1ZK",
        "Sitapura Industrial Area Jaipur", "Factory gate",
    )
    receiver_a = make_customer(
        "Gujarat Ceramics Pvt Ltd", "Nilesh Patel", "+919810000002",
        "nilesh@gujceramics.example.com", "24AAACG5678B1ZQ",
        "Ajmer Rajasthan", "Warehouse",
    )
    receiver_b = make_customer(
        "Delhi Hardware Traders", "Vikram Singh", "+919810000003",
        "vikram@delhihardware.example.com", "07AAACD9012C1ZR",
        "Udaipur Rajasthan", "Godown",
    )

    # ---------- bookings ----------
    print("\n  suggested next LR numbers:",
          ", ".join(call("GET", "/v1/consignments/next-numbers?count=3")["suggestions"]))

    devices = call("GET", "/v1/devices")
    device_id = devices[0]["id"] if devices else None

    bookings = [
        (
            "Trip 1 — tomorrow",
            sender, receiver_a, vehicles[0], drivers[0], 1,
            "Polished marble slabs", "6802", 120, "Crates", 14500.0, 480000.0,
            "EWB291847562931",
        ),
        (
            "Trip 2 — in 3 days",
            sender, receiver_b, vehicles[1], drivers[2], 3,
            "Ceramic floor tiles", "6907", 400, "Boxes", 18200.0, 320000.0,
            "EWB552910384766",
        ),
    ]

    for (title, consignor, consignee, vehicle, driver, day_offset,
         goods, hsn, packages, ptype, weight, value, ewb) in bookings:
        result = call(
            "POST",
            "/v1/bookings",
            {
                "consignment": {
                    "consignorId": consignor["id"],
                    "consignorAddressId": consignor["addresses"][0]["id"],
                    "consigneeId": consignee["id"],
                    "consigneeAddressId": consignee["addresses"][0]["id"],
                    "goodsDescription": goods,
                    "hsnCode": hsn,
                    "packageCount": packages,
                    "packageType": ptype,
                    "weightKg": weight,
                    "declaredValue": value,
                    "ewayBillNumber": ewb,
                    "ewayBillValidUntil": today_plus(day_offset + 3, 23),
                    "invoiceNumber": f"INV-{2600 + day_offset}",
                    "invoiceDate": iso(today),
                    "freightTerms": "to_pay",
                    "freightAmount": 28000.0,
                    "advanceAmount": 8000.0,
                    "specialInstructions": "Handle with care. Call receiver 1 hour before arrival.",
                },
                "trip": {
                    "vehicleId": vehicle["id"],
                    "driverId": driver["id"],
                    # Only the enrolled phone can actually report position, so
                    # the first booking gets it; the second is unassigned,
                    # which is realistic for a future-dated trip.
                    "deviceId": device_id if day_offset == 1 else None,
                    "scheduledStart": today_plus(day_offset),
                    "routeIndex": 0,
                },
                # Explicitly false: automated sending is switched off, and the
                # dispatcher shares the links manually.
                "notifyOnCreate": False,
            },
        )
        c, t = result["consignment"], result["trip"]
        print(f"\n  {title}")
        print(f"    LR        : {c['lrNumber']}")
        print(f"    route     : {t.get('routeSummary')}  "
              f"{(t.get('routeDistanceM') or 0) / 1000:.0f} km / "
              f"{(t.get('routeDurationS') or 0) / 3600:.1f} h")
        print(f"    vehicle   : {vehicle['registrationNumber']}   driver: {driver['fullName']}")
        print(f"    dispatch  : {'OK' if result['dispatchOk'] else 'BLOCKED'}"
              f"  ({len(result['alerts'])} alert(s))")
        for a in result["alerts"][:3]:
            print(f"       - [{a['severity']}] {a['message']}")
        for link in result["links"]:
            print(f"    {link['party']:10}: {link['url']}")

    alerts = call("GET", "/v1/compliance/alerts")
    print(f"\n  fleet-wide compliance alerts: {len(alerts)}")
    for a in alerts[:5]:
        print(f"    [{a['severity']:8}] {a['subjectLabel']:16} {a['message']}")

    print(f"\nDashboard: {EMAIL} / {PASSWORD}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=BASE)
    args = parser.parse_args()
    BASE = args.base_url.rstrip("/")
    main()
