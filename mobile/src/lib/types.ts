/**
 * Wire types — the same contract the web dashboard uses.
 *
 * Kept in sync with web/src/lib/types.ts by hand for now. The payload shape
 * mirrors the FastAPI schemas exactly; changing it here without changing the
 * backend will produce a 422.
 */

export type Activity =
  | "still"
  | "walking"
  | "running"
  | "cycling"
  | "driving"
  | "unknown";

export type NetworkStatus = "wifi" | "cellular" | "offline" | "unknown";

/** One GPS fix, exactly as POSTed to /v1/ingest/batch. */
export interface LocationPingPayload {
  deviceId: string;
  driverId: string | null;
  timestamp: string;
  clientSeq: number;
  location: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    altitude: number | null;
    altitudeAccuracy: number | null;
  };
  movement: {
    speed: number | null;
    bearing: number | null;
    activity: Activity;
  };
  deviceState: {
    batteryLevel: number | null;
    isCharging: boolean | null;
    networkStatus: NetworkStatus;
    isMockLocation: boolean;
  };
}

export interface PingResult {
  clientSeq: number | null;
  accepted: boolean;
  pingId: number | null;
  reason: string | null;
  trustScore: number | null;
  integrityFlags: string[];
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  duplicates: number;
  results: PingResult[];
}

export interface ProvisionResult {
  deviceId: string;
  deviceToken: string;
  organizationId: string;
  expiresAt: string;
}

/** What a driver sign-in returns. The tokens are used once, to claim a phone. */
export interface DriverSession {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  mustChangePassword: boolean;
  driverId: string;
  fullName: string;
}

/** The handset bound to the signed-in driver. */
export interface ClaimedDevice {
  deviceId: string;
  deviceToken: string;
  label: string;
  expiresAt: string | null;
}

export interface DeviceInfo {
  id: string;
  label: string;
  status: "pending" | "active" | "revoked";
  platform: string | null;
  model: string | null;
  driverId: string | null;
  isOnDuty: boolean;
  trustScore: number;
  lastSeenAt: string | null;
  createdAt: string;
}

/** A row in the on-device outbox. */
export interface OutboxRow {
  id: number;
  client_seq: number;
  payload: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
}

/** Lifecycle events recorded for the diagnostics screen. */
export type DiagnosticKind =
  | "service_started"
  | "service_stopped"
  | "fix_recorded"
  | "sync_ok"
  | "sync_failed"
  | "app_launched"
  | "unexpected_restart"
  | "permission_changed"
  | "duty_changed";

export interface DiagnosticRow {
  id: number;
  kind: DiagnosticKind;
  detail: string | null;
  created_at: number;
}


/** A trip as the driver's phone sees it. */
export interface DriverTripStop {
  name: string;
  address: string;
  city: string | null;
  contact: string | null;
  latitude: number;
  longitude: number;
}

export interface DriverTrip {
  id: string;
  lrNumber: string;
  status: string;
  scheduledStart: string;
  goods: string;
  packages: number | null;
  weightKg: number | null;
  isFragile: boolean;
  isHazardous: boolean;
  ewayBillNumber: string | null;
  ewayBillValidUntil: string | null;
  invoiceNumber: string | null;
  vehicle: string | null;
  pickup: DriverTripStop;
  drop: DriverTripStop;
  route: {
    distanceKm: number | null;
    durationH: number | null;
    summary: string | null;
    alternatives: unknown[];
  };
  instructions: string | null;
  notes: string | null;
}
