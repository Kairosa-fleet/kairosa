"""Tracking read-API and health-endpoint tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from tests.test_ingest import payload

pytestmark = pytest.mark.asyncio


async def test_health(client: AsyncClient):
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


async def test_security_headers_present(client: AsyncClient):
    resp = await client.get("/health")
    assert resp.headers["X-Content-Type-Options"] == "nosniff"
    assert resp.headers["X-Frame-Options"] == "DENY"
    assert resp.headers["Cache-Control"] == "no-store"
    assert "X-Request-ID" in resp.headers


async def test_latest_requires_auth(client: AsyncClient):
    assert (await client.get("/v1/tracking/latest")).status_code == 401


async def test_latest_returns_newest_per_device(
    client: AsyncClient, auth_headers: dict, device_headers: dict
):
    now = datetime.now(timezone.utc)
    for i in range(3):
        await client.post(
            "/v1/ingest/single",
            json=payload(
                lat=22.307215 + i * 0.001,
                ts=now - timedelta(seconds=30 - i * 10),
                seq=i,
            ),
            headers=device_headers,
        )

    resp = await client.get("/v1/tracking/latest", headers=auth_headers)
    assert resp.status_code == 200
    positions = resp.json()
    assert len(positions) == 1  # one row per device, not per ping
    assert positions[0]["latitude"] == pytest.approx(22.309215)
    assert positions[0]["isOnline"] is True


async def test_history_returns_ordered_track(
    client: AsyncClient, auth_headers: dict, device_headers: dict, provisioned_device: dict
):
    now = datetime.now(timezone.utc)
    for i in range(5):
        await client.post(
            "/v1/ingest/single",
            json=payload(
                lat=22.307215 + i * 0.0005,
                ts=now - timedelta(seconds=60 - i * 10),
                seq=i,
            ),
            headers=device_headers,
        )

    resp = await client.get(
        f"/v1/tracking/devices/{provisioned_device['deviceId']}/history",
        headers=auth_headers,
    )
    assert resp.status_code == 200
    track = resp.json()
    assert len(track) == 5
    timestamps = [p["recordedAt"] for p in track]
    assert timestamps == sorted(timestamps)


async def test_history_cross_tenant_blocked(
    client: AsyncClient, provisioned_device: dict
):
    import uuid

    other = await client.post(
        "/v1/auth/bootstrap",
        json={
            "organization_name": "Outsider",
            "email": f"out-{uuid.uuid4().hex[:8]}@test.com",
            "password": "correct-horse-battery-1",
            "full_name": "Outsider",
        },
    )
    headers = {"Authorization": f"Bearer {other.json()['accessToken']}"}
    resp = await client.get(
        f"/v1/tracking/devices/{provisioned_device['deviceId']}/history",
        headers=headers,
    )
    assert resp.status_code == 404


async def test_history_rejects_inverted_range(
    client: AsyncClient, auth_headers: dict, provisioned_device: dict
):
    now = datetime.now(timezone.utc)
    resp = await client.get(
        f"/v1/tracking/devices/{provisioned_device['deviceId']}/history",
        params={
            "start": now.isoformat(),
            "end": (now - timedelta(hours=1)).isoformat(),
        },
        headers=auth_headers,
    )
    assert resp.status_code == 400


async def test_history_limit_capped(
    client: AsyncClient, auth_headers: dict, provisioned_device: dict
):
    resp = await client.get(
        f"/v1/tracking/devices/{provisioned_device['deviceId']}/history",
        params={"limit": 99_999},
        headers=auth_headers,
    )
    assert resp.status_code == 422
