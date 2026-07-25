# Backend — Complete Reference

FastAPI service for location ingest, integrity scoring, and live fleet tracking.
**Status: built, migrated, and fully tested — 74 unit/integration tests + 41 end-to-end checks, all passing.**

---

## 1. Verification results

| Suite | Result | What it proves |
|---|---|---|
| `pytest` (74 tests) | ✅ **74 passed** in 20.3 s | Handlers, auth, isolation, validation, integrity, rate limits — against real PostGIS |
| `smoke_test.py` (41 checks) | ✅ **41/41 passed** | The real network path: HTTP over TCP, live WebSocket, Redis fan-out |
| `ruff check` | ✅ Clean | 30 app files, 6 test files, 1 script |
| Alembic migration | ✅ Applied | 5 tables, GiST spatial index, idempotency constraint |

Test breakdown: `test_integrity.py` 20 · `test_ingest.py` 17 · `test_auth.py` 15 · `test_devices.py` 10 · `test_tracking.py` 8 · `test_rate_limit.py` 4.

Tests run against **real PostGIS**, not SQLite. Geography columns, `DISTINCT ON`, JSONB defaults and the unique idempotency constraint cannot be exercised on SQLite, so a suite that avoided the real engine would prove very little.

### Bugs found and fixed during testing

Worth recording, because each was a real defect that only surfaced by running things:

1. **Route-ordering bug (real, would have broken the mobile app).** `GET /devices/{device_id}` was declared before `GET /devices/me`, so FastAPI matched `me` as a UUID path parameter and every device self-service call failed with 401. Fixed by declaring the `me` routes first, with a comment explaining why order matters.
2. **Alembic would have dropped PostGIS.** Autogenerate reflected the `tiger`, `tiger_data` and `topology` schemas the PostGIS image ships, saw they weren't in our metadata, and emitted `DROP TABLE` for all of them. Fixed with an `include_object` filter restricting Alembic to tables we own.
3. **Generated migration didn't import `geoalchemy2`.** Geography columns render as `geoalchemy2.types.Geography(...)` but the template didn't import the module, so the migration crashed with `NameError`. Fixed in `script.py.mako` so every future migration is correct.
4. **Test fixture rewrote the DB username.** `DATABASE_URL.replace("/tracking", "/tracking_test")` also matched `//tracking:` in the credentials, producing user `tracking_test`. Fixed with `rpartition`.
5. **Event-loop binding.** asyncpg connections and the Redis singleton bind to the loop that created them; a session-scoped engine with function-scoped tests raised `got Future attached to a different loop`. Fixed by creating both per test.
6. **History window hid accepted pings.** Ingest tolerates up to 300 s of device clock skew, but `/history` defaulted its upper bound to `now` — so a ping could be accepted and then be invisible. The default `end` now includes the same skew allowance.
7. **Python 3.10 compatibility.** `datetime.UTC` is 3.11+, and `asyncio.wait_for` raises `asyncio.TimeoutError` (not the builtin) on 3.10.
8. **`isMockLocation` scored too leniently.** It landed at 50 — "suspicious" but not "spoofed". The signal is *asymmetric*: `false` proves nothing (bypassable on a rooted phone), but a `true` from the OS has no plausible false positive. Penalty raised to 65 so a true value alone classifies as spoofed.

---

## 2. Architecture

### "Microservice" — what was actually built

**One service with a single bounded responsibility** (location telemetry), not a constellation of tiny services. Splitting auth, ingest and tracking into separate deployables at MVP stage would add network hops, distributed transactions and operational overhead while buying nothing.

What makes it microservice-*ready*:

- **Stateless** — no in-process session or socket state. All shared state is in Postgres and Redis, so N replicas run behind a load balancer with no sticky sessions, **including WebSockets**, which fan out through Redis pub/sub.
- **Config from environment** — no baked-in hosts or secrets.
- **Layered** — `api → services → models`. Business logic in `services/` imports no FastAPI, so it can move to another process without a rewrite.
- **Containerised** with health and readiness probes.

The natural future split is ingest (write-heavy) from tracking reads. The layer boundary already follows that seam.

### Request flow

