/**
 * Device-state and integrity signals attached to every fix.
 *
 * These are Layer 1 of the anti-spoofing design — weak individually and
 * bypassable on a rooted phone, which is exactly why the server does not rely
 * on them. They are collected because they are free and useful in aggregate;
 * the real detection is the server-side physics in services/integrity.py.
 *
 * See docs/ANTI_SPOOFING.md.
 */

import * as Battery from "expo-battery";
import * as Device from "expo-device";
import * as Network from "expo-network";
import { Platform } from "react-native";

import type { NetworkStatus } from "./types";

export interface DeviceState {
  batteryLevel: number | null;
  isCharging: boolean | null;
  networkStatus: NetworkStatus;
}

export async function readDeviceState(): Promise<DeviceState> {
  const [level, state, net] = await Promise.all([
    Battery.getBatteryLevelAsync().catch(() => null),
    Battery.getBatteryStateAsync().catch(() => null),
    Network.getNetworkStateAsync().catch(() => null),
  ]);

  let networkStatus: NetworkStatus = "unknown";
  if (net) {
    if (!net.isConnected) networkStatus = "offline";
    else if (net.type === Network.NetworkStateType.WIFI) networkStatus = "wifi";
    else if (net.type === Network.NetworkStateType.CELLULAR)
      networkStatus = "cellular";
  }

  return {
    // -1 is expo-battery's "unknown" sentinel; send null rather than a lie.
    batteryLevel: level === null || level < 0 ? null : Number(level.toFixed(3)),
    isCharging:
      state === null
        ? null
        : state === Battery.BatteryState.CHARGING ||
          state === Battery.BatteryState.FULL,
    networkStatus,
  };
}

export interface DeviceIdentity {
  platform: string;
  model: string | null;
  osVersion: string | null;
  isEmulator: boolean;
}

export function readDeviceIdentity(): DeviceIdentity {
  return {
    platform: Platform.OS,
    model: Device.modelName ?? null,
    osVersion: Device.osVersion ?? null,
    // Device.isDevice is false on simulators/emulators — a weak but free
    // signal that this is not a real driver's handset.
    isEmulator: !Device.isDevice,
  };
}

/**
 * Whether a fix was produced by a mock provider.
 *
 * Asymmetric signal, and worth understanding before trusting it:
 *   - Android exposes `mocked` on the location object. When it is `true` the
 *     OS is telling us directly, and there is no plausible false positive.
 *   - When it is `false` it proves nothing — a rooted phone with an LSPosed
 *     module reports `false` while feeding fabricated coordinates.
 *   - iOS has no equivalent API at all, so this is always `false` there and
 *     the server records that it is unverifiable rather than trusting it.
 */
export function readMockFlag(location: { mocked?: boolean }): boolean {
  if (Platform.OS !== "android") return false;
  return location.mocked === true;
}
