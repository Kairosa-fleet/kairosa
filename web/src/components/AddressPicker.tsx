"use client";

/**
 * Address entry for Indian addresses.
 *
 * The design follows from a fact about Indian addressing that no geocoder
 * solves: a flat number in a named building — "C2/301 Siddheshwar Harmony,
 * behind Sayaji Township" — is not in any address database. Searching for it
 * returns the road at best, the city at worst.
 *
 * So the text and the point are kept as two separate things:
 *
 *   * **The written address** is whatever the operator types, preserved
 *     verbatim. It goes on the consignment note and is what the driver reads
 *     to find the door. The earlier version overwrote it with the geocoder's
 *     guess, which silently deleted the flat number, the building name and
 *     the landmark — the only parts that actually locate the place.
 *   * **The point** is what the route and the customer's tracking map are
 *     built from. It comes from a search hit or, better, from the operator
 *     dropping the pin on the gate.
 *
 * Because the point is often coarser than it looks, its precision is shown
 * and stored rather than assumed.
 */

import { Loader2, MapPin, Search, X } from "lucide-react";
import maplibregl, { type Map as MlMap, type Marker } from "maplibre-gl";
// Without this the marker element has no positioning styles and renders
// invisibly at the map's origin — the "where is the pin?" bug. The live map
// and the tracking page both import it; the picker previously did not.
import "maplibre-gl/dist/maplibre-gl.css";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import { isMapConfigured, styleUrl } from "@/lib/mapProvider";
import type { Place } from "@/lib/types";
import { useResolvedTheme } from "./ThemeToggle";
import { Input } from "./ui";

/** Where the coordinates came from, worst to best. */
export type Precision = "area" | "street" | "exact" | "pinned";

export interface PickedAddress {
  line1: string;
  city: string | null;
  state: string | null;
  pincode: string | null;
  latitude: number;
  longitude: number;
  placeName: string | null;
  precision: Precision;
}

const PRECISION_COPY: Record<Precision, { label: string; tone: string; note: string }> = {
  pinned: {
    label: "Pin placed by hand",
    tone: "success",
    note: "The driver will be routed to exactly this point.",
  },
  exact: {
    label: "Building or plot level",
    tone: "success",
    note: "Check the pin sits on the gate the truck should use.",
  },
  street: {
    label: "Street level",
    tone: "warning",
    note: "This is the road, not the gate. Drag the pin to the entrance.",
  },
  area: {
    label: "Area centre only",
    tone: "warning",
    note:
      "This is the middle of a locality, not an address. The driver will be " +
      "sent to the wrong place unless you drag the pin to the actual gate.",
  },
};

/** Remembers the last place picked, to bias the next search sensibly. */
const NEAR_KEY = "ft.lastPickedPoint";

function readLastPoint(): { lat: number; lon: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(NEAR_KEY);
    return raw ? (JSON.parse(raw) as { lat: number; lon: number }) : null;
  } catch {
    return null;
  }
}

