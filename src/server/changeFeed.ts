/**
 * A payload diff of the existing newest history page, not an ingestion cursor.
 * Hash only the final privacy-shaped rows. Timestamp windows can hide late arrivals;
 * knowing a row's complete digest permits omitting only that exact, unchanged row.
 */
import { createHash } from 'node:crypto';

export const CHANGE_FEED_MAX_ROWS = 100;
export const CHANGE_FEED_MAX_KNOWN_CHARS = CHANGE_FEED_MAX_ROWS * 65 - 1;

/** Undefined keeps the legacy full-page read; an empty string starts a fresh baseline. */
export function parseKnownRows(raw: unknown): Set<string> | null | 'invalid' {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > CHANGE_FEED_MAX_KNOWN_CHARS) return 'invalid';
  if (raw === '') return new Set();
  const hashes = raw.split(',');
  if (hashes.length > CHANGE_FEED_MAX_ROWS || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) return 'invalid';
  return new Set(hashes);
}

/**
 * The full ordered hash list accompanies the changed rows, in the same order.
 * Clients retain the actual baseline rows and reconstruct the complete page before
 * sharing it with another tab. Missing baselines must request knownRows= again.
 * Read positions, pins and backwards cursors stay outside this message-only diff.
 */
export function filterKnownRows<T>(rows: ReadonlyArray<T>, known: ReadonlySet<string> | null): {
  messages: T[]; changeFeed?: { rowHashes: string[] };
} {
  if (known === null) return { messages: [...rows] };
  const rowHashes = rows.map((row) => createHash('sha256').update(JSON.stringify(row)).digest('hex'));
  return { messages: rows.filter((_row, index) => !known.has(rowHashes[index]!)), changeFeed: { rowHashes } };
}
