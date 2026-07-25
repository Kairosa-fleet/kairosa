"""Test fixtures.

Tests run against a real PostGIS database — geography columns, DISTINCT ON,
JSONB defaults and the partial-unique idempotency constraint cannot be
exercised on SQLite, and a suite that never touches the real engine would not
prove much.

Loop discipline matters here: asyncpg connections and the Redis client bind
to the event loop that created them. pytest-asyncio gives each test its own
loop, so both are created per test and disposed afterwards. Only the one-off
schema creation is session-scoped, and it uses a throwaway engine.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncGenerator
from datetime import date, datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

os.environ.setdefault("JWT_SECRET", "test-secret-key-at-least-32-characters-long!!")

from app.core import redis_client  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402


def _test_db_url() -> str:
    """Swap only the database name, never the username.

    A naive ``.replace("/tracking", "/tracking_test")`` also rewrites the
    credentials in ``//tracking:password@``, producing an invalid user.
    """
    base, _, _ = settings.DATABASE_URL.rpartition("/")
    return f"{base}/tracking_test"


TEST_DB_URL = os.environ.get("TEST_DATABASE_URL", _test_db_url())

_schema_ready = False


async def _ensure_schema() -> None:
    """Create the test database and schema once per session."""
    global _schema_ready
    if _schema_ready:
        return

    admin_url = TEST_DB_URL.rsplit("/", 1)[0] + "/postgres"
    db_name = TEST_DB_URL.rsplit("/", 1)[-1]
    admin_engine = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
    try:
        async with admin_engine.connect() as conn:
            exists = await conn.scalar(
                text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": db_name}
            )
            if not exists:
                await conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    finally:
        await admin_engine.dispose()

    eng = create_async_engine(TEST_DB_URL)
    try:
        async with eng.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
    finally:
        await eng.dispose()

    _schema_ready = True


@pytest_asyncio.fixture
async def engine():
    """A fresh engine per test, bound to this test's event loop."""
    await _ensure_schema()
    eng = create_async_engine(TEST_DB_URL)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture(autouse=True)
async def reset_redis():
    """Rebuild the Redis singleton per test so it binds to this test's loop.

    Also clears rate-limit counters: every test shares one client IP, so the
    limiter would (correctly) start rejecting after a handful of tests.
    Cleared rather than disabled, so the limiter still runs on every request
    and remains covered by test_rate_limit.py.
    """
    await redis_client.close_redis()
    redis = redis_client.get_redis()
    try:
        keys = await redis.keys("ratelimit:*")
        if keys:
            await redis.delete(*keys)
        keys = await redis.keys("revoked:*")
        if keys:
            await redis.delete(*keys)
    except Exception:
        pass
    yield
    await redis_client.close_redis()


