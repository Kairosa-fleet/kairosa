# Fleet Tracking Platform — Final Plan

**Status: planning complete, ready to build.** Last updated 2026-07-21.

A driver-tracking system: a mobile app reports location and device state; a web dashboard shows live positions and history.

---

## 1. Locked decisions

| Area | Decision | Rationale |
|---|---|---|
| **Backend** | Python 3.10 · FastAPI · SQLAlchemy 2 (async) | As requested |
| **Database** | PostgreSQL 16 + PostGIS 3.4 (Docker) | Geo queries in metres without projection headaches |
| **Cache / fan-out** | Redis 7 (Docker) | Lets multiple API workers share WebSocket state |
| **Web** | Next.js 15 · TypeScript · Tailwind | As requested |
| **Mobile** | **React Native + Expo SDK 57** | Reversed from Flutter — see §6 |
| **Maps** | **MapLibre GL + MapTiler tiles** | Reversed from Google Maps — see §6 |
| **Uplink** | Batched REST over HTTPS, SQLite outbox on device | Survives tunnels and dead zones; batching is the biggest battery lever |
| **Downlink** | WebSocket + Redis pub/sub | Live updates without polling |
| **Auth** | JWT for web admins · long-lived device tokens for phones | No driver login on a shared handset |
| **Background location** | `expo-location` + `expo-task-manager` (free) | First-party maintained; see [BACKGROUND_TRACKING.md](BACKGROUND_TRACKING.md) |
| **Integrity** | Server-side physics scoring, not client flags | See [ANTI_SPOOFING.md](ANTI_SPOOFING.md) |

Language split: **TypeScript** for web + mobile (shared types and API client), **Python** for the backend.

## 2. Data flow

```
Expo app                         FastAPI                      Next.js dashboard
────────                         ───────                      ─────────────────
GPS fix (adaptive 5–60 s)
  ↓
SQLite outbox ──HTTPS batch──▶  /v1/ingest/batch
(survives offline)                ↓ validate · dedupe by client_seq
                                  ↓ integrity score (physics checks)
                                  ↓ INSERT → PostGIS
                                  ↓ PUBLISH → Redis
                                                ↓
                                        WS /v1/ws/track ──▶ live marker on MapLibre
```

Details — schema, endpoints, indexes, retention — in [ARCHITECTURE.md](ARCHITECTURE.md).

## 3. Environment (installed and verified)

| Component | Status |
|---|---|
| Python venv, 50 packages | ✅ `.venv/` |
| PostGIS 16-3.4 + Redis 7 | ✅ defined in `docker-compose.yml` |
| Android SDK 36 · build-tools 36 · platform-tools 37 | ✅ carries over to React Native |
| JDK 17 (Temurin) | ✅ system Java 11 untouched |
| MapTiler key | ✅ verified — style 200, Vadodara z14 tile returns 130 KB |
| JWT secret | ✅ generated into `.env` |
| Debug keystore SHA-1 | ✅ `D8:E0:AE:3B:22:A0:D0:BB:58:B7:49:51:4D:0F:CE:D5:E5:F4:D4:3C` |
| **Node 20+** | ⬜ **required** — currently 18; install via `nvm`, no sudo |
| Flutter 3.44.7 | ⚠️ installed but now unused — deletable (~2.5 GB) |

## 4. Build phases

### Phase 1 — Backend
Models + Alembic PostGIS migration · JWT and device-token auth · `POST /v1/ingest/batch` with per-item accept/reject · integrity scoring service · `WS /v1/ws/track` with Redis fan-out · fleet / history / trips endpoints.
**Exit criteria:** full round trip provable with `curl` — provision a device, post a batch, see it stored, watch it arrive on a WebSocket.

### Phase 2 — Web dashboard
Next.js 15 + TS + Tailwind · login · fleet list with live status · MapLibre map mounted once · live markers over WebSocket · history replay · integrity/alerts view.
**Exit criteria:** a `curl`-injected point moves a marker on screen in real time.

