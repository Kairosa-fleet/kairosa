import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { api, ApiError } from "./api";
import { TRACKING } from "./config";
import { logEvent, outboxDepth, metaGet, metaSet } from "./db";
import {
  getPermissionStatus,
  isTracking,
  startTracking,
  stopTracking,
  type PermissionStatus,
} from "./locationService";
import { flushOutbox } from "./sync";

export interface TrackingState {
  onDuty: boolean;
  serviceRunning: boolean;
  permissions: PermissionStatus | null;
  pending: number;
  lastSyncAt: number | null;
  lastError: string | null;
  busy: boolean;
}

const DUTY_KEY = "on_duty";
const LAST_SYNC_KEY = "last_sync_at";

/**
 * Owns duty state and keeps the UI in step with the background service.
 *
 * Duty is persisted locally as well as on the server: the phone must know it
 * is on duty even when it cannot reach the API, otherwise a network outage
 * would silently end a shift.
 */
export function useTracking() {
  const [state, setState] = useState<TrackingState>({
    onDuty: false,
    serviceRunning: false,
    permissions: null,
    pending: 0,
    lastSyncAt: null,
    lastError: null,
    busy: true,
  });

  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const [permissions, running, pending, duty, lastSync] = await Promise.all([
      getPermissionStatus(),
      isTracking(),
      outboxDepth(),
      metaGet(DUTY_KEY),
      metaGet(LAST_SYNC_KEY),
    ]);

    setState((prev) => ({
      ...prev,
      permissions,
      serviceRunning: running,
      pending,
      onDuty: duty === "1",
      lastSyncAt: lastSync ? Number(lastSync) : prev.lastSyncAt,
      busy: false,
    }));
  }, []);

  const goOnDuty = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, lastError: null }));
    try {
      const permissions = await getPermissionStatus();
      if (!permissions.foregroundGranted)
        throw new Error("Location permission is required to go on duty");
      if (!permissions.servicesEnabled)
        throw new Error("Turn on location services (GPS) to go on duty");

      await startTracking();
      await metaSet(DUTY_KEY, "1");
      await logEvent("duty_changed", "on");

      // Local state is authoritative; the server call is best-effort so a
      // patchy connection cannot block the start of a shift.
      try {
        await api.setDuty(true);
      } catch {
        /* will reconcile on the next successful sync */
      }
    } catch (error) {
      setState((s) => ({
        ...s,
        lastError: error instanceof Error ? error.message : "Could not start",
      }));
    } finally {
      await refresh();
    }
  }, [refresh]);

  const goOffDuty = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, lastError: null }));
    try {
      await stopTracking();
      await metaSet(DUTY_KEY, "0");
      await logEvent("duty_changed", "off");
      // Drain whatever is left before the radio goes quiet for the day.
      await flushOutbox();
      try {
        await api.setDuty(false);
      } catch {
        /* best effort */
      }
    } finally {
      await refresh();
    }
  }, [refresh]);

  const syncNow = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, lastError: null }));
    const outcome = await flushOutbox();
    if (!outcome.error) await metaSet(LAST_SYNC_KEY, String(Date.now()));
    setState((s) => ({ ...s, lastError: outcome.error ?? null }));
    await refresh();
    return outcome;
  }, [refresh]);

  /* Reconcile on mount, on foreground, and on a slow poll. */
  useEffect(() => {
    void (async () => {
      await logEvent("app_launched");

      // If duty says on but the service is not running, the OS killed us.
      // That is the single most important signal for OEM field testing.
      const [duty, running] = await Promise.all([metaGet(DUTY_KEY), isTracking()]);
      if (duty === "1" && !running) {
        await logEvent(
          "unexpected_restart",
          "on duty but service was not running — restarting",
        );
        try {
          await startTracking();
        } catch {
          /* permissions may have been revoked while we were dead */
        }
      }
      await refresh();
    })();

    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });

    timer.current = setInterval(() => void refresh(), 5_000);

    return () => {
      sub.remove();
      if (timer.current) clearInterval(timer.current);
    };
  }, [refresh]);

  /* Periodic flush while the app is open, so the UI reflects real progress. */
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        if (!state.onDuty) return;
        const outcome = await flushOutbox();
        if (!outcome.error && outcome.attempted > 0) {
          await metaSet(LAST_SYNC_KEY, String(Date.now()));
        }
        if (outcome.error?.startsWith("Device rejected")) {
          setState((s) => ({ ...s, lastError: outcome.error! }));
        }
      })();
    }, TRACKING.flushIntervalMs);
    return () => clearInterval(id);
  }, [state.onDuty]);

  return { ...state, refresh, goOnDuty, goOffDuty, syncNow };
}

export { ApiError };
