# Background Location Survival

The map is easy. **Staying alive is the entire engineering problem**, and it's where most fleet-tracking apps quietly fail — they work perfectly on the developer's Pixel and lose 40% of pings on the drivers' Redmi handsets.

You said WhatsApp and others do this properly, and that's the right benchmark. Below is what "properly" actually means.

---

## Why Android kills you

Stock Android has Doze mode and app standby. On top of that, **Chinese OEM skins add their own far more aggressive killers** — and these dominate the Indian market:

| OEM | Skin | Behaviour |
|---|---|---|
| Xiaomi/Redmi/POCO | MIUI / HyperOS | Kills background apps within minutes unless "Autostart" is enabled *and* battery saver set to "No restrictions" |
| Oppo / Realme / OnePlus | ColorOS / OxygenOS | Aggressive freeze; needs "Allow background activity" + autostart |
| Vivo / iQOO | Funtouch / OriginOS | "High background power consumption" whitelist required |
| Samsung | One UI | Sleeping apps / "Deep sleeping apps" list must be cleared |
| Huawei | EMUI | Manual "Protected app" toggle |

Combined, that's the large majority of your fleet. **None of these can be handled in code alone** — they require a user-granted toggle in a settings screen buried three levels deep in the OEM's own UI. This is not a bug we can engineer around; the correct product response is to *guide the driver through it and then verify it worked*.

## The architecture that survives

### 1. Foreground Service with a persistent notification (Android)

This is the non-negotiable foundation, and it's exactly what WhatsApp does during a call. A foreground service with an ongoing notification is the only class of background work Android treats as user-visible and therefore protects from routine killing.

- `foregroundServiceType="location"` (required, Android 10+)
- Persistent, non-dismissable notification: *"Tracking active — On duty since 9:15 AM"*
- `FOREGROUND_SERVICE_LOCATION` permission (Android 14+)

**Do not fight the notification.** Drivers should see that they're being tracked — it's an honesty requirement, and on Android 13+ it's unavoidable anyway.

### 2. The permission ladder (order matters)

Requesting background location cold-turkey gets denied. Android 11+ deliberately hides "Allow all the time" from the first prompt. The sequence that actually works:

1. **In-app explainer screen first** — plain language, before any system dialog. "We track your location while you're on duty so dispatch can route jobs to you. Tracking stops when you go off duty."
2. Request `ACCESS_FINE_LOCATION` → system dialog → "While using the app"
3. **Then** a second explainer → request `ACCESS_BACKGROUND_LOCATION` → this opens *Settings*, where the driver must manually pick "Allow all the time"
4. Request `POST_NOTIFICATIONS` (Android 13+) — without it, your foreground notification is silent and the service is far more killable
5. Request battery optimisation exemption (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`)

Skipping step 1 roughly halves grant rates. Google Play also **requires** a prominent disclosure for background location, and will reject the app without it.

### 3. OEM whitelisting — guided, then verified

For the OEM settings we cannot toggle programmatically:

- Detect manufacturer via `Build.MANUFACTURER`
- Show an **OEM-specific illustrated walkthrough** ("Settings → Apps → Fleet → Autostart → Enable") with a button that deep-links straight to that OEM's settings intent where one exists (MIUI, ColorOS, Funtouch all expose known intents)
- **Then verify empirically.** Don't trust that they did it — watch for the service being killed. If the app was terminated without an off-duty event, flag the device as `unstable_background` on the server and re-prompt.

That server-side verification is the part most implementations skip, and it's what turns "we told them to enable it" into "we know it's enabled."

### 4. Watchdogs — recovery when killed anyway

Defence in depth, because sometimes it still dies:

- `START_STICKY` service so Android restarts it when memory frees
- `RECEIVE_BOOT_COMPLETED` → restart tracking after reboot if the driver was on duty
- **WorkManager periodic job (15 min)** — the OEM-proof backstop. WorkManager survives kills that a Service doesn't; it checks "should I be tracking?" and restarts the service if so. Worst case you lose 15 minutes, not the whole shift.
- **Server-side liveness alerts.** If a device that should be on duty stops reporting for >10 minutes, alert dispatch. Never assume silence means stationary — this doubles as your "driver's phone died / lost signal" detection, which dispatch needs regardless.

### 5. iOS

Different model, much less hostile, but stricter rules:

- `UIBackgroundModes: location` + `NSLocationAlwaysAndWhenInUseUsageDescription`
- Request **When In Use** first, then escalate to **Always** after the driver has used the app — iOS shows a "keep allowing?" prompt later, and asking too early gets a denial
- `allowsBackgroundLocationUpdates = true`, `pausesLocationUpdatesAutomatically = false`
- The **blue status bar / pill** appears while tracking. Don't try to hide it; attempting to is grounds for App Store rejection.
- **Significant-location-change + region monitoring as a safety net** — these relaunch a *terminated* app, which standard location updates cannot. This is how you recover from an iOS force-kill.
- App Review requires a clear explanation of continuous tracking, and the disclosure screen from step 2 covers it.

### 6. Battery discipline (why the driver *doesn't* disable it)

The best background-survival strategy is an app drivers don't want to kill. If it eats 40% of their battery, they will uninstall it, and no amount of engineering fixes that.

- Adaptive intervals (5 s driving / 10 s slow / 60 s heartbeat when stationary) — already in the plan
- **Distance filters** so a parked vehicle costs nothing
- **Batched uploads** (50 points/flush) — the cellular radio is a bigger drain than the GPS chip, so fewer wake-ups matters more than fewer fixes
- Activity-recognition to detect "still" and back off automatically
- Stop tracking entirely when off duty — a hard, visible, driver-controlled switch

### 7. On-duty / off-duty is a product requirement, not a nicety

Tracking a driver outside working hours is a privacy problem, is illegal in several jurisdictions, and is the fastest way to make drivers sabotage the app. A clear on/off-duty toggle, with tracking strictly scoped to on-duty, is what makes the aggressive background persistence above defensible.

---

## Framework and package choice — FINAL

**React Native + Expo, using `expo-location` + `expo-task-manager`, with our own `expo-sqlite` outbox.** Free, no paid dependency.

### Why React Native over Flutter (reversed 2026-07-21)

The plan originally specified Flutter, and the toolchain was installed. It was reversed on two findings:

**1. Maintenance data contradicted the original reasoning.** Registry check, 2026-07-21:

| Package | Version | Last publish | Maintainer |
|---|---|---|---|
| `expo-location` | 57.0.5 | 4 days ago | **Expo — first-party, funded company** |
| `expo-task-manager` | 57.0.5 | 4 days ago | Expo — first-party |
| `expo-sqlite` | 57.0.1 | 6 days ago | Expo — first-party |
| `@maplibre/maplibre-react-native` | 11.3.6 | 26 days ago | Official MapLibre org |
| `react-native` | 0.86.0 | 42 days ago | Meta |
| — Flutter equivalents — | | | |
| `flutter_foreground_task` | 10.0.0 | 6 days ago | **single community maintainer** |
| `geolocator` | 14.0.3 | 39 days ago | Baseflow |

Equally fresh, but background location is a **first-party, first-class Expo feature**, whereas Flutter's foreground-service piece rests on one volunteer. For the highest-risk component in this project, that is the safer dependency. The original argument (that Flutter's free stack was better maintained) does not survive the data.

**2. Developer proficiency — the decisive factor.** Much stronger in TypeScript/React than Dart. The outbox, retry/backoff, dedup, state machine and integrity collection are *our* code, not plugin configuration, and that custom logic is where subtle bugs live. Fluency matters more there than anywhere else.

Secondary benefits: shared TypeScript types and API client with the Next.js dashboard (one definition of the ingest payload), and **EAS Build produces iOS builds without a Mac** — a concrete unblock on a Linux machine, which Flutter cannot match.

Staleness is the dominant long-term risk either way, because every Android release changes the rules (foreground service types in 14, notification permission in 13, background location in 11). Everything chosen here shipped within six weeks.

### Final dependency set

```jsonc
"expo": "~57",
"expo-location": "~57.0.5",        // position updates + Android foreground service
"expo-task-manager": "~57.0.5",    // background task registration, survives app backgrounding
"expo-sqlite": "~57.0.1",          // offline outbox
"expo-secure-store": "*",          // device token → Keystore / Keychain
"expo-battery", "expo-network", "expo-device",  // payload deviceState + integrity signals
"expo-notifications",              // foreground service notification + alerts
"@maplibre/maplibre-react-native": "^11.3.6",
"@tanstack/react-query", "zustand" // server state + local state
```

**A development build is required — not Expo Go.** Background location does not work in Expo Go. Build locally with the Android SDK already installed, or via EAS. This is expected and normal, not a workaround.

### What the paid package (Transistor) would add, and how we cover it

`react-native-background-geolocation` (~$300) exists for RN too, so the escape hatch is identical to Flutter's. Going free:

| Paid feature | Our replacement |
|---|---|
| Offline queue + batched sync | Our own `expo-sqlite` outbox — we need custom `client_seq` idempotency anyway, so this was always hand-written |
| Motion-triggered tracking | `expo-location` `distanceInterval` + adaptive intervals |
| Activity recognition | Derive from speed; add a dedicated module later only if needed |
| OEM-specific handling | Guided walkthrough + server-side liveness verification (§3) |
| **iOS terminated-app relaunch** | ⚠️ **Genuine gap — see below** |

### The one real limitation, stated plainly

**If a driver force-kills the app on iOS, the free stack cannot reliably relaunch itself.** The paid package uses significant-location-change and region monitoring to wake a terminated app. `expo-location` does expose `startGeofencingAsync`, which can partially cover this, but it is not equivalent and needs field validation before being relied on.

Android is fine — `expo-location`'s foreground service is resilient, and we restart on boot.

Mitigations, in order of value:
1. **Server-side liveness alerting** — an on-duty device silent for >10 min alerts dispatch. In the plan regardless, since it also catches dead batteries and lost signal, and converts a silent failure into a visible one.
2. Driver training: don't swipe the app away. The persistent notification makes this discoverable.
3. If iOS force-kills prove to be a measured field problem, add a small native module for significant-location-change — a contained addition via a config plugin, not a rewrite.

**This is a framework-independent problem.** Switching to RN did not make it easier or harder; it is identical on Flutter.

Everything sits behind a **`LocationService` interface**, so any future change stays confined to one module.

## Test plan (real devices, not emulators)

Emulators never reproduce OEM killing. Test on: a Xiaomi/Redmi, a Realme/Oppo, a Samsung, and an iPhone.

Per device: 8-hour drive with screen off · overnight idle · airplane mode for 30 min (does the outbox drain?) · force-stop from recents (does it recover?) · reboot mid-shift · battery drain measured over a full shift.

**The app will ship with a built-in diagnostics screen** — service start/stop/kill events, outbox depth, last successful sync, permission and battery-optimisation state, all timestamped and exportable. Field testing without it produces impressions; with it, produces evidence. Kill events are also reported to the server so device reliability is visible on the dashboard.
