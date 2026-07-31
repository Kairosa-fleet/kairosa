"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileText } from "lucide-react";
import { useState } from "react";

import { Button, Card, ErrorNote, Input, Spinner } from "@/components/ui";
import { ErrorSummary, type SummaryItem } from "@/components/ErrorSummary";
import { api } from "@/lib/api";
import {
  type FieldErrors, focusField, isEmail, isGstin, isPan, isPhone, isPincode,
  parseApiError, withoutKey,
} from "@/lib/formErrors";
import type { OrgSettings } from "@/lib/types";

/**
 * The transporter's letterhead.
 *
 * This is not cosmetic: a consignment note or a freight bill without the
 * transporter's legal name, GSTIN and registered address is not a valid
 * document, and the LR generator will not treat one as complete until these
 * are filled in.
 */
export default function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["org-settings"], queryFn: api.orgSettings });

  if (settings.isPending) return <Spinner label="Loading settings…" />;
  if (settings.error)
    return (
      <div className="p-6">
        <ErrorNote>{(settings.error as Error).message}</ErrorNote>
      </div>
    );

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-6">
      <h1 className="text-[1.75rem]">Company &amp; letterhead</h1>
      <p className="mt-1 mb-6 text-sm text-[var(--ink-2)]">
        Printed at the head of every consignment note and freight bill.
      </p>
      <SettingsForm
        key={settings.dataUpdatedAt}
        settings={settings.data!}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["org-settings"] })}
      />
    </div>
  );
}