@pytest_asyncio.fixture
async def db_session(engine) -> AsyncGenerator[AsyncSession, None]:
    """A clean database for every test — truncate rather than recreate."""
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as session:
        await session.execute(
            text(
                "TRUNCATE location_pings, devices, drivers, users, organizations "
                "RESTART IDENTITY CASCADE"
            )
        )
        await session.commit()
        yield session


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """HTTP client driving the ASGI app against the test session."""

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def admin_tokens(client: AsyncClient) -> dict:
    """Bootstrap an organization and return its admin tokens."""
    email = f"admin-{uuid.uuid4().hex[:8]}@example.com"
    resp = await client.post(
        "/v1/auth/bootstrap",
        json={
            "organization_name": "Test Fleet",
            "email": email,
            "password": "correct-horse-battery-1",
            "full_name": "Test Admin",
        },
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    data["email"] = email
    return data


@pytest.fixture
def auth_headers(admin_tokens: dict) -> dict:
    return {"Authorization": f"Bearer {admin_tokens['accessToken']}"}


# The smallest byte sequence the upload endpoint will accept as a PDF.
MINIMAL_PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"


async def mandatory_documents(client: AsyncClient, auth_headers: dict) -> list[dict]:
    """The four documents every vehicle must have, each with a stored scan.

    Uploaded through the real endpoint so tests exercise the same path the
    dashboard does, and so a change to the accepted formats fails here.
    """
    upload = await client.post(
        "/v1/documents",
        files={"file": ("test.pdf", MINIMAL_PDF, "application/pdf")},
        headers=auth_headers,
    )
    assert upload.status_code == 201, upload.text
    file_url = upload.json()["fileUrl"]

    expiry = (date.today() + timedelta(days=180)).isoformat()
    return [
        {"docType": "rc", "number": "RC-TEST-1", "fileUrl": file_url},
        {"docType": "insurance", "number": "INS-TEST-1", "fileUrl": file_url, "expiresOn": expiry},
        {"docType": "puc", "number": "PUC-TEST-1", "fileUrl": file_url, "expiresOn": expiry},
        {"docType": "fitness", "number": "FIT-TEST-1", "fileUrl": file_url, "expiresOn": expiry},
    ]


@pytest_asyncio.fixture
async def vehicle_id(client: AsyncClient, auth_headers: dict) -> str:
    """A vehicle to hang devices off.

    Every tracking phone belongs to one — a device with no vehicle is a dot on
    the map representing nothing — so tests that register a device need this
    first.
    """
    resp = await client.post(
        "/v1/vehicles",
        json={
            "registrationNumber": "GJ06AB1234",
            "vehicleType": "truck",
            "documents": await mandatory_documents(client, auth_headers),
        },
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest_asyncio.fixture
async def provisioned_device(
    client: AsyncClient, auth_headers: dict, vehicle_id: str
) -> dict:
    """Register and provision a device; return its id and token."""
    resp = await client.post(
        "/v1/devices",
        json={"label": "Truck 01", "vehicleId": vehicle_id},
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text
    code = resp.json()["enrollmentCode"]

    resp = await client.post(
        "/v1/devices/provision",
        json={"enrollmentCode": code, "platform": "android", "model": "Redmi Note 12"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture
def device_headers(provisioned_device: dict) -> dict:
    return {"X-Device-Token": provisioned_device["deviceToken"]}


@pytest_asyncio.fixture
async def assigned_trip(
    client: AsyncClient,
    auth_headers: dict,
    vehicle_id: str,
    provisioned_device: dict,
) -> dict:
    """A booked consignment starting now, assigned to the provisioned device.

    Built through the real endpoints rather than inserted directly, so it
    exercises the same path a dispatcher takes.
    """
    scan = (await mandatory_documents(client, auth_headers))[0]["fileUrl"]
    expiry = (date.today() + timedelta(days=365)).isoformat()
    driver = await client.post(
        "/v1/drivers/full",
        json={
            "fullName": "Test Driver",
            "phone": "+919810000001",
            # A driver cannot be dispatched without a valid licence and the
            # paperwork a transporter is expected to hold for them.
            "licenceNumber": "RJ14TEST0001",
            "licenceClass": "HMV",
            "licenceExpiresOn": expiry,
            "licenceFileUrl": scan,
            "documents": [
                {"docType": "police_verification", "number": "PV-T1",
                 "fileUrl": scan, "expiresOn": expiry},
                {"docType": "medical_certificate", "number": "MED-T1",
                 "fileUrl": scan, "expiresOn": expiry},
            ],
        },
        headers=auth_headers,
    )
    assert driver.status_code == 201, driver.text

    async def customer(name: str, lat: float, lon: float) -> dict:
        resp = await client.post(
            "/v1/customers",
            json={
                "name": name,
                "phone": "+919810000002",
                "addresses": [
                    {"line1": f"{name} yard", "city": "Vadodara",
                     "latitude": lat, "longitude": lon},
                ],
            },
            headers=auth_headers,
        )
        assert resp.status_code == 201, resp.text
        return resp.json()

    sender = await customer("Sender Co", 22.3072, 73.1812)
    receiver = await customer("Receiver Co", 23.0225, 72.5714)

    resp = await client.post(
        "/v1/bookings",
        json={
            "consignment": {
                "consignorId": sender["id"],
                "consignorAddressId": sender["addresses"][0]["id"],
                "consigneeId": receiver["id"],
                "consigneeAddressId": receiver["addresses"][0]["id"],
                "goodsDescription": "Test cargo",
                "freightTerms": "to_pay",
            },
            "trip": {
                "vehicleId": vehicle_id,
                "driverId": driver.json()["id"],
                "deviceId": provisioned_device["deviceId"],
                "scheduledStart": datetime.now(timezone.utc).isoformat(),
                "routeIndex": 0,
            },
            "notifyOnCreate": False,
        },
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()
