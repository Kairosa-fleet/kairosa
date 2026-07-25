/**
 * Runtime configuration.
 *
 * The API base URL is the one setting that genuinely differs per developer:
 * an Android emulator reaches the host at 10.0.2.2, but a *physical* device on
 * USB reaches it at the machine's LAN IP (or through `adb reverse`). Because
 * this app is developed against a real Redmi, `adb reverse tcp:8000 tcp:8000`
 * makes localhost work, which is what the default assumes.
 */

const DEFAULT_API = "http://127.0.0.1:8000";

export const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_BASE_URL ?? DEFAULT_API
).replace(/\/$/, "");

export const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";

/** Background task identifier — must be stable across app restarts. */
export const LOCATION_TASK = "fleet-tracking-location";

/**
 * Adaptive cadence. Fewer radio wake-ups matter more for battery than fewer
 * GPS fixes, which is why uploads are batched rather than sent per fix.
 */
export const TRACKING = {
  /** Location update interval while on duty (ms). */
  timeInterval: 10_000,
  /** Suppress updates closer together than this (metres). */
  distanceInterval: 20,
  /** Flush the outbox when it reaches this many rows… */
  batchSize: 50,
  /** …or at least this often (ms), so a slow trickle still reports. */
  flushIntervalMs: 30_000,
  /** Never send more than this in one request — matches the server's cap. */
  maxBatch: 100,
  /** Give up on a row after this many failed attempts and drop it. */
  maxAttempts: 25,
  /** Rows older than this are discarded; the server rejects them anyway. */
  maxAgeMs: 23 * 60 * 60 * 1000,
} as const;

export const COLORS = {
  bg: "#FFFFFF",
  surface: "#F7F7FB",
  surface2: "#EDEDF6",
  stroke: "#E3E3EE",
  ink: "#3A3A46",
  ink2: "#77778A",
  ink3: "#ADADBF",
  accent: "#6366F1",
  accentFill: "#5B5CE0",
  accentFill2: "#7C4FE8",
  accentSoft: "#EEF0FE",
  success: "#0F9D76",
  successSoft: "#E7F8F2",
  warning: "#D98200",
  warningSoft: "#FDF3E3",
  danger: "#E5484D",
  dangerSoft: "#FDEDED",
  white: "#FFFFFF",
} as const;
