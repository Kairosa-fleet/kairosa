"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight, Ban, Check, Copy, ExternalLink, FileText, Mail, MessageCircle, Package,
  Pencil, Plus, Send, ShieldOff,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button, Card, EmptyState, ErrorNote, Input, Spinner, StatusBadge } from "@/components/ui";
import { ErrorSummary, type SummaryItem } from "@/components/ErrorSummary";
import { type FieldErrors, focusField, parseApiError, withoutKey } from "@/lib/formErrors";
import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import type { TripRow } from "@/lib/types";

/** `datetime-local` wants a local ISO string with no timezone suffix. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

const STATUS_TONE: Record<string, "ok" | "warn" | "critical" | "idle"> = {
  planned: "idle", assigned: "warn", started: "ok", in_transit: "ok",
  at_destination: "ok", delivered: "ok", cancelled: "critical",
};

export default function TripsPage() {
  const trips = useQuery({ queryKey: ["trips"], queryFn: api.listTrips });
  const notify = useQuery({ queryKey: ["notify-status"], queryFn: api.notificationStatus });

  if (trips.isPending) return <Spinner label="Loading trips…" />;
  const list = trips.data ?? [];

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[1.75rem]">Trips</h1>
          <p className="mt-1 text-sm text-[var(--ink-2)]">
            Every consignment, its schedule and its customer tracking links.
          </p>
        </div>
        <Link href="/book">
          <Button><Plus size={16} aria-hidden />Book consignment</Button>
        </Link>
      </div>

      {trips.error && <div className="mb-4"><ErrorNote>{(trips.error as Error).message}</ErrorNote></div>}

      {!notify.data?.enabled && list.length > 0 && (
        <div className="mb-4 rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--surface)] p-3 text-sm text-[var(--ink-2)]">
          Automated sending is switched off — use <strong>Copy</strong> or{" "}
          <strong>WhatsApp</strong> to share links.
        </div>
      )}

      {list.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            illustration="/illustrations/delivery.svg"
            title="No trips yet"
            body="Book your first consignment to schedule a trip and issue tracking links."
            action={<Link href="/book"><Button><Plus size={16} aria-hidden />Book consignment</Button></Link>}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((trip) => <TripCard key={trip.id} trip={trip} smsEnabled={!!notify.data?.sms} emailEnabled={!!notify.data?.email} />)}
        </div>
      )}
    </div>
  );
}

function TripCard({ trip, smsEnabled, emailEnabled }: { trip: TripRow; smsEnabled: boolean; emailEnabled: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const closed = trip.status === "delivered" || trip.status === "cancelled";

  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["trips"] });

  const revoke = useMutation({
    mutationFn: (party: string) => api.revokeLink(trip.id, party),
    onSuccess: refresh,
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelTrip(trip.id),
    onSuccess: refresh,
  });

  const send = useMutation({
    mutationFn: ({ party, channel }: { party: string; channel: string }) =>
      api.sendLink(trip.id, party, channel),
    onSuccess: (data) => {
      if (data.whatsappUrl) {
        window.open(data.whatsappUrl, "_blank", "noopener");
        setResult(null);
      } else {
        setResult(data.error ?? `Sent via ${data.channel}`);
        setTimeout(() => setResult(null), 6000);
      }
    },
  });

  const when = new Date(trip.scheduledStart);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-[family-name:var(--font-jetbrains)] font-semibold">{trip.lrNumber}</span>
            <StatusBadge size="sm" level={STATUS_TONE[trip.status] ?? "idle"} label={trip.status.replace(/_/g, " ")} />
          </div>
          <div className="mt-1 flex items-center gap-2 text-sm">
            <span className="font-medium">{trip.origin}</span>
            <ArrowRight size={13} className="text-[var(--ink-3)]" aria-hidden />
            <span className="font-medium">{trip.destination}</span>
          </div>
          <div className="mt-0.5 text-xs text-[var(--ink-2)]">
            {when.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
            {" · "}{when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {trip.distanceKm ? ` · ${trip.distanceKm} km` : ""}
            {trip.durationH ? ` · ${trip.durationH} h` : ""}
            {trip.routeSummary ? ` · ${trip.routeSummary}` : ""}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right text-xs text-[var(--ink-2)]">
            {trip.vehicle && <div className="font-[family-name:var(--font-jetbrains)] text-[var(--ink)]">{trip.vehicle}</div>}
            {trip.driver && <div>{trip.driver}</div>}
            {!trip.deviceId && !closed && (
              <div className="text-[var(--warning)]">No tracking phone</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* The consignment note opens in its own tab: it is a document to
                print or save, not a screen to navigate back from. */}
            <a href={`/lr/${trip.consignmentId}`} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="secondary">
                <FileText size={13} aria-hidden />
                Generate LR
              </Button>
            </a>
            {!closed && (
              <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>
                <Pencil size={13} aria-hidden />
                {editing ? "Close" : "Edit"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {editing && <TripEditor trip={trip} onDone={() => setEditing(false)} />}

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--stroke)] pt-3 text-xs text-[var(--ink-2)]">
        <span className="flex items-center gap-1"><Package size={12} aria-hidden />{trip.goods}</span>
        {trip.weightKg && <span>{(trip.weightKg / 1000).toFixed(1)} T</span>}
        {trip.declaredValue && <span>₹{trip.declaredValue.toLocaleString("en-IN")}</span>}
        {trip.ewayBillNumber && (
          <span className="font-[family-name:var(--font-jetbrains)]">EWB {trip.ewayBillNumber}</span>
        )}
        <span className="capitalize">{trip.freightTerms.replace(/_/g, " ")}</span>
      </div>

      <div className="space-y-2 border-t border-[var(--stroke)] pt-3">
        <div className="text-xs font-medium tracking-wide text-[var(--ink-2)] uppercase">
          Tracking links
        </div>
        {trip.links.map((link) => {
          const who = link.party === "consignor" ? trip.consignor : trip.consignee;
          if (link.revoked) {
            return (
              <div key={link.token} className="flex items-center gap-2 rounded-[var(--radius-control)] border border-dashed border-[var(--stroke)] p-2.5 text-sm text-[var(--ink-2)]">
                <ShieldOff size={13} aria-hidden />
                <span className="capitalize">{link.party}</span>
                <span>· {who} — link revoked, this customer can no longer track</span>
              </div>
            );
          }
          return (
            <div key={link.token} className="flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border border-[var(--stroke)] p-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium capitalize">
                  {link.party} <span className="font-normal text-[var(--ink-2)]">· {who}</span>
                </div>
                <div className="truncate font-[family-name:var(--font-jetbrains)] text-xs text-[var(--ink-3)]">
                  {link.url}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(link.url).catch(() => {});
                    setCopied(link.token); setTimeout(() => setCopied(null), 2000);
                  }}>
                  {copied === link.token ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                  {copied === link.token ? "Copied" : "Copy"}
                </Button>
                <Button size="sm" variant="secondary"
                  onClick={() => send.mutate({ party: link.party, channel: "whatsapp" })}>
                  <MessageCircle size={13} aria-hidden />WhatsApp
                </Button>
                <Button size="sm" variant="ghost" disabled={!emailEnabled}
                  title={emailEnabled ? "Send by email" : "Email sending is switched off"}
                  onClick={() => send.mutate({ party: link.party, channel: "email" })}>
                  <Mail size={13} aria-hidden />
                </Button>
                <Button size="sm" variant="ghost" disabled={!smsEnabled}
                  title={smsEnabled ? "Send by SMS" : "SMS needs a provider — switched off"}
                  onClick={() => send.mutate({ party: link.party, channel: "sms" })}>
                  <Send size={13} aria-hidden />
                </Button>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  <Button size="sm" variant="ghost" title="Open the customer's view">
                    <ExternalLink size={13} aria-hidden />
                  </Button>
                </a>
                {!closed && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title={`Revoke the ${link.party}'s link — the other party keeps theirs`}
                    onClick={() => {
                      if (confirm(`Revoke the ${link.party}'s tracking link? They will no longer be able to follow this consignment.`)) {
                        revoke.mutate(link.party);
                      }
                    }}
                  >
                    <ShieldOff size={13} aria-hidden />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {result && (
          <p className={cn("text-xs", result.startsWith("Sent") ? "text-[var(--success)]" : "text-[var(--ink-2)]")}>
            {result}
          </p>
        )}
        {revoke.error && <ErrorNote>{(revoke.error as Error).message}</ErrorNote>}
      </div>

      {!closed && (
        <div className="flex justify-end border-t border-[var(--stroke)] pt-3">
          <Button
            size="sm"
            variant="ghost"
            loading={cancel.isPending}
            onClick={() => {
              if (confirm(`Cancel ${trip.lrNumber}? Both customers' tracking links stop working immediately.`)) {
                cancel.mutate();
              }
            }}
          >
            <Ban size={13} aria-hidden />
            Cancel trip
          </Button>
        </div>
      )}
      {cancel.error && <ErrorNote>{(cancel.error as Error).message}</ErrorNote>}
    </Card>
  );
}

/**
 * Reschedule or reassign an already-booked trip.
 *
 * Deliberately limited to the things that actually change between the desk and
 * the gate — the date, the truck, the driver, a note. The LR number, the
 * parties and the addresses are not editable: the customer already holds a
 * tracking link and a copy of the consignment note quoting them, so changing
 * them here would leave two contradictory records of one shipment. That is a
 * cancel-and-rebook, not an edit.
 */
function TripEditor({ trip, onDone }: { trip: TripRow; onDone: () => void }) {
  const queryClient = useQueryClient();
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: api.listVehicles });
  const drivers = useQuery({ queryKey: ["drivers-full"], queryFn: api.listDriversFull });

  const [vehicleId, setVehicleId] = useState(trip.vehicleId ?? "");
  const [driverId, setDriverId] = useState(trip.driverId ?? "");
  const [start, setStart] = useState(toLocalInput(trip.scheduledStart));
  const [notes, setNotes] = useState(trip.notes ?? "");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string[]>([]);

  const save = useMutation({
    mutationFn: () =>
      api.updateTrip(trip.id, {
        vehicleId: vehicleId || null,
        driverId: driverId || null,
        scheduledStart: new Date(start).toISOString(),
        notes: notes || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trips"] });
      onDone();
    },
  });

  const summaryItems: SummaryItem[] = [
    ...(errors.editStart ? [{ field: "editStart", message: errors.editStart }] : []),
    ...general.map((message) => ({ message })),
  ];

  async function doSave() {
    setGeneral([]);
    if (!start) {
      setErrors({ editStart: "Set the scheduled start date and time." });
      focusField("editStart");
      return;
    }
    setErrors({});
    try {
      await save.mutateAsync();
    } catch (err) {
      // Most likely a double-booking clash — the message names the conflict.
      const parsed = parseApiError(err);
      const mapped: FieldErrors = {};
      const gen: string[] = [];
      for (const [k, msg] of Object.entries(parsed.fields)) {
        if (k.endsWith("scheduledStart")) mapped.editStart = msg;
        else gen.push(msg);
      }
      setErrors(mapped);
      setGeneral(parsed.general.concat(gen));
      if (mapped.editStart) focusField("editStart");
    }
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-control)] border border-[var(--accent)] bg-[var(--accent-soft)] p-3">
      <div className="text-sm font-semibold">Edit trip</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Vehicle
          <select
            value={vehicleId}
            onChange={(e) => setVehicleId(e.target.value)}
            className="rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--bg)] px-3 py-2 font-normal text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          >
            <option value="">— none —</option>
            {(vehicles.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>{v.registrationNumber}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Driver
          <select
            value={driverId}
            onChange={(e) => setDriverId(e.target.value)}
            className="rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--bg)] px-3 py-2 font-normal text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          >
            <option value="">— none —</option>
            {(drivers.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.fullName}</option>
            ))}
          </select>
        </label>
        <Input
          label="Scheduled start"
          name="editStart"
          type="datetime-local"
          value={start}
          onChange={(e) => { setStart(e.target.value); setErrors((x) => withoutKey(x, "editStart")); }}
          error={errors.editStart}
        />
        <Input
          label="Notes for the driver"
          name="editNotes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <p className="text-xs text-[var(--ink-2)]">
        Changing the driver moves the trip to their phone. The tracking links
        the customers already hold keep working.
      </p>
      <ErrorSummary items={summaryItems} />
      <div className="flex gap-2">
        <Button size="sm" loading={save.isPending} onClick={doSave}>
          Save changes
        </Button>
        <Button size="sm" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
