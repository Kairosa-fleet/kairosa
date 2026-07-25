"use client";

import { Battery, BatteryCharging, Search, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { cn, relativeTime, speedKmh } from "@/lib/format";
import { deviceHealth, type Device, type Position, type HealthLevel } from "@/lib/types";
import { EmptyState, Input, StatusDot } from "./ui";

/**
 * What to call a row in the fleet panel.
 *
 * The registration, whenever we have one. A device claimed by a driver signing
 * in is labelled with their name, which reads as a person rather than a truck
 * in a list headed "Vehicles".
 */
function fleetName(device: Device): string {
  return device.vehicleRegistration ?? device.label;
}

/** Worst-first, so anything needing attention is at the top without scrolling. */
const LEVEL_ORDER: Record<HealthLevel, number> = {
  critical: 0,
  warn: 1,
  ok: 2,
  idle: 3,
};

export function VehicleList({
  devices,
  positions,
  selectedId,
  onSelect,
}: {
  devices: Device[];
  positions: Map<string, Position>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return devices
      .filter((d) => !q || fleetName(d).toLowerCase().includes(q))
      .map((device) => {
        const position = positions.get(device.id);
        return { device, position, health: deviceHealth(position, device) };
      })
      .sort((a, b) => {
        const byLevel = LEVEL_ORDER[a.health.level] - LEVEL_ORDER[b.health.level];
        return byLevel !== 0 ? byLevel : fleetName(a.device).localeCompare(fleetName(b.device));
      });
  }, [devices, positions, query]);

  const counts = useMemo(() => {
    const c = { ok: 0, warn: 0, critical: 0, idle: 0 };
    for (const d of devices) c[deviceHealth(positions.get(d.id), d).level] += 1;
    return c;
  }, [devices, positions]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 border-b border-[var(--stroke)] p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Vehicles</h2>
          <span className="text-sm text-[var(--ink-2)]">{devices.length}</span>
        </div>

        {devices.length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {counts.ok > 0 && <Pill level="ok" n={counts.ok} label="live" />}
            {counts.warn > 0 && <Pill level="warn" n={counts.warn} label="check" />}
            {counts.critical > 0 && (
              <Pill level="critical" n={counts.critical} label="critical" />
            )}
            {counts.idle > 0 && <Pill level="idle" n={counts.idle} label="idle" />}
          </div>
        )}

        <div className="relative">
          <Search
            size={15}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--ink-3)]"
          />
          <Input
            name="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search vehicles"
            aria-label="Search vehicles"
            className="!py-2 pl-9 text-sm"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <EmptyState
            illustration={devices.length === 0 ? "/illustrations/empty.svg" : undefined}
            title={devices.length === 0 ? "No vehicles yet" : "No matches"}
            body={
              devices.length === 0
                ? "Register a device to start tracking."
                : "Try a different search."
            }
          />
        ) : (
          <ul>
            {rows.map(({ device, position, health }) => {
              const selected = device.id === selectedId;
              return (
                <li key={device.id}>
                  <button
                    onClick={() => onSelect(device.id)}
                    aria-current={selected ? "true" : undefined}
                    className={cn(
                      "w-full border-b border-[var(--stroke)] px-4 py-3 text-left transition-colors",
                      selected
                        ? "bg-[var(--accent-soft)]"
                        : "hover:bg-[var(--surface)]",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <StatusDot level={health.level} />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {fleetName(device)}
                      </span>
                      {position?.integrityFlags?.length ? (
                        <ShieldAlert
                          size={14}
                          className="shrink-0 text-[var(--danger)]"
                          aria-label={`${position.integrityFlags.length} integrity flags`}
                        />
                      ) : null}
                    </div>

                    <div className="mt-1 flex items-center gap-2 pl-4 text-xs text-[var(--ink-2)]">
                      <span>{health.label}</span>
                      {position && (
                        <>
                          <span aria-hidden>·</span>
                          <span>{speedKmh(position.speed)}</span>
                          <span aria-hidden>·</span>
                          <span>{relativeTime(position.recordedAt)}</span>
                        </>
                      )}
                      {position?.batteryLevel != null && (
                        <span
                          className={cn(
                            "ml-auto flex items-center gap-1",
                            position.batteryLevel < 0.15 && "text-[var(--warning)]",
                          )}
                        >
                          {position.isCharging ? (
                            <BatteryCharging size={12} aria-hidden />
                          ) : (
                            <Battery size={12} aria-hidden />
                          )}
                          {Math.round(position.batteryLevel * 100)}%
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Pill({ level, n, label }: { level: HealthLevel; n: number; label: string }) {
  const colors: Record<HealthLevel, string> = {
    ok: "var(--success)",
    warn: "var(--warning)",
    critical: "var(--danger)",
    idle: "var(--ink-2)",
  };
  return (
    <span className="flex items-center gap-1 text-[var(--ink-2)]">
      <span
        className="size-1.5 rounded-full"
        style={{ background: colors[level] }}
        aria-hidden
      />
      {n} {label}
    </span>
  );
}
