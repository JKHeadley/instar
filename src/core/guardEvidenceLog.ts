/**
 * guardEvidenceLog — a bounded, append-only JSONL writer for a guard's durable
 * per-run records (CMT-1119). A dry-run guard that leaves no record cannot be
 * graded by a soak: its counters live in memory and vanish at restart. Each
 * guard appends one line per run (or per state change, for fast ticks) so the
 * soak accrues dated evidence.
 *
 * Bounded: when the file passes `maxBytes` it is renamed to `<file>.1`
 * (replacing any older `.1`) and a fresh file starts — at most 2× maxBytes on
 * disk. Observability only: every failure is swallowed and reported through the
 * optional `onError`, so a disk fault never gates the guard that writes.
 */
import fs from 'node:fs';
import path from 'node:path';

export const GUARD_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

export function appendGuardEvidence(
  filePath: string,
  row: object,
  opts: { maxBytes?: number; onError?: (err: unknown) => void } = {},
): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const maxBytes = opts.maxBytes ?? GUARD_EVIDENCE_MAX_BYTES;
    try {
      if (fs.statSync(filePath).size >= maxBytes) fs.renameSync(filePath, `${filePath}.1`);
    } catch { /* @silent-fallback-ok — no file yet (first write) or a rotation race; the append below still lands */ }
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n', { mode: 0o600 });
    return true;
  } catch (err) {
    try { opts.onError?.(err); } catch { /* @silent-fallback-ok — the error sink is itself best-effort */ }
    return false;
  }
}
