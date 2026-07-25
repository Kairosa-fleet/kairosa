# Fleet Tracking Platform — Architecture Plan

Three tiers: **Flutter** (driver app, Android + iOS) → **FastAPI** (ingest + fan-out) → **Next.js** (tracker dashboard). Live map on both ends via Google Maps.

---

## 1. Transport: how a location gets from phone to screen

You asked for the best option under a hard constraint: **minimise Google Maps API requests.** That constraint does not actually affect the transport choice, because Maps is billed per *map load*, not per marker move — see §6. So the transport is chosen purely on reliability and battery:

```
Flutter app                    FastAPI                      Next.js dashboard
-----------                    -------                      -----------------
GPS fix
  ↓
SQLite outbox  ──HTTPS POST──▶  /v1/ingest/batch
(offline queue)   (batched)       ↓ validate + dedupe
                                  ↓ INSERT into PostGIS
                                  ↓ PUBLISH to Redis channel
                                                ↓
                                          WebSocket /v1/ws/track  ──▶  live marker
```

**Uplink (phone → server): batched REST over HTTPS.** Points are written to an on-device SQLite outbox first, then flushed in batches of up to 50. This is the only design that survives the Indian mobile-network reality — tunnels, basements, patchy 4G. A dropped connection loses nothing; the outbox drains when signal returns. Batching also cuts radio wake-ups, which is the single biggest battery lever.

**Downlink (server → viewers): WebSocket.** Viewers hold one socket and receive pushes. Polling would add latency and burn requests for nothing.

**Redis pub/sub in the middle** so that any number of FastAPI workers can serve sockets — worker A receives the ingest, worker B holds the viewer's socket, Redis bridges them. Without it you are locked to a single process forever.

Cadence on the device, adaptive:

| State | Interval | Distance filter |
|---|---|---|
| Driving (>5 m/s) | 5 s | 25 m |
| Slow / urban | 10 s | 15 m |
| Stationary >3 min | 60 s heartbeat | — |

---

## 2. Data model (PostgreSQL 16 + PostGIS 3.4)

Your payload maps to five tables:

```
organizations ─┬─ users        (admins/trackers; email + password hash; role)
               ├─ drivers      (name, phone, org)
               └─ devices      (deviceId UUID, platform, token hash, driver_id FK)
                                    │
                                    ├─ location_pings   ← the hot table
                                    └─ trips            (derived: start/end, distance, path)
```

`location_pings` — one row per fix, exactly mirroring your JSON:

| Column | Type | From payload |
|---|---|---|
| `id` | bigserial PK | |
| `device_id` | uuid FK | `deviceId` |
| `driver_id` | uuid FK | `driverId` |
| `recorded_at` | timestamptz | `timestamp` (device clock) |
| `received_at` | timestamptz | server clock — you need both to detect skew |
| `geom` | `geography(Point,4326)` | `location.latitude/longitude` |
| `accuracy_m` | real | `location.accuracy` |
| `altitude_m` | real | `location.altitude` |
| `altitude_accuracy_m` | real | `location.altitudeAccuracy` |
| `speed_mps` | real | `movement.speed` |
| `bearing_deg` | real | `movement.bearing` |
| `activity` | enum | `movement.activity` |
| `battery_level` | real | `deviceState.batteryLevel` |
| `is_charging` | bool | `deviceState.isCharging` |
| `network_status` | enum | `deviceState.networkStatus` |
| `is_mock_location` | bool | `deviceState.isMockLocation` |
| `client_seq` | bigint | device-side counter, for idempotency |

Indexes: `(device_id, recorded_at DESC)` for history queries, GiST on `geom` for geofences, and a **unique `(device_id, client_seq)`** so a retried batch after a flaky ACK cannot double-insert.

`geography` not `geometry` — it does true spherical distance in metres, which is what you want for "how far did this vehicle travel" without fighting UTM zone projections across India.

**Retention:** raw pings are large (≈1 device × 5 s × 10 h/day ≈ 7 200 rows/day). Plan a nightly job that downsamples pings older than 90 days into the `trips` path geometry and deletes the raw rows. If you later keep years of full-resolution data, add TimescaleDB — the schema above is compatible.

