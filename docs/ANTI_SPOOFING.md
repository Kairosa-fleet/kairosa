# Location Integrity — Anti-Spoofing Design

You asked for "whatever is best." The honest answer: **`isMockLocation` alone is close to worthless.** It's a boolean the client volunteers, on a device the driver physically controls. A rooted phone with an Xposed/LSPosed module returns `false` while feeding fake coordinates. And iOS has no equivalent API at all, so half your fleet reports nothing.

So we treat it as *one weak input among many*, and put the real defence on the server, where the attacker has no control.

**Design principle: never trust a client-reported flag; trust physics.** A spoofer can lie about a flag. Lying convincingly about the *joint distribution* of position, speed, bearing, altitude, accuracy, battery drain and network state — consistently, over hours — is dramatically harder, and every mistake is permanent evidence in your database.

---

## Layer 1 — Client signals (weak, free, collect anyway)

Cheap to gather and useful in aggregate, even though each is individually bypassable.

**Android**
| Signal | Source |
|---|---|
| `isFromMockProvider` / `isMock` (API 31+) | the `Location` object itself |
| Mock-location app selected in Developer Options | `Settings.Secure` |
| Developer Options enabled | `Settings.Global.DEVELOPMENT_SETTINGS_ENABLED` |
| Known spoofing packages installed | `PackageManager` query (Fake GPS, Mock Locations, GPS JoyStick…) |
| Root / Magisk indicators | `su` binary paths, `ro.debuggable`, Magisk mount artifacts |
| Running on emulator | `Build.FINGERPRINT`, `Build.MODEL` |

**iOS**
No mock-location API exists — Apple doesn't expose it. Available instead:
- Simulator detection (`TARGET_OS_SIMULATOR`)
- Jailbreak indicators (`/Applications/Cydia.app`, writability of `/private`, suspicious dylibs)
- `CLLocation.sourceInformation.isSimulatedBySoftware` (iOS 15+) — the closest analogue, and genuinely useful, though it only catches Xcode/desktop-tool simulation, not a jailbroken tweak

We send all of these as a `deviceIntegrity` block, and **record which platform they came from** so the server never compares an iOS `false` against an Android `false` as if they meant the same thing.

## Layer 2 — Platform attestation (strong, free, the real client-side answer)

This is what banking apps use, and it's the correct tool here.

- **Android: Play Integrity API.** Google's servers cryptographically attest that the app binary is unmodified, installed from Play, and running on a genuine non-rooted device. The verdict is signed by Google and verified on *our* backend — the phone cannot forge it. Free tier covers 10,000 requests/day, well beyond our needs since we only attest at provisioning and then hourly, not per ping.
- **iOS: App Attest (DeviceCheck).** Apple-signed hardware attestation that the app is genuine and running on real hardware. Same model — verified server-side against Apple's root.

A device failing attestation doesn't get auto-blocked, but its trust score is floored and every ping is flagged. This closes the "rooted phone lying about `isFromMockProvider`" hole, which nothing in Layer 1 can.

## Layer 3 — Server-side physics (strongest, platform-independent)

Runs on every ingested ping, in `services/integrity.py`. The attacker controls neither the code nor the history it's compared against. **This is the layer that actually catches spoofing**, and it works identically on iOS and Android — which matters, because Layer 1 gives us almost nothing on iOS.

| Check | What it catches |
|---|---|
| **Teleport** — implied speed from previous ping's distance/Δt exceeds a plausible max (~200 km/h road, higher only if flight-plausible) | Coordinate injection, jumping between cities |
| **Speed↔displacement consistency** — reported `speed` vs speed derived from consecutive positions | Spoofers set position but forget to make speed agree |
| **Bearing↔trajectory consistency** — reported `bearing` vs bearing computed from the last two points | Same class of mistake; sideways-moving vehicles are physically impossible |
| **Accuracy fingerprinting** — real GPS accuracy fluctuates constantly; a device reporting exactly `5.0` for hours is synthetic | Static/hardcoded accuracy values |
| **Altitude plausibility** — constant `0.0`, missing, or contradicting terrain for the coordinates | Most spoofing tools ignore altitude entirely |
| **Coordinate quantisation** — too few decimal places, repeated exact coordinates, points snapped to a grid or a perfectly straight line | Interpolated fake routes |
| **Timing regularity** — real fixes jitter by tens of ms; perfectly periodic sub-ms intervals are machine-generated | Scripted replay |
| **Activity↔motion agreement** — `activity: "driving"` at 0 m/s, or 80 km/h while `"still"` | Faked movement blocks |
| **Battery↔motion agreement** — continuous GPS + screen use drains battery predictably; a flat battery level over hours of "driving", or charging state impossible for the claimed vehicle | Emulators, replayed logs |
| **Network↔location agreement** — `networkStatus: "wifi"` while moving at highway speed, or a cell-tower/IP geolocation far from the claimed GPS point | Desktop tools, VPN'd emulators |
| **Impossible-pair (rate limit on identity)** — same `deviceId` reporting from two distant places, or two devices reporting identical tracks | Cloned installs, shared tokens |

Each check returns a weighted contribution to a **0–100 trust score** per ping, plus a rolling exponentially-weighted score per device.

## Layer 4 — Response policy

Critically, **we do not auto-reject low-trust pings.** Legitimate GPS does terrible things: urban canyons in Mumbai, tunnels, parking basements, and cold starts all produce jumps and absurd accuracy values. Auto-blocking creates support tickets and destroys driver trust in the product.

Instead:

| Trust score | Action |
|---|---|
| 70–100 | Store normally |
| 40–69 | Store, flag `suspicious`, show a subtle indicator on the dashboard |
| 0–39 | Store, flag `spoofed`, raise an admin alert, mark the trip as disputed |
| Attestation failure | Floor the score, alert immediately, block *provisioning* of new devices |

Everything is stored either way — a discarded ping is evidence you no longer have. `location_pings` gets `trust_score`, `integrity_flags` (JSONB array of which checks fired), and `attestation_verdict`. Investigating a driver later means querying flags, not guessing.

Admins get a per-device integrity timeline. **Repeated low scores over days, not a single flagged ping, are what indicate fraud** — one bad ping is a tunnel, a hundred is a spoofing app.

## What this costs

Nothing in Google Maps quota. Every check above is arithmetic over data you already store — no Roads API snap-to-road, no Geocoding. Play Integrity and App Attest are free at our volume. The only cost is a few milliseconds of CPU per ping.

## Implementation order

1. Extend the ingest schema with the `deviceIntegrity` block, and add `trust_score` / `integrity_flags` / `attestation_verdict` to `location_pings`.
2. Build `services/integrity.py` with Layer 3 — this alone catches most real-world spoofing and needs no mobile work.
3. Collect Layer 1 signals in the Flutter app.
4. Add Play Integrity / App Attest at provisioning + hourly re-attestation.
5. Dashboard: integrity badge per device, alert feed, per-device timeline.
