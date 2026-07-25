# Web Dashboard (Next.js 16)

Live fleet map, device enrolment, and location-integrity monitoring.

## Running

```bash
# 1. Infrastructure + API (from the repo root)
docker compose up -d
cd backend && PYTHONPATH=. ../.venv/bin/uvicorn app.main:app --port 8000

# 2. Demo data (optional, idempotent — safe to re-run)
cd backend && PYTHONPATH=. ../.venv/bin/python scripts/seed_demo.py

# 3. Web
cd web && npm run dev        # http://localhost:3000
```

Demo login: `demo@example.com` / `correct-horse-battery-1`

> Node 20+ required (this repo uses 22 via `nvm`). Next 16 defaults to Turbopack.

## Structure

```
src/
  app/
    layout.tsx          root layout — local fonts, theme script, providers
    page.tsx            entry redirect
    login/              sign in + first-run organisation setup
    (dash)/
      layout.tsx        authenticated shell — nav, theme, sign out
      fleet/            live map (the main screen)
      devices/          enrolment, revocation, trust scores
      drivers/          driver records
  components/
    FleetMap.tsx        MapLibre, mounted once, imperative markers
    VehicleList.tsx     sidebar, sorted worst-status-first
    VehicleDetail.tsx   telemetry + integrity breakdown
    ui.tsx              Button, Input, Card, StatusBadge, EmptyState…
    Logo.tsx            inline SVG mark (inherits currentColor)
    ThemeToggle.tsx     light / dark / system
    Providers.tsx       React Query client
  lib/
    api.ts              typed client, token storage, silent refresh
    types.ts            wire types + deviceHealth() — shared with mobile later
    queries.ts          React Query hooks
    useLiveTracking.ts  REST seed + WebSocket, backoff with jitter
    useHydrated.ts      hydration-safe gate for browser-only state
    mapProvider.ts      tile provider config (one place to swap vendors)
    format.ts           units — km/h, metres, compass, relative time
```

## Decisions worth knowing

**The map is mounted once and never unmounted.** Markers are managed imperatively
against the MapLibre instance rather than as React children — re-rendering a marker
tree on every WebSocket frame would thrash the DOM. Theme changes call `setStyle`
instead of rebuilding the map, and the detail panel *floats over* the map so the
map never resizes (a resize forces every tile to re-render).

**Server state lives in React Query, never in `useEffect` + `setState`.** React 19's
lint rejects that pattern because it causes cascading renders. The WebSocket writes
straight into the query cache, so there is exactly one source of truth.

**`deviceHealth()` is in `lib/types.ts`, not in a component.** The map marker, the
sidebar row and the detail panel all derive status from the same function, so they
cannot disagree with each other.

**Colour never carries meaning alone.** Every status has an icon and a text label,
so it survives colour-blindness and greyscale.

**The accent is teal, not Bear's red.** Red already means offline/spoofed/critical
here; a red brand colour would collide with the alarm colour. See
`docs/DESIGN_SYSTEM.md`.

## Environment

`.env.local` (gitignored):

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8000
NEXT_PUBLIC_MAP_PROVIDER=maptiler
NEXT_PUBLIC_MAPTILER_KEY=…
```

The backend's `CORS_ORIGINS` must list the exact origin you browse from —
browsers treat `localhost` and `127.0.0.1` as different origins.

## Checks

```bash
npx tsc --noEmit                # types
npx eslint src --max-warnings=0 # lint
npm run build                   # production build
```

All three pass clean, and the app runs with zero browser console errors.

## Not done yet

- No component tests. Verification so far is a real headless browser driving the
  full flow across light/dark/mobile, which caught more than unit tests would
  have — but it is not a regression suite.
- Tokens are in `localStorage`, so a successful XSS could exfiltrate them.
  httpOnly cookies would be stronger; bearer tokens were chosen because the mobile
  app needs them and two auth schemes double the surface area.
- History replay draws a static polyline; no time scrubber yet.
- No pagination — fine for hundreds of devices, not thousands.
