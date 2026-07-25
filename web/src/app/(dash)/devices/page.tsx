"use client";

import { Check, Copy, Plus, ShieldOff, Smartphone } from "lucide-react";
import { useState } from "react";

import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  Spinner,
  StatusBadge,
} from "@/components/ui";
import { relativeTime } from "@/lib/format";
import {
  useAllDevices,
  useDrivers,
  useRegisterDevice,
  useRevokeDevice,
} from "@/lib/queries";
import {
  TRUST_SPOOFED,
  TRUST_SUSPICIOUS,
  type Device,
  type DeviceRegistered,
} from "@/lib/types";

export default function DevicesPage() {
  const devicesQuery = useAllDevices();
  const driversQuery = useDrivers();
  const register = useRegisterDevice();
  const revoke = useRevokeDevice();

  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [driverId, setDriverId] = useState("");
  const [justRegistered, setJustRegistered] = useState<DeviceRegistered | null>(null);

  const devices = devicesQuery.data ?? [];
  const drivers = driversQuery.data ?? [];
  const error =
    devicesQuery.error ?? register.error ?? revoke.error ?? driversQuery.error;

  async function onRegister(e: React.FormEvent) {
    e.preventDefault();
    const created = await register.mutateAsync({ label, driverId: driverId || null });
    setJustRegistered(created);
    setLabel("");
    setDriverId("");
    setShowForm(false);
  }

  function onRevoke(device: Device) {
    if (
      !window.confirm(
        `Revoke "${device.label}"?\n\nThe phone stops being able to report immediately, and the device must be enrolled again with a new code.`,
      )
    )
      return;
    revoke.mutate(device.id);
  }

  if (devicesQuery.isPending) return <Spinner label="Loading devices…" />;

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-[1.75rem]">Devices</h1>
          <p className="mt-1 text-sm text-[var(--ink-2)]">
            Each phone running the tracking app is enrolled once with a single-use code.
          </p>
        </div>
        <Button onClick={() => setShowForm((v) => !v)}>
          <Plus size={16} aria-hidden />
          Add device
        </Button>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorNote>
            {error instanceof Error ? error.message : "Something went wrong"}
          </ErrorNote>
        </div>
      )}

      {/* The enrolment code is shown exactly once — the server stores only a
          hash, so it genuinely cannot be recovered later. */}
      {justRegistered && (
        <Card className="mb-4 border-[var(--accent)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold">
                {justRegistered.label} registered
              </h3>
              <p className="mt-1 mb-3 text-sm text-[var(--ink-2)]">
                Enter this code in the mobile app. It works once and cannot be shown
                again.
              </p>
              <CopyableCode value={justRegistered.enrollmentCode} />
            </div>
            <Button variant="ghost" size="sm" onClick={() => setJustRegistered(null)}>
              Done
            </Button>
          </div>
        </Card>
      )}

      {showForm && (
        <Card className="mb-4">
          <form onSubmit={onRegister} className="space-y-4">
            <Input
              label="Vehicle or device name"
              name="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Truck 01 — GJ 06 AB 1234"
              required
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="driver" className="text-sm font-medium">
                Assign driver (optional)
              </label>
              <select
                id="driver"
                value={driverId}
                onChange={(e) => setDriverId(e.target.value)}
                className="w-full rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--bg)] px-3 py-2.5 text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              >
                <option value="">No driver assigned</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <Button type="submit" loading={register.isPending}>
                Register
              </Button>
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {devices.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            illustration="/illustrations/delivery.svg"
            title="No devices registered"
            body="Register a device to generate its enrolment code."
            action={
              <Button onClick={() => setShowForm(true)}>
                <Plus size={16} aria-hidden />
                Add your first device
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {devices.map((device) => (
            <Card key={device.id} className="lift flex items-center gap-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--surface)]">
                <Smartphone size={18} className="text-[var(--ink-2)]" aria-hidden />
              </div>

              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{device.label}</div>
                <div className="mt-0.5 text-xs text-[var(--ink-2)]">
                  {device.model ?? device.platform ?? "Not yet enrolled"}
                  {device.lastSeenAt && ` · seen ${relativeTime(device.lastSeenAt)}`}
                </div>
              </div>

              <TrustChip score={device.trustScore} />

              <StatusBadge
                size="sm"
                level={
                  device.status === "active"
                    ? "ok"
                    : device.status === "revoked"
                      ? "critical"
                      : "idle"
                }
                label={
                  device.status === "active"
                    ? device.isOnDuty
                      ? "On duty"
                      : "Active"
                    : device.status === "revoked"
                      ? "Revoked"
                      : "Pending"
                }
              />

              {device.status !== "revoked" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRevoke(device)}
                  aria-label={`Revoke ${device.label}`}
                  title="Revoke access"
                >
                  <ShieldOff size={15} aria-hidden />
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function TrustChip({ score }: { score: number }) {
  const color =
    score < TRUST_SPOOFED
      ? "var(--danger)"
      : score < TRUST_SUSPICIOUS
        ? "var(--warning)"
        : "var(--ink-2)";
  return (
    <span
      className="hidden font-[family-name:var(--font-jetbrains)] text-xs sm:inline"
      style={{ color }}
      title="Rolling location-integrity score"
    >
      {Math.round(score)}/100
    </span>
  );
}

function CopyableCode({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          /* clipboard blocked — the code is visible on screen anyway */
        }
      }}
      className="flex items-center gap-3 rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--surface)] px-4 py-2.5 transition-colors hover:border-[var(--accent)]"
    >
      <code className="font-[family-name:var(--font-jetbrains)] text-lg tracking-wider">
        {value}
      </code>
      {copied ? (
        <Check size={16} className="text-[var(--success)]" aria-hidden />
      ) : (
        <Copy size={16} className="text-[var(--ink-2)]" aria-hidden />
      )}
      <span className="sr-only">{copied ? "Copied" : "Copy code"}</span>
    </button>
  );
}
