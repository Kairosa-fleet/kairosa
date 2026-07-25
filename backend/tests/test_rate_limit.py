"""Rate-limiting tests.

The conftest fixture clears counters between tests, so the limiter is live on
every request but never leaks across tests. These tests deliberately exhaust
a window to prove enforcement actually happens.
"""

from __future__ import annotations

import uuid

from tests.conftest import mandatory_documents

import pytest
from httpx import AsyncClient

from app.core.config import settings

pytestmark = pytest.mark.asyncio


async def test_login_rate_limit_enforced(client: AsyncClient):
    """Brute-force protection: repeated logins from one IP get throttled."""
    limit = settings.RATE_LIMIT_LOGIN_PER_MINUTE
    statuses = []
    for _ in range(limit + 5):
        resp = await client.post(
            "/v1/auth/login",
            json={"email": "nobody@example.com", "password": "whatever-password-1"},
        )
        statuses.append(resp.status_code)

    assert 429 in statuses, f"expected throttling within {limit + 5} attempts"
    # Everything before the limit should be a normal auth failure, not a 429.
    assert statuses[0] == 401


async def test_rate_limited_response_has_retry_after(client: AsyncClient):
    for _ in range(settings.RATE_LIMIT_LOGIN_PER_MINUTE + 5):
        resp = await client.post(
            "/v1/auth/login",
            json={"email": "nobody@example.com", "password": "whatever-password-1"},
        )
        if resp.status_code == 429:
            assert "Retry-After" in resp.headers
            return
    pytest.fail("never got rate limited")


async def test_provision_rate_limit_enforced(client: AsyncClient):
    """Stops brute-forcing enrollment codes."""
    limit = settings.RATE_LIMIT_PROVISION_PER_HOUR
    got_429 = False
    for _ in range(limit + 3):
        resp = await client.post(
            "/v1/devices/provision", json={"enrollmentCode": "XXXX-XXXX-XXXX"}
        )
        if resp.status_code == 429:
            got_429 = True
            break
    assert got_429


async def test_ingest_rate_limit_is_per_device(
    client: AsyncClient, auth_headers: dict, device_headers: dict
):
    """One noisy device must not throttle another."""
    # Exhaust the first device's ingest budget.
    from tests.test_ingest import payload

    limit = settings.RATE_LIMIT_INGEST_PER_MINUTE
    throttled = False
    for i in range(limit + 5):
        resp = await client.post(
            "/v1/ingest/single", json=payload(seq=i), headers=device_headers
        )
        if resp.status_code == 429:
            throttled = True
            break
    assert throttled, "first device was never throttled"

    # A second, independent device is unaffected.
    # Its own vehicle: one active tracking phone per vehicle.
    other_vehicle = await client.post(
        "/v1/vehicles",
        json={
            "registrationNumber": f"GJ06ZZ{uuid.uuid4().hex[:4].upper()}",
            "vehicleType": "truck",
            "documents": await mandatory_documents(client, auth_headers),
        },
        headers=auth_headers,
    )
    reg = await client.post(
        "/v1/devices",
        json={
            "label": f"Truck {uuid.uuid4().hex[:4]}",
            "vehicleId": other_vehicle.json()["id"],
        },
        headers=auth_headers,
    )
    prov = await client.post(
        "/v1/devices/provision", json={"enrollmentCode": reg.json()["enrollmentCode"]}
    )
    other_headers = {"X-Device-Token": prov.json()["deviceToken"]}

    resp = await client.post(
        "/v1/ingest/single", json=payload(seq=1), headers=other_headers
    )
    assert resp.status_code == 200, "second device should not be throttled"
