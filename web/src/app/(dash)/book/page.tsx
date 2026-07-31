"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Route as RouteIcon, Truck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { AddressPicker, type PickedAddress } from "@/components/AddressPicker";
import { Button, Card, ErrorNote, Input, Spinner, StatusBadge } from "@/components/ui";
import { DraftBanner, DraftSavedHint } from "@/components/DraftBanner";
import { ErrorSummary, type SummaryItem } from "@/components/ErrorSummary";
import { DocumentUpload, EMPTY_DOC, type DocDraft } from "@/components/DocumentUpload";
import { api } from "@/lib/api";
import { clearFormDraft, DRAFT_KEYS, useFormDraft } from "@/lib/formDraft";
import {
  type FieldErrors, focusField, isEmail, isPhone, parseApiError, withoutKey,
} from "@/lib/formErrors";
import { cn } from "@/lib/format";
import type { BookingResultData, Customer, RouteOption } from "@/lib/types";

function tomorrowAt(hour = 8, plusDays = 1): string {
  const d = new Date();
  d.setDate(d.getDate() + plusDays);
  d.setHours(hour, 0, 0, 0);
  // datetime-local wants a local ISO without the timezone suffix.
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function BookPage() {
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: api.listVehicles });
  const drivers = useQuery({ queryKey: ["drivers-full"], queryFn: api.listDriversFull });
  const customers = useQuery({ queryKey: ["customers"], queryFn: api.listCustomers });
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.listDevices });
  const lrNumbers = useQuery({ queryKey: ["next-lr"], queryFn: () => api.nextLrNumbers(3) });

  const [useOwnLr, setUseOwnLr] = useState(false);
  const [ownLr, setOwnLr] = useState("");

  const [consignorId, setConsignorId] = useState("");
  const [consignorAddressId, setConsignorAddressId] = useState("");
  const [consigneeId, setConsigneeId] = useState("");
  const [consigneeAddressId, setConsigneeAddressId] = useState("");

  const [goods, setGoods] = useState({
    goodsDescription: "", hsnCode: "", packageCount: "", packageType: "Boxes",
    weightKg: "", declaredValue: "",
  });
  const [statutory, setStatutory] = useState({
    ewayBillNumber: "", ewayBillValidUntil: "", invoiceNumber: "", invoiceDate: "",
  });
  // Scans of the two statutory documents a checkpoint asks the driver for.
  const [ewayDoc, setEwayDoc] = useState<DocDraft>(EMPTY_DOC);
  const [invoiceDoc, setInvoiceDoc] = useState<DocDraft>(EMPTY_DOC);

  async function uploadScan(file: File | undefined, apply: (r: Partial<DocDraft>) => void) {
    if (!file) return;
    apply({ uploading: true, error: null });
    try {
      const stored = await api.uploadDocument(file);
      apply({ fileUrl: stored.fileUrl, fileName: stored.fileName, uploading: false, error: null });
    } catch (err) {
      apply({ uploading: false, fileUrl: "", fileName: "", error: err instanceof Error ? err.message : "Upload failed" });
    }
  }
  const [freight, setFreight] = useState({ freightTerms: "to_pay", freightAmount: "", advanceAmount: "" });

  const [vehicleId, setVehicleId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [scheduledStart, setScheduledStart] = useState(tomorrowAt());
  const [notes, setNotes] = useState("");

  const [routeIndex, setRouteIndex] = useState(0);
  const [notifyOnCreate, setNotifyOnCreate] = useState(false);
  const [debouncedLr, setDebouncedLr] = useState("");

  /* --- Draft persistence -------------------------------------------------
     A booking is the longest form in the app: two parties, goods, statutory
     documents, freight and a trip. Autosaving it to the device means closing
     the tab, refreshing, or leaving to add a missing vehicle never discards the
     work. Defaults (the schedule, route choice, package unit) are ignored when
     deciding whether anything has actually been entered. */
  const stripDoc = (d: DocDraft) => ({
    number: d.number, expiresOn: d.expiresOn, fileUrl: d.fileUrl, fileName: d.fileName,
  });
  const draft = useFormDraft({
    key: DRAFT_KEYS.booking,
    enabled: true,
    value: {
      useOwnLr, ownLr,
      consignorId, consignorAddressId, consigneeId, consigneeAddressId,
      goods, statutory,
      ewayDoc: stripDoc(ewayDoc), invoiceDoc: stripDoc(invoiceDoc),
      freight, vehicleId, driverId, deviceId, scheduledStart, notes,
      routeIndex, notifyOnCreate,
    },
    isEmpty: (v) => {
      const touched =
        v.consignorId || v.consignorAddressId || v.consigneeId || v.consigneeAddressId ||
        v.ownLr.trim() || v.notes.trim() ||
        v.goods.goodsDescription.trim() || v.goods.hsnCode.trim() ||
        v.goods.packageCount.trim() || v.goods.weightKg.trim() || v.goods.declaredValue.trim() ||
        v.statutory.ewayBillNumber.trim() || v.statutory.ewayBillValidUntil ||
        v.statutory.invoiceNumber.trim() || v.statutory.invoiceDate ||
        v.freight.freightAmount.trim() || v.freight.advanceAmount.trim() ||
        v.vehicleId || v.driverId || v.deviceId ||
        v.ewayDoc.fileUrl || v.invoiceDoc.fileUrl;
      return !touched;
    },
  });

  function restoreDraft() {
    const d = draft.restore();
    if (!d) return;
    setUseOwnLr(d.useOwnLr); setOwnLr(d.ownLr);
    setConsignorId(d.consignorId); setConsignorAddressId(d.consignorAddressId);
    setConsigneeId(d.consigneeId); setConsigneeAddressId(d.consigneeAddressId);
    setGoods(d.goods); setStatutory(d.statutory);
    setEwayDoc({ ...EMPTY_DOC, ...d.ewayDoc, uploading: false, error: null });
    setInvoiceDoc({ ...EMPTY_DOC, ...d.invoiceDoc, uploading: false, error: null });
    setFreight(d.freight);
    setVehicleId(d.vehicleId); setDriverId(d.driverId); setDeviceId(d.deviceId);
    setScheduledStart(d.scheduledStart); setNotes(d.notes);
    setRouteIndex(d.routeIndex); setNotifyOnCreate(d.notifyOnCreate);
  }

  function clearForm() {
    setUseOwnLr(false); setOwnLr("");
    setConsignorId(""); setConsignorAddressId(""); setConsigneeId(""); setConsigneeAddressId("");
    setGoods({ goodsDescription: "", hsnCode: "", packageCount: "", packageType: "Boxes", weightKg: "", declaredValue: "" });
    setStatutory({ ewayBillNumber: "", ewayBillValidUntil: "", invoiceNumber: "", invoiceDate: "" });
    setEwayDoc(EMPTY_DOC); setInvoiceDoc(EMPTY_DOC);
    setFreight({ freightTerms: "to_pay", freightAmount: "", advanceAmount: "" });
    setVehicleId(""); setDriverId(""); setDeviceId("");
    setScheduledStart(tomorrowAt()); setNotes("");
    setRouteIndex(0); setNotifyOnCreate(false);
    draft.clear();
  }

  const customerList = customers.data ?? [];
  const consignor = customerList.find((c) => c.id === consignorId);
  const consignee = customerList.find((c) => c.id === consigneeId);
  const pickup = consignor?.addresses.find((a) => a.id === consignorAddressId);
  const drop = consignee?.addresses.find((a) => a.id === consigneeAddressId);

  const notify = useQuery({ queryKey: ["notify-status"], queryFn: api.notificationStatus });

  /* Routes, fetched once both ends are known. Keyed on the coordinates so a
     change of address refetches automatically. */
  const routeQuery = useQuery({
    queryKey: ["route-preview", pickup?.id, drop?.id],
    queryFn: () =>
      api.previewRoutes(
        [pickup!.latitude, pickup!.longitude],
        [drop!.latitude, drop!.longitude],
      ),
    enabled: Boolean(pickup && drop),
  });
  const routes: RouteOption[] = routeQuery.data?.routes ?? [];
  const routeLoading = routeQuery.isFetching;

  /* Debounce the typed LR number, then let React Query do the lookup — the
     timer only touches a local string, never fetched state. */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedLr(ownLr.trim()), 400);
    return () => clearTimeout(timer);
  }, [ownLr]);

  const lrCheckQuery = useQuery({
    queryKey: ["lr-check", debouncedLr],
    queryFn: () => api.checkLrNumber(debouncedLr),
    enabled: useOwnLr && debouncedLr.length >= 2,
  });
  const lrCheck = lrCheckQuery.data ?? null;

  const book = useMutation({
    mutationFn: (body: unknown) => api.createBooking(body),
    // The consignment is now booked — drop its draft so a fresh visit starts clean.
    onSuccess: () => clearFormDraft(DRAFT_KEYS.booking),
  });

  // Field-level errors keyed by the anchor id the summary scrolls to.
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string[]>([]);
  const clearErr = (k: string) => setErrors((e) => withoutKey(e, k));

  const ERROR_ORDER = ["ownLr", "consignor", "consignee", "goods", "start"];

  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!consignorId) e.consignor = "Choose the consignor (sender).";
    else if (!consignorAddressId) e.consignor = "Choose the consignor's pickup address.";
    if (!consigneeId) e.consignee = "Choose the consignee (receiver).";
    else if (!consigneeAddressId) e.consignee = "Choose the consignee's delivery address.";
    if (consignorAddressId && consignorAddressId === consigneeAddressId)
      e.consignee = "Pickup and delivery can't be the same address.";
    if (!goods.goodsDescription.trim()) e.goods = "Describe the goods being sent.";
    if (!scheduledStart) e.start = "Set the scheduled start date and time.";
    if (useOwnLr) {
      if (!ownLr.trim()) e.ownLr = "Enter your LR number, or switch back to auto.";
      else if (lrCheck && !lrCheck.available)
        e.ownLr = "That LR number is already used — choose another.";
    }
    return e;
  }

  // Map a server rejection (nested consignment/trip fields, or a business error
  // like a double-booking) onto the right anchor, else show it verbatim.
  function applyServerError(err: unknown) {
    const parsed = parseApiError(err);
    const mapped: FieldErrors = {};
    const gen: string[] = [];
    for (const [k, msg] of Object.entries(parsed.fields)) {
      if (k.endsWith("goodsDescription")) mapped.goods = msg;
      else if (k.endsWith("scheduledStart")) mapped.start = msg;
      else if (/lrnumber/i.test(k)) mapped.ownLr = msg;
      else if (k.endsWith("consignorAddressId") || k.endsWith("consignorId")) mapped.consignor = msg;
      else if (k.endsWith("consigneeAddressId") || k.endsWith("consigneeId")) mapped.consignee = msg;
      else gen.push(msg);
    }
    for (const msg of parsed.general) {
      if (useOwnLr && /\blr\b/i.test(msg) && !mapped.ownLr) mapped.ownLr = msg;
      else gen.push(msg);
    }
    setErrors((prev) => ({ ...prev, ...mapped }));
    setGeneral(Array.from(new Set(gen)));
    const first = ERROR_ORDER.find((kk) => mapped[kk]);
    if (first) focusField(first);
  }

  const summaryItems: SummaryItem[] = [
    ...ERROR_ORDER.filter((k) => errors[k]).map((k) => ({ field: k, message: errors[k] })),
    ...Object.keys(errors)
      .filter((k) => !ERROR_ORDER.includes(k))
      .map((k) => ({ field: k, message: errors[k] })),
    ...general.map((message) => ({ message })),
  ];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setGeneral([]);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      const first = ERROR_ORDER.find((k) => found[k]) ?? Object.keys(found)[0];
      if (first) focusField(first);
      return;
    }
    try {
      await book.mutateAsync({
      consignment: {
        lrNumber: useOwnLr ? ownLr.trim() : null,
        consignorId, consignorAddressId, consigneeId, consigneeAddressId,
        goodsDescription: goods.goodsDescription,
        hsnCode: goods.hsnCode || null,
        packageCount: goods.packageCount ? Number(goods.packageCount) : null,
        packageType: goods.packageType || null,
        weightKg: goods.weightKg ? Number(goods.weightKg) : null,
        declaredValue: goods.declaredValue ? Number(goods.declaredValue) : null,
        isFragile: false, isHazardous: false,
        ewayBillNumber: statutory.ewayBillNumber || null,
        ewayBillValidUntil: statutory.ewayBillValidUntil
          ? new Date(statutory.ewayBillValidUntil).toISOString() : null,
        ewayBillFileUrl: ewayDoc.fileUrl || null,
        ewayBillFileName: ewayDoc.fileName || null,
        invoiceNumber: statutory.invoiceNumber || null,
        invoiceDate: statutory.invoiceDate || null,
        invoiceFileUrl: invoiceDoc.fileUrl || null,
        invoiceFileName: invoiceDoc.fileName || null,
        freightTerms: freight.freightTerms,
        freightAmount: freight.freightAmount ? Number(freight.freightAmount) : null,
        advanceAmount: freight.advanceAmount ? Number(freight.advanceAmount) : null,
        specialInstructions: null,
      },
      trip: {
        vehicleId: vehicleId || null,
        driverId: driverId || null,
        deviceId: deviceId || null,
        scheduledStart: new Date(scheduledStart).toISOString(),
        routeIndex,
        notes: notes || null,
      },
      notifyOnCreate,
      });
    } catch (err) {
      applyServerError(err);
    }
  }

  if (customers.isPending || vehicles.isPending) return <Spinner label="Loading…" />;

  if (book.isSuccess) {
    return (
      <BookingResult
        result={book.data}
        onAnother={() => {
          // Start genuinely fresh: clear the fields (and any draft) so the next
          // consignment isn't pre-filled with the one just booked.
          clearForm();
          book.reset();
        }}
      />
    );
  }

  const declared = Number(goods.declaredValue || 0);
  const needsEway = declared > 50000 && !statutory.ewayBillNumber;

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto p-6">
      <h1 className="text-[1.75rem]">Book a consignment</h1>
      <p className="mt-1 mb-6 text-sm text-[var(--ink-2)]">
        Creates the consignment note, schedules the trip and issues a tracking
        link for each party.
      </p>

      <form onSubmit={submit} noValidate className="space-y-4">
        <ErrorSummary items={summaryItems} />
        {draft.found && (
          <DraftBanner
            savedAt={draft.found.savedAt}
            noun="consignment booking"
            onRestore={restoreDraft}
            onDiscard={draft.discard}
          />
        )}
        {/* --- LR number --- */}
        <Card className="space-y-3">
          <h3 className="text-base font-semibold">Consignment number</h3>
          {!useOwnLr ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {(lrNumbers.data?.suggestions ?? []).map((s, i) => (
                  <span
                    key={s}
                    className={cn(
                      "rounded-[var(--radius-chip)] px-2.5 py-1.5 font-[family-name:var(--font-jetbrains)] text-sm",
                      i === 0
                        ? "bg-[var(--accent-soft)] font-semibold text-[var(--accent)]"
                        : "bg-[var(--surface)] text-[var(--ink-3)]",
                    )}
                  >
                    {s}
                  </span>
                ))}
              </div>
              <p className="text-xs text-[var(--ink-2)]">
                The first is assigned on submit. Numbers are unique per financial
                year and never reused — previewing one here does not consume it.
              </p>
            </>
          ) : (
            <Input
              label="Your LR number"
              name="ownLr"
              value={ownLr}
              onChange={(e) => { setOwnLr(e.target.value.toUpperCase()); clearErr("ownLr"); }}
              placeholder="From your pre-printed LR book"
              error={errors.ownLr ?? (lrCheck && !lrCheck.available ? "Already used — pick another" : undefined)}
              hint={lrCheck?.available ? "Available" : undefined}
            />
          )}
          <button
            type="button"
            onClick={() => { setUseOwnLr((v) => !v); clearErr("ownLr"); }}
            className="text-xs font-medium text-[var(--accent)] hover:underline"
          >
            {useOwnLr ? "Use an auto-generated number" : "I use my own pre-printed LR book"}
          </button>
        </Card>

        {/* --- parties --- */}
        <Card className="space-y-4">
          <h3 className="text-base font-semibold">Parties</h3>
          {customerList.length === 0 && (
            <p className="text-sm text-[var(--ink-2)]">
              No customers on file yet — add the sender and the receiver below.
              They are saved as you go, so you will not have to enter them again.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <PartyPicker
              id="consignor"
              title="Consignor (sender)"
              customers={customerList}
              customerId={consignorId}
              addressId={consignorAddressId}
              invalid={Boolean(errors.consignor)}
              onCustomer={(id) => { setConsignorId(id); setConsignorAddressId(""); clearErr("consignor"); }}
              onAddress={(id) => { setConsignorAddressId(id); clearErr("consignor"); clearErr("consignee"); }}
            />
            <PartyPicker
              id="consignee"
              title="Consignee (receiver)"
              customers={customerList}
              customerId={consigneeId}
              addressId={consigneeAddressId}
              invalid={Boolean(errors.consignee)}
              onCustomer={(id) => { setConsigneeId(id); setConsigneeAddressId(""); clearErr("consignee"); }}
              onAddress={(id) => { setConsigneeAddressId(id); clearErr("consignee"); }}
            />
          </div>
        </Card>

        {/* --- goods --- */}
        <Card className="space-y-4">
          <h3 className="text-base font-semibold">Goods</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Input label="Description" name="goods" value={goods.goodsDescription} onChange={(e) => { setGoods({ ...goods, goodsDescription: e.target.value }); clearErr("goods"); }} error={errors.goods} required placeholder="Polished marble slabs" />
            </div>
            <Input label="HSN code" name="hsn" value={goods.hsnCode} onChange={(e) => setGoods({ ...goods, hsnCode: e.target.value })} placeholder="6802" />
            <Input label="Packages" name="pkg" type="number" value={goods.packageCount} onChange={(e) => setGoods({ ...goods, packageCount: e.target.value })} placeholder="120" />
            <Input label="Weight (kg)" name="wt" type="number" value={goods.weightKg} onChange={(e) => setGoods({ ...goods, weightKg: e.target.value })} placeholder="14500" />
            <Input label="Declared value (₹)" name="val" type="number" value={goods.declaredValue} onChange={(e) => setGoods({ ...goods, declaredValue: e.target.value })} placeholder="480000" />
          </div>
        </Card>

        {/* --- statutory --- */}
        <Card className="space-y-4">
          <h3 className="text-base font-semibold">E-way bill &amp; invoice</h3>
          {needsEway && (
            <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-[var(--warning)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning)]">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                Declared value is above ₹50,000, so an e-way bill is legally
                required. Without it the vehicle can be detained and penalised.
              </span>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="E-way bill number" name="ewb" value={statutory.ewayBillNumber} onChange={(e) => setStatutory({ ...statutory, ewayBillNumber: e.target.value })} placeholder="EWB291847562931" />
            <Input label="Valid until" name="ewbv" type="datetime-local" value={statutory.ewayBillValidUntil} onChange={(e) => setStatutory({ ...statutory, ewayBillValidUntil: e.target.value })} hint="Expires by distance and time" />
            <Input label="Invoice number" name="inv" value={statutory.invoiceNumber} onChange={(e) => setStatutory({ ...statutory, invoiceNumber: e.target.value })} />
            <Input label="Invoice date" name="invd" type="date" value={statutory.invoiceDate} onChange={(e) => setStatutory({ ...statutory, invoiceDate: e.target.value })} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <span className="text-sm font-medium">E-way bill PDF</span>
              <DocumentUpload
                id="ewb-scan"
                doc={ewayDoc}
                onPick={(file) => void uploadScan(file, (r) => setEwayDoc((c) => ({ ...c, ...r })))}
                onClear={() => setEwayDoc(EMPTY_DOC)}
              />
            </div>
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Invoice PDF</span>
              <DocumentUpload
                id="inv-scan"
                doc={invoiceDoc}
                onPick={(file) => void uploadScan(file, (r) => setInvoiceDoc((c) => ({ ...c, ...r })))}
                onClear={() => setInvoiceDoc(EMPTY_DOC)}
              />
            </div>
          </div>
          <p className="text-xs text-[var(--ink-2)]">
            Attaching the scans lets the driver produce them at a checkpoint from
            their phone, and prints them alongside the consignment note.
          </p>
        </Card>

        {/* --- assignment --- */}
        <Card className="space-y-4">
          <h3 className="text-base font-semibold">Vehicle, driver &amp; schedule</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Vehicle" value={vehicleId} onChange={setVehicleId} options={(vehicles.data ?? []).map((v) => ({ value: v.id, label: `${v.registrationNumber} — ${v.displayName ?? v.vehicleType}` }))} />
            <Select label="Driver" value={driverId} onChange={setDriverId} options={(drivers.data ?? []).map((d) => ({ value: d.id, label: `${d.fullName}${d.licenceClass ? ` (${d.licenceClass})` : ""}` }))} />
            <Select label="Tracking phone" value={deviceId} onChange={setDeviceId} options={(devices.data ?? []).filter((d) => d.status === "active").map((d) => ({ value: d.id, label: d.label }))} hint="The enrolled phone that reports position" />
            <Input label="Scheduled start" name="start" type="datetime-local" value={scheduledStart} onChange={(e) => { setScheduledStart(e.target.value); clearErr("start"); }} error={errors.start} required />
            <div className="sm:col-span-2">
              <Input label="Notes for the driver" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Call receiver 1 hour before arrival" />
            </div>
          </div>
        </Card>

        {/* --- routes --- */}
        <Card className="space-y-3">
          <h3 className="text-base font-semibold">Route</h3>
          {!pickup || !drop ? (
            <p className="text-sm text-[var(--ink-2)]">Choose both addresses to see route options.</p>
          ) : routeLoading ? (
            <Spinner label="Finding routes…" />
          ) : routes.length === 0 ? (
            <p className="text-sm text-[var(--ink-2)]">No route found between these points.</p>
          ) : (
            <div className="space-y-2">
              {routes.map((r) => (
                <button
                  key={r.index}
                  type="button"
                  onClick={() => setRouteIndex(r.index)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-[var(--radius-control)] border p-3 text-left transition-colors",
                    routeIndex === r.index
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-[var(--stroke)] hover:bg-[var(--surface)]",
                  )}
                >
                  <RouteIcon size={16} className={routeIndex === r.index ? "text-[var(--accent)]" : "text-[var(--ink-3)]"} aria-hidden />
                  <div className="flex-1">
                    <div className="text-sm font-medium">{r.label}</div>
                    <div className="text-xs text-[var(--ink-2)]">
                      {((r.distanceMeters ?? 0) / 1000).toFixed(0)} km ·{" "}
                      {((r.durationSeconds ?? 0) / 3600).toFixed(1)} h
                      {r.summary ? ` · via ${r.summary}` : ""}
                    </div>
                  </div>
                  {routeIndex === r.index && <Check size={16} className="text-[var(--accent)]" aria-hidden />}
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* --- freight & sharing --- */}
        <Card className="space-y-4">
          <h3 className="text-base font-semibold">Freight &amp; sharing</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Select
              label="Freight terms"
              value={freight.freightTerms}
              onChange={(v) => setFreight({ ...freight, freightTerms: v })}
              options={[
                { value: "to_pay", label: "To Pay (receiver pays)" },
                { value: "paid", label: "Paid (sender paid)" },
                { value: "tbb", label: "To Be Billed" },
              ]}
              allowEmpty={false}
            />
            <Input label="Freight amount (₹)" name="fa" type="number" value={freight.freightAmount} onChange={(e) => setFreight({ ...freight, freightAmount: e.target.value })} />
            <Input label="Advance (₹)" name="aa" type="number" value={freight.advanceAmount} onChange={(e) => setFreight({ ...freight, advanceAmount: e.target.value })} />
          </div>

          <label className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-[var(--stroke)] p-3">
            <input
              type="checkbox"
              checked={notifyOnCreate}
              onChange={(e) => setNotifyOnCreate(e.target.checked)}
              disabled={!notify.data?.enabled}
              className="mt-0.5 size-4 accent-[var(--accent)]"
            />
            <span className="text-sm">
              <span className="font-medium">Send tracking links to both customers now</span>
              <span className="mt-0.5 block text-xs text-[var(--ink-2)]">
                {notify.data?.enabled
                  ? "Emails go out immediately on submit."
                  : notify.data?.reason ??
                    "Automated sending is switched off. You'll get copy and WhatsApp buttons after submit instead."}
              </span>
            </span>
          </label>
        </Card>

        {summaryItems.length > 0 && <ErrorSummary items={summaryItems} />}

        <div className="flex flex-wrap items-center gap-2 pb-8">
          <Button type="submit" loading={book.isPending}>
            <Truck size={16} aria-hidden />
            Book consignment
          </Button>
          <Link href="/trips"><Button type="button" variant="secondary">Cancel</Button></Link>
          <Button type="button" variant="ghost" onClick={clearForm}>Clear form</Button>
          {draft.active && <span className="ml-auto"><DraftSavedHint /></span>}
        </div>
      </form>
    </div>
  );
}

function Select({
  label, value, onChange, options, hint, allowEmpty = true,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; hint?: string; allowEmpty?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--bg)] px-3 py-2.5 text-[var(--ink)] outline-none focus:border-[var(--accent)]"
      >
        {allowEmpty && <option value="">— select —</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint && <p className="text-xs text-[var(--ink-2)]">{hint}</p>}
    </div>
  );
}

/**
 * One end of the consignment.
 *
 * New customers and new addresses are created inline rather than by sending
 * the operator off to another page. An order arriving from a party who is not
 * yet on file is the ordinary case, not the exception, and navigating away
 * mid-form would throw away everything already typed.
 */
function PartyPicker({
  id, title, customers, customerId, addressId, invalid = false, onCustomer, onAddress,
}: {
  id?: string;
  title: string;
  customers: Customer[];
  customerId: string; addressId: string;
  invalid?: boolean;
  onCustomer: (id: string) => void; onAddress: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"none" | "customer" | "address">("none");
  const [draft, setDraft] = useState({ name: "", phone: "", email: "" });
  const [label, setLabel] = useState("");
  const [picked, setPicked] = useState<PickedAddress | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const selected = customers.find((c) => c.id === customerId);

  function reset() {
    setMode("none");
    setDraft({ name: "", phone: "", email: "" });
    setLabel("");
    setPicked(null);
    setErrors({});
  }

  // Validate the inline new-customer form, then create. Highlights the exact
  // field rather than leaving the operator to guess why Save did nothing.
  function saveCustomer() {
    const e: FieldErrors = {};
    if (!draft.name.trim()) e.newName = "Company name is required.";
    if (!draft.phone.trim()) e.newPhone = "Phone number is required.";
    else if (!isPhone(draft.phone)) e.newPhone = "Enter a valid phone number (at least 10 digits).";
    if (!isEmail(draft.email)) e.newEmail = "Enter a valid email address.";
    if (!picked) e.newAddress = "Pick the location on the map.";
    setErrors(e);
    if (Object.keys(e).length > 0) {
      const first = ["newName", "newPhone", "newEmail"].find((k) => e[k]);
      if (first) focusField(first);
      return;
    }
    createCustomer.mutate();
  }

  const createCustomer = useMutation({
    mutationFn: () =>
      api.createCustomer({
        name: draft.name,
        phone: draft.phone,
        email: draft.email || null,
        role: "both",
        addresses: picked ? [{ ...picked, label: label || null, contactPhone: draft.phone }] : [],
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["customers"] });
      onCustomer(created.id);
      if (created.addresses[0]) onAddress(created.addresses[0].id);
      reset();
    },
  });

  const createAddress = useMutation({
    mutationFn: () =>
      api.addCustomerAddress(customerId, {
        ...picked,
        label: label || null,
        contactPhone: selected?.phone,
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["customers"] });
      onAddress(created.id);
      reset();
    },
  });

  const busy = createCustomer.isPending || createAddress.isPending;
  const error = (createCustomer.error ?? createAddress.error) as Error | null;

  return (
    <div
      id={id}
      tabIndex={-1}
      className={cn(
        "space-y-3 rounded-[var(--radius-control)] border p-3 outline-none",
        invalid ? "border-[var(--danger)]" : "border-[var(--stroke)]",
      )}
    >
      <div className="text-sm font-semibold">{title}</div>

      {mode === "customer" ? (
        <div className="space-y-3">
          <Input label="Company name" name="newName" value={draft.name}
            onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setErrors((x) => withoutKey(x, "newName")); }}
            error={errors.newName} required />
          <Input label="Phone" name="newPhone" value={draft.phone} inputMode="tel"
            onChange={(e) => { setDraft({ ...draft, phone: e.target.value }); setErrors((x) => withoutKey(x, "newPhone")); }}
            error={errors.newPhone} required />
          <Input label="Email" name="newEmail" type="email" value={draft.email}
            onChange={(e) => { setDraft({ ...draft, email: e.target.value }); setErrors((x) => withoutKey(x, "newEmail")); }}
            error={errors.newEmail}
            hint="Without one, the tracking link can only go by WhatsApp or SMS" />
          <Input label="Address label" name="newLabel" value={label}
            onChange={(e) => setLabel(e.target.value)} placeholder="Factory gate" />
          <AddressPicker label="Location" value={picked} onChange={(a) => { setPicked(a); setErrors((x) => withoutKey(x, "newAddress")); }} />
          {errors.newAddress && <p className="text-sm text-[var(--danger)]">{errors.newAddress}</p>}
          {error && <ErrorNote>{error.message}</ErrorNote>}
          <div className="flex gap-2">
            <Button type="button" size="sm" loading={busy} onClick={saveCustomer}>
              Save customer
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={reset}>Cancel</Button>
          </div>
        </div>
      ) : (
        <>
          <Select label="Customer" value={customerId} onChange={onCustomer}
            options={customers.map((c) => ({ value: c.id, label: c.name }))} />
          <button type="button" onClick={() => setMode("customer")}
            className="text-xs font-medium text-[var(--accent)] hover:underline">
            + New customer
          </button>
        </>
      )}

      {selected && mode !== "customer" && (
        mode === "address" ? (
          <div className="space-y-3">
            <Input label="Address label" name="addrLabel" value={label}
              onChange={(e) => setLabel(e.target.value)} placeholder="Second godown" />
            <AddressPicker label="Location" value={picked} onChange={setPicked} />
            {error && <ErrorNote>{error.message}</ErrorNote>}
            <div className="flex gap-2">
              <Button type="button" size="sm" loading={busy} disabled={!picked}
                onClick={() => createAddress.mutate()}>
                Save address
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={reset}>Cancel</Button>
            </div>
          </div>
        ) : (
          <>
            <Select label="Address" value={addressId} onChange={onAddress}
              options={selected.addresses.map((a) => ({
                value: a.id, label: `${a.label ? `${a.label} — ` : ""}${a.line1.slice(0, 50)}`,
              }))} />
            <button type="button" onClick={() => setMode("address")}
              className="text-xs font-medium text-[var(--accent)] hover:underline">
              + New address for {selected.name}
            </button>
          </>
        )
      )}
    </div>
  );
}