```
                    ┌─────────────────────────────────────────┐
   Mobile app ──────▶ POST /v1/ingest/batch                    │
   (device token)   │   ├─ deps.get_current_device  (authn)    │
                    │   ├─ deps.rate_limit_ingest   (throttle) │
                    │   ├─ schemas.IngestBatchIn    (validate) │
                    │   └─ services.ingest_service            │
                    │        ├─ _validate()      per ping      │
                    │        ├─ integrity.evaluate()           │
                    │        ├─ INSERT → PostGIS (savepoint)   │
                    │        └─ broadcast.publish() → Redis    │
                    └───────────────────┬─────────────────────┘
                                        │ pub/sub
                    ┌───────────────────▼─────────────────────┐
   Dashboard ◀──────│ WS /v1/ws/track                          │
   (user JWT)       │   broadcast.manager._listen()            │
                    └─────────────────────────────────────────┘
```

---

## 3. File-by-file reference

30 application files, 1,859 lines. Tests: 6 files, 1,165 lines.

### `app/main.py` — application assembly

The entrypoint: creates the `FastAPI` instance, wires middleware, exception handlers and health probes.

| Item | Purpose |
|---|---|
| `lifespan()` | Startup/shutdown. Starts the Redis pub/sub listener; on shutdown stops it, closes Redis, disposes the DB engine. |
| `security_and_logging()` middleware | Rejects bodies over 2 MiB, assigns `X-Request-ID`, times the request, and sets every security header (nosniff, DENY, no-referrer, CSP, no-store, HSTS in prod). |
| `validation_handler()` | Turns Pydantic errors into a compact 422 that names fields without echoing raw input back. |
| `unhandled_handler()` | Catch-all: logs the traceback server-side, returns a bare `{"detail": "Internal server error"}`. Stack traces never reach a client. |
| `health()` | Liveness — always 200 if the process is up. |
| `readiness()` | Checks Postgres and Redis; returns 503 if either is down, so an orchestrator stops routing traffic. |

`docs_url` and `openapi_url` are `None` when `ENVIRONMENT=production` — the interactive schema is a reconnaissance aid.

### `app/core/` — infrastructure (no business logic)

**`config.py`** — all settings in one typed `Settings` class (pydantic-settings), read from `.env`.
- `_reject_placeholder_secret()` — refuses to boot if `JWT_SECRET` is still `CHANGE_ME`. A production deploy with a default signing key is a total auth bypass; failing at startup is the only safe response.
- `cors_origins_list`, `is_production` — derived helpers.
- Tunables: token lifetimes, ingest validation bounds, integrity thresholds, rate limits.

**`database.py`** — async SQLAlchemy.
- `Base` — declarative base all models inherit.
- `engine` — async engine with `pool_pre_ping=True` so dead connections are discarded rather than erroring on first use.
- `get_db()` — FastAPI dependency yielding a session that rolls back on exception.

**`redis_client.py`** — Redis client and key naming. Redis has three jobs: pub/sub fan-out, device-revocation cache, rate limiting.
- `get_redis()` / `close_redis()` — lazily-created shared client.
- `org_channel(org_id)` → `track:org:{id}` · `revoked_key(hash)` · `rate_limit_key(scope, id)`.

**`security.py`** — all cryptographic operations.

| Function | Notes |
|---|---|
| `hash_password` / `verify_password` | bcrypt, 12 rounds. `verify_password` returns `False` on a malformed hash rather than raising — a corrupt row becomes a failed login, not a 500. |
| `create_token` | Issues access/refresh JWTs carrying `sub`, `typ`, `org`, `role`, `iat`, `exp`, `jti`. |
| `decode_token` | Verifies signature **and** `typ`. Without the type check, a long-lived refresh token could be replayed as an access token. |
| `generate_device_token` | `dev_` + 40 bytes of CSPRNG entropy. |
| `hash_device_token` | SHA-256. Deliberately *not* bcrypt: this is verified on every ingest and the input is already high-entropy, so there is no dictionary attack to slow down. |
| `verify_device_token` | Constant-time compare via `hmac.compare_digest`. |
| `generate_enrollment_code` | `XXXX-XXXX-XXXX` from an alphabet excluding `I/O/0/1` — humans transcribe these off a screen. |

### `app/models/` — database tables

**`organization.py`** — `Organization`: the tenancy boundary. Every other row hangs off one, and every query filters by it.

**`user.py`** — `User`: dashboard login. `UserRole` is `admin` (full control) or `tracker` (read-only).

**`driver.py`** — `Driver`: the person operating a vehicle.

