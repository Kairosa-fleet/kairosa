"""Device registration, provisioning, and revocation tests."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def test_register_device_returns_enrollment_code(
    client: AsyncClient, auth_headers: dict, vehicle_id: str
):
    resp = await client.post(
        "/v1/devices",
        json={"label": "Truck 42", "vehicleId": vehicle_id},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "pending"
    assert len(body["enrollmentCode"]) == 14  # XXXX-XXXX-XXXX


async def test_provision_exchanges_code_for_token(
    client: AsyncClient, auth_headers: dict, vehicle_id: str
):
    reg = await client.post(
        "/v1/devices",
        json={"label": "Truck 7", "vehicleId": vehicle_id},
        headers=auth_headers,
    )
    code = reg.json()["enrollmentCode"]

    resp = await client.post(
        "/v1/devices/provision",
        json={"enrollmentCode": code, "platform": "android"},
    )
    assert resp.status_code == 200
    assert resp.json()["deviceToken"].startswith("dev_")


async def test_enrollment_code_is_single_use(
    client: AsyncClient, auth_headers: dict, vehicle_id: str
):
    reg = await client.post(
        "/v1/devices",
        json={"label": "Truck 8", "vehicleId": vehicle_id},
        headers=auth_headers,
    )
    code = reg.json()["enrollmentCode"]

    first = await client.post("/v1/devices/provision", json={"enrollmentCode": code})
    assert first.status_code == 200

    second = await client.post("/v1/devices/provision", json={"enrollmentCode": code})
    assert second.status_code == 400


async def test_invalid_enrollment_code_rejected(client: AsyncClient):
    resp = await client.post(
        "/v1/devices/provision", json={"enrollmentCode": "XXXX-XXXX-XXXX"}
    )
    assert resp.status_code == 400


async def test_device_can_read_itself(client: AsyncClient, device_headers: dict):
    resp = await client.get("/v1/devices/me", headers=device_headers)
    assert resp.status_code == 200
    assert resp.json()["status"] == "active"


async def test_going_on_duty_without_a_trip_is_refused(
    client: AsyncClient, device_headers: dict
):
    """Tracking a driver with no job collects location data for no reason."""
    resp = await client.post(
        "/v1/devices/me/duty", json={"onDuty": True}, headers=device_headers
    )
    assert resp.status_code == 409


async def test_duty_toggle_with_an_assigned_trip(
    client: AsyncClient, device_headers: dict, assigned_trip: dict
):
    resp = await client.post(
        "/v1/devices/me/duty", json={"onDuty": True}, headers=device_headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["isOnDuty"] is True

    # Going off duty is always allowed — never trap someone in a tracked state.
    resp = await client.post(
        "/v1/devices/me/duty", json={"onDuty": False}, headers=device_headers
    )
    assert resp.json()["isOnDuty"] is False


async def test_device_token_required_for_ingest(client: AsyncClient):
    resp = await client.get("/v1/devices/me")
    assert resp.status_code == 401


async def test_revoked_device_cannot_ingest(
    client: AsyncClient, auth_headers: dict, provisioned_device: dict, device_headers: dict
):
    """Revocation must take effect immediately."""
    ok = await client.get("/v1/devices/me", headers=device_headers)
    assert ok.status_code == 200

    resp = await client.post(
        f"/v1/devices/{provisioned_device['deviceId']}/revoke", headers=auth_headers
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "revoked"

    denied = await client.get("/v1/devices/me", headers=device_headers)
    assert denied.status_code == 401


async def test_driver_creation_and_listing(client: AsyncClient, auth_headers: dict):
    resp = await client.post(
        "/v1/drivers",
        json={"fullName": "Ramesh Patel", "phone": "+919812345678"},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    assert resp.json()["fullName"] == "Ramesh Patel"

    listing = await client.get("/v1/drivers", headers=auth_headers)
    assert len(listing.json()) == 1


async def test_device_with_unknown_driver_rejected(
    client: AsyncClient, auth_headers: dict, vehicle_id: str
):
    resp = await client.post(
        "/v1/devices",
        json={
            "label": "Ghost",
            "vehicleId": vehicle_id,
            "driverId": "00000000-0000-0000-0000-000000000000",
        },
        headers=auth_headers,
    )
    assert resp.status_code == 404
