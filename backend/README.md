# Tracking Service (FastAPI)

Location ingest, integrity scoring, and live fleet tracking.

## On "microservice"

This is **one service with a single bounded responsibility** — location telemetry — not a
constellation of tiny services. That is the right shape for an MVP: splitting auth, ingest and
tracking into separate deployables now would add network hops, distributed transactions and
operational overhead while buying nothing.

What makes it microservice-*ready* is that it obeys the constraints that make splitting cheap later:

- **Stateless.** No in-process session or socket state. All shared state is in Postgres and Redis,
  so N replicas run behind a load balancer with no sticky sessions — including WebSockets, which
  fan out through Redis pub/sub.
- **Config from environment.** No baked-in hosts or secrets.
- **Layered.** `api → services → models`. Business logic lives in `services/` with no FastAPI
  imports, so it can move to another process without rewriting.
- **Containerised** with health and readiness probes for an orchestrator.

The natural future split is ingest (write-heavy) from tracking reads. The service boundary already
follows that seam.

## Layout

```
app/
  core/       config, database, redis, security   (no business logic)
  models/     SQLAlchemy ORM — one file per table
  schemas/    Pydantic request/response contracts
  services/   business logic — integrity, ingest, broadcast (framework-free)
  api/        HTTP layer — deps.py + v1/ routes
  main.py     app assembly, middleware, health
tests/        pytest suite (runs against real PostGIS)
scripts/      smoke_test.py — end-to-end over real HTTP + WebSocket
```

## Running

```bash
docker compose up -d          # Postgres + Redis (from the repo root)
make migrate                  # apply schema
make dev                      # http://localhost:8000/docs
```

```bash
make test                     # pytest suite
make smoke                    # end-to-end against a running server
make lint
```

## Data flow

```
device → POST /v1/ingest/batch → validate → integrity score → PostGIS
                                                    ↓
                                            Redis pub/sub
                                                    ↓
                              WS /v1/ws/track → dashboard
```

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/health`, `/health/ready` | — |
| POST | `/v1/auth/bootstrap` | — (rate limited) |
| POST | `/v1/auth/login`, `/v1/auth/refresh` | — (rate limited) |
| GET | `/v1/auth/me` | user |
| POST | `/v1/auth/users` | admin |
| POST/GET | `/v1/drivers` | admin / user |
| POST | `/v1/devices` | admin |
| POST | `/v1/devices/provision` | enrollment code |
| GET | `/v1/devices`, `/v1/devices/{id}` | user |
| POST | `/v1/devices/{id}/revoke` | admin |
| GET/POST | `/v1/devices/me`, `/v1/devices/me/duty` | device |
| POST | `/v1/ingest/batch`, `/v1/ingest/single` | device |
| GET | `/v1/tracking/latest` | user |
| GET | `/v1/tracking/devices/{id}/history` | user |
| WS | `/v1/ws/track?token=…` | user |

## Security

| Control | Implementation |
|---|---|
| Password storage | bcrypt, 12 rounds; ≥12 chars, letters + digits |
| User auth | JWT access (60 min) + refresh (30 d); type-confusion blocked |
| Device auth | Opaque 40-byte token, stored as SHA-256 only |
| Revocation | Immediate, via Redis cache checked before the DB |
| Enrollment | Single-use expiring code, stored hashed |
| Tenant isolation | Every query filtered by `organization_id`; cross-tenant returns 404, never 403 |
| Role enforcement | `require_admin` dependency on all mutating admin routes |
| Rate limiting | Sliding window in Redis — login, provisioning, ingest |
| Input validation | Pydantic with `extra="forbid"`; typos rejected, not silently ignored |
| SQL injection | SQLAlchemy parameterised queries throughout |
| Body size cap | 2 MiB |
| Security headers | nosniff, DENY, no-referrer, CSP, no-store, HSTS in prod |
| Error handling | Stack traces never returned; generic 500 body |
| Docs exposure | `/docs` and `/openapi.json` disabled in production |
| Container | Runs as non-root uid 10001 |
| User enumeration | Login returns one error and equalises timing |

## Design decisions worth knowing

**Ingest never rejects on trust score.** Low-trust pings are stored and flagged. Legitimate GPS
produces terrible data in tunnels, basements and urban canyons — auto-blocking generates support
tickets and destroys driver trust. A discarded ping is also evidence you no longer have. See
`docs/ANTI_SPOOFING.md`.

**Per-item batch results.** One malformed fix never fails a batch; the response tells the app
exactly which entries it may purge from its outbox.

**Duplicates report `accepted: true`.** A retried batch after a lost ACK is already stored, so the
app should purge it. Reporting failure would make it retry forever.

**`geography` not `geometry`.** True metre distances across India without fighting UTM zones.

**Device tokens are opaque, not JWTs.** A JWT stays valid until expiry regardless of the database;
an opaque token can be revoked instantly.

## Known gaps (deliberate, for MVP)

- No refresh-token rotation or server-side revocation list — access tokens are short-lived instead.
- Rate limiting is a fixed window, not a true sliding log. Adequate here; swap for Lua if abuse appears.
- Rate limiting **fails open** if Redis is down. Availability was chosen over enforcement; revisit
  if this is ever internet-facing without a WAF.
- `X-Forwarded-For` is trusted for the client IP. Only correct behind a proxy that overwrites it.
- Trips/geofences are not implemented; the schema supports adding them.
- Play Integrity / App Attest (Layer 2 of the anti-spoofing plan) is not implemented yet.
