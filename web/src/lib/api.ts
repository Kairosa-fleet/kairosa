/**
 * API client.
 *
 * Tokens live in memory with a localStorage mirror so a refresh doesn't log you
 * out. That is a deliberate trade: httpOnly cookies would be more resistant to
 * XSS, but the backend issues bearer tokens for the mobile app too, and running
 * two auth schemes doubles the surface area. Access tokens are short-lived
 * (60 min) and a 401 triggers a single silent refresh.
 */

import type {
  BookingResultData,
  ComplianceAlert,
  Customer,
  CustomerAddress,
  Device,
  DeviceRegistered,
  Driver,
  DriverCredentials,
  DriverFull,
  LrData,
  OrgSettings,
  NotificationStatus,
  Place,
  Position,
  RouteOption,
  Tokens,
  TripRow,
  UploadedDocument,
  User,
  Vehicle,
} from "./types";

const BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ??
  "http://localhost:8000";

const ACCESS_KEY = "ft.access";
const REFRESH_KEY = "ft.refresh";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/* --- token storage ------------------------------------------------------ */

let accessToken: string | null = null;
let refreshToken: string | null = null;

function loadTokens() {
  if (typeof window === "undefined") return;
  accessToken ??= window.localStorage.getItem(ACCESS_KEY);
  refreshToken ??= window.localStorage.getItem(REFRESH_KEY);
}

export function setTokens(t: Tokens) {
  accessToken = t.accessToken;
  refreshToken = t.refreshToken;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ACCESS_KEY, t.accessToken);
    window.localStorage.setItem(REFRESH_KEY, t.refreshToken);
  }
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(REFRESH_KEY);
  }
}

export function getAccessToken(): string | null {
  loadTokens();
  return accessToken;
}

export function isAuthenticated(): boolean {
  return getAccessToken() !== null;
}

/* --- core request ------------------------------------------------------- */

// Shared so N concurrent 401s trigger exactly one refresh, not N.
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  loadTokens();
  if (!refreshToken) return false;

  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${BASE}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        clearTokens();
        return false;
      }
      setTokens((await res.json()) as Tokens);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  loadTokens();

  const headers = new Headers(options.headers);
  // FormData must set its own Content-Type: the browser appends the multipart
  // boundary, and overriding it with application/json makes the body
  // unparseable on the server.
  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!headers.has("Content-Type") && options.body && !isFormData)
    headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...options, headers });
  } catch {
    throw new ApiError(
      0,
      "Cannot reach the server. Check the backend is running and that this origin is allowed by CORS_ORIGINS.",
    );
  }

  if (res.status === 401 && retry && (await tryRefresh()))
    return request<T>(path, options, false);

  if (!res.ok) {
    let detail: unknown;
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      detail = body;
      if (typeof body?.detail === "string") message = body.detail;
      else if (Array.isArray(body?.errors) && body.errors.length) {
        // FastAPI's validation handler returns [{field, message}, …].
        message = (body.errors as Array<{ field?: string; message: string }>)
          .map((e) => (e.field ? `${e.field}: ${e.message}` : e.message))
          .join(", ");
      }
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401) clearTokens();
    throw new ApiError(res.status, message, detail);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* --- endpoints ---------------------------------------------------------- */

