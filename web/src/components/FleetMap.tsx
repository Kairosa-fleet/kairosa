"use client";

/**
 * The map.
 *
 * Mounted once and never unmounted. Markers are managed imperatively against
 * the MapLibre instance rather than rendered as React children — re-rendering
 * a marker tree on every WebSocket frame would thrash the DOM, and remounting
 * the map itself is visibly janky (and used to cost money under Google's
 * per-map-load billing).
 */

import maplibregl, { type LngLatLike, type Map as MlMap, type Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";

import {
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  isMapConfigured,
  styleUrl,
} from "@/lib/mapProvider";
import { speedKmh } from "@/lib/format";
import { deviceHealth, type Device, type Position } from "@/lib/types";

const LEVEL_COLOR: Record<string, string> = {
  ok: "var(--success)",
  warn: "var(--warning)",
  critical: "var(--danger)",
  idle: "var(--ink-2)",
};

function markerElement(position: Position, device?: Device): HTMLDivElement {
  const health = deviceHealth(position, device);
  const color = LEVEL_COLOR[health.level];

  const el = document.createElement("div");
  el.className = "ft-marker";
  el.style.cssText = "position:relative;width:34px;height:34px;cursor:pointer;";
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute(
    "aria-label",
    `${position.label ?? "Device"} — ${health.label}, ${speedKmh(position.speed)}`,
  );

  // Only live vehicles pulse. If everything pulsed, nothing would stand out.
  const pulse =
    health.level === "ok" && (position.speed ?? 0) > 1
      ? `<span style="position:absolute;inset:0;border-radius:50%;background:${color};
           opacity:.35;animation:pulse-ring 2.4s cubic-bezier(.4,0,.6,1) infinite;"></span>`
      : "";

  // A bearing arrow only makes sense when the vehicle is actually moving.
  const arrow =
    position.bearing != null && (position.speed ?? 0) > 1
      ? `<span style="position:absolute;left:50%;top:50%;width:0;height:0;
           transform:translate(-50%,-50%) rotate(${position.bearing}deg) translateY(-15px);
           border-left:5px solid transparent;border-right:5px solid transparent;
           border-bottom:8px solid ${color};"></span>`
      : "";

  el.innerHTML = `
    ${pulse}
    <span style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
      width:16px;height:16px;border-radius:50%;background:${color};
      border:3px solid var(--bg);box-shadow:0 1px 4px rgb(0 0 0 / .35);"></span>
    ${arrow}`;
  return el;
}

function popupHtml(position: Position, device?: Device): string {
  const health = deviceHealth(position, device);
  const flags = position.integrityFlags?.length
    ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--stroke);
         color:var(--danger);font-size:11px;">⚠ ${position.integrityFlags.length} integrity flag(s)</div>`
    : "";
  return `
    <div style="padding:10px 12px;min-width:180px;font-family:var(--font-inter),sans-serif;">
      <div style="font-weight:600;color:var(--ink);margin-bottom:2px;">
        ${position.label ?? "Device"}
      </div>
      <div style="font-size:12px;color:${LEVEL_COLOR[health.level]};margin-bottom:6px;">
        ${health.label} · ${health.reason}
      </div>
      <div style="font-size:12px;color:var(--ink-2);line-height:1.5;">
        ${speedKmh(position.speed)}${position.activity ? ` · ${position.activity}` : ""}<br/>
        <span style="font-family:var(--font-jetbrains),monospace;">
          ${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}
        </span>
      </div>
      ${flags}
    </div>`;
}