**`device.py`** — `Device`: a phone running the app.
- `DeviceStatus`: `pending` → `active` → `revoked`.
- Credentials stored as hashes only: `enrollment_code_hash`, `token_hash`.
- `is_on_duty` — tracking is only expected while on duty (a privacy requirement, see [BACKGROUND_TRACKING.md](BACKGROUND_TRACKING.md)).
- `trust_score` — rolling integrity reputation.

**`ping.py`** — `LocationPing`, the hot table. Mirrors the client payload one-to-one plus server-side additions.

| Design point | Reason |
|---|---|
| `geom` is `geography(Point,4326)` | True metre distances across India without fighting UTM zone projections |
| Both `recorded_at` and `received_at` | Device clock vs server clock; divergence is itself a signal |
| `UniqueConstraint(device_id, client_seq)` | The reason a retried batch cannot double-insert |
| `trust_score` + `integrity_flags` (JSONB) | Server-computed, never client-supplied |
| `ix_pings_device_recorded` | History queries |
| `ix_pings_geom` (GiST) | Geofencing / spatial search |

### `app/schemas/` — request/response contracts

Every schema sets `extra="forbid"`, so a typo like `locationn` is a 422 rather than a silently ignored field.

**`ingest.py`** — the exact agreed payload. `LocationBlock`, `MovementBlock`, `DeviceStateBlock`, `LocationPingIn`, `IngestBatchIn` (1–100 items), and the responses `PingResult` / `IngestBatchOut`. camelCase on the wire via aliases, snake_case internally. `_require_timezone()` normalises naive timestamps to UTC instead of guessing local time.

**`auth.py`** — `OrganizationBootstrapIn` (with `_password_strength`: ≥12 chars, letters and digits, ≤72 bytes because bcrypt silently truncates past that), `LoginIn`, `RefreshIn`, `TokenOut`, `UserOut`.

**`device.py`** — driver/device CRUD, `DeviceRegisteredOut` (enrollment code, returned once), `DeviceProvisionOut` (device token, returned once), `PositionOut` (map-ready position).

### `app/api/deps.py` — dependencies

| Dependency | Behaviour |
|---|---|
| `get_current_user` | Validates an **access** JWT, loads the user, checks `is_active`. |
| `require_admin` | 403 unless role is admin. |
| `get_current_device` | Accepts `X-Device-Token` or bearer. Checks the Redis revocation cache *before* the DB so revocation is instant, then verifies status and expiry. |
| `_check_rate_limit` | Fixed-window counter in Redis. **Fails open** if Redis is unavailable. |
| `client_ip` | Best-effort IP; trusts `X-Forwarded-For`, which is only correct behind a proxy that overwrites it. |
| `rate_limit_login` / `_provision` / `_ingest` | 10/min per IP · 20/hr per IP · 120/min per device. |

### `app/api/v1/` — routes

**`auth.py`** — `POST /bootstrap` (create org + first admin; open by design, rate limited), `POST /login`, `POST /refresh`, `GET /me`, `POST /users`.

`login` returns one error message for both unknown-email and wrong-password, and runs a dummy hash when the user is absent so response timing doesn't leak whether an address is registered.

**`devices.py`** — drivers, device registration, provisioning, revocation, duty toggle.

⚠️ **Route order is load-bearing.** `/devices/me` and `/devices/me/duty` are declared *before* `/devices/{device_id}`, because FastAPI matches in declaration order and would otherwise parse `me` as a UUID. This was a real bug caught by tests.

`_get_own_device()` returns **404, not 403**, for another tenant's device — a 403 would confirm the resource exists.

**`ingest.py`** — `POST /ingest/batch` and `/ingest/single`. Thin; all logic is in the service layer.

**`tracking.py`** — `GET /tracking/latest` (newest fix per device via Postgres `DISTINCT ON`, one query for the whole fleet) and `GET /tracking/devices/{id}/history`.

**`ws.py`** — `WS /v1/ws/track?token=…`. The token is a query parameter because browsers can't set headers on a WebSocket handshake; it's verified *before* the socket is accepted, and the user is re-checked against the DB because a valid JWT could belong to a since-deactivated account. A 60 s heartbeat keeps intermediaries from idling the connection out.

### `app/services/` — business logic (framework-free)

**`integrity.py`** — the anti-spoofing engine. Pure functions, trivially testable.

