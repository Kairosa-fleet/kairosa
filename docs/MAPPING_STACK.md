# Mapping Stack — Decision

**Engine: MapLibre GL (open source, vendor-neutral). Tiles: MapTiler.**

No Google Cloud billing account. No card required.

> **Decided 2026-07-21:** MapTiler only. Ola Maps is **not** being integrated — its Flutter
> auth path was unverified and we don't need it. The provider abstraction stays in place
> (one env var), so switching later remains cheap, but there is no second provider to build
> or test against now.
>
> **Key is configured and verified working** — `streets-v2` style returns 200, and the
> Vadodara z14 tile returns 130 KB of vector data, confirming dense India road coverage.
>
> **Production intent:** the user plans to evaluate Google Maps or another commercial
> provider at deployment time. That's a config swap plus a renderer change, not a rewrite —
> see "Consequences" below.

---

## The key insight

"Google Maps alternative" sounds like picking a competitor. It isn't. The right move is to separate two things Google bundles together:

1. **The rendering engine** — draws the map, markers, polylines, handles pan/zoom
2. **The tile/data provider** — supplies the actual map imagery and road data

Google forces you to take both, from them, with their billing attached. **MapLibre GL separates them.** MapLibre is the engine (a community fork of Mapbox GL from before it went closed-source, now used by AWS, Meta, and the Wikimedia Foundation). It renders *any* provider's vector tiles.

So the provider becomes a **config value, not an architecture**. If MapTiler's pricing changes, or Ola's India data turns out to be better, we change one environment variable. That's the property Google Maps specifically denied you, and it's why this is the right answer regardless of which provider we start with.

## Why not the obvious candidates

| Option | Verdict |
|---|---|
| **Mapbox** | Good engine, but same trap — card required, per-load billing, vendor lock-in. Trading one billing dependency for another. |
| **Ola Maps (as an SDK)** | **No official Flutter SDK** — Ola's own team has confirmed this. Only third-party community wrappers exist. Unacceptable dependency for a production fleet app. *But see below — we can still use their data.* |
| **Mappls / MapmyIndia** | Genuinely excellent Indian data, NMA-compliant, but paid tiers arrive quickly and the SDK is India-only, locking us in again. |
| **Raw OpenStreetMap tiles** | Free, but OSM's public tile servers explicitly forbid production use and will block you. Fine for a demo, not for a product. |
| **Leaflet / flutter_map** | Raster-only, no vector styling, no smooth rotation for bearing arrows. A step backwards. |

## What we're using

### Engine (both platforms)

- **Web:** `maplibre-gl` — the direct, mature equivalent of the Google Maps JS API
- **Mobile:** `@maplibre/maplibre-react-native` v11.3.6 — maintained under the official MapLibre GitHub org, Android + iOS

Both are MIT/BSD licensed. No key needed for the *engine* — only for tiles.

### Tile provider — default: MapTiler

- **100,000 map loads/month free, and no credit card required to sign up.** That is the single most important property given the billing problems you hit.
- OpenStreetMap-derived vector tiles, globally maintained, updated continuously
- Works in both `maplibre-gl` and Flutter's `maplibre_gl` by putting the key directly in the style URL — no special request-signing plumbing
- Satellite imagery and terrain available on the same key

### Tile provider — India option: Ola Maps

Worth knowing because it's the strongest India-specific data available on a free tier:

- **5 million API calls/month free, per API** — vastly more generous than anything Google offers
- Priced ~50% below Google beyond that
- India-first road data, Indian address formats, and correct Survey of India border depiction
- **Their tiles are MapLibre-compatible** — a standard `style.json` at `https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json`, consumed by the same engine

This is why dropping Ola's *SDK* doesn't mean dropping Ola's *data*. We use MapLibre as the engine and point it at Ola's tiles — sidestepping the missing Flutter SDK entirely.

**One caveat I have not yet verified on-device:** Ola authenticates with an `api_key` query parameter on *every* tile, sprite, and glyph request. On web this is a one-line `transformRequest` callback. Flutter's `maplibre_gl` has weaker support for rewriting requests, so this may need the backend proxy described below. I'll validate it on your phone before committing to Ola as the default — until then MapTiler is the safe path, since its key-in-URL scheme works on both platforms with no workaround.

## Architecture: providers stay swappable

