"use client";

import { AlertTriangle } from "lucide-react";

import { focusField } from "@/lib/formErrors";

export type SummaryItem = {
  /** The id of the field to jump to. Omit for a general (non-field) message. */
  field?: string;
  message: string;
};

/**
 * The banner shown at the top of a form when submission is blocked. It answers
 * "what's wrong, where, and why" in one place: every item is the exact reason,
 * and the field-bound ones are buttons that scroll to and focus the input — so
 * the operator never has to hunt the form for the red box.
 */
export function ErrorSummary({ items, title }: { items: SummaryItem[]; title?: string }) {
  if (!items.length) return null;
  const count = items.length;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-[var(--radius-control)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm"
    >
      <div className="flex items-center gap-2 font-medium text-[var(--danger)]">
        <AlertTriangle size={15} className="shrink-0" aria-hidden />
        {title ?? `Please fix ${count} ${count === 1 ? "thing" : "things"} before saving`}
      </div>
      <ul className="mt-2 space-y-1 pl-1">
        {items.map((it, i) => (
          <li key={`${it.field ?? "general"}-${i}`} className="flex gap-1.5">
            <span aria-hidden className="text-[var(--danger)]">
              •
            </span>
            {it.field ? (
              <button
                type="button"
                onClick={() => focusField(it.field!)}
                className="text-left text-[var(--danger)] underline underline-offset-2 hover:opacity-80"
              >
                {it.message}
              </button>
            ) : (
              <span className="text-[var(--danger)]">{it.message}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
