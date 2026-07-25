/**
 * The background location task.
 *
 * IMPORTANT: this module is imported for its side effect — `defineTask` must
 * run at module scope, before React renders, because Android can relaunch the
 * app directly into this task with no UI. Registering it inside a component
 * would mean the task is undefined on a headless relaunch and every fix
 * collected while the app was killed is lost.
 */

import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

import { LOCATION_TASK, TRACKING } from "./config";
import { getDeviceId } from "./api";
import { enqueue, logEvent, nextClientSeq, outboxDepth } from "./db";
import { readDeviceState, readMockFlag } from "./deviceState";
import { flushOutbox } from "./sync";
import type { Activity, LocationPingPayload } from "./types";

/** Derive activity from speed. Cheap, and enough for a vehicle fleet. */
function activityFromSpeed(speed: number | null): Activity {
  if (speed === null || Number.isNaN(speed)) return "unknown";
  if (speed < 0.5) return "still";
  if (speed < 2.2) return "walking";
  if (speed < 4.5) return "running";
  if (speed < 8) return "cycling";
  return "driving";
}

let lastFlush = 0;

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    await logEvent("sync_failed", `location task error: ${error.message}`);
    return;
  }

  const locations = (data as { locations?: Location.LocationObject[] })?.locations;
  if (!locations?.length) return;

  const deviceId = await getDeviceId();
  if (!deviceId) return; // not enrolled — nothing to attribute fixes to

  const state = await readDeviceState();

  for (const fix of locations) {
    const coords = fix.coords;
    const speed =
      coords.speed === null || coords.speed < 0 ? null : coords.speed;

    const payload: LocationPingPayload = {
      deviceId,
      driverId: null, // the server resolves the driver from the device
      timestamp: new Date(fix.timestamp).toISOString(),
      clientSeq: await nextClientSeq(),
      location: {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy ?? null,
        altitude: coords.altitude ?? null,
        altitudeAccuracy: coords.altitudeAccuracy ?? null,
      },
      movement: {
        speed,
        // A bearing is meaningless when stationary; the server's
        // bearing-vs-trajectory check would flag the noise as a mismatch.
        bearing:
          coords.heading === null || coords.heading < 0 || (speed ?? 0) < 1
            ? null
            : coords.heading,
        activity: activityFromSpeed(speed),
      },
      deviceState: {
        batteryLevel: state.batteryLevel,
        isCharging: state.isCharging,
        networkStatus: state.networkStatus,
        isMockLocation: readMockFlag(fix.coords as { mocked?: boolean }),
      },
    };

    await enqueue(payload);
  }

  await logEvent("fix_recorded", `${locations.length} fix(es)`);

  // Flush on size or on time — whichever comes first. Batching is the biggest
  // battery lever we have, because the cellular radio costs more than the GPS.
  const depth = await outboxDepth();
  const due = Date.now() - lastFlush > TRACKING.flushIntervalMs;

  if (state.networkStatus !== "offline" && (depth >= TRACKING.batchSize || due)) {
    lastFlush = Date.now();
    await flushOutbox();
  }
});

export { LOCATION_TASK };