export const api = {
  async login(email: string, password: string): Promise<Tokens> {
    const tokens = await request<Tokens>("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setTokens(tokens);
    return tokens;
  },

  async bootstrap(input: {
    organization_name: string;
    email: string;
    password: string;
    full_name: string;
  }): Promise<Tokens> {
    const tokens = await request<Tokens>("/v1/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setTokens(tokens);
    return tokens;
  },

  me: () => request<User>("/v1/auth/me"),

  orgSettings: () => request<OrgSettings>("/v1/org/settings"),
  updateOrgSettings: (body: unknown) =>
    request<OrgSettings>("/v1/org/settings", { method: "PATCH", body: JSON.stringify(body) }),
  /** All the data a consignment note prints, assembled server-side. */
  consignmentLr: (consignmentId: string) =>
    request<LrData>(`/v1/consignments/${consignmentId}/lr`),

  /** Fleet view: active and pending phones only. */
  listDevices: () => request<Device[]>("/v1/devices"),
  /** Device administration, where retired handsets are the point. */
  listAllDevices: () => request<Device[]>("/v1/devices?includeRevoked=true"),
  getDevice: (id: string) => request<Device>(`/v1/devices/${id}`),

  registerDevice: (label: string, driverId?: string | null) =>
    request<DeviceRegistered>("/v1/devices", {
      method: "POST",
      body: JSON.stringify({ label, driverId: driverId ?? null }),
    }),

  revokeDevice: (id: string) =>
    request<Device>(`/v1/devices/${id}/revoke`, { method: "POST" }),

  listDrivers: () => request<Driver[]>("/v1/drivers"),

  createDriver: (input: {
    fullName: string;
    phone?: string;
    employeeCode?: string;
  }) =>
    request<Driver>("/v1/drivers", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  latestPositions: () => request<Position[]>("/v1/tracking/latest"),

  history: (deviceId: string, params?: { start?: string; end?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.start) q.set("start", params.start);
    if (params?.end) q.set("end", params.end);
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return request<Position[]>(
      `/v1/tracking/devices/${deviceId}/history${qs ? `?${qs}` : ""}`,
    );
  },

  logout: () => clearTokens(),

  /* --- transport management --- */

  /** Upload a scanned document (PDF). Returns the reference to store on it. */
  uploadDocument: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<UploadedDocument>("/v1/documents", { method: "POST", body: form });
  },
  /** Authenticated URL for viewing a stored scan. */
  documentUrl: (fileUrl: string) => `${BASE}${fileUrl}`,

  listVehicles: () => request<Vehicle[]>("/v1/vehicles"),
  createVehicle: (body: unknown) =>
    request<Vehicle>("/v1/vehicles", { method: "POST", body: JSON.stringify(body) }),
  updateVehicle: (id: string, body: unknown) =>
    request<Vehicle>(`/v1/vehicles/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  listDriversFull: () => request<DriverFull[]>("/v1/drivers/full"),
  createDriverFull: (body: unknown) =>
    request<DriverCredentials>("/v1/drivers/full", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Issue a fresh temporary password. Returned once and never recoverable. */
  resetDriverPassword: (driverId: string) =>
    request<{ loginId: string; temporaryPassword: string; note: string }>(
      `/v1/auth/driver/${driverId}/reset-password`,
      { method: "POST" },
    ),
  updateDriver: (id: string, body: unknown) =>
    request<DriverFull>(`/v1/drivers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  getDriver: (id: string) => request<DriverFull>(`/v1/drivers/${id}/full`),

  listCustomers: () => request<Customer[]>("/v1/customers"),
  createCustomer: (body: unknown) =>
    request<Customer>("/v1/customers", { method: "POST", body: JSON.stringify(body) }),
  updateCustomer: (customerId: string, body: unknown) =>
    request<Customer>(`/v1/customers/${customerId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  updateCustomerAddress: (customerId: string, addressId: string, body: unknown) =>
    request<CustomerAddress>(`/v1/customers/${customerId}/addresses/${addressId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteCustomerAddress: (customerId: string, addressId: string) =>
    request<void>(`/v1/customers/${customerId}/addresses/${addressId}`, {
      method: "DELETE",
    }),
  addCustomerAddress: (customerId: string, body: unknown) =>
    request<CustomerAddress>(`/v1/customers/${customerId}/addresses`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  searchPlaces: (q: string, near?: { lat: number; lon: number }) => {
    const params = new URLSearchParams({ q, limit: "6" });
    // Biasing towards where the dispatcher is working is what stops
    // "Transport Nagar" resolving to a different state.
    if (near) {
      params.set("nearLat", String(near.lat));
      params.set("nearLon", String(near.lon));
    }
    return request<Place[]>(`/v1/places/search?${params}`);
  },
  reverseGeocode: (lat: number, lon: number) =>
    request<Place | null>(`/v1/places/reverse?lat=${lat}&lon=${lon}`),

  previewRoutes: (from: [number, number], to: [number, number]) =>
    request<{ routes: RouteOption[] }>(
      `/v1/routes/preview?fromLat=${from[0]}&fromLon=${from[1]}&toLat=${to[0]}&toLon=${to[1]}`,
    ),

  nextLrNumbers: (count = 3) =>
    request<{ suggestions: string[] }>(`/v1/consignments/next-numbers?count=${count}`),
  checkLrNumber: (lr: string) =>
    request<{ lrNumber: string; available: boolean }>(
      `/v1/consignments/check-number?lr=${encodeURIComponent(lr)}`,
    ),

  createBooking: (body: unknown) =>
    request<BookingResultData>("/v1/bookings", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listTrips: () => request<TripRow[]>("/v1/trips"),

  updateTrip: (tripId: string, body: unknown) =>
    request<{ id: string }>(`/v1/trips/${tripId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  cancelTrip: (tripId: string) =>
    request<{ id: string }>(`/v1/trips/${tripId}/cancel`, { method: "POST" }),
  updateConsignment: (consignmentId: string, body: unknown) =>
    request<{ id: string }>(`/v1/consignments/${consignmentId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  revokeLink: (tripId: string, party: string) =>
    request<{ party: string; revoked: boolean }>(
      `/v1/trips/${tripId}/links/${party}/revoke`,
      { method: "POST" },
    ),
  complianceAlerts: () => request<ComplianceAlert[]>("/v1/compliance/alerts"),
  notificationStatus: () => request<NotificationStatus>("/v1/notifications/status"),

  sendLink: (tripId: string, party: string, channel: string, recipient?: string) =>
    request<{
      status: string; channel: string; recipient: string | null;
      error: string | null; url: string; whatsappUrl?: string;
    }>(`/v1/trips/${tripId}/send-link`, {
      method: "POST",
      body: JSON.stringify({ party, channel, recipient }),
    }),
};

export { BASE as API_BASE };