export function FleetMap({
  positions,
  devices,
  selectedId,
  onSelect,
  theme,
  trail,
}: {
  positions: Position[];
  devices: Map<string, Device>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  theme: "light" | "dark";
  trail?: Position[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const readyRef = useRef(false);
  const didFitRef = useRef(false);
  const onSelectRef = useRef(onSelect);

  // Assigned in an effect, never during render — mutating a ref while
  // rendering is unsafe under concurrent React.
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  /* Create the map exactly once. */
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !isMapConfigured()) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl(theme),
      center: DEFAULT_CENTER as LngLatLike,
      zoom: DEFAULT_ZOOM,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 100, unit: "metric" }),
      "bottom-left",
    );
    map.on("load", () => {
      readyRef.current = true;
    });
    map.on("click", () => onSelectRef.current(null));
    mapRef.current = map;

    const markers = markersRef.current;
    return () => {
      markers.forEach((m) => m.remove());
      markers.clear();
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
    // Theme is handled separately via setStyle so the map is never recreated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Theme change swaps the style in place rather than rebuilding the map. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setStyle(styleUrl(theme));
  }, [theme]);

  /* Sync markers to the current positions. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const seen = new Set<string>();

    for (const position of positions) {
      seen.add(position.deviceId);
      const device = devices.get(position.deviceId);
      const lngLat: [number, number] = [position.longitude, position.latitude];
      const existing = markersRef.current.get(position.deviceId);

      if (existing) {
        existing.setLngLat(lngLat);
        // Replace the element only when the visual actually changes, so we
        // aren't rebuilding DOM on every frame.
        const next = markerElement(position, device);
        const current = existing.getElement();
        if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
        existing.getPopup()?.setHTML(popupHtml(position, device));
      } else {
        const el = markerElement(position, device);
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          onSelectRef.current(position.deviceId);
        });
        const marker = new maplibregl.Marker({ element: el })
          .setLngLat(lngLat)
          .setPopup(
            new maplibregl.Popup({ offset: 18, closeButton: false }).setHTML(
              popupHtml(position, device),
            ),
          )
          .addTo(map);
        markersRef.current.set(position.deviceId, marker);
      }
    }

    for (const [id, marker] of markersRef.current) {
      if (!seen.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }

    // Fit to the fleet once, on first data — after that the operator's chosen
    // viewport is theirs to keep.
    if (!didFitRef.current && positions.length > 0) {
      didFitRef.current = true;
      if (positions.length === 1) {
        map.easeTo({
          center: [positions[0].longitude, positions[0].latitude],
          zoom: 13,
        });
      } else {
        const bounds = new maplibregl.LngLatBounds();
        positions.forEach((p) => bounds.extend([p.longitude, p.latitude]));
        map.fitBounds(bounds, { padding: 96, maxZoom: 14, duration: 800 });
      }
    }
  }, [positions, devices]);

  /* Fly to the selected device. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const target = positions.find((p) => p.deviceId === selectedId);
    if (!target) return;
    map.easeTo({
      center: [target.longitude, target.latitude],
      zoom: Math.max(map.getZoom(), 14),
      duration: 700,
    });
    markersRef.current.get(selectedId)?.togglePopup();
    // Only react to a change of selection, not to every position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /* History trail for the selected device. */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    const draw = () => {
      const data = {
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "LineString" as const,
          coordinates: (trail ?? []).map((p) => [p.longitude, p.latitude]),
        },
      };
      const source = map.getSource("trail") as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
        return;
      }
      if (!trail?.length) return;
      map.addSource("trail", { type: "geojson", data });
      map.addLayer({
        id: "trail-line",
        type: "line",
        source: "trail",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#0d7d74",
          "line-width": 3,
          "line-opacity": 0.75,
        },
      });
    };

    if (map.isStyleLoaded()) draw();
    else map.once("styledata", draw);
  }, [trail]);

  if (!isMapConfigured()) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--surface)] p-8">
        <div className="max-w-sm text-center">
          <h3 className="mb-2 text-lg font-semibold">Map not configured</h3>
          <p className="text-sm text-[var(--ink-2)]">
            Set <code className="font-[family-name:var(--font-jetbrains)]">
              NEXT_PUBLIC_MAPTILER_KEY
            </code>{" "}
            in <code className="font-[family-name:var(--font-jetbrains)]">web/.env.local</code>{" "}
            and restart the dev server.
          </p>
        </div>
      </div>
    );
  }

  return <div ref={containerRef} className="h-full w-full" />;
}