### Phase 3 — Mobile
Expo dev build · `LocationService` abstraction · foreground service + staged permission ladder · SQLite outbox with batched sync · on/off-duty toggle · MapLibre map · integrity signal collection · **diagnostics screen**.
**Exit criteria:** an 8-hour real-device shift with no lost pings.

### Phase 4 — Hardening
Play Integrity / App Attest · OEM walkthrough screens + server-side liveness verification · real-device matrix (Xiaomi, Realme/Oppo, Samsung, iPhone) · retention and downsampling job.

Phases 1 and 2 are fully verifiable on this machine. Phase 3 needs your devices.

## 5. Known risks

1. **Background survival on Indian OEM handsets.** Xiaomi/Oppo/Vivo/Realme kill background services aggressively, and the required autostart toggles cannot be set programmatically — only guided and then verified server-side. The largest chunk of Phase 3, and only provable on real hardware. *You are testing on devices; the app ships with a diagnostics screen so those sessions produce evidence rather than impressions.*
2. **iOS force-kill cannot be recovered by the free stack.** Framework-independent. Mitigated by server-side liveness alerting, which is in the plan anyway because it also catches dead batteries and lost signal.
3. **Border compliance deferred.** Fine for development; must be resolved before any public deployment in India. See [MAPPING_STACK.md](MAPPING_STACK.md).
4. **Client-reported `isMockLocation` is nearly worthless alone.** Handled by server-side physics scoring, which is cheap and platform-independent.

## 6. Decisions that were reversed, and why

Recorded so the reasoning isn't lost.

**Google Maps → MapLibre + MapTiler.** The Google Cloud billing account turned out to be closed, and reopening ran into India-specific recurring-payment friction. Rather than fight it, we separated the *rendering engine* from the *tile provider* — which Google deliberately bundles. MapTiler needs no credit card, gives 100k loads/month, and the provider is now one env var. Consequence: the map-load-minimisation constraint that shaped the original design **no longer binds**. Production may still swap to Google — costed at a day or two in [MAPPING_STACK.md](MAPPING_STACK.md).

**Flutter → React Native + Expo.** Two findings. First, the claim that Flutter's free background stack was better maintained did not survive a registry check: `expo-location` is first-party, funded, and shipped 4 days ago, while Flutter's foreground-service piece rests on a single volunteer. Second and decisive — much stronger in TypeScript than Dart, and the outbox, retry, dedup and integrity logic is *our* code where fluency matters most. Bonus: shared types with the Next.js app, and EAS Build produces iOS builds without a Mac.

**Paid `background_geolocation` → free stack.** Chosen deliberately; the gap and its mitigations are documented in [BACKGROUND_TRACKING.md](BACKGROUND_TRACKING.md). The paid package exists for React Native too, so the escape hatch remains open.

## 7. Documents

| Doc | Contents |
|---|---|
| [PLAN.md](PLAN.md) | This file — the index |
| [BACKEND.md](BACKEND.md) | **Built backend — every file, function, API, test results** |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | **Bear-derived visual system, assets, licences** |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Transport, schema, API, auth, build order |
| [MAPPING_STACK.md](MAPPING_STACK.md) | MapLibre + MapTiler; production swap path |
| [ANTI_SPOOFING.md](ANTI_SPOOFING.md) | 4-layer location integrity |
| [BACKGROUND_TRACKING.md](BACKGROUND_TRACKING.md) | OEM survival, permission ladder, package choice |
| [GOOGLE_MAPS_SETUP.md](GOOGLE_MAPS_SETUP.md) | Obsolete; retained for a future production swap |

## 8. Progress

**Phase 1 (backend): COMPLETE.** 74 tests + 41 end-to-end checks passing, migration applied, lint clean. Full reference in [BACKEND.md](BACKEND.md).

**Phase 2 (web dashboard): COMPLETE.** Next.js 16 + React 19 + Tailwind 4. Login, live MapLibre map, device enrolment, drivers, integrity monitoring, light/dark, responsive. Typecheck + lint + build clean; verified in a real headless browser with zero console errors. See [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) and `web/README.md`.

**Next:** Phase 3 — the Expo mobile app.