export function AddressPicker({
  label,
  value,
  onChange,
  near,
}: {
  label: string;
  value: PickedAddress | null;
  onChange: (address: PickedAddress | null) => void;
  /** Bias searches towards here — usually the consignment's other end. */
  near?: { lat: number; lon: number } | null;
}) {
  const theme = useResolvedTheme();

  const [written, setWritten] = useState(value?.line1 ?? "");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [point, setPoint] = useState<{
    lat: number; lon: number; precision: Precision;
    city: string | null; state: string | null; pincode: string | null;
    placeName: string | null;
  } | null>(
    value
      ? {
          lat: value.latitude, lon: value.longitude, precision: value.precision,
          city: value.city, state: value.state, pincode: value.pincode,
          placeName: value.placeName,
        }
      : null,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markerRef = useRef<Marker | null>(null);

  /* Push a complete address up whenever either half changes. Both are needed:
     text with no point cannot be routed, a point with no text cannot be
     found by a driver. */
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!written.trim() || !point) {
      onChangeRef.current(null);
      return;
    }
    onChangeRef.current({
      line1: written.trim().slice(0, 240),
      city: point.city,
      state: point.state,
      pincode: point.pincode,
      latitude: point.lat,
      longitude: point.lon,
      placeName: point.placeName?.slice(0, 390) ?? null,
      precision: point.precision,
    });
  }, [written, point]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Fall back to the last place this operator picked. A transporter books from
  // the same few cities all week, so it is a far better guess than nothing.
  const bias = near ?? readLastPoint();

  const search = useQuery({
    queryKey: ["places", debounced, bias?.lat ?? null, bias?.lon ?? null],
    queryFn: () => api.searchPlaces(debounced, bias ?? undefined),
    enabled: debounced.length >= 3,
  });
  const results: Place[] = search.data ?? [];

  const applyPoint = useCallback((next: {
    lat: number; lon: number; precision: Precision;
    city?: string | null; state?: string | null; pincode?: string | null;
    placeName?: string | null;
  }) => {
    setPoint((current) => ({
      lat: next.lat,
      lon: next.lon,
      precision: next.precision,
      // Keep anything already filled in — a hand-dragged pin should not blank
      // a PIN code the operator typed or a previous search resolved.
      city: next.city ?? current?.city ?? null,
      state: next.state ?? current?.state ?? null,
      pincode: next.pincode ?? current?.pincode ?? null,
      placeName: next.placeName ?? current?.placeName ?? null,
    }));
    try {
      window.localStorage.setItem(NEAR_KEY, JSON.stringify({ lat: next.lat, lon: next.lon }));
    } catch { /* private browsing — the bias is optional */ }
  }, []);

  const pick = useCallback((place: Place) => {
    applyPoint({
      lat: place.latitude,
      lon: place.longitude,
      precision: (place.precision as Precision) ?? "area",
      city: place.city, state: place.state, pincode: place.pincode,
      placeName: place.placeName,
    });
    // Deliberately does NOT touch `written`. The geocoder found roughly where
    // this is; it did not improve on what the operator wrote.
    setQuery("");
    setDebounced("");
    setDismissed(true);
    setShowMap(true);
  }, [applyPoint]);

  /* Map for pin-dropping, created only when opened. */
  useEffect(() => {
    if (!showMap || !containerRef.current || mapRef.current || !isMapConfigured())
      return;

    const centre: [number, number] = point ? [point.lon, point.lat] : [78.9629, 22.5937];
    const map = new maplibregl.Map({
      container: containerRef.current,
      // The detailed street map: building footprints and landmark labels are
      // how an operator locates an Indian address the geocoder cannot find.
      style: styleUrl(theme, "detailed"),
      center: centre,
      // Zoomed in enough to distinguish one gate from the next. Opening at a
      // whole-country zoom made the pin useless.
      zoom: point ? 17 : 4,
      maxZoom: 19,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new maplibregl.GeolocateControl({ trackUserLocation: false }),
      "top-right",
    );

    // A larger pin than the default, so it reads as "the pin" on a busy street
    // map rather than getting lost among the POI markers.
    const marker = new maplibregl.Marker({ color: "#4F46E5", draggable: true, scale: 1.25 })
      .setLngLat(centre)
      .addTo(map);
    markerRef.current = marker;

    const commit = async (lngLat: { lng: number; lat: number }) => {
      // A human placing the pin is the most trustworthy source there is, so
      // reverse geocoding only fills the postal fields — it never moves the
      // point and never downgrades the precision.
      const place = await api.reverseGeocode(lngLat.lat, lngLat.lng).catch(() => null);
      applyPoint({
        lat: lngLat.lat,
        lon: lngLat.lng,
        precision: "pinned",
        city: place?.city ?? null,
        state: place?.state ?? null,
        pincode: place?.pincode ?? null,
        placeName: place?.placeName ?? null,
      });
    };

    map.on("click", (e) => { marker.setLngLat(e.lngLat); void commit(e.lngLat); });
    marker.on("dragend", () => void commit(marker.getLngLat()));
    // The container was hidden until this render, so its size may have been
    // measured as zero. Recompute once tiles are ready or the map paints blank.
    map.on("load", () => map.resize());

    mapRef.current = map;
    return () => {
      marker.remove();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMap]);

  /* Keep the pin in step when a suggestion is chosen instead. */
  useEffect(() => {
    if (!mapRef.current || !markerRef.current || !point) return;
    markerRef.current.setLngLat([point.lon, point.lat]);
    mapRef.current.easeTo({ center: [point.lon, point.lat], zoom: 16 });
  }, [point]);

  const copy = point ? PRECISION_COPY[point.precision] : null;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor={`written-${label}`} className="text-sm font-medium text-[var(--ink)]">
          {label}
        </label>
        <textarea
          id={`written-${label}`}
          value={written}
          onChange={(e) => setWritten(e.target.value)}
          rows={3}
          placeholder={"C2/301 Siddheshwar Harmony,\nbehind Sayaji Township, New VIP Road,\nVadodara, Gujarat 390019"}
          className="w-full rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        />
        <p className="text-xs text-[var(--ink-2)]">
          Write it exactly as the driver needs to read it — flat or plot number,
          building, landmark. This is kept word for word and printed on the
          consignment note.
        </p>
      </div>

      {/* Locating is a separate step, because finding the point and writing
          the address are genuinely different jobs for an Indian address. */}
      <div className="space-y-2 rounded-[var(--radius-control)] border border-[var(--stroke)] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Location on the map</span>
          <button
            type="button"
            onClick={() => setShowMap((v) => !v)}
            className="text-xs font-medium text-[var(--accent)] hover:underline"
          >
            {showMap ? "Hide map" : "Pick on map"}
          </button>
        </div>

        <div className="relative">
          <Search
            size={15}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 text-[var(--ink-3)]"
          />
          <Input
            name={`addr-${label}`}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setDismissed(false); }}
            onFocus={() => setDismissed(false)}
            placeholder="Search the road, area or landmark…"
            className="pl-9"
            autoComplete="off"
          />
          {search.isFetching && (
            <Loader2
              size={15}
              className="absolute top-1/2 right-3 -translate-y-1/2 animate-spin text-[var(--ink-3)]"
              aria-hidden
            />
          )}

          {!dismissed && results.length > 0 && (
            <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--bg)] shadow-[var(--shadow-pop)]">
              {results.map((place) => (
                <li key={place.id}>
                  <button
                    type="button"
                    onClick={() => pick(place)}
                    className="flex w-full items-start gap-2 border-b border-[var(--stroke)] px-3 py-2.5 text-left last:border-0 hover:bg-[var(--surface)]"
                  >
                    <MapPin
                      size={14}
                      className={cn(
                        "mt-0.5 shrink-0",
                        place.kind === "poi" ? "text-[var(--accent)]" : "text-[var(--ink-3)]",
                      )}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm text-[var(--ink)]">{place.text}</span>
                        {/* Landmarks are how Indian addresses are described, so
                            flag them — a nearby POI is often the best pin. */}
                        {place.kind === "poi" && (
                          <span className="shrink-0 rounded-[var(--radius-chip)] bg-[var(--accent-soft)] px-1.5 py-px text-[0.65rem] font-semibold text-[var(--accent)]">
                            landmark
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-[var(--ink-2)]">{place.placeName}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      {/* Distance is shown because the provider will happily
                          offer a match 1,000 km away and it looks identical
                          to the right one in a list. */}
                      {typeof place.distanceKm === "number" && (
                        <div className="text-xs text-[var(--ink-3)]">
                          {place.distanceKm < 1
                            ? "here"
                            : `${Math.round(place.distanceKm)} km`}
                        </div>
                      )}
                      {place.precision === "area" && (
                        <div className="text-[0.65rem] text-[var(--warning)]">area only</div>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {point && copy && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-[var(--radius-control)] p-2.5 text-xs",
              copy.tone === "success"
                ? "bg-[var(--success-soft)] text-[var(--success)]"
                : "bg-[var(--warning-soft)] text-[var(--warning)]",
            )}
          >
            <MapPin size={13} className="mt-0.5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{copy.label}</div>
              <div className="mt-0.5 opacity-90">{copy.note}</div>
              <div className="mt-1 font-[family-name:var(--font-jetbrains)] opacity-80">
                {point.lat.toFixed(5)}, {point.lon.toFixed(5)}
                {point.pincode ? ` · ${point.pincode}` : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPoint(null)}
              aria-label="Clear location"
              className="rounded p-1 opacity-70 hover:opacity-100"
            >
              <X size={13} aria-hidden />
            </button>
          </div>
        )}

        {!point && (
          <p className="text-xs text-[var(--ink-2)]">
            Search for the road or area, then drag the pin onto the gate. A flat
            or plot number cannot be found by search — it has to be pinned.
          </p>
        )}

        {showMap && (
          <div
            ref={containerRef}
            className="h-64 w-full overflow-hidden rounded-[var(--radius-control)] border border-[var(--stroke)]"
          />
        )}
      </div>
    </div>
  );
}

/** Compact button set used where a full picker is too heavy. */
export function AddressSummary({ address }: { address: PickedAddress }) {
  return (
    <span className="text-sm text-[var(--ink-2)]">
      {address.city ?? address.line1}
    </span>
  );
}