**`isMockLocation` is a security signal, not a display field.** Store it, flag the ping, surface it to admins. Drivers spoofing GPS is the most common fraud in fleet tracking.

---

## 3. API surface

**Device (device-token auth)**
- `POST /v1/devices/provision` — one-time, exchanges an admin-issued enrolment code for a long-lived device token
- `POST /v1/ingest/batch` — array of your payload objects; returns per-item accepted/rejected so the app knows what to purge from its outbox
- `POST /v1/ingest/single` — same shape, one point; for debugging with curl

**Web (JWT, admin/tracker)**
- `POST /v1/auth/login`, `POST /v1/auth/refresh`
- `GET /v1/devices` — fleet list with each device's latest ping (one query, `DISTINCT ON`)
- `GET /v1/devices/{id}/history?from=&to=` — polyline for replay
- `GET /v1/devices/{id}/trips`
- `WS /v1/ws/track?token=…&devices=…` — live stream; server pushes `{deviceId, lat, lng, bearing, speed, ts}` deltas only

**Both**
- `GET /health`, `GET /v1/me`

Validation on ingest rejects: accuracy worse than 100 m, timestamps more than 24 h old or in the future, coordinates outside plausible bounds. Garbage in the DB is far more expensive to remove than to refuse.

---

## 4. Auth

- **Web:** email + password → short-lived access JWT (60 min) + refresh token. Role on the claim: `admin` sees the org's whole fleet, `tracker` sees an assigned subset, `driver` sees only itself.
- **Mobile:** the device is provisioned once with an enrolment code an admin generates; it receives a long-lived device token bound to `deviceId`. No driver login screen, no password on a shared vehicle handset. Tokens are stored **hashed** server-side and held in the OS keystore on device (`expo-secure-store` → Android Keystore / iOS Keychain), never in plain preferences.
- Admin can revoke a device instantly; ingest checks a revocation flag cached in Redis.

---

## 5. Mobile app — React Native + Expo

Packages: `expo-location` + `expo-task-manager` (background tracking), `@maplibre/maplibre-react-native` (see [MAPPING_STACK.md](MAPPING_STACK.md)), `expo-sqlite` (outbox), `expo-secure-store` (device token), `expo-battery`, `expo-network`, `expo-device`, `expo-notifications`, `zustand`, `@tanstack/react-query`.

Shares TypeScript types and the API client with the Next.js web app — one definition of the ingest payload across both. See [BACKGROUND_TRACKING.md](BACKGROUND_TRACKING.md) for why this stack over Flutter.

The hard part is not the map — it is **staying alive in the background.** Budget real time for:
- Android: foreground service with a persistent notification, `ACCESS_BACKGROUND_LOCATION` permission with Google's justification flow, and per-OEM battery-optimisation whitelisting (Xiaomi/Oppo/Vivo/Realme kill background services aggressively — this matters a lot for an Indian fleet).
- iOS: `UIBackgroundModes: location`, "Always" authorisation, and the blue status bar. App Store review requires a clear in-app explanation of why you track continuously.

`isMockLocation` comes from the Android fix's `mocked` field; on iOS there is no equivalent, so infer it (implausible jumps, simulator detection) and mark iOS values as `false` with lower trust. See [ANTI_SPOOFING.md](ANTI_SPOOFING.md).

---

## 6. Maps — superseded

> **This section is obsolete.** Google Cloud billing proved unworkable, so we moved to
> **MapLibre GL with a swappable tile provider (MapTiler default, Ola Maps for India)**.
> See **[MAPPING_STACK.md](MAPPING_STACK.md)** for the current design.
>
> Consequence: the map-load-minimisation constraint below **no longer binds**, since the new
> providers' free tiers are far beyond this app's usage. Everything else in this document —
> transport, schema, API, auth, mobile background handling — is provider-independent and unchanged.
> The Google material is retained below only in case you revisit it later.

### (Superseded) Google Maps — getting a key, and keeping the bill at zero

**How billing actually works, since this drove your constraint:**

