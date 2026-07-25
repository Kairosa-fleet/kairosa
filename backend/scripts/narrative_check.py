#!/usr/bin/env python
"""Walk the manager's narrative end to end, taking every if/else branch.

Each step asserts what the manager would actually expect to happen, not what
the code happens to do.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone

BASE = "http://127.0.0.1:8000"
TOKEN = ""
FAILS: list[str] = []
PASSES: list[str] = []


def call(method: str, path: str, body=None, auth=True, expect=None):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {TOKEN}"} if auth and TOKEN else {}),
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"detail": raw[:300]}


def check(name: str, ok: bool, detail: str = ""):
    (PASSES if ok else FAILS).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"\n        {detail}" if detail and not ok else ""))


tag = uuid.uuid4().hex[:8]
NOW = datetime.now(timezone.utc)

print("\n=== 0. Manager signs up; the system is empty ===")
st, reg = call(
    "POST", "/v1/auth/bootstrap",
    {"organization_name": f"Narrative Transport {tag}", "email": f"mgr-{tag}@example.com",
     "password": "correct-horse-battery-1", "full_name": "Pritam"},
    auth=False,
)
if st >= 400:
    print("register failed:", st, reg)
    sys.exit(1)
st, tok = call("POST", "/v1/auth/login",
               {"email": f"mgr-{tag}@example.com", "password": "correct-horse-battery-1"}, auth=False)
TOKEN = tok["accessToken"]

st, v = call("GET", "/v1/vehicles")
check("empty system shows no vehicles", v == [])
st, t = call("GET", "/v1/trips")
check("empty system shows no trips", t == [])

print("\n=== 1. Add 3 vehicles with documents ===")
# Every mandatory document now needs its scan attached, so upload one first
# and reference it — the rule is enforced by the API, not just the form.
MINIMAL_PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"


def upload_pdf() -> str:
    boundary = "----" + uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="doc.pdf"\r\n'
        "Content-Type: application/pdf\r\n\r\n"
    ).encode() + MINIMAL_PDF + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{BASE}/v1/documents", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
                 "Authorization": f"Bearer {TOKEN}"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)["fileUrl"]


SCAN = upload_pdf()
vehicles = []
for i, (reg_no, kind) in enumerate([("GJ06AB1234", "truck"), ("GJ06CD5678", "truck"), ("GJ06EF9012", "pickup")]):
    st, veh = call("POST", "/v1/vehicles", {
        "registrationNumber": reg_no, "vehicleType": kind, "displayName": f"Truck {i+1}",
        "make": "Tata", "model": "Signa", "capacityKg": 16000,
        "documents": [
            {"docType": "rc", "number": f"RC{i}", "issuedOn": "2022-01-01", "fileUrl": SCAN},
            {"docType": "insurance", "number": f"INS{i}", "fileUrl": SCAN, "expiresOn": str(date.today() + timedelta(days=200))},
            {"docType": "puc", "number": f"PUC{i}", "fileUrl": SCAN, "expiresOn": str(date.today() + timedelta(days=90))},
            {"docType": "fitness", "number": f"FIT{i}", "fileUrl": SCAN, "expiresOn": str(date.today() + timedelta(days=300))},
        ],
    })
    if st >= 400:
        print("   vehicle create failed", st, veh)
        sys.exit(1)
    vehicles.append(veh)
check("3 vehicles added", len(vehicles) == 3)

print("\n=== 2. Add drivers with licences, and enrol a phone for each ===")
drivers, devices = [], []
for i in range(3):
    st, d = call("POST", "/v1/drivers/full", {
        "fullName": f"Driver {i+1}", "phone": f"+9198100000{i}{i}",
        "licenceNumber": f"GJ06 2019000{i}", "licenceClass": "HMV",
        "licenceExpiresOn": str(date.today() + timedelta(days=400)),
        "licenceFileUrl": SCAN,
        "documents": [
            {"docType": "police_verification", "number": f"PV{i}", "fileUrl": SCAN,
             "expiresOn": str(date.today() + timedelta(days=365))},
            {"docType": "medical_certificate", "number": f"MED{i}", "fileUrl": SCAN,
             "expiresOn": str(date.today() + timedelta(days=300))},
        ],
    })
    if st >= 400:
        print("   driver create failed", st, d)
        sys.exit(1)
    drivers.append(d)
    st, dev = call("POST", "/v1/devices", {
        "label": f"Phone {i+1}", "driverId": d["id"], "vehicleId": vehicles[i]["id"],
    })
    if st >= 400:
        print("   device create failed", st, dev)
        sys.exit(1)
    devices.append(dev)
check("3 drivers added", len(drivers) == 3)

# Bring the phones online so they are selectable/resolvable.
for dev in devices:
    code = dev.get("enrollmentCode")
    if code:
        call("POST", "/v1/devices/provision", {"enrollmentCode": code, "platform": "android"}, auth=False)

print("\n=== 3. Add customers with geocoded addresses ===")
def customer(name, phone, email, lat, lon, line1, city):
    st, c = call("POST", "/v1/customers", {
        "name": name, "phone": phone, "email": email, "contactPerson": "Mr X",
        "addresses": [{"line1": line1, "city": city, "state": "Gujarat", "pincode": "390001",
                       "latitude": lat, "longitude": lon, "label": "Godown"}],
    })
    if st >= 400:
        print("   customer create failed", st, c)
        sys.exit(1)
    return c

sender = customer("Rajesh Marbles", "+919810000101", f"sender-{tag}@example.com", 22.3072, 73.1812, "Plot 12, GIDC Makarpura", "Vadodara")
# A receiver with a phone but deliberately NO email — the manager still ticked
# "send links now", and must not be silently told nothing happened.
receiver = customer("Delhi Traders", "+919810000102", None, 28.6139, 77.2090, "Naraina Industrial Area", "New Delhi")
check("customers created with addresses", len(sender["addresses"]) == 1 and len(receiver["addresses"]) == 1)

print("\n=== 4. LR numbering: preview must not burn a number ===")
st, n1 = call("GET", "/v1/consignments/next-numbers?count=3")
st, n2 = call("GET", "/v1/consignments/next-numbers?count=3")
check("previewing twice returns the same numbers", n1["suggestions"] == n2["suggestions"],
      f"{n1['suggestions']} vs {n2['suggestions']}")

def book(lr=None, vehicle=0, driver=0, device=None, start=None, notify=False, expect_ok=True):
    body = {
        "consignment": {
            "lrNumber": lr,
            "consignorId": sender["id"], "consignorAddressId": sender["addresses"][0]["id"],
            "consigneeId": receiver["id"], "consigneeAddressId": receiver["addresses"][0]["id"],
            "goodsDescription": "Polished marble slabs", "packageCount": 120,
            "weightKg": 14500, "declaredValue": 480000,
            "ewayBillNumber": "EWB291847562931",
            "ewayBillValidUntil": (NOW + timedelta(days=6)).isoformat(),
            "freightTerms": "to_pay",
        },
        "trip": {
            "vehicleId": vehicles[vehicle]["id"] if vehicle is not None else None,
            "driverId": drivers[driver]["id"] if driver is not None else None,
            "deviceId": device,
            "scheduledStart": (start or (NOW + timedelta(days=1))).isoformat(),
            "routeIndex": 0,
        },
        "notifyOnCreate": notify,
    }
    return call("POST", "/v1/bookings", body)

print("\n=== 5. Book the first consignment ===")
st, b1 = book(start=NOW + timedelta(days=1))
check("first booking succeeds", st == 201, f"{st} {b1}")
if st != 201:
    print(json.dumps(b1, indent=2)); sys.exit(1)
check("LR number matches what was previewed", b1["consignment"]["lrNumber"] == n1["suggestions"][0],
      f"got {b1['consignment']['lrNumber']}, preview said {n1['suggestions'][0]}")
check("two tracking links issued, one per party", len(b1["links"]) == 2)
check("driver's phone was resolved from the driver (no device picked)", b1.get("driverNotified") is True,
      "driverNotified=False — the driver's app will never show this trip")

print("\n=== 6. IF the same vehicle/driver is booked over the same hours ===")
st, clash = book(vehicle=0, driver=0, start=NOW + timedelta(days=1, hours=2))
check("overlapping trip on the same truck is refused", st == 409,
      f"got {st} — the same truck was booked twice over the same hours")
check("refusal names the conflicting consignment", "already on" in str(clash.get("detail", "")),
      str(clash.get("detail")))

print("\n=== 7. ELSE a different vehicle and driver on the same day is allowed ===")
st, b2 = book(vehicle=1, driver=1, start=NOW + timedelta(days=1, hours=2))
check("second truck on the same day is accepted", st == 201, f"{st} {b2}")

print("\n=== 8. ELSE the same truck on a later day is allowed ===")
st, b3 = book(vehicle=0, driver=0, start=NOW + timedelta(days=4))
check("same truck on a different day is accepted", st == 201, f"{st} {b3}")

print("\n=== 9. Manual LR from a pre-printed book, then auto again ===")
prefix, fy, _ = b1["consignment"]["lrNumber"].split("/")
manual = f"{prefix}/{fy}/000042"
st, chk = call("GET", f"/v1/consignments/check-number?lr={manual}")
check("a far-ahead manual number reads as available", chk.get("available") is True)
st, bm = book(lr=manual, vehicle=2, driver=2, start=NOW + timedelta(days=5))
check("manual LR number is accepted", st == 201, f"{st} {bm}")

st, dup = book(lr=manual, vehicle=2, driver=2, start=NOW + timedelta(days=6))
check("re-using the same manual LR is refused", dup and "already used" in str(dup.get("detail", "")),
      str(dup.get("detail")))

# The counter must now be past 000042, so no auto number can ever collide.
seen = {b1["consignment"]["lrNumber"], bm["consignment"]["lrNumber"]}
collision = None
for i in range(6):
    st, bx = book(vehicle=i % 3, driver=i % 3, start=NOW + timedelta(days=10 + i * 2))
    if st != 201:
        collision = f"auto booking #{i} failed with {st}: {bx}"
        break
    lr = bx["consignment"]["lrNumber"]
    if lr in seen:
        collision = f"auto-generated {lr} duplicates an existing consignment"
        break
    seen.add(lr)
check("auto numbers never collide with the hand-entered one", collision is None, collision or "")

print("\n=== 10. Sharing: manager ticked 'send now' but receiver has no email ===")
st, bn = book(vehicle=1, driver=1, start=NOW + timedelta(days=30), notify=True)
check("booking with notify-on-create succeeds", st == 201, f"{st} {bn}")
if st == 201:
    deliveries = bn.get("deliveries", [])
    parties = {d["party"] for d in deliveries}
    check("an attempt is recorded for BOTH parties, not just the one with email",
          parties == {"consignor", "consignee"},
          f"only attempted for {parties or 'nobody'} — the phone-only customer was silently skipped")
    check("every attempt reports an explicit outcome",
          all(d.get("status") for d in deliveries), str(deliveries))

print("\n=== 11. Edit after submit ===")
trip_id = b1["trip"]["id"]
st, ed = call("PATCH", f"/v1/trips/{trip_id}",
              {"scheduledStart": (NOW + timedelta(days=2)).isoformat(), "notes": "Call receiver 1h before"})
check("a booked trip can be rescheduled", st == 200, f"{st} {ed}")

st, ed2 = call("PATCH", f"/v1/trips/{trip_id}", {"vehicleId": vehicles[2]["id"], "driverId": drivers[2]["id"]})
check("a trip can be reassigned to another truck and driver after a breakdown", st == 200, f"{st} {ed2}")

st, ed3 = call("PATCH", f"/v1/consignments/{b1['consignment']['id']}",
               {"weightKg": 15200, "ewayBillNumber": "EWB999999999999"})
check("consignment details can be corrected", st == 200, f"{st} {ed3}")
check("the LR number survives the edit unchanged",
      ed3.get("lrNumber") == b1["consignment"]["lrNumber"])

st, bad = call("PATCH", f"/v1/trips/{trip_id}",
               {"vehicleId": vehicles[1]["id"], "driverId": drivers[1]["id"],
                "scheduledStart": (NOW + timedelta(days=1, hours=2)).isoformat()})
check("editing a trip into a clash is refused too", bad and st == 409, f"{st} {bad}")

print("\n=== 12. Tracking links seen by the customer ===")
token = b1["links"][0]["token"]
st, pub = call("GET", f"/v1/track/{token}", auth=False)
check("the consignor's link opens with no login", st == 200, f"{st} {pub}")
check("the customer view never leaks freight amounts",
      "freightAmount" not in json.dumps(pub) and "freight" not in json.dumps(pub).lower(),
      "freight detail is visible on the public page")

st, rv = call("POST", f"/v1/trips/{trip_id}/links/consignor/revoke")
check("one party's link can be revoked alone", st == 200, f"{st} {rv}")
st, gone = call("GET", f"/v1/track/{token}", auth=False)
check("the revoked link stops working", st == 404, f"{st} {gone}")
st, still = call("GET", f"/v1/track/{b1['links'][1]['token']}", auth=False)
check("the OTHER party's link still works", still and st == 200, f"{st} {still}")

print("\n=== 13. Cancelling a trip ===")
st, cx = call("POST", f"/v1/trips/{b3['trip']['id']}/cancel")
check("a trip can be cancelled", st == 200, f"{st} {cx}")
st, ctrack = call("GET", f"/v1/track/{b3['links'][0]['token']}", auth=False)
check("a cancelled trip's tracking link no longer shows a moving truck", st == 404, f"{st} {ctrack}")
st, cedit = call("PATCH", f"/v1/trips/{b3['trip']['id']}", {"notes": "x"})
check("a cancelled trip cannot be quietly edited afterwards", st == 409, f"{st} {cedit}")

print("\n=== 14. Nonsense the manager could plausibly enter ===")
st, same = call("POST", "/v1/bookings", {
    "consignment": {
        "consignorId": sender["id"], "consignorAddressId": sender["addresses"][0]["id"],
        "consigneeId": sender["id"], "consigneeAddressId": sender["addresses"][0]["id"],
        "goodsDescription": "Nothing", "freightTerms": "to_pay",
    },
    "trip": {"scheduledStart": (NOW + timedelta(days=3)).isoformat(), "routeIndex": 0},
    "notifyOnCreate": False,
})
check("pickup == delivery is refused", st in (409, 422), f"{st} {same}")

print("\n=== 15. The driver's phone must show his trips ===")
st, trips = call("GET", "/v1/trips")
mine = [t for t in trips if t.get("deviceId")]
check("trips carry a tracking phone so the driver's app can find them", len(mine) > 0,
      "no trip has a device attached — every driver's app would be empty")

print("\n" + "=" * 60)
print(f"{len(PASSES)} passed, {len(FAILS)} failed")
for f in FAILS:
    print("  FAILED:", f)
sys.exit(1 if FAILS else 0)
