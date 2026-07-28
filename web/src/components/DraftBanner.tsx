"use client";

import { History, X } from "lucide-react";

import { relativeTime } from "@/lib/formDraft";

/**
 * Offered at the top of a create form when an unsaved draft from a previous
 * visit is found. It gives the operator the choice the offline-first pattern
 * implies: pick up where they left off, or start clean.
 */
export function DraftBanner({
  savedAt,
  noun,
  onRestore,
  onDiscard,
}: {
  savedAt: number;
  /** e.g. "vehicle", "driver" — used in the sentence. */
  noun: string;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] border border-[var(--accent)] bg-[var(--accent-soft)] p-3 text-sm">
      <History size={16} className="shrink-0 text-[var(--accent)]" aria-hidden />
      <span className="flex-1 text-[var(--ink)]">
        You have an unsaved {noun} from{" "}
        <span className="font-medium">{relativeTime(savedAt)}</span>. Restore it?
      </span>
      <button
        type="button"
        onClick={onRestore}
        className="rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 font-medium text-white transition-[filter] hover:brightness-108"
      >
        Restore draft
      </button>
      <button
        type="button"
        onClick={onDiscard}
        aria-label="Discard saved draft"
        className="inline-flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-1.5 text-[var(--ink-2)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--ink)]"
      >
        <X size={14} aria-hidden />
        Discard
      </button>
    </div>
  );
}

/**
 * A small "Draft saved" hint the forms show while autosave is active, so the
 * operator can trust that leaving won't lose the entry.
 */
export function DraftSavedHint() {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-[var(--ink-2)]">
      <span className="size-1.5 rounded-full bg-[var(--success)]" aria-hidden />
      Draft saved on this device
    </span>
  );
}