function BookingResult({
  result, onAnother,
}: {
  result: BookingResultData;
  onAnother: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const failedSends = result.deliveries.filter((d) => d.status !== "sent");

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-6">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-full bg-[var(--success-soft)]">
          <Check size={22} className="text-[var(--success)]" aria-hidden />
        </div>
        <div>
          <h1 className="text-[1.6rem]">Consignment booked</h1>
          <p className="font-[family-name:var(--font-jetbrains)] text-sm text-[var(--ink-2)]">
            {result.consignment.lrNumber}
          </p>
        </div>
      </div>

      {result.alerts.length > 0 && (
        <Card className="mb-4 space-y-2">
          <div className="flex items-center gap-2">
            <StatusBadge level={result.dispatchOk ? "warn" : "critical"} label={result.dispatchOk ? "Dispatch allowed" : "Dispatch blocked"} size="sm" />
            <span className="text-sm text-[var(--ink-2)]">checked against the travel date</span>
          </div>
          {result.alerts.map((a, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <AlertTriangle size={14} className={cn("mt-0.5 shrink-0", a.severity === "expired" || a.severity === "missing" ? "text-[var(--danger)]" : "text-[var(--warning)]")} aria-hidden />
              <span className="text-[var(--ink-2)]"><span className="font-medium text-[var(--ink)]">{a.subjectLabel}</span> — {a.message}</span>
            </div>
          ))}
        </Card>
      )}

      {/* Anything that quietly did not happen. A booking that looks entirely
          successful while the driver was never told is the failure mode worth
          shouting about. */}
      {(!result.driverNotified || !result.routeAvailable || failedSends.length > 0) && (
        <Card className="mb-4 space-y-2">
          <h3 className="text-base font-semibold">Needs your attention</h3>
          {!result.driverNotified && (
            <Warning>
              No tracking phone is linked to this driver, so the trip will not
              appear in their app and the customers will see no live position.
              Enrol the driver&apos;s phone under{" "}
              <Link href="/devices" className="underline">Devices</Link>, then
              reassign the driver on this trip.
            </Warning>
          )}
          {!result.routeAvailable && (
            <Warning>
              The routing service could not be reached, so this trip has no
              distance, ETA or route line. The booking itself is fine — edit the
              trip later to fill it in.
            </Warning>
          )}
          {failedSends.map((d, i) => (
            <Warning key={i}>
              <span className="capitalize">{d.party}</span> was not reached by{" "}
              {d.channel} ({d.recipient}) — {d.error ?? d.status}. Use the copy
              or WhatsApp buttons below instead.
            </Warning>
          ))}
        </Card>
      )}

      {result.deliveries.some((d) => d.status === "sent") && (
        <Card className="mb-4 space-y-1">
          <h3 className="text-base font-semibold">Sent</h3>
          {result.deliveries.filter((d) => d.status === "sent").map((d, i) => (
            <p key={i} className="text-sm text-[var(--ink-2)]">
              <span className="capitalize">{d.party}</span> — {d.channel} to {d.recipient}
            </p>
          ))}
        </Card>
      )}

      <Card className="space-y-4">
        <div>
          <h3 className="text-base font-semibold">Tracking links</h3>
          <p className="mt-1 text-sm text-[var(--ink-2)]">
            One per party, so you can share with either without the other.
            They open without a login.
          </p>
        </div>
        {result.links.map((link) => (
          <div key={link.token} className="space-y-2 rounded-[var(--radius-control)] border border-[var(--stroke)] p-3">
            <div className="text-sm font-medium capitalize">{link.party}</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[var(--radius-chip)] bg-[var(--surface)] px-2 py-1.5 font-[family-name:var(--font-jetbrains)] text-xs">
                {link.url}
              </code>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(link.url).catch(() => {});
                  setCopied(link.token);
                  setTimeout(() => setCopied(null), 2000);
                }}
              >
                {copied === link.token ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                {copied === link.token ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        ))}
      </Card>

      <div className="mt-4 flex flex-wrap gap-2 pb-8">
        <Link href="/trips"><Button>View all trips</Button></Link>
        <Button variant="secondary" onClick={onAnother}>Book another</Button>
      </div>
      <p className="-mt-6 pb-8 text-xs text-[var(--ink-2)]">
        Need to change the date, truck or driver? Open this consignment under{" "}
        <Link href="/trips" className="underline">Trips</Link> and use Edit — the
        LR number and the customers&apos; links stay the same.
      </p>
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-[var(--warning)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning)]">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}