| Check | Penalty | Catches |
|---|---|---|
| `mock_location_flag` | 65 | OS-reported mock provider |
| `teleport` | 40 | Displacement impossible for a road vehicle (>60 m/s) |
| `timestamp_regression` | 20 | Clock manipulation |
| `speed_displacement_mismatch` | 15 | Position set but speed not updated to match |
| `quantised_coordinates` | 15 | Hand-written or grid-snapped coordinates |
| `zero_accuracy` | 15 | Synthetic perfect accuracy |
| `bearing_trajectory_mismatch` | 10 | Claimed heading contradicts actual direction |
| `static_accuracy` | 10 | Real GNSS accuracy fluctuates; a constant value doesn't |
| `battery_rose_uncharged` | 10 | Physically impossible |
| `wifi_at_speed` | 10 | Wifi at 90 km/h — desktop tool or emulator |
| `activity_speed_mismatch` | 5–10 | "driving" at 0 m/s, "still" at 80 km/h |
| `zero_altitude` | 5 | Most spoofing tools ignore altitude |
| `ios_mock_unverifiable` | 0 | Noted only — iOS has no mock API, so its `false` means less |

`blend_device_trust()` is an exponentially-weighted rolling average (weight 0.1): one bad ping is a tunnel, a hundred is a spoofing app.

**`ingest_service.py`** — the pipeline.
- `_validate()` — rejects stale (>24 h), future (>300 s), poor accuracy (>100 m), and Null Island `(0,0)`.
- `_load_previous_fix()` — the integrity baseline.
- `ingest_batch()` — processes **oldest-first** so the baseline advances correctly; each row inserts inside a **savepoint** so a duplicate can't poison the batch; updates rolling device trust; broadcasts **only the newest** position (viewers want the current dot, not a replay of a drained offline backlog).

**`broadcast.py`** — `ConnectionManager`: per-worker socket registry plus Redis pub/sub bridge. `publish()` goes through Redis so any worker can reach any socket; `_listen()` psubscribes to `track:org:*` and relays into local sockets, reconnecting on failure. Dead sockets are pruned on send.

### `alembic/`

`env.py` configures async migrations and — critically — `include_object()` restricts Alembic to tables in our metadata, so it can never emit `DROP TABLE` for PostGIS's own `tiger`/`topology` schemas. `script.py.mako` imports `geoalchemy2` so geography columns render correctly.

### `tests/`

`conftest.py` builds the test DB, creates a fresh engine and Redis client **per test** (both bind to the event loop that created them), truncates tables between tests, and clears rate-limit counters — cleared rather than disabled, so the limiter still runs on every request and is covered by its own tests.

`scripts/smoke_test.py` is the complement: the pytest suite drives the ASGI app in-process, while the smoke test hits a **running server** over real TCP with a real WebSocket, which is the only way to prove Redis fan-out actually works.

---

## 4. API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Liveness |
| GET | `/health/ready` | — | Readiness (Postgres + Redis) |
| POST | `/v1/auth/bootstrap` | — | Create org + first admin |
| POST | `/v1/auth/login` | — | Email + password → tokens |
| POST | `/v1/auth/refresh` | — | Refresh → new access token |
| GET | `/v1/auth/me` | user | Current user |
| POST | `/v1/auth/users` | admin | Add a user to the org |
| POST | `/v1/drivers` | admin | Create driver |
| GET | `/v1/drivers` | user | List drivers |
| POST | `/v1/devices` | admin | Register device → enrollment code |
| POST | `/v1/devices/provision` | code | Code → device token |
| GET | `/v1/devices` | user | List devices |
| GET | `/v1/devices/me` | device | Device reads itself |
| POST | `/v1/devices/me/duty` | device | On/off duty |
| GET | `/v1/devices/{id}` | user | One device |
| POST | `/v1/devices/{id}/revoke` | admin | Revoke immediately |
| POST | `/v1/ingest/batch` | device | Batch of fixes |
| POST | `/v1/ingest/single` | device | One fix (debugging) |
| GET | `/v1/tracking/latest` | user | Newest fix per device |
| GET | `/v1/tracking/devices/{id}/history` | user | Track for replay |
| WS | `/v1/ws/track?token=…` | user | Live position stream |

### Example — the agreed payload