```
shared/mapProvider.ts   ← single source of truth: style URL + attribution
                          consumed by BOTH the Next.js app and the Expo app
```

Because web and mobile are now both TypeScript, this is genuinely one shared module rather than two parallel implementations.

Both read a single `MAP_PROVIDER` value (`maptiler` | `ola` | `custom`). Switching providers is an env change and a restart, not a code change. The tracking logic, markers, and polylines are all provider-agnostic MapLibre calls.

### Optional: backend tile proxy

FastAPI can proxy `/v1/tiles/*` to the provider, injecting the key server-side. Benefits: the key never reaches the client, we can swap providers without redeploying apps, and it solves Ola's per-request auth on Flutter.

**Check the provider's terms before enabling this.** MapTiler's terms restrict proxying and re-caching of tiles; doing it without permission risks your account. It's a real option for Ola, and a "get written permission first" option for MapTiler — not something to switch on casually.

## Data accuracy — an honest comparison

You asked for accurate, up-to-date data. Straight answer:

- **For vehicle tracking specifically, OSM-based tiles are entirely sufficient.** You are drawing a dot on a road and a line behind it. Road geometry in Indian cities is well-mapped and updated continuously by a large community.
- **Google is still ahead** on business/POI names, very recent road changes, and rural coverage. If you later need turn-by-turn navigation or address search, that gap matters.
- **Ola Maps closes most of that gap for India specifically**, which is exactly why it stays a first-class option here.
- **We are not using routing, geocoding, or place search at all** in the current design, so the gap does not affect this product today.

### Border compliance — deferred to deployment (decided 2026-07-21)

MapTiler/OSM renders borders in disputed regions per OSM convention, which does not necessarily match Survey of India requirements.

**Accepted for development.** This is a legal question, not a technical one, and it does not affect building or testing the product.

**Revisit before any public deployment in India.** Under the National Geospatial Policy, publishing non-compliant maps of India carries real legal exposure for a commercially distributed app. At that point, switch the tile provider to a compliant source — Google, Mappls/MapmyIndia, or Ola all qualify. Logged here so it isn't forgotten at launch.

## Setup status

**MapTiler: done.** Key is in `.env` and verified against both the style endpoint and live India tiles. Nothing outstanding.

One optional hardening step: MapTiler keys are inherently public (they ship in the JS bundle and the app binary), so restrict them at [cloud.maptiler.com](https://cloud.maptiler.com) → Account → Keys → Restrictions → allowed origins. Not required for development.

**Google Cloud:** nothing needed. The closed billing account can stay closed. [GOOGLE_MAPS_SETUP.md](GOOGLE_MAPS_SETUP.md) is retained for the eventual production evaluation.

## Consequences for the rest of the plan

- The map-load-minimisation constraint that shaped the earlier design **no longer binds**. MapTiler's 100k free loads and Ola's 5M calls are far beyond this application's usage. The "mount the map once, never remount" discipline is still good practice, but it's no longer a billing risk.
- Nothing in the backend, database, ingest pipeline, integrity scoring, or background-tracking design changes. Those were always provider-independent.
- Mobile dependency: `@maplibre/maplibre-react-native` (v11.3.6, 26 days ago — actively maintained).

### Swapping to Google Maps at production time

Since that's the stated plan, here's the actual cost so it can be budgeted rather than discovered:

- **Backend, database, ingest, integrity, WebSocket, tracking logic: zero change.** All provider-independent.
- **Web:** MapLibre GL and the Google Maps JS API have different APIs, so the map component gets rewritten — roughly one file. Markers, polylines and camera control are conceptually identical.
- **Mobile:** `@maplibre/maplibre-react-native` → `react-native-maps` (Google provider), again confined to the map component behind our interface.
- **Ops:** back to a working billing account, three restricted keys, a Map ID, and SHA-1 fingerprints — [GOOGLE_MAPS_SETUP.md](GOOGLE_MAPS_SETUP.md) already documents all of it, including your debug SHA-1.

Estimate: a day or two, isolated to two files plus the Google Cloud setup. Worth noting the trade you'd be making — Google's advantage here is POI names and rural coverage, neither of which this product uses today, against per-load billing and the account fragility you already hit. Worth re-testing MapTiler against real routes before assuming the swap is necessary.
