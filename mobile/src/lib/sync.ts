/**
 * Outbox → server sync.
 *
 * Rules that matter:
 *   1. A row is deleted only when the server has confirmed it. Anything else
 *      loses data on a flaky connection.
 *   2. A *duplicate* counts as confirmed. The server already has it (the
 *      unique constraint on (device_id, client_seq) caught the retry), so
 *      keeping it would make the device retry forever.
 *   3. A *rejected* row is also deleted. The server will never accept a fix
 *      that is too old or too inaccurate, so retrying is pure waste.
 *   4. Only transport failures are retried, with backoff handled by the caller.
 */

import { api, ApiError } from "./api";
import { logEvent, markFailed, peekBatch, pruneOutbox, removeRows } from "./db";
import { TRACKING } from "./config";
import type { LocationPingPayload } from "./types";

let flushing = false;

export interface FlushOutcome {
  attempted: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  error?: string;
}

/**
 * Drain the outbox. Safe to call concurrently — overlapping calls return
 * immediately rather than sending the same rows twice.
 */
export async function flushOutbox(): Promise<FlushOutcome> {
  if (flushing) return { attempted: 0, accepted: 0, duplicates: 0, rejected: 0 };
  flushing = true;

  try {
    await pruneOutbox();

    const rows = await peekBatch(TRACKING.maxBatch);
    if (rows.length === 0)
      return { attempted: 0, accepted: 0, duplicates: 0, rejected: 0 };

    const ids = rows.map((r) => r.id);
    const pings: LocationPingPayload[] = [];
    const malformed: number[] = [];

    for (const row of rows) {
      try {
        pings.push(JSON.parse(row.payload));
      } catch {
        // Unparseable row would poison every future flush — drop it.
        malformed.push(row.id);
      }
    }
    if (malformed.length) await removeRows(malformed);
    if (pings.length === 0)
      return { attempted: 0, accepted: 0, duplicates: 0, rejected: 0 };

    const sendIds = ids.filter((id) => !malformed.includes(id));

    try {
      const result = await api.ingestBatch(pings);

      // The server reports per item, so partial success is handled precisely.
      const settled = new Set<number>();
      result.results.forEach((r, index) => {
        // accepted:true covers both stored and duplicate — both mean "the
        // server has it", which is the only thing that licenses deletion.
        if (r.accepted || r.reason) settled.add(sendIds[index]);
      });

      const toDelete = sendIds.filter((id) => settled.has(id));
      await removeRows(toDelete);

      const unsettled = sendIds.filter((id) => !settled.has(id));
      if (unsettled.length) await markFailed(unsettled, "not confirmed");

      await logEvent(
        "sync_ok",
        `sent=${pings.length} accepted=${result.accepted} dup=${result.duplicates} rejected=${result.rejected}`,
      );

      return {
        attempted: pings.length,
        accepted: result.accepted,
        duplicates: result.duplicates,
        rejected: result.rejected,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown sync error";
      await markFailed(sendIds, message);
      await logEvent("sync_failed", message);

      // An auth failure is not transient — the device was revoked or the token
      // expired. Surface it rather than hammering the server.
      if (error instanceof ApiError && error.isAuthFailure) {
        return {
          attempted: pings.length,
          accepted: 0,
          duplicates: 0,
          rejected: 0,
          error: `Device rejected: ${message}`,
        };
      }

      return {
        attempted: pings.length,
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        error: message,
      };
    }
  } finally {
    flushing = false;
  }
}
