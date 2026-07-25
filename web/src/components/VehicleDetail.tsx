"use client";

import {
  Battery,
  BatteryCharging,
  Clock,
  Compass,
  Gauge,
  MapPin,
  Route,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useState } from "react";

import { api } from "@/lib/api";
import { clockTime, compass, coords, metres, percent, relativeTime, speedKmh } from "@/lib/format";
import {
  INTEGRITY_FLAG_LABELS,
  TRUST_SPOOFED,
  TRUST_SUSPICIOUS,
  deviceHealth,
  type Device,
  type Position,
} from "@/lib/types";
import { Button, StatusBadge, Stat } from "./ui";

export function VehicleDetail({
  device,
  position,
  onClose,
  onTrailChange,
}: {
  device: Device;
  position?: Position;
  onClose: () => void;
  onTrailChange: (trail: Position[] | undefined) => void;
}) {
  // This component is keyed by device.id in the parent, so selecting a
  // different vehicle remounts it and this state resets naturally — no
  // reset-in-effect needed.
  const [showTrail, setShowTrail] = useState(false);
  const [loadingTrail, setLoadingTrail] = useState(false);
  const health = deviceHealth(position, device);
  const trust = position?.trustScore ?? device.trustScore;

  async function toggleTrail() {
    if (showTrail) {
      setShowTrail(false);
      onTrailChange(undefined);
      return;
    }
    setLoadingTrail(true);
    try {
      const rows = await api.history(device.id, { limit: 1000 });
      onTrailChange(rows);
      setShowTrail(true);
    } catch {
      onTrailChange(undefined);
    } finally {
      setLoadingTrail(false);
    }
  }

  const trustColor =
    trust < TRUST_SPOOFED
      ? "var(--danger)"
      : trust < TRUST_SUSPICIOUS
        ? "var(--warning)"
        : "var(--success)";

  return (
    <div className="pointer-events-auto w-full overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--bg)] shadow-[var(--shadow-pop)] sm:w-[22rem]">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--stroke)] p-4">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{device.label}</h3>
          <p className="mt-0.5 text-xs text-[var(--ink-2)]">
            {device.model ?? device.platform ?? "Unknown device"}
            {device.isOnDuty ? " · on duty" : " · off duty"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge level={health.level} label={health.label} size="sm" />
          <button
            onClick={onClose}
            aria-label="Close details"
            className="rounded p-1 text-[var(--ink-3)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--ink)]"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>

      {position ? (
        <>
          <div className="grid grid-cols-2 gap-4 p-4">
            <Stat
              label="Speed"
              value={
                <span className="flex items-center gap-1.5">
                  <Gauge size={13} className="text-[var(--ink-3)]" aria-hidden />
                  {speedKmh(position.speed)}
                </span>
              }
            />
            <Stat
              label="Heading"
              value={
                <span className="flex items-center gap-1.5">
                  <Compass size={13} className="text-[var(--ink-3)]" aria-hidden />
                  {compass(position.bearing)}
                  {position.bearing != null && (
                    <span className="text-[var(--ink-3)]">
                      {Math.round(position.bearing)}°
                    </span>
                  )}
                </span>
              }
            />
            <Stat
              label="Battery"
              value={
                <span className="flex items-center gap-1.5">
                  {position.isCharging ? (
                    <BatteryCharging size={13} className="text-[var(--success)]" aria-hidden />
                  ) : (
                    <Battery size={13} className="text-[var(--ink-3)]" aria-hidden />
                  )}
                  {percent(position.batteryLevel)}
                </span>
              }
            />
            <Stat
              label="Accuracy"
              value={
                <span className="flex items-center gap-1.5">
                  <MapPin size={13} className="text-[var(--ink-3)]" aria-hidden />
                  {metres(position.accuracy)}
                </span>
              }
            />
            <div className="col-span-2">
              <Stat label="Coordinates" value={coords(position.latitude, position.longitude)} mono />
            </div>
            <div className="col-span-2">
              <Stat
                label="Last fix"
                value={
                  <span className="flex items-center gap-1.5">
                    <Clock size={13} className="text-[var(--ink-3)]" aria-hidden />
                    {clockTime(position.recordedAt)}
                    <span className="text-[var(--ink-2)]">
                      ({relativeTime(position.recordedAt)})
                    </span>
                  </span>
                }
              />
            </div>
          </div>

          {/* Integrity is given its own block rather than buried as a number —
              it is the thing an operator most needs to notice. */}
          <div className="border-t border-[var(--stroke)] p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs tracking-wide text-[var(--ink-2)] uppercase">
                {trust >= TRUST_SUSPICIOUS ? (
                  <ShieldCheck size={13} aria-hidden />
                ) : (
                  <ShieldAlert size={13} aria-hidden />
                )}
                Location integrity
              </span>
              <span className="text-sm font-semibold" style={{ color: trustColor }}>
                {Math.round(trust)}/100
              </span>
            </div>

            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]"
              role="meter"
              aria-valuenow={Math.round(trust)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Location trust score"
            >
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${Math.max(2, trust)}%`, background: trustColor }}
              />
            </div>

            {position.integrityFlags?.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {position.integrityFlags.map((flag) => (
                  <li key={flag} className="flex items-start gap-2 text-xs text-[var(--ink-2)]">
                    <span
                      className="mt-1 size-1.5 shrink-0 rounded-full"
                      style={{ background: "var(--danger)" }}
                      aria-hidden
                    />
                    {INTEGRITY_FLAG_LABELS[flag] ?? flag}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-[var(--stroke)] p-3">
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={toggleTrail}
              loading={loadingTrail}
            >
              <Route size={14} aria-hidden />
              {showTrail ? "Hide route" : "Show today's route"}
            </Button>
          </div>
        </>
      ) : (
        <div className="p-6 text-center text-sm text-[var(--ink-2)]">
          No position data yet.
          <br />
          {health.reason}
        </div>
      )}
    </div>
  );
}