- **Maps SDK for Android / iOS: unlimited and free.** Google stopped charging for mobile dynamic maps. Your Flutter app can render maps all day at no cost.
- **Maps JavaScript API (the Next.js dashboard): billed per map *load*.** A "load" is one `new google.maps.Map()` instantiation. Moving markers, panning, zooming, and streaming a thousand WebSocket updates into an existing map cost **nothing extra**. Free tier covers roughly 10 000 loads/month.

So the way to stay free is not to send fewer position updates — it is to **create fewer map instances**:

1. Mount the map **once** in a persistent layout component and never unmount it on navigation. In Next.js App Router, put it above the route segments that change. A remount on every page view is what silently burns quota.
2. Do not create a second map for a modal or thumbnail — reuse the one instance, or render a static polyline in plain SVG for small previews.
3. Guard against React 18 StrictMode double-mounting in dev, which doubles your dev loads.
4. **Never call the paid extras**: Directions, Roads (snap-to-road), Distance Matrix, Geocoding, Places, Static Maps. These bill per request and will dwarf map loads. If you need route-snapping or address lookup later, self-host OSRM and Nominatim — free and India-complete from OpenStreetMap data.
5. Use a **separate key for local development** so your dev refreshes never touch the production quota, and set a **budget alert at ₹0** in Google Cloud Billing.

**Getting the key — do this yourself, I cannot:**

1. <https://console.cloud.google.com> → create a project (e.g. `fleet-tracking`).
2. **Billing must be enabled** even for free-tier use — Google requires a card on file. Set a budget alert immediately after.
3. APIs & Services → Library → enable exactly three: **Maps SDK for Android**, **Maps SDK for iOS**, **Maps JavaScript API**. Enable nothing else.
4. Credentials → Create credentials → API key. **Create three separate keys**, because restrictions differ per platform:
   - *Web key* → Application restriction: **HTTP referrers** → `http://localhost:3000/*` and your production domain. API restriction: Maps JavaScript API only.
   - *Android key* → Application restriction: **Android apps** → your package name + the SHA-1 from `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`. API restriction: Maps SDK for Android only.
   - *iOS key* → Application restriction: **iOS apps** → your bundle ID. API restriction: Maps SDK for iOS only.
5. For the web dashboard also create a **Map ID** (Google Maps Platform → Map Management) — required for the modern `AdvancedMarkerElement`, and it lets you restyle the map without code changes.
6. Put the keys in `.env` (already gitignored). Give me nothing — the app reads them from env at build time.

An unrestricted key scraped from your JS bundle is the standard way people wake up to a large bill. Restrict on day one.

**On "official Indian map":** Google Maps renders Indian borders per the Survey of India depiction when served from an Indian domain/locale. Set `region: 'IN'` and `language` on the JS loader. If you later need a strictly government-certified basemap, the alternative is MapmyIndia/Mappls (Indian, NMA-compliant) — worth knowing it exists, but Google with `region=IN` is what almost every Indian fleet product ships.

---

## 7. What's already set up in this repo

```
application/
├── .venv/                 ← Python 3.10.12, 50 packages installed
├── .env.example           ← copy to .env and fill in
├── .gitignore             ← secrets and key files excluded
├── docker-compose.yml     ← PostGIS 16-3.4 + Redis 7
├── backend/
│   ├── requirements.txt
│   └── app/{api,core,models,schemas,services}/
├── web/                   ← Next.js goes here
├── mobile/                ← Flutter goes here
└── docs/ARCHITECTURE.md
```

Local Postgres server is not installed, so the DB runs in Docker (`docker compose up -d`). Flutter is **not installed** on this machine — that install is the one step I need you to do (§8).

---

## 8. Build order

1. **Backend** — models, Alembic migration, auth, ingest, WebSocket. Testable end to end with `curl` before any UI exists.
2. **Web** — Next.js 15 + TypeScript + Tailwind, login, fleet list, single persistent map, WebSocket client.
3. **Mobile** — Flutter app, background location, SQLite outbox, map view. Requires you to install Flutter first: <https://docs.flutter.dev/get-started/install/linux> (plus Android Studio for the SDK and an emulator; iOS builds need a Mac).

Backend and web I can build and verify here. Mobile I can write in full, but you'll run `flutter run` yourself.
