"use client";

/**
 * Local draft persistence for long data-entry forms.
 *
 * The problem: adding a vehicle (four documents), a driver (licence + photo +
 * documents) or a customer (with a geocoded address) is a long form. If the tab
 * is closed, the page refreshed, or the operator switches from the vehicle
 * screen to the driver screen mid-entry, everything typed is lost — and there
 * was no way to deliberately clear a half-filled form either.
 *
 * The fix mirrors how an offline-first app (Google Docs, Spotify) keeps your
 * work: every change is written to the browser's own storage as you type, so it
 * survives a reload and can be restored on return. A single form snapshot is
 * tiny and its access is synchronous, so localStorage is the right tool here —
 * the principle ("persist locally, restore on return, sync/submit later") is
 * exactly the one from the offline-first pattern, just sized to a form.
 *
 * What it remembers: typed fields and the references to files already uploaded
 * (an uploaded scan lives on the server, so its URL stays valid after a reload).
 * It is a convenience for in-progress entry, never the record of truth — that
 * becomes the backend the moment the form is submitted, at which point the
 * draft is cleared.
 */

import { useEffect, useState } from "react";

const PREFIX = "kairosa.draft.";
// Bump when a persisted shape changes so an old draft is ignored, not restored
// into a form that no longer matches it.
const VERSION = 1;

/** Stable storage keys, one per create form. */
export const DRAFT_KEYS = {
  vehicle: "vehicle",
  driver: "driver",
  customer: "customer",
  booking: "booking",
} as const;

type Stored<T> = { v: number; savedAt: number; data: T };

const storageKey = (key: string) => PREFIX + key;

function read<T>(key: string): Stored<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored<T>;
    if (parsed?.v !== VERSION || typeof parsed.savedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Drop a saved draft. Call from the parent's mutation `onSuccess`, so a record
 * that made it to the backend does not leave a stale draft behind.
 */
export function clearFormDraft(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(key));
  } catch {
    /* storage disabled — nothing to clear */
  }
}

export type FormDraft<T> = {
  /**
   * A saved draft found on mount, awaiting the operator's choice. Null once it
   * has been restored or discarded, or if none existed. While this is set,
   * autosave is paused so the pending draft is never overwritten before the
   * operator decides.
   */
  found: { data: T; savedAt: number } | null;
  /** True when there is genuinely something being autosaved right now — drives
   *  an honest "Draft saved" hint (never shown on an untouched form). */
  active: boolean;
  /** Apply the found draft: returns its data and dismisses the banner. */
  restore: () => T | null;
  /** Throw the found draft away and dismiss the banner. */
  discard: () => void;
  /** Wipe persisted storage — used by the form's "Clear" button. */
  clear: () => void;
};

export function useFormDraft<T>(opts: {
  key: string;
  /** False when editing an existing record — an edit is never autosaved. */
  enabled: boolean;
  /** The current serialisable snapshot of the form. */
  value: T;
  /** True when the snapshot is untouched, so we neither save nor offer it. */
  isEmpty: (value: T) => boolean;
  debounceMs?: number;
}): FormDraft<T> {
  const { key, enabled, value, isEmpty, debounceMs = 600 } = opts;

  // Read any existing draft once, synchronously at mount. On the server `read`
  // returns null (no window), and the banner it drives is never part of the
  // hydration render (the create forms mount behind a click, booking behind a
  // loading state), so this stays free of hydration mismatches. Reading here
  // rather than in an effect also guarantees `found` is known before the first
  // autosave runs, so an existing draft is never clobbered.
  const [found, setFound] = useState<{ data: T; savedAt: number } | null>(() => {
    if (!enabled) return null;
    try {
      const stored = read<T>(key);
      // isEmpty reaches into the stored shape; a draft that somehow doesn't
      // match must be ignored, never crash the form.
      if (!stored || isEmpty(stored.data)) return null;
      return { data: stored.data, savedAt: stored.savedAt };
    } catch {
      return null;
    }
  });

  // Serialise once per render; drives the effect dependency so we only write
  // when the content actually changed.
  let serialized: string | null = null;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = null;
  }
  const empty = isEmpty(value);

  useEffect(() => {
    // Skip while: editing, nothing typed, un-serialisable, or a restore banner
    // is still open (don't clobber the pending draft before the operator picks).
    if (!enabled || empty || serialized == null || found) return;
    const handle = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          storageKey(key),
          `{"v":${VERSION},"savedAt":${Date.now()},"data":${serialized}}`,
        );
      } catch {
        /* quota exceeded or storage disabled — a lost draft beats a thrown form */
      }
    }, debounceMs);
    return () => window.clearTimeout(handle);
  }, [enabled, empty, serialized, found, key, debounceMs]);

  // These only ever run from the banner's click handlers, so plain functions
  // are correct — no memoisation or refs needed.
  const restore = () => {
    const data = found?.data ?? null;
    setFound(null);
    return data;
  };

  const discard = () => {
    setFound(null);
    clearFormDraft(key);
  };

  const clear = () => {
    setFound(null);
    clearFormDraft(key);
  };

  return {
    found,
    // Something is genuinely being persisted right now (not editing, not the
    // pending-restore state, and the form has content). Drives an honest hint.
    active: enabled && !empty && !found,
    restore,
    discard,
    clear,
  };
}

/** "2 minutes ago" style relative time for the restore banner. */
export function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
