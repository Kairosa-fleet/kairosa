"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, FileText, ImagePlus, Pencil, Plus, Truck,
} from "lucide-react";
import { useState } from "react";

import { Button, Card, EmptyState, ErrorNote, Input, Spinner, StatusBadge } from "@/components/ui";
import { AuthedImage, openAuthedFile } from "@/components/AuthedFile";
import { DraftBanner, DraftSavedHint } from "@/components/DraftBanner";
import { ErrorSummary, type SummaryItem } from "@/components/ErrorSummary";
import {
  DocumentUpload, EMPTY_DOC, shrinkImage, type DocDraft,
} from "@/components/DocumentUpload";
import { api } from "@/lib/api";
import { clearFormDraft, DRAFT_KEYS, useFormDraft } from "@/lib/formDraft";
import { type FieldErrors, focusField, parseApiError, withoutKey } from "@/lib/formErrors";
import { cn } from "@/lib/format";
import type { Vehicle, VehicleDoc, VehicleDocType, VehicleImage } from "@/lib/types";

/**
 * Documents a driver is actually asked for at a checkpoint.
 *
 * The first four are `required`: every commercial goods vehicle carries them,
 * and each is something the vehicle can be detained over. Permits and road tax
 * are not — a truck running only inside its home state has no national permit,
 * and demanding one would make a legitimate vehicle impossible to add.
 */
const DOC_FIELDS: {
  type: VehicleDocType;
  label: string;
  needsExpiry: boolean;
  required: boolean;
  placeholder: string;
}[] = [
  { type: "rc", label: "Registration Certificate (RC)", needsExpiry: false, required: true, placeholder: "RJ14 20219876543" },
  { type: "insurance", label: "Insurance", needsExpiry: true, required: true, placeholder: "POL/2026/8891234" },
  { type: "puc", label: "PUC certificate", needsExpiry: true, required: true, placeholder: "PUC-RJ-2026-44821" },
  { type: "fitness", label: "Fitness certificate", needsExpiry: true, required: true, placeholder: "FIT/RJ14/2026/771" },
  { type: "permit_national", label: "National permit", needsExpiry: true, required: false, placeholder: "NP/RJ/2026/5567" },
  { type: "permit_state", label: "State permit", needsExpiry: true, required: false, placeholder: "SP/RJ/2026/3390" },
  { type: "road_tax", label: "Road tax", needsExpiry: true, required: false, placeholder: "RT-RJ-2026-1180" },
];


function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function docTone(doc: VehicleDoc): "ok" | "warn" | "critical" | "idle" {
  const days = daysUntil(doc.expiresOn);
  if (days === null) return "idle";
  if (days < 0) return "critical";
  if (days <= 30) return "warn";
  return "ok";
}

