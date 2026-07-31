"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Mail, MapPin, Pencil, Phone, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { AddressPicker, type PickedAddress } from "@/components/AddressPicker";
import { DraftBanner, DraftSavedHint } from "@/components/DraftBanner";
import { ErrorSummary, type SummaryItem } from "@/components/ErrorSummary";
import { Button, Card, EmptyState, ErrorNote, Input, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { clearFormDraft, DRAFT_KEYS, useFormDraft } from "@/lib/formDraft";
import {
  type FieldErrors, focusField, isEmail, isGstin, isPhone, parseApiError, withoutKey,
} from "@/lib/formErrors";
import type { Customer, CustomerAddress } from "@/lib/types";

export default function CustomersPage() {
  const queryClient = useQueryClient();
  const customers = useQuery({ queryKey: ["customers"], queryFn: api.listCustomers });
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);

  const create = useMutation({
    mutationFn: (body: unknown) => api.createCustomer(body),
    onSuccess: () => {
      clearFormDraft(DRAFT_KEYS.customer);
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setShowForm(false);
    },
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) =>
      api.updateCustomer(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setEditing(null);
    },
  });

  if (customers.isPending) return <Spinner label="Loading customers…" />;
  const list = customers.data ?? [];

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[1.75rem]">Customers</h1>
          <p className="mt-1 text-sm text-[var(--ink-2)]">
            Consignors and consignees, with GSTIN and pickup or delivery addresses.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setShowForm((v) => !v); }}>
          <Plus size={16} aria-hidden />
          Add customer
        </Button>
      </div>

      {/* List-load failures only; submit errors show inside the form on the field. */}
      {customers.error && (
        <div className="mb-4">
          <ErrorNote>{(customers.error as Error).message}</ErrorNote>
        </div>
      )}

      {(showForm || editing) && (
        <CustomerForm
          key={editing?.id ?? "new"}
          existing={editing ?? undefined}
          busy={create.isPending || update.isPending}
          onCancel={() => { setShowForm(false); setEditing(null); }}
          onSubmit={(body) =>
            editing ? update.mutateAsync({ id: editing.id, body }) : create.mutateAsync(body)
          }
        />
      )}

      {list.length === 0 && !showForm ? (
        <Card padded={false}>
          <EmptyState
            illustration="/illustrations/empty.svg"
            title="No customers yet"
            body="Add the parties you ship for. Each can have several pickup or delivery addresses."
            action={<Button onClick={() => setShowForm(true)}><Plus size={16} aria-hidden />Add your first customer</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map((c) => (
            <Card key={c.id} className="lift space-y-3">
              <div className="flex items-start gap-4">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--surface)]">
                  <Building2 size={19} className="text-[var(--ink-2)]" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{c.name}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--ink-2)]">
                    {c.contactPerson && <span>{c.contactPerson}</span>}
                    <span className="flex items-center gap-1"><Phone size={11} aria-hidden />{c.phone}</span>
                    {c.email && <span className="flex items-center gap-1"><Mail size={11} aria-hidden />{c.email}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {c.gstin && (
                    <span className="rounded-[var(--radius-chip)] bg-[var(--surface)] px-2 py-1 font-[family-name:var(--font-jetbrains)] text-xs text-[var(--ink-2)]">
                      {c.gstin}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { setEditing(c); setShowForm(false); }}
                  >
                    <Pencil size={13} aria-hidden />
                    Edit
                  </Button>
                </div>
              </div>
              <AddressList customer={c} />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A customer's addresses, with a way to add another.
 *
 * A consignor rarely ships from one gate forever — a second godown, a new
 * factory, a one-off pickup from a port. Without this the only way to record
 * one was to create a duplicate customer, which then splits their history in
 * two.
 */
function AddressList({ customer }: { customer: Customer }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [picked, setPicked] = useState<PickedAddress | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.addCustomerAddress(customer.id, {
        ...picked,
        label: label || null,
        contactPerson: customer.contactPerson,
        contactPhone: customer.phone,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setAdding(false);
      setPicked(null);
      setLabel("");
    },
  });

  return (
    <div className="space-y-2 border-t border-[var(--stroke)] pt-3">
      {customer.addresses.map((a) => (
        <AddressRow key={a.id} customer={customer} address={a} />
      ))}

      {adding ? (
        <div className="space-y-3 rounded-[var(--radius-control)] border border-[var(--stroke)] p-3">
          <Input
            label="Label"
            name={`addrLabel-${customer.id}`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Second godown / Port yard"
          />
          <AddressPicker label="Location" value={picked} onChange={setPicked} />
          {add.error && <ErrorNote>{(add.error as Error).message}</ErrorNote>}
          <div className="flex gap-2">
            <Button size="sm" loading={add.isPending} disabled={!picked} onClick={() => add.mutate()}>
              Save address
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-xs font-medium text-[var(--accent)] hover:underline"
        >
          + Add another address
        </button>
      )}
    </div>
  );
}

/**
 * One saved address, with a way to correct it.
 *
 * Edited in place rather than deleted-and-re-added because consignments hold
 * an address by id: correcting a pin here fixes the route on trips that
 * already reference it, where a replacement would leave them on the old
 * coordinates.
 */
function AddressRow({ customer, address }: { customer: Customer; address: CustomerAddress }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(address.label ?? "");
  const [picked, setPicked] = useState<PickedAddress | null>(null);

  const done = () => {
    queryClient.invalidateQueries({ queryKey: ["customers"] });
    setEditing(false);
    setPicked(null);
  };

  const save = useMutation({
    mutationFn: () =>
      api.updateCustomerAddress(customer.id, address.id, {
        ...(picked ?? {
          line1: address.line1,
          city: address.city,
          state: address.state,
          pincode: address.pincode,
          latitude: address.latitude,
          longitude: address.longitude,
          placeName: address.placeName,
        }),
        label: label || null,
        contactPhone: customer.phone,
      }),
    onSuccess: done,
  });

  const remove = useMutation({
    mutationFn: () => api.deleteCustomerAddress(customer.id, address.id),
    onSuccess: done,
  });

  if (editing) {
    return (
      <div className="space-y-3 rounded-[var(--radius-control)] border border-[var(--accent)] p-3">
        <Input
          label="Label"
          name={`edit-label-${address.id}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Factory gate / Godown"
        />
        <div>
          <p className="mb-1.5 text-xs text-[var(--ink-2)]">
            Currently: {address.line1}
          </p>
          <AddressPicker
            label="Move or re-search this location"
            value={picked}
            onChange={setPicked}
          />
        </div>
        {(save.error || remove.error) && (
          <ErrorNote>{((save.error ?? remove.error) as Error).message}</ErrorNote>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
            Save address
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={remove.isPending}
            onClick={() => {
              if (confirm(`Delete "${address.label ?? address.line1}"? This cannot be undone.`)) {
                remove.mutate();
              }
            }}
          >
            <Trash2 size={13} aria-hidden />
            Delete
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2 text-xs text-[var(--ink-2)]">
      <MapPin size={12} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {address.label && (
          <span className="font-medium text-[var(--ink)]">{address.label} · </span>
        )}
        {address.line1}
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="shrink-0 font-medium text-[var(--accent)] hover:underline"
      >
        Edit
      </button>
    </div>
  );
}

function CustomerForm({
  busy, existing, onSubmit, onCancel,
}: {
  busy: boolean;
  /** When present the form edits this customer instead of creating one. */
  existing?: Customer;
  /** Rejects on a server error so the form can map it to the offending field. */
  onSubmit: (b: unknown) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [f, setF] = useState({
    name: existing?.name ?? "",
    contactPerson: existing?.contactPerson ?? "",
    phone: existing?.phone ?? "",
    altPhone: existing?.altPhone ?? "",
    email: existing?.email ?? "",
    gstin: existing?.gstin ?? "",
  });
  const [addressLabel, setAddressLabel] = useState("");
  const [address, setAddress] = useState<PickedAddress | null>(null);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<string[]>([]);
  const set = (k: string, v: string) => {
    setF((s) => ({ ...s, [k]: v }));
    setErrors((e) => withoutKey(e, k));
  };

  const ERROR_ORDER = ["name", "phone", "email", "gstin"];

  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!f.name.trim()) e.name = "Company name is required.";
    else if (f.name.trim().length < 2) e.name = "Company name is too short.";
    if (!f.phone.trim()) e.phone = "Phone number is required.";
    else if (!isPhone(f.phone)) e.phone = "Enter a valid phone number (at least 10 digits).";
    if (!isEmail(f.email)) e.email = "Enter a valid email address.";
    if (!isGstin(f.gstin)) e.gstin = "That isn't a valid 15-character GSTIN (e.g. 24ABCDE1234F1Z5).";
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

  /* --- Draft persistence — new customers only (an edit is seeded from the
     server). Keeps the typed details and the picked location on the device so
     a closed tab, refresh, or screen switch does not lose them. */
  const draft = useFormDraft({
    key: DRAFT_KEYS.customer,
    enabled: !existing,
    value: { f, addressLabel, address },
    isEmpty: (v) =>
      !Object.values(v.f).some((x) => (x ?? "").trim() !== "") &&
      (v.addressLabel ?? "").trim() === "" &&
      v.address === null,
  });

  function restoreDraft() {
    const data = draft.restore();
    if (!data) return;
    setF(data.f);
    setAddressLabel(data.addressLabel);
    setAddress(data.address);
  }

  function clearForm() {
    setF({ name: "", contactPerson: "", phone: "", altPhone: "", email: "", gstin: "" });
    setAddressLabel("");
    setAddress(null);
    draft.clear();
  }

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
    const details = {
      name: f.name,
      contactPerson: f.contactPerson || null,
      phone: f.phone,
      altPhone: f.altPhone || null,
      email: f.email || null,
      gstin: f.gstin || null,
    };
    // Editing never touches addresses. They are managed on the card, because
    // a consignment holds an address by id and dropping one from under a
    // booked trip would strand it.
    try {
      await onSubmit(
        existing
          ? details
          : {
              ...details,
              role: "both",
              addresses: address
                ? [{ ...address, label: addressLabel || null, contactPerson: f.contactPerson || null, contactPhone: f.phone }]
                : [],
            },
      );
    } catch (err) {
      applyServerError(err);
    }
  }

  return (
    <Card className="mb-4">
      <form onSubmit={submit} noValidate className="space-y-5">
        <ErrorSummary items={summaryItems} />
        {draft.found && (
          <DraftBanner
            savedAt={draft.found.savedAt}
            noun="customer entry"
            onRestore={restoreDraft}
            onDiscard={draft.discard}
          />
        )}
        <div>
          <h3 className="mb-3 text-base font-semibold">
            {existing ? `Edit ${existing.name}` : "Customer"}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Company name" name="name" value={f.name} onChange={(e) => set("name", e.target.value)} error={errors.name} required minLength={2} placeholder="Rajasthan Marble Works" />
            <Input label="Contact person" name="contactPerson" value={f.contactPerson} onChange={(e) => set("contactPerson", e.target.value)} placeholder="Mahesh Sharma" />
            <Input label="Phone" name="phone" value={f.phone} onChange={(e) => set("phone", e.target.value)} error={errors.phone} required placeholder="+91 98100 00001" inputMode="tel" />
            <Input label="Alternate phone" name="altPhone" value={f.altPhone} onChange={(e) => set("altPhone", e.target.value)} inputMode="tel" />
            <Input label="Email" name="email" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} error={errors.email} placeholder="accounts@company.com" />
            <Input label="GSTIN" name="gstin" value={f.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase())} error={errors.gstin} placeholder="08AAACR1234A1ZK" hint="Required on the consignment note if registered" />
          </div>
        </div>

        {!existing && (
          <div className="space-y-3 border-t border-[var(--stroke)] pt-4">
            <h3 className="text-base font-semibold">Address</h3>
            <Input label="Label" name="addrLabel" value={addressLabel} onChange={(e) => setAddressLabel(e.target.value)} placeholder="Factory gate / Warehouse / Godown" />
            <AddressPicker label="Location" value={address} onChange={setAddress} />
          </div>
        )}
        {existing && (
          <p className="border-t border-[var(--stroke)] pt-4 text-sm text-[var(--ink-2)]">
            Addresses are edited on the customer&apos;s card below — each one can
            be corrected or moved without disturbing consignments that use it.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--stroke)] pt-4">
          <Button type="submit" loading={busy}>{existing ? "Save changes" : "Save customer"}</Button>
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
