"use client";

/**
 * The Lorry Receipt (LR) / Goods Consignment Note — the transporter's core
 * legal document, rendered in one defined A4 format.
 *
 * This lives OUTSIDE the dashboard shell (its own top-level route) because it
 * is a document, not a screen: on print, only the note itself should appear,
 * with no app chrome. "Save as PDF" from the browser's print dialog produces
 * the shareable/archivable file — which keeps the whole feature dependency-free
 * and gives pixel-perfect output that a server-side PDF library would fight us
 * for.
 *
 * Three copies print by design — Consignor, Consignee, Transporter — because a
 * physical LR is a three-part document and each party keeps one.
 */

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useEffect } from "react";

import { api } from "@/lib/api";
import type { LrData, LrParty } from "@/lib/types";

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return "₹" + n.toLocaleString("en-IN");
}

function dateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export default function LrPage() {
  const params = useParams<{ consignmentId: string }>();
  const lr = useQuery({
    queryKey: ["lr", params.consignmentId],
    queryFn: () => api.consignmentLr(params.consignmentId),
  });

  // Set a document title so "Save as PDF" defaults to a sensible filename.
  useEffect(() => {
    if (lr.data) document.title = `LR ${lr.data.lrNumber}`;
  }, [lr.data]);

  if (lr.isPending)
    return <div className="p-10 text-center text-sm text-neutral-500">Preparing the consignment note…</div>;
  if (lr.error)
    return <div className="p-10 text-center text-sm text-red-600">{(lr.error as Error).message}</div>;

  const data = lr.data!;

  return (
    <div className="lr-root">
      <style>{PRINT_CSS}</style>

      {/* Toolbar — screen only, never printed. */}
      <div className="lr-toolbar no-print">
        <div>
          <strong>Consignment note {data.lrNumber}</strong>
          {!data.letterheadReady && (
            <span className="lr-warn">
              {" "}
              · Letterhead incomplete ({data.letterheadMissing.join(", ")}) — fix
              it in Settings before issuing this to a customer.
            </span>
          )}
        </div>
        <button className="lr-print-btn" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </div>

      <CopyLabelledSheet data={data} copyFor="Consignor copy" />
      <CopyLabelledSheet data={data} copyFor="Consignee copy" />
      <CopyLabelledSheet data={data} copyFor="Transporter copy" />
    </div>
  );
}

