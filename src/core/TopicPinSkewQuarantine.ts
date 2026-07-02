/**
 * TopicPinSkewQuarantine — the STICKY, DURABLE exclusion set for future-skewed
 * replicated pin records (U4.1 §2C, R-r3-2 / R-r4-1;
 * docs/specs/u4-1-pin-persistence.md).
 *
 * WHY STICKY: the HLC skew gate (`HybridLogicalClock.receive()`) rejects on
 * `remote.physical − max(last.physical, poolReference) > maxDriftMs` — a
 * reference that MOVES with wall time. A +Δ-skewed poison record would
 * silently un-quarantine after ~Δ of real time, then WIN `compareHlc` over
 * every honest tombstone and re-pin the operator minted during the quarantine
 * window (retroactive resurrection). A point-in-time exclusion cannot hold
 * across a time advance — so the FIRST rejection persists `(recordKey, hlc)`
 * here, and every future fold excludes any record matching that exact pair
 * REGARDLESS of clock progress.
 *
 * CLEARING (R-r4-1 — dismissal is not re-admission):
 *  - Self-clearing ONLY by honest supersession: a NEWER honest record (higher
 *    HLC that passed the gate) makes the quarantined entry dead by ordering
 *    anyway → `pruneSuperseded` drops it.
 *  - Operator ack of the attention NOTIFICATION clears nothing here.
 *  - `readmit(key, hlc)` is the deliberate, explicit per-record re-admission —
 *    an authority decision distinct from dismissing an alert.
 *
 * Bound: tiny by construction — one entry per poisoned record, and poisoned
 * records are rare (a misclocked peer's pin events). Entries prune on
 * supersession/re-admit. Registered in the state-coherence registry as
 * `topic-pin-skew-quarantine` (machine-local; each fold quarantines what ITS
 * gate rejected).
 *
 * Durability posture mirrors the sibling TopicPlacementPinStore: atomic JSON
 * (temp + rename). A CORRUPT file is quarantined ASIDE (renamed, preserved)
 * and reported via `onCorrupt` — never silently wiped; the set restarts empty
 * and still-skewed records re-quarantine on the next fold (the honest
 * degraded direction; the preserved aside file keeps the evidence).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import { compareHlc } from './TopicPinReplicatedStore.js';

export interface QuarantinedPinRecord {
  /** The replicated record's key (the topic id as a string). */
  key: string;
  /** The exact offending HLC — the (key, hlc) pair IS the exclusion identity. */
  hlc: HlcTimestamp;
  /** The machine that asserted the poisoned record (diagnosability, P17 dedup key). */
  origin: string;
  quarantinedAt: string;
}

export interface TopicPinSkewQuarantineDeps {
  filePath: string;
  now?: () => Date;
  /** Loud corrupt-file report (quarantined-aside path + error). Optional — absence never gates. */
  onCorrupt?: (asidePath: string, error: string) => void;
}

function sameHlc(a: HlcTimestamp, b: HlcTimestamp): boolean {
  return a.physical === b.physical && a.logical === b.logical && a.node === b.node;
}

export class TopicPinSkewQuarantine {
  private readonly d: TopicPinSkewQuarantineDeps;
  private entries: QuarantinedPinRecord[] = [];
  private loaded = false;

  constructor(deps: TopicPinSkewQuarantineDeps) {
    this.d = deps;
  }

  private load(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(this.d.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf-8'));
        if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
          this.entries = (raw.entries as unknown[]).filter((e): e is QuarantinedPinRecord => {
            const r = e as QuarantinedPinRecord;
            return !!r && typeof r.key === 'string' && !!r.hlc
              && typeof r.hlc.physical === 'number' && typeof r.hlc.logical === 'number'
              && typeof r.hlc.node === 'string' && typeof r.origin === 'string';
          });
        }
      }
    } catch (err) {
      // Corrupt quarantine set: preserve ASIDE + report loudly, never wipe in place.
      const aside = `${this.d.filePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.d.filePath, aside); } catch { /* rename best-effort; the report below still fires */ }
      try { this.d.onCorrupt?.(aside, err instanceof Error ? err.message : String(err)); } catch { /* report is observability — never gates */ }
      this.entries = [];
    }
    this.loaded = true;
  }

  private persist(): void {
    const dir = path.dirname(this.d.filePath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* @silent-fallback-ok — dir already exists (recursive mkdir); the writeFileSync below throws loudly on a genuinely unwritable dir */ }
    const tmp = `${this.d.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2));
    fs.renameSync(tmp, this.d.filePath); // atomic swap
  }

  /** Is this exact (key, hlc) pair quarantined? Sticky — immune to clock progress. */
  has(key: string, hlc: HlcTimestamp): boolean {
    this.load();
    return this.entries.some((e) => e.key === key && sameHlc(e.hlc, hlc));
  }

  /** Quarantine a record. Returns true when NEWLY added (drives the one-per-episode item). */
  add(rec: { key: string; hlc: HlcTimestamp; origin: string }): boolean {
    this.load();
    if (this.has(rec.key, rec.hlc)) return false;
    const now = (this.d.now ?? (() => new Date()))().toISOString();
    this.entries.push({ key: rec.key, hlc: { ...rec.hlc }, origin: rec.origin, quarantinedAt: now });
    this.persist();
    return true;
  }

  /**
   * Honest supersession (R-r3-2): a NEWER honest record for `key` (higher HLC
   * that passed the gate) makes any quarantined entry with a LOWER hlc dead by
   * ordering — prune those. An entry whose hlc is still HIGHER than the honest
   * winner stays excluded (it would still poison the comparison).
   */
  pruneSuperseded(key: string, honestWinner: HlcTimestamp): number {
    this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.key === key && compareHlc(honestWinner, e.hlc) > 0));
    const pruned = before - this.entries.length;
    if (pruned > 0) this.persist();
    return pruned;
  }

  /** The deliberate, explicit per-record re-admission (R-r4-1) — NOT the ack path. */
  readmit(key: string, hlc: HlcTimestamp): boolean {
    this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.key === key && sameHlc(e.hlc, hlc)));
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }

  /** All quarantined records (diagnostics / the attention item body / read surfaces). */
  all(): QuarantinedPinRecord[] {
    this.load();
    return this.entries.map((e) => ({ ...e, hlc: { ...e.hlc } }));
  }
}
