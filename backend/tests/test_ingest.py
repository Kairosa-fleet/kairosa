"""Ingest pipeline tests — the exact payload contract, validation, idempotency."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


def payload(
    lat=22.307215,
    lon=73.181234,
    ts=None,
    seq=None,
    accuracy=5.0,
    speed=16.67,
    mock=False,
):
    return {
        "deviceId": "unique_device_uuid_here",
        "driverId": "driver_identifier_or_token",
        "timestamp": (ts or datetime.now(timezone.utc)).isoformat(),
        **({"clientSeq": seq} if seq is not None else {}),
        "location": {
            "latitude": lat,
            "longitude": lon,
            "accuracy": accuracy,
            "altitude": 35.8,
            "altitudeAccuracy": 1.5,
        },
        "movement": {"speed": speed, "bearing": 180.5, "activity": "driving"},
        "deviceState": {
            "batteryLevel": 0.85,
            "isCharging": True,
            "networkStatus": "cellular",
            "isMockLocation": mock,
        },
    }


async def test_exact_agreed_payload_accepted(
    client: AsyncClient, device_headers: dict
):
    """The payload shape agreed at the start of the project must work as-is."""
    resp = await client.post(
        "/v1/ingest/single", json=payload(), headers=device_headers
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] == 1
    assert body["results"][0]["trustScore"] == 100


async def test_ingest_requires_device_token(client: AsyncClient):
    resp = await client.post("/v1/ingest/single", json=payload())
    assert resp.status_code == 401


async def test_user_jwt_cannot_ingest(client: AsyncClient, auth_headers: dict):
    """A dashboard login must not be usable as a device credential."""
    resp = await client.post(
        "/v1/ingest/single", json=payload(), headers=auth_headers
    )
    assert resp.status_code == 401


async def test_batch_ingest(client: AsyncClient, device_headers: dict):
    now = datetime.now(timezone.utc)
    pings = [
        payload(lat=22.307215 + i * 0.0005, ts=now - timedelta(seconds=50 - i * 10), seq=i)
        for i in range(5)
    ]
    resp = await client.post(
        "/v1/ingest/batch", json={"pings": pings}, headers=device_headers
    )
    assert resp.status_code == 200
    assert resp.json()["accepted"] == 5


async def test_duplicate_client_seq_is_idempotent(
    client: AsyncClient, device_headers: dict
):
    """A retried batch after a lost ACK must not double-insert."""
    body = {"pings": [payload(seq=99)]}
    first = await client.post("/v1/ingest/batch", json=body, headers=device_headers)
    assert first.json()["accepted"] == 1

    second = await client.post("/v1/ingest/batch", json=body, headers=device_headers)
    assert second.json()["duplicates"] == 1
    # Still reported accepted so the app purges it from the outbox.
    assert second.json()["results"][0]["accepted"] is True


async def test_stale_timestamp_rejected(client: AsyncClient, device_headers: dict):
    old = datetime.now(timezone.utc) - timedelta(days=3)
    resp = await client.post(
        "/v1/ingest/single", json=payload(ts=old), headers=device_headers
    )
    assert resp.json()["results"][0]["reason"] == "timestamp_too_old"


async def test_future_timestamp_rejected(client: AsyncClient, device_headers: dict):
    future = datetime.now(timezone.utc) + timedelta(hours=2)
    resp = await client.post(
        "/v1/ingest/single", json=payload(ts=future), headers=device_headers
    )
    assert resp.json()["results"][0]["reason"] == "timestamp_in_future"


async def test_poor_accuracy_rejected(client: AsyncClient, device_headers: dict):
    resp = await client.post(
        "/v1/ingest/single", json=payload(accuracy=500), headers=device_headers
    )
    assert resp.json()["results"][0]["reason"] == "accuracy_too_poor"


async def test_null_island_rejected(client: AsyncClient, device_headers: dict):
    resp = await client.post(
        "/v1/ingest/single", json=payload(lat=0, lon=0), headers=device_headers
    )
    assert resp.json()["results"][0]["reason"] == "null_island"


async def test_out_of_range_latitude_is_422(client: AsyncClient, device_headers: dict):
    resp = await client.post(
        "/v1/ingest/single", json=payload(lat=91.0), headers=device_headers
    )
    assert resp.status_code == 422


async def test_unknown_field_rejected(client: AsyncClient, device_headers: dict):
    """extra='forbid' stops silently-ignored typos in the client payload."""
    body = payload()
    body["locationn"] = {}
    resp = await client.post("/v1/ingest/single", json=body, headers=device_headers)
    assert resp.status_code == 422


async def test_mock_location_stored_and_flagged(
    client: AsyncClient, device_headers: dict
):
    resp = await client.post(
        "/v1/ingest/single", json=payload(mock=True), headers=device_headers
    )
    result = resp.json()["results"][0]
    # Stored, not rejected — a discarded ping is evidence you no longer have.
    assert result["accepted"] is True
    assert "mock_location_flag" in result["integrityFlags"]
    assert result["trustScore"] < 70


async def test_batch_size_limit_enforced(client: AsyncClient, device_headers: dict):
    resp = await client.post(
        "/v1/ingest/batch",
        json={"pings": [payload(seq=i) for i in range(101)]},
        headers=device_headers,
    )
    assert resp.status_code == 422


async def test_empty_batch_rejected(client: AsyncClient, device_headers: dict):
    resp = await client.post(
        "/v1/ingest/batch", json={"pings": []}, headers=device_headers
    )
    assert resp.status_code == 422


async def test_bad_ping_does_not_fail_whole_batch(
    client: AsyncClient, device_headers: dict
):
    """Per-item results are the point: one bad fix must not lose the rest."""
    now = datetime.now(timezone.utc)
    pings = [
        payload(ts=now - timedelta(seconds=30), seq=1),
        payload(ts=now - timedelta(days=5), seq=2),  # too old
        payload(ts=now - timedelta(seconds=10), seq=3),
    ]
    resp = await client.post(
        "/v1/ingest/batch", json={"pings": pings}, headers=device_headers
    )
    body = resp.json()
    assert body["accepted"] == 2
    assert body["rejected"] == 1


async def test_teleport_flagged_but_stored(client: AsyncClient, device_headers: dict):
    now = datetime.now(timezone.utc)
    pings = [
        payload(lat=22.307215, lon=73.181234, ts=now - timedelta(seconds=20), seq=1),
        # ~100 km away, 10 s later.
        payload(lat=23.022505, lon=72.571362, ts=now - timedelta(seconds=10), seq=2),
    ]
    resp = await client.post(
        "/v1/ingest/batch", json={"pings": pings}, headers=device_headers
    )
    results = resp.json()["results"]
    assert results[1]["accepted"] is True
    assert "teleport" in results[1]["integrityFlags"]


async def test_device_trust_score_degrades(
    client: AsyncClient, device_headers: dict
):
    for i in range(10):
        await client.post(
            "/v1/ingest/single",
            json=payload(ts=datetime.now(timezone.utc) - timedelta(seconds=100 - i * 5), mock=True),
            headers=device_headers,
        )
    resp = await client.get("/v1/devices/me", headers=device_headers)
    assert resp.json()["trustScore"] < 100