function CopyLabelledSheet({ data, copyFor }: { data: LrData; copyFor: string }) {
  const t = data.transporter;
  return (
    <div className="lr-sheet">
      {/* Header — transporter letterhead */}
      <header className="lr-head">
        <div className="lr-head-main">
          <div className="lr-title">{t.name || "Transporter name not set"}</div>
          {t.tradeName && t.tradeName !== t.name && (
            <div className="lr-sub">({t.tradeName})</div>
          )}
          {t.address && <div className="lr-sub">{t.address}</div>}
          <div className="lr-sub">
            {[t.phone, t.email].filter(Boolean).join("  ·  ")}
          </div>
          <div className="lr-ids">
            {t.gstin && <span>GSTIN: <b>{t.gstin}</b></span>}
            {t.pan && <span>PAN: <b>{t.pan}</b></span>}
            {t.transporterId && <span>Transporter ID: <b>{t.transporterId}</b></span>}
          </div>
        </div>
        <div className="lr-head-side">
          <div className="lr-doc-name">GOODS CONSIGNMENT NOTE</div>
          <div className="lr-doc-sub">(Lorry Receipt)</div>
          <table className="lr-meta">
            <tbody>
              <tr><td>LR No.</td><td className="mono"><b>{data.lrNumber}</b></td></tr>
              <tr><td>Date</td><td>{dateOnly(data.createdAt)}</td></tr>
              <tr><td>Copy</td><td>{copyFor}</td></tr>
            </tbody>
          </table>
        </div>
      </header>

      {/* Parties */}
      <div className="lr-parties">
        <PartyBox title="Consignor (From)" party={data.consignor} />
        <PartyBox title="Consignee (To)" party={data.consignee} />
      </div>

      {/* Goods table */}
      <table className="lr-goods">
        <thead>
          <tr>
            <th>Description of goods</th>
            <th>HSN</th>
            <th>Packages</th>
            <th>Weight</th>
            <th>Declared value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              {data.goods.description}
              {(data.goods.isFragile || data.goods.isHazardous) && (
                <div className="lr-flags">
                  {data.goods.isFragile && <span>FRAGILE</span>}
                  {data.goods.isHazardous && <span>HAZARDOUS</span>}
                </div>
              )}
            </td>
            <td className="mono">{data.goods.hsnCode ?? "—"}</td>
            <td>
              {data.goods.packageCount ?? "—"}
              {data.goods.packageType ? ` ${data.goods.packageType}` : ""}
            </td>
            <td>{data.goods.weightKg ? `${data.goods.weightKg.toLocaleString("en-IN")} kg` : "—"}</td>
            <td>{money(data.goods.declaredValue)}</td>
          </tr>
        </tbody>
      </table>

      {/* Statutory + carriage + freight, three columns */}
      <div className="lr-grid3">
        <section>
          <h4>Statutory</h4>
          <Row k="E-way bill" v={data.statutory.ewayBillNumber} mono />
          <Row k="E-way valid till" v={dateTime(data.statutory.ewayBillValidUntil)} />
          <Row k="Invoice no." v={data.statutory.invoiceNumber} mono />
          <Row k="Invoice date" v={dateOnly(data.statutory.invoiceDate)} />
        </section>
        <section>
          <h4>Carriage</h4>
          <Row k="Vehicle no." v={data.carriage.vehicleNumber} mono />
          <Row k="Driver" v={data.carriage.driverName} />
          <Row k="Dispatch" v={dateTime(data.carriage.scheduledStart)} />
          <Row k="Distance" v={data.carriage.distanceKm ? `${data.carriage.distanceKm} km` : null} />
        </section>
        <section className="lr-freight">
          <h4>Freight — {data.freight.payableBy}</h4>
          <Row k="Freight" v={money(data.freight.amount)} />
          <Row k="Advance" v={money(data.freight.advance)} />
          <Row k="Balance" v={money(data.freight.balance)} strong />
        </section>
      </div>

      {data.specialInstructions && (
        <div className="lr-instructions">
          <b>Special instructions:</b> {data.specialInstructions}
        </div>
      )}

      {/* Terms + signatures */}
      <div className="lr-foot">
        <div className="lr-terms">
          {t.terms ??
            "Goods carried entirely at owner\u2019s risk. The company is not responsible for leakage, breakage, or loss by fire, accident or theft in transit."}
        </div>
        <div className="lr-signs">
          <div className="lr-sign">Receiver&apos;s signature</div>
          <div className="lr-sign">For {t.tradeName || t.name}</div>
        </div>
      </div>
    </div>
  );
}

function PartyBox({ title, party }: { title: string; party: LrParty }) {
  return (
    <div className="lr-party">
      <div className="lr-party-title">{title}</div>
      <div className="lr-party-name">{party.name}</div>
      <div className="lr-party-addr">{party.address}</div>
      <div className="lr-party-meta">
        {party.gstin && <span>GSTIN: <b>{party.gstin}</b></span>}
        {party.phone && <span>{party.phone}</span>}
        {party.contactPerson && <span>Attn: {party.contactPerson}</span>}
      </div>
    </div>
  );
}

function Row({ k, v, mono, strong }: { k: string; v: string | null; mono?: boolean; strong?: boolean }) {
  return (
    <div className="lr-row">
      <span className="lr-row-k">{k}</span>
      <span className={`lr-row-v${mono ? " mono" : ""}${strong ? " strong" : ""}`}>{v ?? "—"}</span>
    </div>
  );
}

/* Self-contained CSS. Kept inline so the document renders identically whether
   opened in the app or printed, without depending on the app's theme tokens
   (a printed document must be black on white regardless of dark mode). */
