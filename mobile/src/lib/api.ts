/**
 * API client.
 *
 * The device holds an opaque long-lived token, not a JWT — an admin revoking
 * a device must take effect immediately, and a JWT would stay valid until it
 * expired no matter what the server said.
 *
 * The token lives in the OS keystore via expo-secure-store, never in plain
 * AsyncStorage.
 */

import * as SecureStore from "expo-secure-store";

import { API_BASE_URL } from "./config";
import { clearOutbox, logEvent } from "./db";
import type {
  ClaimedDevice,
  DeviceInfo,
  DriverSession,
  DriverTrip,
  IngestResult,
  LocationPingPayload,
  ProvisionResult,
} from "./types";

const TOKEN_KEY = "ft_device_token";
const DEVICE_ID_KEY = "ft_device_id";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** True when the server has actively rejected us, not merely failed. */
  get isAuthFailure() {
    return this.status === 401 || this.status === 403;
  }
}

/* --- credential storage --------------------------------------------------- */

export async function saveCredentials(
  deviceId: string,
  token: string,
): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
}

export async function getDeviceToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function getDeviceId(): Promise<string | null> {
  return SecureStore.getItemAsync(DEVICE_ID_KEY);
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(DEVICE_ID_KEY);
}

export async function isEnrolled(): Promise<boolean> {
  return (await getDeviceToken()) !== null;
}

/**
 * Confirm the stored token is still accepted by the server.
 *
 * Holding a token locally is not the same as being enrolled: the device can
 * be revoked by an admin, or its organisation removed, and the phone would
 * otherwise keep showing a working duty screen while every request 401s.
 *
 * Returns:
 *   "valid"    — server accepted it
 *   "rejected" — server refused it; credentials have been cleared, re-enrol
 *   "unknown"  — could not reach the server; keep the existing state rather
 *                than logging a driver out because they drove into a tunnel
 */
export async function verifyEnrolment(): Promise<"valid" | "rejected" | "unknown"> {
  const token = await getDeviceToken();
  if (!token) return "rejected";
  try {
    await api.me();
    return "valid";
  } catch (error) {
    if (error instanceof ApiError && error.isAuthFailure) {
      await clearCredentials();
      return "rejected";
    }
    return "unknown";
  }
}

/* --- requests ------------------------------------------------------------- */

async function request<T>(
  path: string,
  init: RequestInit = {},
  auth = true,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };

  if (auth) {
    const token = await getDeviceToken();
    if (!token) throw new ApiError(401, "This device is not enrolled");
    headers["X-Device-Token"] = token;
  }

  // A hung request holds the outbox flush open, so it is bounded explicitly.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new ApiError(0, aborted ? "Request timed out" : "Cannot reach the server");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") message = body.detail;
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/* --- endpoints ------------------------------------------------------------ */

export const api = {
  /**
   * Sign in with the driver ID and password issued by the transport office.
   *
   * Returns a short-lived driver JWT, which is only used to claim a handset —
   * it is deliberately not persisted. Tracking authenticates with the opaque
   * device token, because revoking a phone has to take effect immediately.
   */
  driverLogin: (loginId: string, password: string) =>
    request<DriverSession>(
      "/v1/auth/driver/login",
      { method: "POST", body: JSON.stringify({ loginId, password }) },
      false,
    ),

  /** Replace the temporary password issued by the office. */
  driverSetPassword: (loginId: string, currentPassword: string, newPassword: string) =>
    request<DriverSession>(
      "/v1/auth/driver/set-password",
      {
        method: "POST",
        body: JSON.stringify({ loginId, currentPassword, newPassword }),
      },
      false,
    ),

  /** Bind this handset to the signed-in driver and store its device token. */
  async claimDevice(driverToken: string, input: {
    platform: string;
    model?: string | null;
    osVersion?: string | null;
    appVersion?: string | null;
  }): Promise<ClaimedDevice> {
    const previousDeviceId = await getDeviceId();

    const result = await request<ClaimedDevice>(
      "/v1/auth/driver/claim-device",
      {
        method: "POST",
        body: JSON.stringify(input),
        headers: { Authorization: `Bearer ${driverToken}` },
      },
      false,
    );

    // Anything still queued belongs to whoever held this phone before. The
    // server attributes an upload by its token, so sending those now would
    // file one driver's movements under another's name.
    if (previousDeviceId && previousDeviceId !== result.deviceId) {
      const dropped = await clearOutbox();
      if (dropped > 0) {
        await logEvent(
          "sync_failed",
          `discarded ${dropped} queued fix(es) belonging to the previous device`,
        );
      }
    }

    await saveCredentials(result.deviceId, result.deviceToken);
    return result;
  },

  /** Exchange a one-time enrolment code for a long-lived device token. */
  async provision(input: {
    enrollmentCode: string;
    platform: string;
    model?: string | null;
    osVersion?: string | null;
    appVersion?: string | null;
  }): Promise<ProvisionResult> {
    const result = await request<ProvisionResult>(
      "/v1/devices/provision",
      { method: "POST", body: JSON.stringify(input) },
      false,
    );
    await saveCredentials(result.deviceId, result.deviceToken);
    return result;
  },

  me: () => request<DeviceInfo>("/v1/devices/me"),

  setDuty: (onDuty: boolean) =>
    request<DeviceInfo>("/v1/devices/me/duty", {
      method: "POST",
      body: JSON.stringify({ onDuty }),
    }),

  ingestBatch: (pings: LocationPingPayload[]) =>
    request<IngestResult>("/v1/ingest/batch", {
      method: "POST",
      body: JSON.stringify({ pings }),
    }),

  /** Trips assigned to this phone. Scoped server-side to this device. */
  myTrips: () => request<DriverTrip[]>("/v1/devices/me/trips"),

  health: () => request<{ status: string }>("/health", {}, false),
};
