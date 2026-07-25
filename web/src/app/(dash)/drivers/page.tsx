"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, Copy, FileText, IdCard, KeyRound, Pencil, Phone, Plus, User,
} from "lucide-react";
import { useState } from "react";

import { Button, Card, EmptyState, ErrorNote, Input, Spinner, StatusBadge } from "@/components/ui";
import { AuthedImage, openAuthedFile } from "@/components/AuthedFile";
import {
  DocumentUpload, EMPTY_DOC, PhotoUpload, type DocDraft,
} from "@/components/DocumentUpload";
import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import type { DriverDocType, DriverFull } from "@/lib/types";

/**
 * Documents held for an employed driver.
 *
 * Police verification and a medical certificate are `required`: a transporter
 * is expected to hold both for anyone driving a goods vehicle. PAN and address
 * proof are employment records rather than roadside ones, so demanding them
 * would block a legitimate hire.
 *
 * Aadhaar is deliberately absent — only its last four digits are kept, and a
 * scanned card would put the full number, address and photograph on disk.
 */
const DOC_FIELDS: {
  type: DriverDocType;
  label: string;
  expiry: boolean;
  required: boolean;
  placeholder: string;
}[] = [
  { type: "police_verification", label: "Police verification", expiry: true, required: true, placeholder: "PV/RJ/2026/4471" },
  { type: "medical_certificate", label: "Medical certificate (Form 1A)", expiry: true, required: true, placeholder: "MED/2026/9928" },
  { type: "pan", label: "PAN card", expiry: false, required: false, placeholder: "ABCDE1234F" },
  { type: "address_proof", label: "Address proof", expiry: false, required: false, placeholder: "Ration card / utility bill no." },
];

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export default function DriversPage() {
  const queryClient = useQueryClient();
  const drivers = useQuery({ queryKey: ["drivers-full"], queryFn: api.listDriversFull });
  const [showForm, setShowForm] = useState(false);

  // Shown once, immediately after creation. The password exists only in that
  // response — there is no way to look it up again.
  const [issued, setIssued] = useState<{
    fullName: string; loginId: string | null; temporaryPassword: string | null;
  } | null>(null);

  const [editing, setEditing] = useState<DriverFull | null>(null);

  const create = useMutation({
    mutationFn: (body: unknown) => api.createDriverFull(body),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["drivers-full"] });
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      setShowForm(false);
      setIssued({
        fullName: created.fullName,
        loginId: created.loginId,
        temporaryPassword: created.temporaryPassword,
      });
    },
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.updateDriver(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drivers-full"] });
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      setEditing(null);
    },
  });

  if (drivers.isPending) return <Spinner label="Loading drivers…" />;
  const list = drivers.data ?? [];

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[1.75rem]">Drivers</h1>
          <p className="mt-1 text-sm text-[var(--ink-2)]">
            Licence, employment and safety details — everything needed for a
            checkpoint or an insurance claim.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setShowForm((v) => !v); }}>
          <Plus size={16} aria-hidden />
          Add driver
        </Button>
      </div>

      {(drivers.error || create.error || update.error) && (
        <div className="mb-4">
          <ErrorNote>
            {((drivers.error ?? create.error ?? update.error) as Error).message}
          </ErrorNote>
        </div>
      )}

      {issued && (
        <CredentialsCard credentials={issued} onDismiss={() => setIssued(null)} />
      )}

      {(showForm || editing) && (
        <DriverForm
          key={editing?.id ?? "new"}
          existing={editing ?? undefined}
          busy={create.isPending || update.isPending}
          onCancel={() => { setShowForm(false); setEditing(null); }}
          onSubmit={(body) =>
            editing ? update.mutate({ id: editing.id, body }) : create.mutate(body)
          }
        />
      )}

      {list.length === 0 && !showForm ? (
        <Card padded={false}>
          <EmptyState
            illustration="/illustrations/empty.svg"
            title="No drivers yet"
            body="Add your drivers with their licence and verification documents."
            action={
              <Button onClick={() => setShowForm(true)}>
                <Plus size={16} aria-hidden />
                Add your first driver
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((driver) => (
            <DriverCard
              key={driver.id}
              driver={driver}
              onEdit={() => { setEditing(driver); setShowForm(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The driver's sign-in details, shown exactly once.
 *
 * These are what the driver types into the phone app. The password is stored
 * only as a hash, so this is the single moment it can be read — hence the
 * deliberate friction of an explicit dismiss rather than a toast that vanishes.
 */
function CredentialsCard({
  credentials, onDismiss,
}: {
  credentials: { fullName: string; loginId: string | null; temporaryPassword: string | null };
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const text =
    `Driver ID: ${credentials.loginId ?? "—"}\n` +
    `Password: ${credentials.temporaryPassword ?? "—"}`;

  return (
    <Card className="mb-4 space-y-3 border-[var(--accent)]">
      <div className="flex items-start gap-2">
        <KeyRound size={17} className="mt-0.5 shrink-0 text-[var(--accent)]" aria-hidden />
        <div>
          <h3 className="text-base font-semibold">
            Sign-in details for {credentials.fullName}
          </h3>
          <p className="mt-0.5 text-sm text-[var(--ink-2)]">
            Give these to the driver for the phone app. The password is shown
            once and cannot be retrieved again — they will be asked to change
            it when they first sign in.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-[var(--radius-control)] bg-[var(--surface)] p-3">
          <div className="text-xs text-[var(--ink-2)]">Driver ID</div>
          <div className="font-[family-name:var(--font-jetbrains)] text-lg font-semibold">
            {credentials.loginId ?? "—"}
          </div>
        </div>
        <div className="rounded-[var(--radius-control)] bg-[var(--surface)] p-3">
          <div className="text-xs text-[var(--ink-2)]">Temporary password</div>
          <div className="font-[family-name:var(--font-jetbrains)] text-lg font-semibold">
            {credentials.temporaryPassword ?? "—"}
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(text).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" onClick={onDismiss}>
          I have given these to the driver
        </Button>
      </div>
    </Card>
  );
}

function DriverCard({ driver, onEdit }: { driver: DriverFull; onEdit: () => void }) {
  const dlDays = daysUntil(driver.licenceExpiresOn);
  const dlTone = dlDays === null ? "idle" : dlDays < 0 ? "critical" : dlDays <= 30 ? "warn" : "ok";

  // Everything within the warning window, so the card says what to act on
  // rather than leaving the operator to read each chip.
  const expiring: string[] = [];
  if (dlDays !== null && dlDays <= 30) expiring.push("Driving licence");
  for (const doc of driver.documents) {
    const days = daysUntil(doc.expiresOn);
    if (days !== null && days <= 30) {
      expiring.push(DOC_FIELDS.find((f) => f.type === doc.docType)?.label ?? doc.docType);
    }
  }

  const [reset, setReset] = useState<{ loginId: string; temporaryPassword: string } | null>(null);
  const resetPassword = useMutation({
    mutationFn: () => api.resetDriverPassword(driver.id),
    onSuccess: (r) => setReset({ loginId: r.loginId, temporaryPassword: r.temporaryPassword }),
  });

  return (
    <Card className="lift space-y-3">
      <div className="flex items-start gap-4">
        {driver.photoUrl ? (
          <AuthedImage
            fileUrl={driver.photoUrl}
            alt={driver.fullName}
            className="size-11 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--surface)]">
            <User size={19} className="text-[var(--ink-2)]" aria-hidden />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{driver.fullName}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--ink-2)]">
            {driver.phone && (
              <span className="flex items-center gap-1">
                <Phone size={11} aria-hidden />
                {driver.phone}
              </span>
            )}
            {driver.employeeCode && (
              <span className="font-[family-name:var(--font-jetbrains)]">{driver.employeeCode}</span>
            )}
            {driver.bloodGroup && <span>Blood {driver.bloodGroup}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge
            size="sm"
            level={dlTone}
            label={
              dlDays === null
                ? "No licence"
                : dlDays < 0
                  ? `Licence expired`
                  : dlDays <= 30
                    ? `Licence ${dlDays}d`
                    : "Licence valid"
            }
          />
          <Button size="sm" variant="secondary" onClick={onEdit}>
            <Pencil size={13} aria-hidden />
            Edit
          </Button>
        </div>
      </div>

      {expiring.length > 0 && (
        <div className="flex items-start gap-2 rounded-[var(--radius-control)] bg-[var(--warning-soft)] p-2.5 text-sm text-[var(--warning)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            {expiring.join(", ")} {expiring.length === 1 ? "needs" : "need"}{" "}
            renewing — use Edit to upload the new document.
          </span>
        </div>
      )}

      <div className="grid gap-2 border-t border-[var(--stroke)] pt-3 text-xs sm:grid-cols-2">
        <div className="flex items-center gap-1.5 text-[var(--ink-2)]">
          <IdCard size={12} aria-hidden />
          {driver.licenceFileUrl ? (
            <button
              type="button"
              onClick={() => void openAuthedFile(driver.licenceFileUrl!)}
              title="Open the licence scan"
              className="font-[family-name:var(--font-jetbrains)] underline"
            >
              {driver.licenceNumber ?? "—"}
            </button>
          ) : (
            <span className="font-[family-name:var(--font-jetbrains)]">
              {driver.licenceNumber ?? "—"}
            </span>
          )}
          {driver.licenceClass && (
            <span className="rounded-[var(--radius-chip)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[var(--accent)]">
              {driver.licenceClass}
            </span>
          )}
        </div>
        {driver.emergencyContactPhone && (
          <div className="text-[var(--ink-2)]">
            Emergency: {driver.emergencyContactName} · {driver.emergencyContactPhone}
          </div>
        )}
      </div>

      {driver.documents.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {driver.documents.map((doc) => {
            const days = daysUntil(doc.expiresOn);
            const tone = days === null ? "idle" : days < 0 ? "critical" : days <= 30 ? "warn" : "ok";
            const label = DOC_FIELDS.find((f) => f.type === doc.docType)?.label
              ?? doc.docType.replace(/_/g, " ");
            const chip = (
              <>
                {(tone === "critical" || tone === "warn") && <AlertTriangle size={11} aria-hidden />}
                {label}
                {days !== null && <span className="opacity-70">{days < 0 ? `expired` : `${days}d`}</span>}
                {/* The paperclip separates "we noted a number" from "we can
                    produce the document". */}
                {doc.fileUrl && <FileText size={11} aria-hidden />}
              </>
            );
            const className = cn(
              "inline-flex items-center gap-1 rounded-[var(--radius-chip)] px-2 py-1 text-xs",
              tone === "critical" && "bg-[var(--danger-soft)] text-[var(--danger)]",
              tone === "warn" && "bg-[var(--warning-soft)] text-[var(--warning)]",
              (tone === "ok" || tone === "idle") && "bg-[var(--surface)] text-[var(--ink-2)]",
              doc.fileUrl && "hover:underline",
            );
            return doc.fileUrl ? (
              <button
                key={`${doc.docType}-${doc.number}`}
                type="button"
                onClick={() => void openAuthedFile(doc.fileUrl!)}
                title={`Open the ${label} scan${doc.number ? ` — ${doc.number}` : ""}`}
                className={className}
              >
                {chip}
              </button>
            ) : (
              <span key={`${doc.docType}-${doc.number}`} className={className}>
                {chip}
              </span>
            );
          })}
        </div>
      )}

      {/* App sign-in. The driver types these into the phone; without a way to
          reissue them, a forgotten password would strand a driver at a dock. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--stroke)] pt-3">
        {reset ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-[var(--ink-2)]">New sign-in:</span>
            <code className="rounded-[var(--radius-chip)] bg-[var(--surface)] px-2 py-1 font-[family-name:var(--font-jetbrains)]">
              {reset.loginId}
            </code>
            <code className="rounded-[var(--radius-chip)] bg-[var(--accent-soft)] px-2 py-1 font-[family-name:var(--font-jetbrains)] text-[var(--accent)]">
              {reset.temporaryPassword}
            </code>
            <Button size="sm" variant="ghost" onClick={() => setReset(null)}>Done</Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={resetPassword.isPending}
            onClick={() => {
              if (confirm(`Issue a new temporary password for ${driver.fullName}? Their current password stops working immediately.`)) {
                resetPassword.mutate();
              }
            }}
          >
            <KeyRound size={13} aria-hidden />
            Reset app password
          </Button>
        )}
        {resetPassword.error && (
          <span className="text-xs text-[var(--danger)]">
            {(resetPassword.error as Error).message}
          </span>
        )}
      </div>
    </Card>
  );
}

function DriverForm({
  busy,
  existing,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  /** When present the form edits this driver instead of creating one. */
  existing?: DriverFull;
  onSubmit: (body: unknown) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({
    fullName: existing?.fullName ?? "",
    phone: existing?.phone ?? "",
    employeeCode: existing?.employeeCode ?? "",
    licenceNumber: existing?.licenceNumber ?? "",
    licenceClass: existing?.licenceClass ?? "HMV",
    licenceIssuingRto: existing?.licenceIssuingRto ?? "",
    licenceExpiresOn: existing?.licenceExpiresOn ?? "",
    dateOfBirth: "", bloodGroup: existing?.bloodGroup ?? "",
    address: existing?.address ?? "",
    emergencyContactName: existing?.emergencyContactName ?? "",
    emergencyContactPhone: existing?.emergencyContactPhone ?? "",
    aadhaarLast4: existing?.aadhaarLast4 ?? "",
    panNumber: existing?.panNumber ?? "",
    joinedOn: "",
  });

  const [photo, setPhoto] = useState({
    fileUrl: existing?.photoUrl ?? "",
    fileName: existing?.photoName ?? "",
  });

  const [licence, setLicence] = useState<DocDraft>({
    ...EMPTY_DOC,
    fileUrl: existing?.licenceFileUrl ?? "",
    fileName: existing?.licenceFileName ?? (existing?.licenceFileUrl ? "Attached scan" : ""),
  });

  /* Prefilled so renewing an expiring document means changing that one row,
     not re-entering everything else. */
  const [docs, setDocs] = useState<Record<string, DocDraft>>(() => {
    const seed: Record<string, DocDraft> = {};
    for (const doc of existing?.documents ?? []) {
      seed[doc.docType] = {
        number: doc.number ?? "",
        expiresOn: doc.expiresOn ?? "",
        fileUrl: doc.fileUrl ?? "",
        fileName: doc.fileName ?? (doc.fileUrl ? "Attached scan" : ""),
        uploading: false,
        error: null,
      };
    }
    return seed;
  });

  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const patchDoc = (type: string, patch: Partial<DocDraft>) =>
    setDocs((d) => ({ ...d, [type]: { ...(d[type] ?? EMPTY_DOC), ...patch } }));

  async function upload(file: File | undefined, apply: (r: Partial<DocDraft>) => void) {
    if (!file) return;
    apply({ uploading: true, error: null });
    try {
      const stored = await api.uploadDocument(file);
      apply({
        fileUrl: stored.fileUrl,
        fileName: stored.fileName,
        uploading: false,
        error: null,
      });
    } catch (err) {
      apply({
        uploading: false,
        fileUrl: "",
        fileName: "",
        error: err instanceof Error ? err.message : "Could not upload that file",
      });
    }
  }

  /** What is still missing before this driver can be dispatched. */
  const incomplete: string[] = [];
  if (!f.fullName.trim()) incomplete.push("Full name");
  if (!f.licenceNumber.trim()) incomplete.push("Licence number");
  if (!f.licenceExpiresOn) incomplete.push("Licence expiry");
  if (!licence.fileUrl) incomplete.push("Licence scan");
  for (const field of DOC_FIELDS) {
    if (!field.required) continue;
    const d = docs[field.type] ?? EMPTY_DOC;
    if (!d.number.trim() || !d.fileUrl || (field.expiry && !d.expiresOn)) {
      incomplete.push(field.label);
    }
  }
  const anyUploading =
    licence.uploading || Object.values(docs).some((d) => d.uploading);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (incomplete.length > 0 || anyUploading) return;
    const body: Record<string, unknown> = { ...f };
    for (const key of Object.keys(body)) if (body[key] === "") body[key] = null;
    body.photoUrl = photo.fileUrl || null;
    body.photoName = photo.fileName || null;
    body.licenceFileUrl = licence.fileUrl || null;
    body.licenceFileName = licence.fileName || null;
    // The licence is not a document row — its number, class and expiry live on
    // the driver, and a second copy here would drift out of step.
    body.documents = Object.entries(docs)
      .filter(([, v]) => v.number.trim() && v.fileUrl)
      .map(([docType, v]) => ({
        docType,
        number: v.number.trim(),
        expiresOn: v.expiresOn || null,
        fileUrl: v.fileUrl,
        fileName: v.fileName || null,
      }));
    onSubmit(body);
  }

  return (
    <Card className="mb-4">
      <form onSubmit={submit} className="space-y-5">
        <div>
          <h3 className="mb-3 text-base font-semibold">
            {existing ? `Edit ${existing.fullName}` : "Personal"}
          </h3>
          <div className="mb-4">
            <PhotoUpload
              fileUrl={photo.fileUrl}
              fileName={photo.fileName}
              onUploaded={(r) => setPhoto(r)}
              onClear={() => setPhoto({ fileUrl: "", fileName: "" })}
            />
            <p className="mt-2 text-xs text-[var(--ink-2)]">
              A photograph helps whoever is on the gate confirm the right person
              turned up with the right truck.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Full name" name="fullName" value={f.fullName} onChange={(e) => set("fullName", e.target.value)} required minLength={2} placeholder="Ramesh Patel" />
            <Input label="Phone" name="phone" value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+91 98123 45678" inputMode="tel" />
            <Input label="Employee code" name="employeeCode" value={f.employeeCode} onChange={(e) => set("employeeCode", e.target.value)} placeholder="EMP-001" />
            <Input label="Date of birth" name="dateOfBirth" type="date" value={f.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} />
            <Input label="Blood group" name="bloodGroup" value={f.bloodGroup} onChange={(e) => set("bloodGroup", e.target.value)} placeholder="B+" hint="Shown to emergency services" />
            <Input label="Joined on" name="joinedOn" type="date" value={f.joinedOn} onChange={(e) => set("joinedOn", e.target.value)} />
            <div className="sm:col-span-2">
              <Input label="Address" name="address" value={f.address} onChange={(e) => set("address", e.target.value)} placeholder="Village, district, state" />
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--stroke)] pt-4">
          <h3 className="mb-3 text-base font-semibold">Driving licence</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Licence number" name="licenceNumber" value={f.licenceNumber} onChange={(e) => set("licenceNumber", e.target.value.toUpperCase())} placeholder="RJ1420110012345" />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dlclass" className="text-sm font-medium">Class</label>
              <select
                id="dlclass"
                value={f.licenceClass}
                onChange={(e) => set("licenceClass", e.target.value)}
                className="w-full rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--bg)] px-3 py-2.5 text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              >
                {["HMV", "HTV", "HGMV", "LMV", "MGV", "Trailer"].map((c) => <option key={c}>{c}</option>)}
              </select>
              <p className="text-xs text-[var(--ink-2)]">
                An LMV licence on a goods truck is an offence and voids insurance.
              </p>
            </div>
            <Input label="Issuing RTO" name="licenceIssuingRto" value={f.licenceIssuingRto} onChange={(e) => set("licenceIssuingRto", e.target.value)} placeholder="RTO Jaipur (RJ14)" />
            <Input label="Licence expires on" name="licenceExpiresOn" type="date" value={f.licenceExpiresOn} onChange={(e) => set("licenceExpiresOn", e.target.value)} required />
            <div className="sm:col-span-2">
              <DocumentUpload
                id="licence"
                doc={licence}
                label="Attach the licence scan (PDF)"
                onPick={(file) => void upload(file, (r) => setLicence((c) => ({ ...c, ...r })))}
                onClear={() => setLicence((c) => ({ ...c, fileUrl: "", fileName: "", error: null }))}
              />
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--stroke)] pt-4">
          <h3 className="mb-3 text-base font-semibold">Identity &amp; emergency</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Aadhaar (last 4 digits)"
              name="aadhaarLast4"
              value={f.aadhaarLast4}
              onChange={(e) => set("aadhaarLast4", e.target.value)}
              placeholder="9012"
              hint="Only the last 4 are stored — full Aadhaar is deliberately not kept"
            />
            <Input label="PAN" name="panNumber" value={f.panNumber} onChange={(e) => set("panNumber", e.target.value.toUpperCase())} placeholder="ABCDE1234F" />
            <Input label="Emergency contact name" name="emergencyContactName" value={f.emergencyContactName} onChange={(e) => set("emergencyContactName", e.target.value)} />
            <Input label="Emergency contact phone" name="emergencyContactPhone" value={f.emergencyContactPhone} onChange={(e) => set("emergencyContactPhone", e.target.value)} inputMode="tel" />
          </div>
        </div>

        <div className="border-t border-[var(--stroke)] pt-4">
          <h3 className="text-base font-semibold">Other documents</h3>
          <p className="mt-1 mb-3 text-sm text-[var(--ink-2)]">
            Each needs its reference number and a scanned PDF. You&apos;ll be
            warned 30 days before police verification or the medical
            certificate expires.
          </p>
          <div className="space-y-3">
            {DOC_FIELDS.map((field) => {
              const doc = docs[field.type] ?? EMPTY_DOC;
              return (
                <div
                  key={field.type}
                  className="space-y-3 rounded-[var(--radius-control)] border border-[var(--stroke)] p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{field.label}</span>
                    {field.required ? (
                      <span className="rounded-[var(--radius-chip)] bg-[var(--accent-soft)] px-1.5 py-0.5 text-[0.7rem] font-semibold text-[var(--accent)]">
                        Required
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--ink-3)]">Optional</span>
                    )}
                  </div>
                  <div className={cn("grid gap-3", field.expiry ? "sm:grid-cols-[1fr_10rem]" : "")}>
                    <Input
                      label="Number / reference"
                      name={`d-${field.type}`}
                      value={doc.number}
                      onChange={(e) => patchDoc(field.type, { number: e.target.value.toUpperCase() })}
                      placeholder={field.placeholder}
                    />
                    {field.expiry && (
                      <Input
                        label="Expires on"
                        name={`de-${field.type}`}
                        type="date"
                        value={doc.expiresOn}
                        onChange={(e) => patchDoc(field.type, { expiresOn: e.target.value })}
                      />
                    )}
                  </div>
                  <DocumentUpload
                    id={field.type}
                    doc={doc}
                    onPick={(file) => void upload(file, (r) => patchDoc(field.type, r))}
                    onClear={() => patchDoc(field.type, { fileUrl: "", fileName: "", error: null })}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {incomplete.length > 0 && (
          <div className="rounded-[var(--radius-control)] border border-[var(--warning)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning)]">
            Still needed before this driver can be saved: {incomplete.join(", ")}.
          </div>
        )}

        <div className="flex gap-2 border-t border-[var(--stroke)] pt-4">
          <Button
            type="submit"
            loading={busy}
            disabled={incomplete.length > 0 || anyUploading}
          >
            {existing ? "Save changes" : "Save driver"}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