const PRINT_CSS = `
.lr-root { background:#f4f4f5; min-height:100vh; color:#18181b; }
.lr-toolbar {
  position:sticky; top:0; z-index:10; display:flex; align-items:center;
  justify-content:space-between; gap:12px; padding:12px 20px;
  background:#fff; border-bottom:1px solid #e4e4e7; font-size:13px;
}
.lr-warn { color:#b45309; }
.lr-print-btn {
  background:#4f46e5; color:#fff; border:0; border-radius:8px;
  padding:9px 18px; font-size:14px; font-weight:600; cursor:pointer;
}
.lr-sheet {
  width:190mm; min-height:auto; margin:16px auto; padding:14mm 12mm;
  background:#fff; box-shadow:0 1px 8px rgba(0,0,0,.12);
  font-family: Inter, system-ui, sans-serif; font-size:11px; line-height:1.4;
}
.lr-head { display:flex; justify-content:space-between; gap:16px;
  border-bottom:2px solid #18181b; padding-bottom:10px; }
.lr-title { font-size:19px; font-weight:800; letter-spacing:-0.3px; }
.lr-sub { color:#3f3f46; font-size:10.5px; margin-top:1px; }
.lr-ids { display:flex; flex-wrap:wrap; gap:12px; margin-top:5px; font-size:10px; color:#3f3f46; }
.lr-head-side { text-align:right; min-width:58mm; }
.lr-doc-name { font-size:13px; font-weight:800; letter-spacing:.5px; }
.lr-doc-sub { font-size:10px; color:#52525b; margin-bottom:6px; }
.lr-meta { margin-left:auto; border-collapse:collapse; font-size:10.5px; }
.lr-meta td { border:1px solid #d4d4d8; padding:3px 8px; text-align:left; }
.lr-meta td:first-child { color:#52525b; }
.lr-parties { display:grid; grid-template-columns:1fr 1fr; gap:0; margin-top:10px;
  border:1px solid #d4d4d8; }
.lr-party { padding:8px 10px; }
.lr-party + .lr-party { border-left:1px solid #d4d4d8; }
.lr-party-title { font-size:9px; font-weight:700; text-transform:uppercase;
  letter-spacing:.5px; color:#71717a; }
.lr-party-name { font-size:13px; font-weight:700; margin-top:2px; }
.lr-party-addr { color:#3f3f46; margin-top:2px; }
.lr-party-meta { display:flex; flex-wrap:wrap; gap:10px; margin-top:4px; font-size:10px; color:#3f3f46; }
.lr-goods { width:100%; border-collapse:collapse; margin-top:10px; }
.lr-goods th { background:#f4f4f5; border:1px solid #d4d4d8; padding:5px 8px;
  text-align:left; font-size:9.5px; text-transform:uppercase; letter-spacing:.4px; color:#52525b; }
.lr-goods td { border:1px solid #d4d4d8; padding:7px 8px; vertical-align:top; }
.lr-flags { display:flex; gap:6px; margin-top:4px; }
.lr-flags span { background:#fef2f2; color:#b91c1c; border:1px solid #fecaca;
  border-radius:3px; padding:1px 6px; font-size:9px; font-weight:700; }
.lr-grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:0;
  margin-top:10px; border:1px solid #d4d4d8; }
.lr-grid3 section { padding:8px 10px; }
.lr-grid3 section + section { border-left:1px solid #d4d4d8; }
.lr-grid3 h4 { margin:0 0 5px; font-size:9px; font-weight:700; text-transform:uppercase;
  letter-spacing:.5px; color:#71717a; }
.lr-freight { background:#fafafa; }
.lr-row { display:flex; justify-content:space-between; gap:8px; padding:1.5px 0; }
.lr-row-k { color:#52525b; }
.lr-row-v { text-align:right; }
.lr-row-v.strong { font-weight:700; font-size:12px; }
.lr-instructions { margin-top:8px; padding:6px 10px; background:#fffbeb;
  border:1px solid #fde68a; border-radius:4px; font-size:10.5px; }
.lr-foot { margin-top:12px; }
.lr-terms { font-size:8.5px; color:#71717a; line-height:1.35;
  border-top:1px solid #e4e4e7; padding-top:6px; }
.lr-signs { display:flex; justify-content:space-between; margin-top:24px; }
.lr-sign { width:44%; border-top:1px solid #18181b; padding-top:4px;
  font-size:10px; color:#3f3f46; text-align:center; }
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }

@media print {
  .lr-root { background:#fff; }
  .no-print { display:none !important; }
  .lr-sheet { width:auto; margin:0; box-shadow:none; padding:10mm 8mm;
    page-break-after:always; }
  .lr-sheet:last-child { page-break-after:auto; }
  @page { size: A4; margin: 6mm; }
}
`;