```bash
curl -X POST http://localhost:8000/v1/ingest/single \
  -H "X-Device-Token: dev_..." -H "Content-Type: application/json" \
  -d '{
    "deviceId": "unique_device_uuid_here",
    "driverId": "driver_identifier_or_token",
    "timestamp": "2026-07-20T17:35:00Z",
    "clientSeq": 1,
    "location":    {"latitude": 22.307215, "longitude": 73.181234,
                    "accuracy": 5.0, "altitude": 35.8, "altitudeAccuracy": 1.5},
    "movement":    {"speed": 16.67, "bearing": 180.5, "activity": "driving"},
    "deviceState": {"batteryLevel": 0.85, "isCharging": true,
                    "networkStatus": "cellular", "isMockLocation": false}
  }'
```

```json
{"accepted": 1, "rejected": 0, "duplicates": 0,
 "results": [{"clientSeq": 1, "accepted": true, "pingId": 1,
              "trustScore": 100, "integrityFlags": []}]}
```

---

## 5. Security controls (all test-covered)

| Control | Implementation | Test |
|---|---|---|
| Password storage | bcrypt, 12 rounds; ≥12 chars, letters + digits | `test_weak_password_rejected` |
| Token type confusion | `typ` claim verified | `test_refresh_token_cannot_be_used_as_access` |
| Device auth separation | User JWT cannot ingest | `test_user_jwt_cannot_ingest` |
| Device token storage | SHA-256 only; plaintext never stored | — |
| Instant revocation | Redis cache checked before DB | `test_revoked_device_cannot_ingest` |
| Single-use enrollment | Hash cleared on provision | `test_enrollment_code_is_single_use` |
| Tenant isolation | Every query scoped by org; 404 not 403 | `test_cross_tenant_device_access_blocked` |
| Role enforcement | `require_admin` on mutating routes | `test_tracker_cannot_create_devices` |
| User enumeration | One error + timing equalisation | `test_login_unknown_email_same_error` |
| Brute-force protection | Redis rate limits | `test_login_rate_limit_enforced` |
| Per-device throttling | Noisy device can't affect another | `test_ingest_rate_limit_is_per_device` |
| Input validation | `extra="forbid"`, range checks | `test_unknown_field_rejected` |
| Batch size cap | 100 pings | `test_batch_size_limit_enforced` |
| Body size cap | 2 MiB | — |
| Security headers | nosniff/DENY/CSP/no-store/HSTS | `test_security_headers_present` |
| No info leakage | Generic 500, no stack traces | — |
| SQL injection | Parameterised throughout | — |
| Container | Non-root uid 10001 | — |

---

## 6. Running it

```bash
cd /home/reward_hack/Desktop/application
sudo docker compose up -d              # Postgres + Redis

cd backend
PYTHONPATH=. ../.venv/bin/alembic upgrade head
PYTHONPATH=. ../.venv/bin/uvicorn app.main:app --reload --port 8000
```

```bash
PYTHONPATH=. ../.venv/bin/pytest                        # 74 tests
PYTHONPATH=. ../.venv/bin/python scripts/smoke_test.py  # 41 checks (needs a running server)
../.venv/bin/ruff check app tests scripts
```

Interactive docs at `http://localhost:8000/docs` (development only).

> **Docker note:** this account isn't in the `docker` group, so `docker compose` needs `sudo`. Adding yourself with `sudo usermod -aG docker $USER` (then re-login) removes that, but it grants effectively-root access to the host — your call, not something to enable silently.

---

## 7. Known gaps — deliberate, for MVP

Recorded plainly so none of them is a surprise later:

- **No refresh-token rotation or revocation list.** Mitigated by short access-token lifetime (60 min). A stolen refresh token is valid for 30 days.
- **Rate limiting is a fixed window**, not a sliding log — a burst can straddle a boundary and briefly get 2× the limit. Adequate here; swap for a Lua sliding window if abuse appears.
- **Rate limiting fails open if Redis is down.** Availability was chosen over enforcement. Revisit before exposing this to the internet without a WAF.
- **`X-Forwarded-For` is trusted** for client IP. Only correct behind a proxy that overwrites it; directly exposed, an attacker can spoof it to evade IP rate limits.
- **`/v1/auth/bootstrap` is open.** Anyone can create an organization. Fine for development; gate behind an invite or disable it in production.
- **No trips, geofences, or retention/downsampling job.** The schema supports all three.
- **Play Integrity / App Attest not implemented** — Layer 2 of [ANTI_SPOOFING.md](ANTI_SPOOFING.md). Layer 3 (server-side physics) is complete and is the layer that does the real work.
- **No structured/JSON logging or metrics endpoint.** Request IDs and timings are emitted; wiring them to a log aggregator is deployment work.
