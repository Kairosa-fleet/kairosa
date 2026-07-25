# Mobile App (Expo SDK 57 / React Native 0.86)

The driver-side app: enrols once with a code, tracks location while on duty,
queues everything locally, and syncs when there's signal.

## Running

```bash
# 1. Backend must be reachable (from repo root)
docker compose up -d
cd backend && PYTHONPATH=. ../.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000

# 2. Let the phone reach the laptop's localhost over USB
adb reverse tcp:8000 tcp:8000

# 3. Install the dev build, then start the bundler
cd mobile
npx expo run:android          # first build ~5-15 min
npx expo start --dev-client   # subsequent runs: JS only, seconds
```

Get an enrolment code from the dashboard: **Devices → Add device**.

> **Not Expo Go.** Background location needs native modules Expo Go doesn't
> ship. This is a dev build, which is normal and expected — not a workaround.

## Architecture

```
App.tsx                  route = f(enrolled, permissions) — derived, not stored
src/lib/
  config.ts              API URL, cadence, colours
  types.ts               wire contract — mirrors the FastAPI schemas
  api.ts                 device-token client; token in OS keystore
  db.ts                  SQLite outbox + diagnostics log + client_seq
  deviceState.ts         battery / network / mock-location signals
  sync.ts                outbox → server, with confirm-before-delete
  locationTask.ts        the background task (registered at module scope)
  locationService.ts     the ONLY module that knows how tracking works
  useTracking.ts         duty state, reconciliation, periodic flush
src/screens/
  EnrolScreen            one-time code → device token
  PermissionScreen       the staged permission ladder + OEM walkthrough
  DutyScreen             the switch, queue health, integrity score
  DiagnosticsScreen      event log, kill counter, exportable
```

## Decisions worth knowing

**The task is registered at module scope, not in a component.** Android can
relaunch the app directly into the background task with no UI. If registration
happened inside a `useEffect`, the task would be undefined on a headless
relaunch and every fix collected while the app was killed would be lost.

**A fix is written to SQLite before anything else.** It's deleted only once the
server confirms it. That's what makes tunnels, basements and dead cells
survivable — a fix is never held only in memory.

**Duplicates count as confirmed.** The server's unique `(device_id, client_seq)`
constraint catches a retry after a lost ACK. It already has the data, so
deleting locally is correct; treating it as a failure would retry forever.

**Rejected fixes are also deleted.** The server will never accept a fix that's
too old or too inaccurate. Retrying is pure battery waste.

**Duty state is stored locally as well as on the server.** The phone must know
it's on duty even with no connection, otherwise a network outage would
silently end a shift. The server call is best-effort.

**Bearing is dropped below 1 m/s.** A stationary GPS produces random heading
noise, which would trip the server's bearing-vs-trajectory integrity check and
falsely lower the device's trust score.

**`mocked` is only trusted when true.** On Android, `true` from the OS has no
plausible false positive. `false` proves nothing — a rooted phone reports
`false` while feeding fake coordinates. iOS has no equivalent API at all. This
is why the real detection is the server-side physics, not this flag.

**Everything sits behind `locationService.ts`.** If the free stack proves
inadequate in the field, swapping to `react-native-background-geolocation`
touches one file.

## The hard part: staying alive

Not the map — surviving OEM battery managers. See
`docs/BACKGROUND_TRACKING.md`.

- **Foreground service with a persistent notification** — the only class of
  background work Android protects. Don't fight the notification; drivers are
  entitled to see they're being tracked.
- **Staged permissions** — Android 11+ hides "Allow all the time" from the
  first dialog, so background must be a separate, later request, after an
  in-app explanation. Skipping the explanation roughly halves grant rates, and
  Play Store *requires* the disclosure.
- **OEM whitelisting can't be automated.** Autostart toggles on
  Xiaomi/Oppo/Vivo live in the OEM's own settings. The app detects the
  manufacturer, shows exact per-brand steps, and then **verifies empirically**
  — if the service dies while on duty, it's recorded as `unexpected_restart`.

That last part is what most implementations skip. "We told them to enable it"
becomes "we know whether it's enabled".

## Field testing

Diagnostics screen → **Export log** shares a timestamped timeline.

Per device: 8-hour drive screen-off · overnight idle · airplane mode 30 min
(does the outbox drain?) · force-stop from recents (does it recover?) · reboot
mid-shift · battery drain over a full shift.

Watch the **unexpected restarts** counter. Non-zero means the OEM killed the
service — that's the number that matters, and it's invisible without this
screen.

## Known gaps

- **iOS force-kill can't be recovered** by the free stack. Android restarts
  fine. Mitigated by server-side liveness alerting (a device silent >10 min
  while on duty alerts dispatch), which is in the plan regardless because it
  also catches dead batteries.
- **No map screen yet.** Deliberate — drivers need to know tracking *works*,
  not watch themselves move. The dashboard is where maps matter.
- **No Play Integrity attestation** (Layer 2 of the anti-spoofing design).
  Layer 3 — the server-side physics — is complete and does the real work.
- **No unit tests.** Verification so far is typecheck + a real build on a real
  Redmi.
