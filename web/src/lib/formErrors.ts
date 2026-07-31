"use client";

/**
 * Field-level form errors — knowing *what* is wrong *where*, not just *that*
 * something is.
 *
 * A form keeps a `FieldErrors` map (field id → message). Inputs render their own
 * message in red (via the shared `Input`'s `error` prop) and the ErrorSummary
 * lists them all as links that scroll to the offending field. The same map is
 * filled two ways: client-side validation on submit (instant, no round-trip),
 * and by mapping the backend's response when it rejects something the client
 * couldn't know (a duplicate registration, a bad GSTIN).
 */

export type FieldErrors = Record<string, string>;

/**
 * Turn any thrown API error into field-targeted messages plus general ones.
 *
 * The backend's validation handler returns `{ errors: [{ field, message }] }`
 * where `field` is the dotted path minus the body prefix (e.g.
 * `registrationNumber`, or `consignment.goodsDescription`). We key each message
 * by its full path *and* its leaf segment, so a form can look it up by whichever
 * id its input uses. A business error (a plain string detail) has no field and
 * becomes a general message — shown verbatim so the operator sees the real
 * reason.
 */
export function parseApiError(err: unknown): { fields: FieldErrors; general: string[] } {
  const fields: FieldErrors = {};
  const general: string[] = [];

  const detail =
    err && typeof err === "object" && "detail" in err
      ? (err as { detail?: unknown }).detail
      : undefined;

  const list = (detail as { errors?: Array<{ field?: string; message: string }> })?.errors;
  if (Array.isArray(list) && list.length) {
    for (const e of list) {
      if (!e?.message) continue;
      if (e.field) {
        fields[e.field] = e.message;
        const leaf = e.field.split(".").pop();
        if (leaf && !(leaf in fields)) fields[leaf] = e.message;
      } else {
        general.push(e.message);
      }
    }
    if (Object.keys(fields).length || general.length) return { fields, general };
  }

  general.push(err instanceof Error ? err.message : "Something went wrong. Please try again.");
  return { fields, general };
}

/**
 * Scroll a field into view and focus it. Works for a plain input (by its `id`)
 * and for a wrapper element given the same id (document rows), which is why it
 * guards `focus`.
 */
export function focusField(id: string): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(id) as (HTMLElement & { focus?: () => void }) | null;
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // Focus once the scroll has begun; preventScroll stops a second jump.
  window.setTimeout(() => {
    try {
      (el as HTMLElement).focus({ preventScroll: true });
    } catch {
      /* not focusable — scrolling into view is enough */
    }
  }, 120);
}

/** Remove one key from an error map (used to clear a field as it's corrected). */
export function withoutKey(errors: FieldErrors, key: string): FieldErrors {
  if (!(key in errors)) return errors;
  const rest = { ...errors };
  delete rest[key];
  return rest;
}

/* --- Format validators -------------------------------------------------- */
/* Shared so the same rule (and message) is applied wherever a GSTIN, PAN,
   pincode or email is entered. All are lenient about surrounding whitespace and
   case; each returns true for an EMPTY string so callers decide separately
   whether a field is required — "optional but must be well-formed if present". */

export const isEmail = (v: string): boolean =>
  v.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

// 2-digit state code, 5-letter PAN block, 4 digits, 1 letter, 1 entity char,
// 'Z', 1 checksum char — the standard 15-character GSTIN shape.
export const isGstin = (v: string): boolean =>
  v.trim() === "" || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(v.trim().toUpperCase());

// 5 letters, 4 digits, 1 letter.
export const isPan = (v: string): boolean =>
  v.trim() === "" || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v.trim().toUpperCase());

// Indian PIN: 6 digits, first non-zero.
export const isPincode = (v: string): boolean =>
  v.trim() === "" || /^[1-9][0-9]{5}$/.test(v.trim());

// Deliberately loose — Indian mobile/landline with or without +91, spaces or
// dashes. We only insist there are at least 10 digits in there somewhere.
export const isPhone = (v: string): boolean =>
  v.trim() === "" || v.replace(/\D/g, "").length >= 10;
