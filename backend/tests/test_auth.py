"""Authentication and authorization tests, including tenant isolation."""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def test_bootstrap_creates_org_and_admin(client: AsyncClient):
    resp = await client.post(
        "/v1/auth/bootstrap",
        json={
            "organization_name": "Acme Logistics",
            "email": "owner@acme.example.com",
            "password": "correct-horse-battery-1",
            "full_name": "Owner",
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["accessToken"] and body["refreshToken"]
    assert body["tokenType"] == "bearer"


async def test_duplicate_email_rejected(client: AsyncClient, admin_tokens: dict):
    resp = await client.post(
        "/v1/auth/bootstrap",
        json={
            "organization_name": "Another",
            "email": admin_tokens["email"],
            "password": "correct-horse-battery-1",
            "full_name": "Dup",
        },
    )
    assert resp.status_code == 409


async def test_weak_password_rejected(client: AsyncClient):
    resp = await client.post(
        "/v1/auth/bootstrap",
        json={
            "organization_name": "Weak",
            "email": "weak@example.com",
            "password": "short",
            "full_name": "Weak",
        },
    )
    assert resp.status_code == 422


async def test_password_without_digits_rejected(client: AsyncClient):
    resp = await client.post(
        "/v1/auth/bootstrap",
        json={
            "organization_name": "NoDigits",
            "email": "nodigit@example.com",
            "password": "abcdefghijklmnop",
            "full_name": "No Digits",
        },
    )
    assert resp.status_code == 422


async def test_login_success(client: AsyncClient, admin_tokens: dict):
    resp = await client.post(
        "/v1/auth/login",
        json={"email": admin_tokens["email"], "password": "correct-horse-battery-1"},
    )
    assert resp.status_code == 200
    assert resp.json()["accessToken"]


async def test_login_wrong_password(client: AsyncClient, admin_tokens: dict):
    resp = await client.post(
        "/v1/auth/login",
        json={"email": admin_tokens["email"], "password": "wrong-password-here-1"},
    )
    assert resp.status_code == 401


async def test_login_unknown_email_same_error(client: AsyncClient):
    """Must not reveal whether an address is registered."""
    resp = await client.post(
        "/v1/auth/login",
        json={"email": "nobody@nowhere.example.com", "password": "whatever-password-1"},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Incorrect email or password"


async def test_me_requires_auth(client: AsyncClient):
    assert (await client.get("/v1/auth/me")).status_code == 401


async def test_me_returns_user(client: AsyncClient, auth_headers: dict):
    resp = await client.get("/v1/auth/me", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["role"] == "admin"


async def test_invalid_token_rejected(client: AsyncClient):
    resp = await client.get(
        "/v1/auth/me", headers={"Authorization": "Bearer not-a-real-token"}
    )
    assert resp.status_code == 401


async def test_refresh_token_cannot_be_used_as_access(
    client: AsyncClient, admin_tokens: dict
):
    """Token type confusion must be blocked."""
    resp = await client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {admin_tokens['refreshToken']}"},
    )
    assert resp.status_code == 401


async def test_refresh_issues_new_access(client: AsyncClient, admin_tokens: dict):
    resp = await client.post(
        "/v1/auth/refresh", json={"refreshToken": admin_tokens["refreshToken"]}
    )
    assert resp.status_code == 200
    assert resp.json()["accessToken"]


async def test_access_token_rejected_at_refresh(
    client: AsyncClient, admin_tokens: dict
):
    resp = await client.post(
        "/v1/auth/refresh", json={"refreshToken": admin_tokens["accessToken"]}
    )
    assert resp.status_code == 401


async def test_tracker_cannot_create_devices(client: AsyncClient, auth_headers: dict):
    """Role enforcement: only admins may register devices."""
    email = f"tracker-{uuid.uuid4().hex[:8]}@example.com"
    resp = await client.post(
        "/v1/auth/users",
        json={
            "email": email,
            "password": "correct-horse-battery-1",
            "full_name": "Read Only",
            "role": "tracker",
        },
        headers=auth_headers,
    )
    assert resp.status_code == 201

    login = await client.post(
        "/v1/auth/login",
        json={"email": email, "password": "correct-horse-battery-1"},
    )
    tracker_headers = {"Authorization": f"Bearer {login.json()['accessToken']}"}

    resp = await client.post(
        "/v1/devices", json={"label": "Nope"}, headers=tracker_headers
    )
    assert resp.status_code == 403


async def test_cross_tenant_device_access_blocked(
    client: AsyncClient, auth_headers: dict, provisioned_device: dict
):
    """A second organization must not see the first one's device."""
    other = await client.post(
        "/v1/auth/bootstrap",
        json={
            "organization_name": "Rival Fleet",
            "email": f"rival-{uuid.uuid4().hex[:8]}@example.com",
            "password": "correct-horse-battery-1",
            "full_name": "Rival",
        },
    )
    rival_headers = {"Authorization": f"Bearer {other.json()['accessToken']}"}

    resp = await client.get(
        f"/v1/devices/{provisioned_device['deviceId']}", headers=rival_headers
    )
    assert resp.status_code == 404  # 404 not 403 — never confirm existence

    resp = await client.get("/v1/devices", headers=rival_headers)
    assert resp.json() == []
