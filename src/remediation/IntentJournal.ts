/**
 * IntentJournal — Append-only declaration log for remediation intents.
 *
 * Part of Foundation F-4 for the Self-Healing Remediator v2
 * (SELF-HEALING-REMEDIATOR-V2-SPEC). The journal is the durable record of
 * "this attempt declared intent X at time T" — read by the audit projection
 * and by reconciliation paths that need to compare in-flight locks against
 * declared intent.
 *
 * Path: `<stateDir>/remediation/intent-journal-<machineId>.jsonl`
 *
 * Append semantics:
 *   - One JSON object per line.
 *   - `fsync` on every write (we accept the latency cost; this file is the
 *     durable witness of intent).
 *   - Atomic-append via `O_APPEND` opens — Node's `fs.appendFileSync`
 *     guarantees a single write() call for short payloads on POSIX, so
 *     concurrent declares cannot interleave bytes within an entry.
 *
 * Monotonic ordering: every entry records both wall-clock (`declaredAt`) and
 * `process.hrtime.bigint()` (`monotonicTs`). The monotonic stamp is the
 * authoritative within-process ordering key.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type IntentBlastRadius = 'process' | 'machine' | 'fleet';
export type IntentKind = 'dispatch' | 'verify' | 'rollback' | 'quarantine';

export interface IntentEntry {
  intentId: string;
  attemptId: string;
  runbookId: string;
  signatureHash: string;
  blastRadius: IntentBlastRadius;
  intent: IntentKind;
  declaredAt: number;
  /** process.hrtime.bigint() at declare time. Serialized as decimal string. */
  monotonicTs: bigint;
}

export interface IntentJournalOptions {
  /** Machine id — disambiguates journals on a multi-agent host. */
  machineId: string;
}

export class IntentJournal {
  private readonly journalPath: string;

  /**
   * @param stateDir Root state dir (e.g., process state). The journal lives
   *                 under <stateDir>/remediation/.
   */
  constructor(stateDir: string, options: IntentJournalOptions) {
    const dir = path.join(stateDir, 'remediation');
    fs.mkdirSync(dir, { recursive: true });
    this.journalPath = path.join(dir, `intent-journal-${options.machineId}.jsonl`);
  }

  /**
   * Append a new intent. Returns the persisted entry (with `intentId`,
   * `declaredAt`, and `monotonicTs` filled in).
   *
   * Errors propagate — the caller decides whether to retry. We intentionally
   * do NOT swallow fsync failures: if the durable witness wasn't fsynced,
   * later reconciliation can't trust the file.
   */
  async declareIntent(
    entry: Omit<IntentEntry, 'intentId' | 'declaredAt' | 'monotonicTs'>
  ): Promise<IntentEntry> {
    const full: IntentEntry = {
      ...entry,
      intentId: crypto.randomUUID(),
      declaredAt: Date.now(),
      monotonicTs: process.hrtime.bigint(),
    };
    const line = serializeEntry(full) + '\n';
    // fs.appendFileSync with O_APPEND is atomic for sub-PIPE_BUF writes.
    // We open a fresh fd each call to ensure fsync targets the actual entry.
    const fd = fs.openSync(this.journalPath, 'a', 0o600);
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return full;
  }

  /**
   * Read entries whose `declaredAt > cursor` (cursor is a wall-clock ms epoch
   * boundary). Returns entries in file order, which by construction matches
   * declare-time order on a single host.
   */
  async readSince(cursor: number): Promise<IntentEntry[]> {
    if (!fs.existsSync(this.journalPath)) return [];
    const raw = fs.readFileSync(this.journalPath, 'utf8');
    const out: IntentEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let parsed: IntentEntry | undefined;
      try {
        parsed = deserializeEntry(line);
      } catch {
        // Corrupt line — skip (the GC sweeper will eventually compact).
        continue;
      }
      if (parsed.declaredAt > cursor) out.push(parsed);
    }
    return out;
  }
}

function serializeEntry(e: IntentEntry): string {
  return JSON.stringify({
    intentId: e.intentId,
    attemptId: e.attemptId,
    runbookId: e.runbookId,
    signatureHash: e.signatureHash,
    blastRadius: e.blastRadius,
    intent: e.intent,
    declaredAt: e.declaredAt,
    monotonicTs: e.monotonicTs.toString(),
  });
}

function deserializeEntry(line: string): IntentEntry {
  const obj = JSON.parse(line);
  return {
    intentId: String(obj.intentId),
    attemptId: String(obj.attemptId),
    runbookId: String(obj.runbookId),
    signatureHash: String(obj.signatureHash),
    blastRadius: obj.blastRadius as IntentBlastRadius,
    intent: obj.intent as IntentKind,
    declaredAt: Number(obj.declaredAt),
    monotonicTs: BigInt(obj.monotonicTs),
  };
}