function SettingsForm({ settings, onSaved }: { settings: OrgSettings; onSaved: () => void }) {
  const [f, setF] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string[]>([]);
  const set = (k: keyof OrgSettings, v: string) => {
    setF((s) => ({ ...s, [k]: v }));
    setErrors((e) => withoutKey(e, k as string));
  };

  const save = useMutation({
    mutationFn: () =>
      api.updateOrgSettings({
        name: f.name,
        legalName: f.legalName || null,
        gstin: f.gstin || null,
        pan: f.pan || null,
        addressLine: f.addressLine || null,
        city: f.city || null,
        state: f.state || null,
        pincode: f.pincode || null,
        phone: f.phone || null,
        email: f.email || null,
        transporterId: f.transporterId || null,
        lrTerms: f.lrTerms || null,
      }),
    onSuccess: () => {
      onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  // Mirror the server's definition of a complete letterhead so the operator
  // sees the same readiness the LR generator will enforce.
  const missing: string[] = [];
  if (!f.legalName) missing.push("Legal name");
  if (!f.gstin) missing.push("GSTIN");
  if (!f.addressLine) missing.push("Address");
  if (!f.city) missing.push("City");
  if (!f.state) missing.push("State");

  const ERROR_ORDER = ["name", "gstin", "pan", "pincode", "phone", "email"];

  // Hard rules that BLOCK saving: the trade name must exist, and anything typed
  // into a formatted field must be well-formed. (The soft "letterhead
  // incomplete" banner above is a separate nudge, not a block.)
  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!f.name.trim()) e.name = "Trade name is required — it's shown across the app.";
    if (!isGstin(f.gstin ?? "")) e.gstin = "That isn't a valid 15-character GSTIN (e.g. 24ABCDE1234F1Z5).";
    if (!isPan(f.pan ?? "")) e.pan = "That isn't a valid PAN (e.g. ABCDE1234F).";
    if (!isPincode(f.pincode ?? "")) e.pincode = "PIN code must be 6 digits.";
    if (!isPhone(f.phone ?? "")) e.phone = "Enter a valid phone number (at least 10 digits).";
    if (!isEmail(f.email ?? "")) e.email = "Enter a valid email address.";
    return e;
  }

  function applyServerError(err: unknown) {
    const parsed = parseApiError(err);
    setErrors((prev) => ({ ...prev, ...parsed.fields }));
    setGeneral(Array.from(new Set(parsed.general)));
    const first = ERROR_ORDER.find((k) => parsed.fields[k]);
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
      await save.mutateAsync();
    } catch (err) {
      applyServerError(err);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {missing.length > 0 ? (
        <div className="flex items-start gap-2 rounded-[var(--radius-control)] border border-[var(--warning)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning)]">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Your letterhead is incomplete — consignment notes will print with a
            warning until you add: {missing.join(", ")}.
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--success)] bg-[var(--success-soft)] p-3 text-sm text-[var(--success)]">
          <FileText size={15} className="shrink-0" aria-hidden />
          Letterhead complete — consignment notes will print as valid documents.
        </div>
      )}

      <ErrorSummary items={summaryItems} />

      <Card className="space-y-4">
        <h3 className="text-base font-semibold">Identity</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Trade name" name="name" value={f.name} onChange={(e) => set("name", e.target.value)} error={errors.name} required placeholder="Vediya Transport" hint="Short name shown across the app" />
          <Input label="Registered legal name" name="legalName" value={f.legalName ?? ""} onChange={(e) => set("legalName", e.target.value)} placeholder="Vediya Transport Company" />
          <Input label="GSTIN" name="gstin" value={f.gstin ?? ""} onChange={(e) => set("gstin", e.target.value.toUpperCase())} error={errors.gstin} placeholder="24ABCDE1234F1Z5" />
          <Input label="PAN" name="pan" value={f.pan ?? ""} onChange={(e) => set("pan", e.target.value.toUpperCase())} error={errors.pan} placeholder="ABCDE1234F" />
          <Input label="Transporter ID (e-way bill)" name="transporterId" value={f.transporterId ?? ""} onChange={(e) => set("transporterId", e.target.value.toUpperCase())} placeholder="88AABBCC1234D5" hint="Printed so consignors can enter it on the portal" />
        </div>
      </Card>

      <Card className="space-y-4">
        <h3 className="text-base font-semibold">Registered address &amp; contact</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Input label="Address" name="addressLine" value={f.addressLine ?? ""} onChange={(e) => set("addressLine", e.target.value)} placeholder="Plot 44, Transport Nagar" />
          </div>
          <Input label="City" name="city" value={f.city ?? ""} onChange={(e) => set("city", e.target.value)} placeholder="Vadodara" />
          <Input label="State" name="state" value={f.state ?? ""} onChange={(e) => set("state", e.target.value)} placeholder="Gujarat" />
          <Input label="PIN code" name="pincode" value={f.pincode ?? ""} onChange={(e) => set("pincode", e.target.value)} error={errors.pincode} inputMode="numeric" placeholder="390019" />
          <Input label="Phone" name="phone" value={f.phone ?? ""} onChange={(e) => set("phone", e.target.value)} error={errors.phone} placeholder="+91 98250 12345" inputMode="tel" />
          <div className="sm:col-span-2">
            <Input label="Email" name="email" type="email" value={f.email ?? ""} onChange={(e) => set("email", e.target.value)} error={errors.email} placeholder="office@company.com" />
          </div>
        </div>
      </Card>

      <Card className="space-y-3">
        <h3 className="text-base font-semibold">Consignment note terms</h3>
        <p className="text-sm text-[var(--ink-2)]">
          The liability wording printed at the foot of every LR.
        </p>
        <textarea
          value={f.lrTerms ?? ""}
          onChange={(e) => set("lrTerms", e.target.value)}
          rows={4}
          placeholder="Goods carried entirely at owner's risk. The company is not responsible for leakage, breakage, or loss by fire, accident or theft in transit. Disputes subject to local jurisdiction only."
          className="w-full rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
        />
      </Card>

      <div className="flex items-center gap-3 pb-8">
        <Button type="submit" loading={save.isPending}>Save</Button>
        {saved && (
          <span className="flex items-center gap-1 text-sm text-[var(--success)]">
            <Check size={15} aria-hidden /> Saved
          </span>
        )}
      </div>
    </form>
  );
}
