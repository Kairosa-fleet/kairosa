/**
 * On-device store: the outbox and the diagnostics log.
 *
 * Every fix is written here *first* and only removed once the server has
 * confirmed it. That is what makes a tunnel, a basement or a dead cell
 * survivable — the app never holds a fix only in memory.
 *
 * The background location task runs in a separate JS context from the UI, so
 * the connection is opened lazily per context rather than shared.
 */

import * as SQLite from "expo-sqlite";

import { TRACKING } from "./config";
import type { DiagnosticKind, DiagnosticRow, LocationPingPayload, OutboxRow } from "./types";

const DB_NAME = "fleet-tracking.db";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function open(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  // WAL keeps the background writer from blocking the UI reader.
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS outbox (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_seq  INTEGER NOT NULL UNIQUE,
      payload     TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_outbox_created ON outbox (created_at);

    CREATE TABLE IF NOT EXISTS diagnostics (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT    NOT NULL,
      detail     TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_diag_created ON diagnostics (created_at);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  dbPromise ??= open();
  return dbPromise;
}

/* --- meta ---------------------------------------------------------------- */

export async function metaGet(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM meta WHERE key = ?",
    key,
  );
  return row?.value ?? null;
}

export async function metaSet(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

/**
 * Monotonic per-device sequence number.
 *
 * This is what makes a retried batch idempotent: the server has a UNIQUE
 * constraint on (device_id, client_seq), so a re-send after a lost ACK is
 * recognised as a duplicate instead of creating a second row.
 */
export async function nextClientSeq(): Promise<number> {
  const db = await getDb();
  let next = 1;
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'client_seq'",
    );
    next = row ? parseInt(row.value, 10) + 1 : 1;
    await db.runAsync(
      "INSERT INTO meta (key, value) VALUES ('client_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(next),
    );
  });
  return next;
}

/* --- outbox -------------------------------------------------------------- */

export async function enqueue(payload: LocationPingPayload): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT OR IGNORE INTO outbox (client_seq, payload, created_at) VALUES (?, ?, ?)",
    payload.clientSeq,
    JSON.stringify(payload),
    Date.now(),
  );
}

export async function peekBatch(limit = TRACKING.maxBatch): Promise<OutboxRow[]> {
  const db = await getDb();
  // Oldest first, so the server's integrity baseline advances in real order.
  return db.getAllAsync<OutboxRow>(
    "SELECT * FROM outbox ORDER BY created_at ASC LIMIT ?",
    Math.min(limit, TRACKING.maxBatch),
  );
}

export async function removeRows(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(",");
  await db.runAsync(`DELETE FROM outbox WHERE id IN (${placeholders})`, ...ids);
}

export async function markFailed(ids: number[], error: string): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(",");
  await db.runAsync(
    `UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id IN (${placeholders})`,
    error.slice(0, 200),
    ...ids,
  );
}

/**
 * Drop rows that can never succeed: too old for the server to accept, or
 * retried so many times that something is permanently wrong with them.
 * Without this the outbox grows without bound on a device that is offline for
 * days, and every flush re-sends the same doomed rows.
 */
export async function pruneOutbox(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    "DELETE FROM outbox WHERE created_at < ? OR attempts >= ?",
    Date.now() - TRACKING.maxAgeMs,
    TRACKING.maxAttempts,
  );
  return result.changes;
}

/**
 * Drop every queued fix. Used when this phone changes hands.
 *
 * The server attributes an upload to whichever device token sent it, not to
 * the `deviceId` recorded in the payload. So fixes captured before a different
 * driver signed in would be stored as *their* movements — one driver's evening
 * commute appearing inside another's trip history. On a handset shared between
 * shifts that is both wrong and a privacy leak, and the fixes can never be
 * legitimately attributed now, so they are discarded rather than sent.
 */
export async function clearOutbox(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync("DELETE FROM outbox");
  return result.changes;
}

export async function outboxDepth(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM outbox",
  );
  return row?.n ?? 0;
}

export async function oldestPending(): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ t: number }>(
    "SELECT MIN(created_at) AS t FROM outbox",
  );
  return row?.t ?? null;
}

/* --- diagnostics --------------------------------------------------------- */

/**
 * Field-testing evidence. Without this, an 8-hour drive produces impressions
 * ("it felt like it dropped some") rather than a timeline you can act on.
 */
export async function logEvent(
  kind: DiagnosticKind,
  detail?: string,
): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync(
      "INSERT INTO diagnostics (kind, detail, created_at) VALUES (?, ?, ?)",
      kind,
      detail ?? null,
      Date.now(),
    );
    // Keep the log bounded — this table is written from a background task.
    await db.runAsync(
      "DELETE FROM diagnostics WHERE id NOT IN (SELECT id FROM diagnostics ORDER BY created_at DESC LIMIT 1000)",
    );
  } catch {
    // Diagnostics must never break tracking.
  }
}

export async function recentEvents(limit = 200): Promise<DiagnosticRow[]> {
  const db = await getDb();
  return db.getAllAsync<DiagnosticRow>(
    "SELECT * FROM diagnostics ORDER BY created_at DESC LIMIT ?",
    limit,
  );
}

export async function clearDiagnostics(): Promise<void> {
  const db = await getDb();
  await db.execAsync("DELETE FROM diagnostics");
}