export default function VehiclesPage() {
  const queryClient = useQueryClient();
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: api.listVehicles });
  const [showForm, setShowForm] = useState(false);
  // The vehicle currently open for editing. Held here rather than inside the
  // card so only one form can be open at a time.
  const [editing, setEditing] = useState<Vehicle | null>(null);

  const done = () => {
    queryClient.invalidateQueries({ queryKey: ["vehicles"] });
    queryClient.invalidateQueries({ queryKey: ["alerts"] });
    setShowForm(false);
    setEditing(null);
  };

  const create = useMutation({
    mutationFn: (body: unknown) => api.createVehicle(body),
    onSuccess: () => {
      // The vehicle is now the backend's record of truth — retire its draft.
      clearFormDraft(DRAFT_KEYS.vehicle);
      done();
    },
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => api.updateVehicle(id, body),
    onSuccess: done,
  });

  if (vehicles.isPending) return <Spinner label="Loading vehicles…" />;
  const list = vehicles.data ?? [];

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[1.75rem]">Vehicles</h1>
          <p className="mt-1 text-sm text-[var(--ink-2)]">
            Registration, specifications and the documents a traffic officer will ask for.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setShowForm((v) => !v); }}>
          <Plus size={16} aria-hidden />
          Add vehicle
        </Button>
      </div>

      {/* List-load failures only. Submit errors are shown inside the form,
          mapped to the exact field that was rejected. */}
      {vehicles.error && (
        <div className="mb-4">
          <ErrorNote>{(vehicles.error as Error).message}</ErrorNote>
        </div>
      )}

      {(showForm || editing) && (
        <VehicleForm
          key={editing?.id ?? "new"}
          existing={editing ?? undefined}
          busy={create.isPending || update.isPending}
          onCancel={() => { setShowForm(false); setEditing(null); }}
          onSubmit={(body) =>
            editing
              ? update.mutateAsync({ id: editing.id, body })
              : create.mutateAsync(body)
          }
        />
      )}

      {list.length === 0 && !showForm ? (
        <Card padded={false}>
          <EmptyState
            illustration="/illustrations/delivery.svg"
            title="No vehicles yet"
            body="Add your first vehicle with its RC, insurance, PUC and fitness details."
            action={
              <Button onClick={() => setShowForm(true)}>
                <Plus size={16} aria-hidden />
                Add your first vehicle
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((vehicle) => (
            <VehicleCard
              key={vehicle.id}
              vehicle={vehicle}
              onEdit={() => { setEditing(vehicle); setShowForm(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VehicleCard({ vehicle, onEdit }: { vehicle: Vehicle; onEdit: () => void }) {
  const problems = vehicle.documents.filter((d) => {
    const days = daysUntil(d.expiresOn);
    return days !== null && days <= 30;
  });
  const cover = vehicle.images.find((i) => i.isPrimary) ?? vehicle.images[0];

  return (
    <Card className="lift space-y-3">
      <div className="flex items-start gap-4">
        {cover ? (
          <AuthedImage
            fileUrl={cover.fileUrl}
            alt={vehicle.registrationNumber}
            className="size-11 shrink-0 rounded-[var(--radius-control)] object-cover"
          />
        ) : (
          <div className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--surface)]">
            <Truck size={19} className="text-[var(--ink-2)]" aria-hidden />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-[family-name:var(--font-jetbrains)] font-semibold">
              {vehicle.registrationNumber}
            </span>
            <span className="text-sm text-[var(--ink-2)]">{vehicle.displayName}</span>
          </div>
          <div className="mt-0.5 text-xs text-[var(--ink-2)]">
            {vehicle.vehicleType}
            {vehicle.capacityKg ? ` · ${(vehicle.capacityKg / 1000).toFixed(1)} T` : ""}
            {vehicle.bodyType ? ` · ${vehicle.bodyType}` : ""}
            {vehicle.fuelType ? ` · ${vehicle.fuelType}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {problems.length > 0 ? (
            <StatusBadge size="sm" level="warn" label={`${problems.length} expiring`} />
          ) : (
            <StatusBadge size="sm" level="ok" label="Documents OK" />
          )}
          <Button size="sm" variant="secondary" onClick={onEdit}>
            <Pencil size={13} aria-hidden />
            Edit
          </Button>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="flex items-start gap-2 rounded-[var(--radius-control)] bg-[var(--warning-soft)] p-2.5 text-sm text-[var(--warning)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            {problems.map((d) => DOC_FIELDS.find((f) => f.type === d.docType)?.label ?? d.docType).join(", ")}
            {problems.length === 1 ? " needs" : " need"} renewing — use Edit to
            upload the new certificate.
          </span>
        </div>
      )}

      {vehicle.images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto">
          {vehicle.images.map((image) => (
            <AuthedImage
              key={image.fileUrl}
              fileUrl={image.fileUrl}
              alt={image.caption ?? vehicle.registrationNumber}
              className="h-16 w-24 shrink-0 rounded-[var(--radius-chip)] object-cover"
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 border-t border-[var(--stroke)] pt-3">
        {vehicle.documents.map((doc) => {
          const tone = docTone(doc);
          const days = daysUntil(doc.expiresOn);
          const label = DOC_FIELDS.find((f) => f.type === doc.docType)?.label ?? doc.docType;
          const chip = (
            <>
              {tone !== "ok" && tone !== "idle" && <AlertTriangle size={11} aria-hidden />}
              {label}
              {days !== null && (
                <span className="opacity-70">
                  {days < 0 ? `expired ${-days}d` : `${days}d`}
                </span>
              )}
              {/* The paperclip is the difference between "we recorded a number"
                  and "we can produce the certificate". */}
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
            <span key={`${doc.docType}-${doc.number}`} className={className} title={doc.number ?? undefined}>
              {chip}
            </span>
          );
        })}
        {vehicle.documents.length === 0 && (
          <span className="flex items-center gap-1 text-xs text-[var(--danger)]">
            <FileText size={12} aria-hidden />
            No documents on file
          </span>
        )}
      </div>
    </Card>
  );
}

/** A blank create form — used to seed the fields and to reset them on Clear. */
const INITIAL_VEHICLE_FORM = {
  registrationNumber: "", displayName: "", vehicleType: "truck", make: "", model: "",
  manufactureYear: "", bodyType: "", capacityKg: "", chassisNumber: "", engineNumber: "",
  fuelType: "Diesel",
};

function VehicleForm({
  busy,
  existing,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  /** When present the form edits this vehicle instead of creating one. */
  existing?: Vehicle;
  /** Rejects on a server error so the form can map it to the offending field. */
  onSubmit: (body: unknown) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    registrationNumber: existing?.registrationNumber ?? "",
    displayName: existing?.displayName ?? "",
    vehicleType: existing?.vehicleType ?? "truck",
    make: existing?.make ?? "",
    model: existing?.model ?? "",
    manufactureYear: existing?.manufactureYear ? String(existing.manufactureYear) : "",
    bodyType: existing?.bodyType ?? "",
    capacityKg: existing?.capacityKg ? String(existing.capacityKg) : "",
    chassisNumber: existing?.chassisNumber ?? "",
    engineNumber: existing?.engineNumber ?? "",
    fuelType: existing?.fuelType ?? "Diesel",
  });

  /* Documents come back pre-filled so renewing one is a matter of changing the
     number, date and PDF — not re-entering the other three from scratch. */
  const [docs, setDocs] = useState<Record<string, DocDraft>>(() => {
    const seed: Record<string, DocDraft> = {};
    for (const doc of existing?.documents ?? []) {
      seed[doc.docType] = {
        number: doc.number ?? "",
        expiresOn: doc.expiresOn ?? "",
        fileUrl: doc.fileUrl ?? "",
        fileName: doc.fileName ?? "Attached scan",
        uploading: false,
        error: null,
      };
    }
    return seed;
  });

  const [images, setImages] = useState<VehicleImage[]>(existing?.images ?? []);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // Field-level validation errors, keyed by the input's element id so the error
  // summary can scroll straight to the offending field.
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string[]>([]);

  const set = (k: string, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => withoutKey(e, k)); // clear this field's red as it's corrected
  };
  const patchDoc = (type: string, patch: Partial<DocDraft>) => {
    setDocs((d) => ({ ...d, [type]: { ...(d[type] ?? EMPTY_DOC), ...patch } }));
    setErrors((e) => {
      let next = e;
      for (const k of [`doc-${type}`, `exp-${type}`, `docfile-${type}`]) next = withoutKey(next, k);
      return next;
    });
  };

  /* --- Draft persistence -------------------------------------------------
     Autosaves this in-progress entry to the browser so closing the tab,
     refreshing, or switching to the driver screen never loses it. Only for a
     new vehicle — an edit is seeded from the server and must not be autosaved
     over. Uploaded scans are kept by reference (the file already lives on the
     server), minus the transient uploading/error flags. */
  const draft = useFormDraft({
    key: DRAFT_KEYS.vehicle,
    enabled: !existing,
    value: {
      form,
      docs: Object.fromEntries(
        Object.entries(docs).map(([type, d]) => [
          type,
          { number: d.number, expiresOn: d.expiresOn, fileUrl: d.fileUrl, fileName: d.fileName },
        ]),
      ),
      images,
    },
    isEmpty: (v) => {
      const f = v.form;
      const typed = [
        f.registrationNumber, f.displayName, f.make, f.model, f.manufactureYear,
        f.bodyType, f.capacityKg, f.chassisNumber, f.engineNumber,
      ].some((x) => (x ?? "").trim() !== "");
      const docsTouched = Object.values(v.docs).some(
        (d) => (d.number ?? "").trim() !== "" || !!d.fileUrl,
      );
      return !typed && !docsTouched && v.images.length === 0;
    },
  });

  function restoreDraft() {
    const data = draft.restore();
    if (!data) return;
    setForm(data.form);
    setDocs(
      Object.fromEntries(
        Object.entries(data.docs).map(([type, d]) => [
          type,
          { ...EMPTY_DOC, ...d, uploading: false, error: null },
        ]),
      ),
    );
    setImages(data.images);
  }

  function clearForm() {
    setForm(INITIAL_VEHICLE_FORM as typeof form);
    setDocs({});
    setImages([]);
    setImageError(null);
    draft.clear();
  }

  /* The scan is uploaded the moment it is chosen rather than on submit, so a
     rejected file is reported next to that row while the operator is still
     looking at it — not as one opaque failure after a long form. */
  async function attach(type: string, file: File | undefined) {
    if (!file) return;
    patchDoc(type, { uploading: true, error: null });
    try {
      const result = await api.uploadDocument(file);
      patchDoc(type, {
        fileUrl: result.fileUrl,
        fileName: result.fileName,
        uploading: false,
        error: null,
      });
    } catch (err) {
      patchDoc(type, {
        uploading: false,
        fileUrl: "",
        fileName: "",
        error: err instanceof Error ? err.message : "Could not upload that file",
      });
    }
  }

  async function addImages(files: FileList | null) {
    if (!files?.length) return;
    setImageBusy(true);
    setImageError(null);
    try {
      const room = 12 - images.length;
      for (const file of Array.from(files).slice(0, Math.max(0, room))) {
        const stored = await api.uploadDocument(await shrinkImage(file));
        setImages((current) => [
          ...current,
          {
            fileUrl: stored.fileUrl,
            fileName: stored.fileName,
            caption: null,
            // The first photo added becomes the cover unless one already is.
            isPrimary: current.length === 0,
            sortOrder: current.length,
          },
        ]);
      }
      if (files.length > room) {
        setImageError(`Only ${room} more photo(s) could be added — the limit is 12.`);
      }
    } catch (err) {
      setImageError(err instanceof Error ? err.message : "Could not upload that photo");
    } finally {
      setImageBusy(false);
    }
  }

  const anyUploading = Object.values(docs).some((d) => d.uploading);

  // The order errors are focused/listed in — top to bottom, matching the form.
  const ERROR_ORDER = [
    "registrationNumber",
    ...DOC_FIELDS.flatMap((f) => [`doc-${f.type}`, `exp-${f.type}`, `docfile-${f.type}`]),
  ];

  /** Everything wrong with the current form, keyed by field element id. */
  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!form.registrationNumber.trim()) e.registrationNumber = "Registration number is required.";
    for (const f of DOC_FIELDS) {
      if (!f.required) continue;
      const d = docs[f.type] ?? EMPTY_DOC;
      if (!d.number.trim()) e[`doc-${f.type}`] = `${f.label}: enter the document number.`;
      if (f.needsExpiry && !d.expiresOn) e[`exp-${f.type}`] = `${f.label}: enter the expiry date.`;
      if (!d.fileUrl) e[`docfile-${f.type}`] = `${f.label}: attach the scanned PDF.`;
    }
    return e;
  }

  // Map a server rejection onto the field it belongs to (e.g. a duplicate
  // registration), so the same highlight+summary UX covers backend errors too.
  function applyServerError(err: unknown) {
    const parsed = parseApiError(err);
    const mapped: FieldErrors = {};
    const gen: string[] = [];
    for (const [k, msg] of Object.entries(parsed.fields)) {
      if (k === "registrationNumber") mapped.registrationNumber = msg;
      else gen.push(msg);
    }
    for (const msg of parsed.general) {
      if (/registration/i.test(msg) && !mapped.registrationNumber) mapped.registrationNumber = msg;
      else gen.push(msg);
    }
    setErrors((prev) => ({ ...prev, ...mapped }));
    setGeneral(Array.from(new Set(gen)));
    // A general error (e.g. a business rule) is shown in the summary that sits
    // right above the Save button, so it's already in view where they clicked.
    if (mapped.registrationNumber) focusField("registrationNumber");
  }

  // Build the summary in form order, then any leftover field errors, then
  // general (non-field) messages.
  const summaryItems: SummaryItem[] = [
    ...ERROR_ORDER.filter((k) => errors[k]).map((k) => ({ field: k, message: errors[k] })),
    ...Object.keys(errors)
      .filter((k) => !ERROR_ORDER.includes(k))
      .map((k) => ({ field: k, message: errors[k] })),
    ...general.map((message) => ({ message })),
  ];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (anyUploading) return; // don't submit while a scan is still uploading
    setGeneral([]);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      const first = ERROR_ORDER.find((k) => found[k]) ?? Object.keys(found)[0];
      if (first) focusField(first);
      return;
    }
    try {
      await onSubmit({
        ...form,
        manufactureYear: form.manufactureYear ? Number(form.manufactureYear) : null,
        capacityKg: form.capacityKg ? Number(form.capacityKg) : null,
        displayName: form.displayName || null,
        documents: Object.entries(docs)
          // A row counts only once it has both a number and its scan; a
          // half-filled optional row is dropped rather than sent and rejected.
          .filter(([, v]) => v.number.trim() && v.fileUrl)
          .map(([docType, v]) => ({
            docType,
            number: v.number.trim(),
            expiresOn: v.expiresOn || null,
            fileUrl: v.fileUrl,
            fileName: v.fileName || null,
          })),
        images: images.map((img, index) => ({
          fileUrl: img.fileUrl,
          fileName: img.fileName ?? null,
          caption: img.caption ?? null,
          isPrimary: img.isPrimary,
          sortOrder: index,
        })),
      });
    } catch (err) {
      applyServerError(err);
    }
  }

  return (
    <Card className="mb-4">
      <form onSubmit={submit} noValidate className="space-y-5">
        {draft.found && (
          <DraftBanner
            savedAt={draft.found.savedAt}
            noun="vehicle entry"
            onRestore={restoreDraft}
            onDiscard={draft.discard}
          />
        )}
        <ErrorSummary items={summaryItems} />
        <div>
          <h3 className="mb-3 text-base font-semibold">
            {existing ? `Edit ${existing.registrationNumber}` : "Vehicle details"}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Registration number"
              name="registrationNumber"
              value={form.registrationNumber}
              onChange={(e) => set("registrationNumber", e.target.value.toUpperCase())}
              placeholder="RJ14GA5623"
              hint="Spaces and dashes are ignored"
              error={errors.registrationNumber}
              required
            />
            <Input
              label="Display name"
              name="displayName"
              value={form.displayName}
              onChange={(e) => set("displayName", e.target.value)}
              placeholder="Tata LPT 1618"
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="vtype" className="text-sm font-medium">Type</label>
              <select
                id="vtype"
                value={form.vehicleType}
                onChange={(e) => set("vehicleType", e.target.value)}
                className="w-full rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--bg)] px-3 py-2.5 text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              >
                {["truck", "tempo", "trailer", "container", "tanker", "tipper", "pickup", "other"].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <Input
              label="Capacity (kg)"
              name="capacityKg"
              type="number"
              value={form.capacityKg}
              onChange={(e) => set("capacityKg", e.target.value)}
              placeholder="16000"
            />
            <Input label="Make" name="make" value={form.make} onChange={(e) => set("make", e.target.value)} placeholder="Tata" />
            <Input label="Model" name="model" value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="LPT 1618" />
            <Input label="Year" name="manufactureYear" type="number" value={form.manufactureYear} onChange={(e) => set("manufactureYear", e.target.value)} placeholder="2021" />
            <Input label="Body type" name="bodyType" value={form.bodyType} onChange={(e) => set("bodyType", e.target.value)} placeholder="Closed body" />
            <Input label="Chassis number" name="chassisNumber" value={form.chassisNumber} onChange={(e) => set("chassisNumber", e.target.value)} />
            <Input label="Engine number" name="engineNumber" value={form.engineNumber} onChange={(e) => set("engineNumber", e.target.value)} />
          </div>
        </div>

        <div className="border-t border-[var(--stroke)] pt-4">
          <h3 className="text-base font-semibold">Photos</h3>
          <p className="mt-1 mb-3 text-sm text-[var(--ink-2)]">
            Pictures of the vehicle — useful for proving what condition it left
            the yard in, and for an insurance claim later. The first one is the
            cover shown on the vehicle list.
          </p>

          {images.length > 0 && (
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {images.map((image, index) => (
                <div
                  key={image.fileUrl}
                  className={cn(
                    "group relative overflow-hidden rounded-[var(--radius-control)] border",
                    image.isPrimary ? "border-[var(--accent)]" : "border-[var(--stroke)]",
                  )}
                >
                  <AuthedImage
                    fileUrl={image.fileUrl}
                    alt={image.caption ?? `Photo ${index + 1}`}
                    className="aspect-4/3 w-full object-cover"
                  />
                  {image.isPrimary && (
                    <span className="absolute top-1.5 left-1.5 rounded-[var(--radius-chip)] bg-[var(--accent)] px-1.5 py-0.5 text-[0.65rem] font-semibold text-white">
                      Cover
                    </span>
                  )}
                  <div className="flex items-center justify-between gap-1 p-1.5 text-xs">
                    {!image.isPrimary ? (
                      <button
                        type="button"
                        onClick={() =>
                          setImages((cur) =>
                            cur.map((c, i) => ({ ...c, isPrimary: i === index })),
                          )
                        }
                        className="font-medium text-[var(--accent)] hover:underline"
                      >
                        Make cover
                      </button>
                    ) : (
                      <span className="text-[var(--ink-3)]">Cover photo</span>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setImages((cur) => {
                          const next = cur.filter((_, i) => i !== index);
                          // Removing the cover promotes whatever is left.
                          if (next.length && !next.some((n) => n.isPrimary)) {
                            next[0] = { ...next[0], isPrimary: true };
                          }
                          return next;
                        })
                      }
                      className="font-medium text-[var(--danger)] hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {images.length < 12 && (
            <label
              htmlFor="vehicle-photos"
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border border-dashed border-[var(--stroke)] px-3 py-2.5 text-sm transition-colors",
                imageBusy ? "opacity-60" : "hover:border-[var(--accent)] hover:bg-[var(--surface)]",
              )}
            >
              <ImagePlus size={15} className="shrink-0 text-[var(--ink-2)]" aria-hidden />
              <span className="text-[var(--ink-2)]">
                {imageBusy ? "Uploading…" : "Add photos — JPEG, PNG or WebP"}
              </span>
              <input
                id="vehicle-photos"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                disabled={imageBusy}
                onChange={(e) => {
                  void addImages(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          )}
          {imageError && <p className="mt-1.5 text-xs text-[var(--danger)]">{imageError}</p>}
        </div>

        <div className="border-t border-[var(--stroke)] pt-4">
          <h3 className="text-base font-semibold">Documents</h3>
          <p className="mt-1 mb-3 text-sm text-[var(--ink-2)]">
            Each document needs its number and a scanned PDF. A number on its
            own is not something you can show at a checkpoint. Insurance, PUC
            and fitness are what get a vehicle detained — you&apos;ll be warned
            30 days before each expires.
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

                  <div className={cn("grid gap-3", field.needsExpiry ? "sm:grid-cols-[1fr_10rem]" : "")}>
                    <Input
                      label="Document number"
                      name={`doc-${field.type}`}
                      value={doc.number}
                      onChange={(e) => patchDoc(field.type, { number: e.target.value.toUpperCase() })}
                      placeholder={field.placeholder}
                      hint="Letters, digits and slashes — enter it exactly as printed"
                      error={errors[`doc-${field.type}`]}
                    />
                    {field.needsExpiry && (
                      <Input
                        label="Expires on"
                        name={`exp-${field.type}`}
                        type="date"
                        value={doc.expiresOn}
                        onChange={(e) => patchDoc(field.type, { expiresOn: e.target.value })}
                        error={errors[`exp-${field.type}`]}
                      />
                    )}
                  </div>

                  <DocumentUpload
                    id={field.type}
                    doc={doc}
                    invalid={Boolean(errors[`docfile-${field.type}`])}
                    onPick={(file) => void attach(field.type, file)}
                    onClear={() => patchDoc(field.type, { fileUrl: "", fileName: "", error: null })}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* A second copy of the summary at the foot, so after a long form the
            operator sees what's blocking without scrolling back up. */}
        {summaryItems.length > 0 && <ErrorSummary items={summaryItems} />}

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--stroke)] pt-4">
          <Button
            type="submit"
            loading={busy}
            disabled={anyUploading || imageBusy}
          >
            {existing ? "Save changes" : "Save vehicle"}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          {!existing && (
            <Button type="button" variant="ghost" onClick={clearForm}>Clear form</Button>
          )}
          {draft.active && <span className="ml-auto"><DraftSavedHint /></span>}
        </div>
      </form>
    </Card>
  );
}
