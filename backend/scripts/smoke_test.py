#!/usr/bin/env python
"""End-to-end smoke test against a *running* server.

Unlike the pytest suite (which drives the ASGI app in-process), this exercises
the real network path: HTTP over TCP, a live WebSocket, and Redis fan-out.
It is the proof that the whole round trip works, not just the handlers.

    python scripts/smoke_test.py [--base-url http://localhost:8000]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import websockets

GREEN, RED, YELLOW, DIM, RESET = (
    "\033[32m",
    "\033[31m",
    "\033[33m",
    "\033[2m",
    "\033[0m",
)

passed = failed = 0


def check(label: str, ok: bool, detail: str = "") -> bool:
    global passed, failed
    if ok:
        passed += 1
        print(f"  {GREEN}PASS{RESET}  {label}")
    else:
        failed += 1
        print(f"  {RED}FAIL{RESET}  {label} {DIM}{detail}{RESET}")
    return ok


def section(title: str) -> None:
    print(f"\n{YELLOW}{title}{RESET}")


async def main(base_url: str, ws_url: str) -> int:
    email = f"smoke-{uuid.uuid4().hex[:8]}@example.com"
    password = "correct-horse-battery-1"

    async with httpx.AsyncClient(base_url=base_url, timeout=15) as c:
        section("Health")
        r = await c.get("/health")
        check("GET /health returns 200", r.status_code == 200, r.text[:120])
        r = await c.get("/health/ready")
        checks = r.json().get("checks", {})
        check("database reachable", checks.get("database") == "ok", str(checks))
        check("redis reachable", checks.get("redis") == "ok", str(checks))

        section("Security headers")
        r = await c.get("/health")
        check("X-Content-Type-Options", r.headers.get("X-Content-Type-Options") == "nosniff")
        check("X-Frame-Options", r.headers.get("X-Frame-Options") == "DENY")
        check("Cache-Control no-store", r.headers.get("Cache-Control") == "no-store")
        check("X-Request-ID present", "X-Request-ID" in r.headers)

        section("Auth")
        r = await c.post(
            "/v1/auth/bootstrap",
            json={
                "organization_name": "Smoke Fleet",
                "email": email,
                "password": password,
                "full_name": "Smoke Admin",
            },
        )
        if not check("bootstrap org + admin", r.status_code == 201, r.text[:200]):
            return 1
        tokens = r.json()
        access, refresh = tokens["accessToken"], tokens["refreshToken"]
        auth = {"Authorization": f"Bearer {access}"}

        r = await c.post("/v1/auth/login", json={"email": email, "password": password})
        check("login succeeds", r.status_code == 200, r.text[:120])

        r = await c.post(
            "/v1/auth/login", json={"email": email, "password": "wrong-password-1"}
        )
        check("wrong password rejected", r.status_code == 401)

        r = await c.get("/v1/auth/me", headers=auth)
        check("GET /me authenticated", r.status_code == 200)

        r = await c.get("/v1/auth/me", headers={"Authorization": f"Bearer {refresh}"})
        check("refresh token rejected as access token", r.status_code == 401)

        r = await c.get("/v1/auth/me")
        check("unauthenticated request rejected", r.status_code == 401)

        section("Device provisioning")
        r = await c.post("/v1/drivers", json={"fullName": "Ramesh Patel"}, headers=auth)
        check("create driver", r.status_code == 201, r.text[:120])
        driver_id = r.json()["id"]

        r = await c.post(
            "/v1/devices",
            json={"label": "Truck 01", "driverId": driver_id},
            headers=auth,
        )
        check("register device", r.status_code == 201, r.text[:120])
        code = r.json()["enrollmentCode"]

        r = await c.post(
            "/v1/devices/provision",
            json={"enrollmentCode": code, "platform": "android", "model": "Redmi Note 12"},
        )
        check("provision device", r.status_code == 200, r.text[:120])
        device = r.json()
        device_id = device["deviceId"]
        dev_headers = {"X-Device-Token": device["deviceToken"]}

        r = await c.post("/v1/devices/provision", json={"enrollmentCode": code})
        check("enrollment code is single-use", r.status_code == 400)

        r = await c.post(
            "/v1/devices/me/duty", json={"onDuty": True}, headers=dev_headers
        )
        check("device goes on duty", r.status_code == 200)

        section("Ingest — the agreed payload")
        now = datetime.now(timezone.utc)
        agreed = {
            "deviceId": "unique_device_uuid_here",
            "driverId": "driver_identifier_or_token",
            "timestamp": (now - timedelta(seconds=60)).isoformat(),
            "clientSeq": 1,
            "location": {
                "latitude": 22.307215,
                "longitude": 73.181234,
                "accuracy": 5.0,
                "altitude": 35.8,
                "altitudeAccuracy": 1.5,
            },
            "movement": {"speed": 16.67, "bearing": 180.5, "activity": "driving"},
            "deviceState": {
                "batteryLevel": 0.85,
                "isCharging": True,
                "networkStatus": "cellular",
                "isMockLocation": False,
            },
        }
        r = await c.post("/v1/ingest/single", json=agreed, headers=dev_headers)
        ok = r.status_code == 200 and r.json()["accepted"] == 1
        check("exact agreed payload accepted", ok, r.text[:200])
        check("clean ping scores 100", r.json()["results"][0]["trustScore"] == 100)

        r = await c.post("/v1/ingest/single", json=agreed)
        check("ingest without device token rejected", r.status_code == 401)

        r = await c.post("/v1/ingest/single", json=agreed, headers=auth)
        check("user JWT cannot ingest", r.status_code == 401)

        section("Idempotency")
        r = await c.post(
            "/v1/ingest/batch", json={"pings": [agreed]}, headers=dev_headers
        )
        check("replayed clientSeq deduplicated", r.json()["duplicates"] == 1, r.text[:200])

        section("Integrity scoring")
        spoofed = json.loads(json.dumps(agreed))
        spoofed["clientSeq"] = 2
        spoofed["timestamp"] = (now - timedelta(seconds=50)).isoformat()
        spoofed["deviceState"]["isMockLocation"] = True
        r = await c.post("/v1/ingest/single", json=spoofed, headers=dev_headers)
        res = r.json()["results"][0]
        check("mock location stored, not discarded", res["accepted"] is True)
        check("mock location flagged", "mock_location_flag" in res["integrityFlags"])
        check("trust score dropped", res["trustScore"] < 40, str(res["trustScore"]))

        teleport = json.loads(json.dumps(agreed))
        teleport["clientSeq"] = 3
        teleport["timestamp"] = (now - timedelta(seconds=40)).isoformat()
        teleport["location"]["latitude"] = 23.022505   # ~100 km away
        teleport["location"]["longitude"] = 72.571362
        r = await c.post("/v1/ingest/single", json=teleport, headers=dev_headers)
        res = r.json()["results"][0]
        check("teleport detected", "teleport" in res["integrityFlags"], str(res))

        section("Ingest validation")
        stale = json.loads(json.dumps(agreed))
        stale["clientSeq"] = 4
        stale["timestamp"] = (now - timedelta(days=3)).isoformat()
        r = await c.post("/v1/ingest/single", json=stale, headers=dev_headers)
        check("stale timestamp rejected", r.json()["results"][0]["reason"] == "timestamp_too_old")

        bad = json.loads(json.dumps(agreed))
        bad["location"]["latitude"] = 91.0
        r = await c.post("/v1/ingest/single", json=bad, headers=dev_headers)
        check("latitude out of range is 422", r.status_code == 422)

        typo = json.loads(json.dumps(agreed))
        typo["locationn"] = {}
        r = await c.post("/v1/ingest/single", json=typo, headers=dev_headers)
        check("unknown field rejected", r.status_code == 422)

        r = await c.post(
            "/v1/ingest/batch",
            json={"pings": [agreed for _ in range(101)]},
            headers=dev_headers,
        )
        check("oversized batch rejected", r.status_code == 422)

        section("Tracking reads")
        r = await c.get("/v1/tracking/latest", headers=auth)
        positions = r.json()
        check("latest positions returned", r.status_code == 200 and len(positions) == 1, r.text[:200])

        r = await c.get(f"/v1/tracking/devices/{device_id}/history", headers=auth)
        check("history returned", r.status_code == 200 and len(r.json()) >= 3, r.text[:150])

        r = await c.get("/v1/tracking/latest")
        check("tracking requires auth", r.status_code == 401)

        section("Tenant isolation")
        r = await c.post(
            "/v1/auth/bootstrap",
            json={
                "organization_name": "Rival Fleet",
                "email": f"rival-{uuid.uuid4().hex[:8]}@example.com",
                "password": password,
                "full_name": "Rival",
            },
        )
        rival = {"Authorization": f"Bearer {r.json()['accessToken']}"}
        r = await c.get(f"/v1/devices/{device_id}", headers=rival)
        check("cross-tenant device read blocked (404)", r.status_code == 404)
        r = await c.get("/v1/tracking/latest", headers=rival)
        check("cross-tenant tracking is empty", r.json() == [])

        section("WebSocket live stream")
        try:
            async with websockets.connect(f"{ws_url}/v1/ws/track?token={access}") as ws:
                hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
                check("websocket connects and greets", hello.get("type") == "connected", str(hello))

                live = json.loads(json.dumps(agreed))
                live["clientSeq"] = 500
                live["timestamp"] = (now - timedelta(seconds=5)).isoformat()
                live["location"]["latitude"] = 22.310000

                async def post_later():
                    await asyncio.sleep(0.3)
                    await c.post("/v1/ingest/single", json=live, headers=dev_headers)

                task = asyncio.create_task(post_later())
                msg = None
                for _ in range(5):
                    raw = await asyncio.wait_for(ws.recv(), timeout=8)
                    candidate = json.loads(raw)
                    if candidate.get("type") == "position":
                        msg = candidate
                        break
                await task
                check("live position pushed over websocket", msg is not None, "no position frame")
                if msg:
                    check(
                        "pushed coordinates match ingest",
                        abs(msg["latitude"] - 22.310000) < 1e-6,
                        str(msg),
                    )
        except Exception as exc:
            check("websocket live stream", False, f"{type(exc).__name__}: {exc}")

        section("Revocation")
        r = await c.post(f"/v1/devices/{device_id}/revoke", headers=auth)
        check("device revoked", r.status_code == 200 and r.json()["status"] == "revoked")
        r = await c.post("/v1/ingest/single", json=agreed, headers=dev_headers)
        check("revoked device cannot ingest", r.status_code == 401)

    total = passed + failed
    colour = GREEN if failed == 0 else RED
    print(f"\n{colour}{passed}/{total} checks passed{RESET}\n")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8000")
    args = ap.parse_args()
    ws = args.base_url.replace("http://", "ws://").replace("https://", "wss://")
    sys.exit(asyncio.run(main(args.base_url, ws)))
