/**
 * LocationService — the one module that knows how tracking is implemented.
 *
 * Everything else talks to this interface. If the free stack ever proves
 * inadequate in the field (the documented risk is iOS force-kill recovery),
 * swapping to react-native-background-geolocation is confined to this file.
 *
 * See docs/BACKGROUND_TRACKING.md.
 */

import * as Location from "expo-location";
import { Linking, Platform } from "react-native";

import { LOCATION_TASK, TRACKING } from "./config";
import { logEvent } from "./db";
import "./locationTask"; // side effect: registers the background task

export type PermissionStage =
  | "none"
  | "foreground"
  | "background"
  | "denied"
  | "blocked";

export interface PermissionStatus {
  stage: PermissionStage;
  foregroundGranted: boolean;
  backgroundGranted: boolean;
  canAskAgain: boolean;
  servicesEnabled: boolean;
}

export async function getPermissionStatus(): Promise<PermissionStatus> {
  const [fg, bg, services] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
    Location.hasServicesEnabledAsync().catch(() => false),
  ]);

  const foregroundGranted = fg.status === "granted";
  const backgroundGranted = bg.status === "granted";

  let stage: PermissionStage = "none";
  if (backgroundGranted) stage = "background";
  else if (foregroundGranted) stage = "foreground";
  else if (!fg.canAskAgain) stage = "blocked";
  else if (fg.status === "denied") stage = "denied";

  return {
    stage,
    foregroundGranted,
    backgroundGranted,
    canAskAgain: fg.canAskAgain,
    servicesEnabled: services,
  };
}

/**
 * Step 1 of the permission ladder.
 *
 * Deliberately separate from the background request. Android 11+ hides
 * "Allow all the time" from the first dialog entirely, so asking for both at
 * once simply fails — and asking cold, without the in-app explanation screen
 * first, roughly halves grant rates.
 */
export async function requestForeground(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  await logEvent("permission_changed", `foreground=${status}`);
  return status === "granted";
}

/**
 * Step 2. On Android 11+ this does not show a dialog at all — it opens
 * Settings, where the driver must pick "Allow all the time" themselves.
 */
export async function requestBackground(): Promise<boolean> {
  const { status } = await Location.requestBackgroundPermissionsAsync();
  await logEvent("permission_changed", `background=${status}`);
  return status === "granted";
}

export function openSettings(): void {
  Linking.openSettings().catch(() => {});
}

export async function isTracking(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    return false;
  }
}

/**
 * Start background tracking.
 *
 * The foreground service notification is not optional on Android and should
 * not be fought: it is what stops the OS treating this as idle background work
 * and killing it, and drivers are entitled to see that they are being tracked.
 */
export async function startTracking(): Promise<void> {
  if (await isTracking()) return;

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: TRACKING.timeInterval,
    distanceInterval: TRACKING.distanceInterval,

    // Android foreground service — the whole basis of surviving in background.
    foregroundService: {
      notificationTitle: "On duty — sharing location",
      notificationBody: "Dispatch can see your position. Go off duty to stop.",
      notificationColor: "#6366F1",
      // false: if the OS destroys our activity we still want the service to
      // continue, which is the entire point on aggressive OEM skins.
      killServiceOnDestroy: false,
    },

    // iOS
    activityType: Location.ActivityType.AutomotiveNavigation,
    // A paused update stream on iOS never resumes on its own; for a shift-long
    // trip that silently ends tracking.
    pausesUpdatesAutomatically: false,
    // Required by App Review for continuous background tracking, and honest.
    showsBackgroundLocationIndicator: true,

    mayShowUserSettingsDialog: true,
  });

  await logEvent("service_started");
}

export async function stopTracking(): Promise<void> {
  if (!(await isTracking())) return;
  await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  await logEvent("service_stopped");
}

/** One-shot fix, used to centre the map before tracking begins. */
export async function getCurrentPosition(): Promise<Location.LocationObject | null> {
  try {
    return await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
  } catch {
    return null;
  }
}

/**
 * Whether this device is from a manufacturer known to kill background work
 * aggressively. Used to decide whether to show the OEM walkthrough.
 */
export function needsOemWhitelisting(manufacturer: string | null): boolean {
  if (Platform.OS !== "android" || !manufacturer) return false;
  const aggressive = [
    "xiaomi",
    "redmi",
    "poco",
    "oppo",
    "realme",
    "oneplus",
    "vivo",
    "iqoo",
    "huawei",
    "honor",
    "samsung",
    "meizu",
    "asus",
    "wiko",
    "lenovo",
    "tecno",
    "infinix",
  ];
  return aggressive.includes(manufacturer.toLowerCase());
}

/** OEM-specific instructions. Generic advice is useless — menus differ. */
export function oemInstructions(manufacturer: string | null): string[] {
  const m = (manufacturer ?? "").toLowerCase();

  if (["xiaomi", "redmi", "poco"].includes(m))
    return [
      "Settings → Apps → Manage apps → Fleet Tracking",
      "Turn ON “Autostart”",
      "Open “Battery saver” → choose “No restrictions”",
      "Lock the app in Recents (swipe up, tap the padlock)",
    ];
  if (["oppo", "realme", "oneplus"].includes(m))
    return [
      "Settings → Battery → App battery management → Fleet Tracking",
      "Turn ON “Allow background activity”",
      "Turn OFF “Sleep in background”",
      "Enable “Auto-launch” in Settings → Apps → Auto-launch",
    ];
  if (["vivo", "iqoo"].includes(m))
    return [
      "Settings → Battery → Background power consumption management",
      "Find Fleet Tracking → “Allow high background power consumption”",
      "Settings → Apps → Autostart → enable Fleet Tracking",
    ];
  if (m === "samsung")
    return [
      "Settings → Apps → Fleet Tracking → Battery",
      "Choose “Unrestricted”",
      "Settings → Battery → Background usage limits",
      "Make sure Fleet Tracking is NOT in “Sleeping apps”",
    ];
  if (["huawei", "honor"].includes(m))
    return [
      "Settings → Apps → Fleet Tracking → Battery",
      "Set “Launch” to Manage manually",
      "Enable Auto-launch, Secondary launch and Run in background",
    ];

  return [
    "Settings → Apps → Fleet Tracking → Battery",
    "Allow background activity and remove any battery restriction",
  ];
}
