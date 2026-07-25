"use client";

/**
 * The customer's view. Public, no login — the token in the URL is the only
 * credential, which is exactly why the API deliberately withholds the driver's
 * licence, the vehicle's chassis numbers, freight amounts and the other
 * party's contact details.
 */

import maplibregl, { type Map as MlMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { use, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { Logo } from "@/components/Logo";
import { API_BASE } from "@/lib/api";
import { isMapConfigured, styleUrl } from "@/lib/mapProvider";
import { relativeTime } from "@/lib/format";

interface TrackData {
  transporter: string | null;
  party: string;
  lrNumber: string;
  status: string;
  goods: string;
  packages: number | null;
  weightKg: number | null;
  scheduledStart: string;
  deliveredAt: string | null;
  origin: { label: string; address: string; latitude: number; longitude: number };
  destination: { label: string; address: string; latitude: number; longitude: number };
  counterparty: string;
  vehicle: { registrationNumber: string } | null;
  driver: { name: string; phone: string | null } | null;
  route: {
    // GeoJSON LineString from the router; typed narrowly so MapLibre accepts it.
    geometry: { type: "LineString"; coordinates: [number, number][] } | null;
    distanceKm: number | null;
    durationH: number | null;
  };
  position: { latitude: number; longitude: number; speedKmh: number; recordedAt: string; isLive: boolean } | null;
}

const STATUS_LABEL: Record<string, string> = {
  planned: "Being scheduled", assigned: "Vehicle assigned", started: "Picked up",
  in_transit: "On the way", at_destination: "Arriving", delivered: "Delivered",
  cancelled: "Cancelled",
};

export default function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  // Next 16 route params are async; `use` unwraps them during render.
  const { token } = use(params);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const truckRef = useRef<Marker | null>(null);

  /* Polled rather than a WebSocket: a customer leaves this tab open for hours,
     and a socket per viewer costs far more than a 20s poll. */
  const { data, error } = useQuery<TrackData>({
    queryKey: ["track", token],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/v1/track/${token}`);
      if (!res.ok) throw new Error((await res.json()).detail ?? "Not found");
      return res.json();
    },
    refetchInterval: 20_000,
    retry: false,
  });

  /* Map, created once data arrives. */
  useEffect(() => {
    if (!data || !containerRef.current || mapRef.current || !isMapConfigured()) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl("light"),
      center: [data.origin.longitude, data.origin.latitude],
      zoom: 6,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      if (data.route.geometry) {
        map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: data.route.geometry } });
        map.addLayer({
          id: "route-line", type: "line", source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#6366F1", "line-width": 4, "line-opacity": 0.75 },
        });
      }
      new maplibregl.Marker({ color: "#0F9D76" })
        .setLngLat([data.origin.longitude, data.origin.latitude])
        .setPopup(new maplibregl.Popup({ offset: 16 }).setText(`Pickup: ${data.origin.label}`))
        .addTo(map);
      new maplibregl.Marker({ color: "#E5484D" })
        .setLngLat([data.destination.longitude, data.destination.latitude])
        .setPopup(new maplibregl.Popup({ offset: 16 }).setText(`Delivery: ${data.destination.label}`))
        .addTo(map);

      const bounds = new maplibregl.LngLatBounds();
      bounds.extend([data.origin.longitude, data.origin.latitude]);
      bounds.extend([data.destination.longitude, data.destination.latitude]);
      map.fitBounds(bounds, { padding: 70, maxZoom: 12, duration: 0 });
    });

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; truckRef.current = null; };
  }, [data]);

  /* Move the truck marker as new positions arrive. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data?.position) return;
    const at: [number, number] = [data.position.longitude, data.position.latitude];
    if (truckRef.current) {
      truckRef.current.setLngLat(at);
      return;
    }
    const el = document.createElement("div");
    el.style.cssText = "width:22px;height:22px;border-radius:50%;background:#6366F1;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35)";
    truckRef.current = new maplibregl.Marker({ element: el }).setLngLat(at).addTo(map);
  }, [data?.position]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <h1 className="mb-2 text-[1.5rem]">Link not valid</h1>
          <p className="text-sm text-[var(--ink-2)]">
            This tracking link may have expired or been withdrawn. Please ask
            the sender for a new one.
          </p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-[var(--ink-2)]">Loading shipment…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <header className="flex items-center justify-between border-b border-[var(--stroke)] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Logo size={22} className="text-[var(--accent)]" />
          <div>
            <div className="text-sm font-semibold">{data.transporter}</div>
            <div className="font-[family-name:var(--font-jetbrains)] text-xs text-[var(--ink-2)]">
              {data.lrNumber}
            </div>
          </div>
        </div>
        <span
          className="rounded-[var(--radius-pill)] px-3 py-1.5 text-sm font-medium"
          style={{
            color: data.position?.isLive ? "var(--success)" : "var(--ink-2)",
            background: data.position?.isLive ? "var(--success-soft)" : "var(--surface)",
          }}
        >
          {STATUS_LABEL[data.status] ?? data.status}
        </span>
      </header>

      <div className="h-[45vh] w-full sm:h-[55vh]">
        <div ref={containerRef} className="h-full w-full" />
      </div>

      <section className="mx-auto max-w-2xl space-y-4 p-4 pb-12">
        <div className="rounded-[var(--radius-card)] border border-[var(--stroke)] p-4">
          <div className="flex items-start gap-3">
            <div className="mt-1 flex flex-col items-center">
              <span className="size-2.5 rounded-full bg-[var(--success)]" />
              <span className="my-1 h-8 w-px bg-[var(--stroke)]" />
              <span className="size-2.5 rounded-full bg-[var(--danger)]" />
            </div>
            <div className="flex-1 space-y-6">
              <div>
                <div className="text-xs tracking-wide text-[var(--ink-2)] uppercase">Pickup</div>
                <div className="text-sm font-medium">{data.origin.label}</div>
                <div className="text-xs text-[var(--ink-2)]">{data.origin.address}</div>
              </div>
              <div>
                <div className="text-xs tracking-wide text-[var(--ink-2)] uppercase">Delivery</div>
                <div className="text-sm font-medium">{data.destination.label}</div>
                <div className="text-xs text-[var(--ink-2)]">{data.destination.address}</div>
              </div>
            </div>
          </div>
        </div>

        {data.position && (
          <div className="rounded-[var(--radius-card)] border border-[var(--stroke)] p-4">
            <div className="mb-2 text-sm font-semibold">Vehicle position</div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Row label="Speed" value={`${data.position.speedKmh} km/h`} />
              <Row label="Updated" value={relativeTime(data.position.recordedAt)} />
            </div>
            {!data.position.isLive && (
              <p className="mt-2 text-xs text-[var(--ink-2)]">
                The last update is not recent — the vehicle may be in an area
                with no mobile signal.
              </p>
            )}
          </div>
        )}

        <div className="rounded-[var(--radius-card)] border border-[var(--stroke)] p-4">
          <div className="mb-2 text-sm font-semibold">Shipment</div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Row label="Goods" value={data.goods} />
            {data.packages && <Row label="Packages" value={String(data.packages)} />}
            {data.weightKg && <Row label="Weight" value={`${(data.weightKg / 1000).toFixed(1)} T`} />}
            {data.route.distanceKm && <Row label="Distance" value={`${data.route.distanceKm} km`} />}
            {data.vehicle && <Row label="Vehicle" value={data.vehicle.registrationNumber} />}
            {data.driver && <Row label="Driver" value={`${data.driver.name}${data.driver.phone ? ` · ${data.driver.phone}` : ""}`} />}
            <Row
              label={data.party === "consignor" ? "Receiver" : "Sender"}
              value={data.counterparty}
            />
            <Row
              label="Scheduled"
              value={new Date(data.scheduledStart).toLocaleString(undefined, {
                day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
              })}
            />
          </div>
        </div>

        <p className="text-center text-xs text-[var(--ink-3)]">
          This page updates automatically. Please do not share the link publicly.
        </p>
      </section>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs tracking-wide text-[var(--ink-2)] uppercase">{label}</div>
      <div className="text-[var(--ink)]">{value}</div>
    </div>
  );
}
