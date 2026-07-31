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
