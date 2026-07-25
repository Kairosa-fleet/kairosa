/**
 * Wire types — mirror the FastAPI schemas exactly.
 *
 * This file is intended to be shared with the Expo app so the ingest payload
 * has one definition across web, mobile and (by review) the backend.
 */

export type UserRole = "admin" | "tracker";
export type DeviceStatus = "pending" | "active" | "revoked";
export type Activity =
  | "still"
  | "walking"
  | "running"
  | "cycling"
  | "driving"
  | "unknown";
export type NetworkStatus = "wifi" | "cellular" | "offline" | "unknown";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  organizationId: string;
  isActive: boolean;
  createdAt: string;
}

export interface Driver {
  id: string;
  fullName: string;
  phone: string | null;
  employeeCode: string | null;
  isActive: boolean;
}

export interface Device {
  id: string;
  label: string;
  status: DeviceStatus;
  platform: string | null;
  model: string | null;
  driverId: string | null;
  /** The vehicle this phone rides in, when one is assigned. */
  vehicleRegistration: string | null;
  isOnDuty: boolean;
  trustScore: number;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface DeviceRegistered {
  id: string;
  label: string;
  status: DeviceStatus;
  enrollmentCode: string;
  enrollmentExpiresAt: string;
}

export interface Position {
  deviceId: string;
  label: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  bearing: number | null;
  activity: Activity | null;
  batteryLevel: number | null;
  isCharging: boolean | null;
  trustScore: number | null;
  integrityFlags: string[];
  recordedAt: string;
  isOnline?: boolean | null;
}

/** Frame pushed over the WebSocket when a device reports a new fix. */
export interface PositionFrame extends Position {
  type: "position";
}

export type SocketFrame =
  | PositionFrame
  | { type: "connected"; organizationId: string }
  | { type: "heartbeat" };

/* -------------------------------------------------------------------------
   Derived status — the single source of truth for how a device is presented.
   Kept here rather than in a component so the map marker, the sidebar row and
   the detail panel can never disagree with each other.
------------------------------------------------------------------------- */

export type HealthLevel = "ok" | "warn" | "critical" | "idle";

export interface DeviceHealth {
  level: HealthLevel;
  label: string;
  reason: string;
}

/** Thresholds mirror the backend's TRUST_SUSPICIOUS/SPOOFED settings. */
export const TRUST_SUSPICIOUS = 70;
export const TRUST_SPOOFED = 40;
export const OFFLINE_AFTER_MS = 600_000; // matches DEVICE_OFFLINE_AFTER_SECONDS

export function deviceHealth(
  position: Position | undefined,
  device?: Pick<Device, "status" | "isOnDuty" | "trustScore">,
): DeviceHealth {
  if (device?.status === "revoked")
    return { level: "critical", label: "Revoked", reason: "Access revoked" };
  if (device?.status === "pending")
    return { level: "idle", label: "Not set up", reason: "Awaiting enrolment" };
  if (!position)
    return { level: "idle", label: "No data", reason: "No fixes received yet" };

  const trust = position.trustScore ?? 100;
  if (trust < TRUST_SPOOFED)
    return {
      level: "critical",
      label: "Suspect",
      reason: "Location integrity failed",
    };

  const ageMs = Date.now() - new Date(position.recordedAt).getTime();
  if (ageMs > OFFLINE_AFTER_MS)
    return { level: "critical", label: "Offline", reason: "No recent fix" };

  if (trust < TRUST_SUSPICIOUS)
    return {
      level: "warn",
      label: "Check",
      reason: "Location integrity questionable",
    };
  if (position.batteryLevel !== null && position.batteryLevel < 0.15)
    return { level: "warn", label: "Low battery", reason: "Battery under 15%" };
  if (device && !device.isOnDuty)
    return { level: "idle", label: "Off duty", reason: "Not on shift" };

  return { level: "ok", label: "Live", reason: "Reporting normally" };
}

/** Human-readable explanations for the backend's integrity flags. */
export const INTEGRITY_FLAG_LABELS: Record<string, string> = {
  mock_location_flag: "Device reported a mock location provider",
  teleport: "Moved an impossible distance between fixes",
  timestamp_regression: "Device clock went backwards",
  speed_displacement_mismatch: "Reported speed disagrees with actual movement",
  bearing_trajectory_mismatch: "Reported heading disagrees with direction moved",
  quantised_coordinates: "Coordinates look rounded or grid-snapped",
  zero_accuracy: "Impossibly perfect accuracy reported",
  static_accuracy: "Accuracy never varies — real GPS always fluctuates",
  battery_rose_uncharged: "Battery increased while not charging",
  wifi_at_speed: "On Wi-Fi while moving at vehicle speed",
  activity_speed_mismatch: "Activity type disagrees with speed",
  zero_altitude: "Altitude reported as exactly zero",
  ios_mock_unverifiable: "iOS cannot verify mock location (informational)",
};


/* -------------------------------------------------------------------------
   Transport management
------------------------------------------------------------------------- */

export type VehicleType =
  | "truck" | "tempo" | "trailer" | "container" | "tanker" | "tipper"
  | "pickup" | "other";

export type VehicleDocType =
  | "rc" | "insurance" | "puc" | "fitness" | "permit_national"
  | "permit_state" | "road_tax" | "other";

export type DriverDocType =
  | "driving_licence" | "aadhaar" | "pan" | "police_verification"
  | "medical_certificate" | "address_proof" | "photo" | "other";

export type FreightTerms = "paid" | "to_pay" | "tbb";
export type TripStatus =
  | "planned" | "assigned" | "started" | "in_transit"
  | "at_destination" | "delivered" | "cancelled";

export interface VehicleDoc {
  id?: string;
  docType: VehicleDocType;
  number?: string | null;
  issuer?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  /** Path to the stored scan, served through the authenticated API. */
  fileUrl?: string | null;
  /** The file's original name, for display only. */
  fileName?: string | null;
}

/** What the upload endpoint hands back once a file is stored. */
export interface UploadedDocument {
  fileUrl: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/** A photograph of a vehicle. */
export interface VehicleImage {
  id?: string;
  fileUrl: string;
  fileName?: string | null;
  caption?: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

export interface Vehicle {
  id: string;
  registrationNumber: string;
  displayName: string | null;
  vehicleType: VehicleType;
  make: string | null;
  model: string | null;
  manufactureYear: number | null;
  bodyType: string | null;
  capacityKg: number | null;
  chassisNumber: string | null;
  engineNumber: string | null;
  fuelType: string | null;
  isActive: boolean;
  documents: VehicleDoc[];
  images: VehicleImage[];
}

export interface DriverDoc {
  id?: string;
  docType: DriverDocType;
  number?: string | null;
  expiresOn?: string | null;
  /** Path to the stored scan, served through the authenticated API. */
  fileUrl?: string | null;
  fileName?: string | null;
}

export interface DriverFull {
  id: string;
  fullName: string;
  phone: string | null;
  employeeCode: string | null;
  licenceNumber: string | null;
  licenceClass: string | null;
  licenceIssuingRto: string | null;
  licenceExpiresOn: string | null;
  /** The licence scan itself, kept on the driver beside its number. */
  licenceFileUrl: string | null;
  licenceFileName: string | null;
  photoUrl: string | null;
  photoName: string | null;
  bloodGroup: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  aadhaarLast4: string | null;
  panNumber: string | null;
  isActive: boolean;
  documents: DriverDoc[];
}

export interface CustomerAddress {
  id: string;
  label: string | null;
  /** How the coordinates were arrived at — see AddressPicker. */
  precision?: string | null;
  line1: string;
  city: string | null;
  state: string | null;
  pincode: string | null;
  latitude: number;
  longitude: number;
  placeName: string | null;
}

export interface Customer {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string;
  altPhone: string | null;
  email: string | null;
  gstin: string | null;
  isActive: boolean;
  addresses: CustomerAddress[];
}

/**
 * Returned once, when a driver is created or their password is reset.
 * The password is never recoverable — it exists only in this response.
 */
export interface DriverCredentials {
  id: string;
  fullName: string;
  loginId: string | null;
  mustChangePassword: boolean;
  temporaryPassword: string | null;
  licenceNumber: string | null;
}

export interface Place {
  id: string;
  /** How precise the coordinates are: exact | street | area. */
  precision: "exact" | "street" | "area";
  /** 0–1 match quality from the provider. */
  relevance: number | null;
  /** Feature type — "poi" is a landmark, worth flagging in the list. */
  kind?: string;
  /** Distance from the search bias point, when one was given. */
  distanceKm?: number | null;
  placeName: string;
  text: string;
  latitude: number;
  longitude: number;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string;
}

export interface RouteOption {
  index: number;
  label: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
  summary: string | null;
  geometry?: { type: string; coordinates: [number, number][] } | null;
}

export interface ComplianceAlert {
  severity: "expired" | "missing" | "critical" | "warning";
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  document: string;
  message: string;
  expiresOn: string | null;
  daysRemaining: number | null;
}

export interface TripLink {
  party: "consignor" | "consignee";
  url: string;
  token: string;
  viewCount: number;
  revoked: boolean;
}

export interface TripRow {
  id: string;
  consignmentId: string;
  status: TripStatus;
  scheduledStart: string;
  scheduledEnd: string | null;
  notes: string | null;
  lrNumber: string;
  goods: string;
  weightKg: number | null;
  declaredValue: number | null;
  ewayBillNumber: string | null;
  freightTerms: FreightTerms;
  consignor: string;
  consignee: string;
  origin: string;
  destination: string;
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
  vehicle: string | null;
  vehicleId: string | null;
  driver: string | null;
  driverId: string | null;
  deviceId: string | null;
  distanceKm: number | null;
  durationH: number | null;
  routeSummary: string | null;
  links: TripLink[];
}

/** One send attempt, per party and channel, as reported by the booking. */
export interface DeliveryAttempt {
  party: string;
  channel: string;
  recipient: string;
  status: "queued" | "sent" | "failed" | "skipped";
  error: string | null;
}

export interface BookingResultData {
  consignment: { id: string; lrNumber: string };
  trip: { id: string };
  links: { party: string; url: string; token: string }[];
  alerts: ComplianceAlert[];
  dispatchOk: boolean;
  deliveries: DeliveryAttempt[];
  /** False when no phone could be resolved — the driver's app stays empty. */
  driverNotified: boolean;
  /** False when routing was unreachable — no distance, ETA or map line. */
  routeAvailable: boolean;
}

export interface NotificationStatus {
  enabled: boolean;
  email: boolean;
  sms: boolean;
  whatsapp: boolean;
  reason: string | null;
}

/** Alerts are shown worst-first; this is the order used everywhere. */
export const ALERT_ORDER: Record<ComplianceAlert["severity"], number> = {
  expired: 0,
  missing: 1,
  critical: 2,
  warning: 3,
};

export function alertTone(
  severity: ComplianceAlert["severity"],
): HealthLevel {
  if (severity === "expired" || severity === "missing") return "critical";
  if (severity === "critical") return "warn";
  return "warn";
}

/* --- Organization settings & the consignment note (LR) ------------------- */

export interface OrgSettings {
  id: string;
  name: string;
  legalName: string | null;
  gstin: string | null;
  pan: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  transporterId: string | null;
  logoUrl: string | null;
  lrTerms: string | null;
  /** True once the fields a legal consignment note requires are present. */
  letterheadReady: boolean;
}

/** Everything the LR / Goods Consignment note prints. */
export interface LrData {
  lrNumber: string;
  status: string;
  createdAt: string;
  letterheadReady: boolean;
  letterheadMissing: string[];
  transporter: {
    name: string; tradeName: string; gstin: string | null; pan: string | null;
    transporterId: string | null; address: string; phone: string | null;
    email: string | null; logoUrl: string | null; terms: string | null;
  };
  consignor: LrParty;
  consignee: LrParty;
  goods: {
    description: string; hsnCode: string | null; packageCount: number | null;
    packageType: string | null; weightKg: number | null; declaredValue: number | null;
    isFragile: boolean; isHazardous: boolean;
  };
  statutory: {
    ewayBillNumber: string | null; ewayBillValidUntil: string | null;
    invoiceNumber: string | null; invoiceDate: string | null;
  };
  freight: {
    terms: string; amount: number | null; advance: number | null;
    balance: number | null; payableBy: string;
  };
  carriage: {
    vehicleNumber: string | null; vehicleType: string | null;
    driverName: string | null; driverPhone: string | null;
    scheduledStart: string | null; distanceKm: number | null;
  };
  specialInstructions: string | null;
}

export interface LrParty {
  name: string; gstin: string | null; phone: string | null;
  contactPerson: string | null; address: string;
  city: string | null; state: string | null; pincode: string | null;
}
