/**
 * JudgmentProvenanceLog — durable decision-content log for judgment calls
 * (ownership-gated-spawn-and-judgment-within-floors spec §3.5; the runtime arm
 * of the Decision Provenance & Outcome Review standard).
 *
 * One row per judgment call: the full context AS HANDED to the decider
 * (enveloped form — full FIDELITY to the model's input, never more than the
 * model saw), the options presented, the decision + stated reason, the floor
 * bounds in force, model/door, tokens, latency, fallback rung. Outcome rows
 * are appended when ground truth arrives (owner-return timestamps, reconciler
 * results, resend signals) referencing the decision row's id.
 *
 * Increment 1 writes DETERMINISTIC-verdict rows from the SpawnAdmission seam;
 * arbiter rows (J1/J2) arrive with Increment 3 and are ALWAYS written
 * regardless of the sampling knob.
 *
 * Storage contract (§3.5 — the parts that are INVARIANTS, not config):
 *  - rows live under `state/judgment-provenance/` — dir 0700, files 0600,
 *    gitignored, backup-excluded, never served raw over HTTP
 *    (NEVER_SERVED_PREFIXES in the file-routes validator);
 *  - the HTTP surface (`GET /judgment-provenance`) serves REDACTED rows only —
 *    the redacted form is precomputed at WRITE time through the project's
 *    credential-shape scrubber; redaction is an invariant, never config;
 *  - async buffered appends only (never a sync write on a hot path);
 *  - per-row byte clamp 64KB (oversized context is truncated, flagged, never
 *    dropped silently).
 * Config: retention (default 14 days) and deterministic sampling (default 1.0
 * during Increment-1 soak; 0.1 from Increment 2).
 *
 * Redaction honesty (§3.5): the scrubbers are credential-shape scrubbers, NOT
 * PII scrubbing — which is exactly why the full rows are machine-local,
 * deny-listed, and short-retention.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { scrub, scrubString } from './CredentialAuditEmit.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { isHighStakesDecisionPoint } from './provenanceRequired.js';
import { envelopeRedactedRowForHttp } from './provenanceEnvelope.js';

/** Per-row byte clamp (§3.5 write discipline) — a code constant, not config. */
export const PROVENANCE_ROW_BYTE_CLAMP = 64 * 1024;

/** How large the precomputed redacted context view may grow (chars). */
const REDACTED_CONTEXT_CLAMP = 2_000;

/** Flush the append buffer at this many rows or this many ms, whichever first. */
const FLUSH_MAX_ROWS = 50;
const FLUSH_INTERVAL_MS = 1_000;

/**
 * §5 two-ring buffer caps. Under a pathological sustained disk stall the append
 * buffer trades memory for never-slowing-the-decision, bounded here. Background
 * rows drop FIRST and independently; a high-stakes row is never dropped to make
 * room for a background row (priority isolation).
 */
const HIGH_STAKES_RING_CAP = 5_000;
const BACKGROUND_RING_CAP = 20_000;

export interface DecisionRowInput {
  component: string;
  decisionPoint: string;
  /** Full-fidelity context as handed to the decider (enveloped form). */
  context: Record<string, unknown>;
  optionsPresented: string[];
  decision: string;
  reason: string;
  /** The floor bounds in force, human-readable. */
  floor: string;
  /** 'deterministic' for floor-default verdicts; arbiter rungs from Increment 3. */
  fallbackRung: string;
  /** Arbiter rows are ALWAYS written regardless of sampling. */
  arbiter?: boolean;
  model?: string;
  door?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
}

export interface ProvenanceRow {
  id: string;
  ts: string;
  kind: 'decision' | 'outcome';
  component: string;
  decisionPoint?: string;
  /** Machine-local full context — NEVER leaves this machine. */
  contextFull?: unknown;
  /** Scrubbed + clamped context view — the ONLY form the HTTP surface serves. */
  contextRedacted?: string;
  truncated?: boolean;
  optionsPresented?: string[];
  decision?: string;
  reason?: string;
  floor?: string;
  fallbackRung?: string;
  arbiter?: boolean;
  model?: string;
  door?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  /** Outcome rows reference their decision row. */
  decisionId?: string;
  outcome?: unknown;
  /**
   * §5 buffer-ring routing marker: true when this row is a high-stakes decision
   * point (sampling-exempt by identity, priority-isolated in the append buffer).
   * Internal to buffering; it is a legitimate served field (the read surface
   * carries it so a consumer can tell a gate/kill row from a background one).
   */
  highStakes?: boolean;
}

/** The HTTP-served view: everything EXCEPT the machine-local full context. */
export type RedactedProvenanceRow = Omit<ProvenanceRow, 'contextFull'>;

export interface JudgmentProvenanceLogOptions {
  /** Absolute directory, canonically `<agent>/state/judgment-provenance`. */
  dir: string;
  /** Retention in days (config `provenance.retentionDays`, default 14). */
  retentionDays?: number;
  /**
   * Deterministic sampling in [0,1] (config `provenance.deterministicSampling`,
   * default 1.0). Applies to NON-arbiter rows only; deterministic — a hash of
   * the row identity, never RNG — so a given row samples identically on replay.
   */
  sampling?: number;
  log?: (msg: string) => void;
  now?: () => number;
  /**
   * §5 — invoked ONCE per high-stakes buffer-drop episode (deduped by the
   * caller-owned notice surface, e.g. a deduped Attention item). A dropped
   * high-stakes row (a lost process-kill audit) crosses the housekeeping→signal
   * line; a background drop stays a counter only. Optional: absent ⇒ counters
   * only (the substrate never itself pages). Called from the write path and
   * MUST be total (its own failure is swallowed here).
   */
  onHighStakesBufferDrop?: (info: { dropped: number; decisionPoint?: string }) => void;
}

/**
 * Extract the monotonic seq from a row id `jp-<now36>-<seq36>` for stable
 * chronological ordering when draining the two-ring buffer (§5). A malformed id
 * sorts to 0 (front) — harmless, ordering is best-effort observability.
 */
function seqOf(id: string): number {
  const last = id.slice(id.lastIndexOf('-') + 1);
  const n = parseInt(last, 36);
  return Number.isFinite(n) ? n : 0;
}

/** FNV-1a 32-bit — cheap deterministic hash for the sampling decision. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class JudgmentProvenanceLog {
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly sampling: number;
  private readonly log: (msg: string) => void;
  private readonly nowFn: () => number;
  private readonly onHighStakesBufferDrop?: (info: { dropped: number; decisionPoint?: string }) => void;
  /**
   * §5 two-ring append buffer. High-stakes and background rows buffer
   * INDEPENDENTLY: a background overflow drops background rows only, and a
   * high-stakes row is never dropped to make room for a background row.
   */
  private highStakesBuffer: ProvenanceRow[] = [];
  private backgroundBuffer: ProvenanceRow[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  /** §5 — true while a disk write is in flight (backpressure stays in the ring). */
  private isFlushing = false;
  /** §5 — a flush was requested while a write was in flight; drain on settle. */
  private reflushQueued = false;
  private seq = 0;
  private lastRetentionSweepDay: string | null = null;
  /** §3.3 idempotency — decision ids that already carry a terminal outcome. */
  private annotatedDecisionIds = new Set<string>();
  private counters = {
    decisionsWritten: 0,
    decisionsSampledOut: 0,
    outcomesWritten: 0,
    outcomesRejectedDuplicate: 0,
    writeErrors: 0,
    highStakesBufferDropped: 0,
    backgroundBufferDropped: 0,
  };

  constructor(opts: JudgmentProvenanceLogOptions) {
    this.dir = opts.dir;
    this.retentionDays = opts.retentionDays && opts.retentionDays > 0 ? opts.retentionDays : 14;
    this.sampling = typeof opts.sampling === 'number' && opts.sampling >= 0 && opts.sampling <= 1 ? opts.sampling : 1.0;
    this.log = opts.log ?? (() => {});
    this.nowFn = opts.now ?? (() => Date.now());
    this.onHighStakesBufferDrop = opts.onHighStakesBufferDrop;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // mkdirSync's mode is ignored when the dir pre-exists — assert it anyway.
      fs.chmodSync(this.dir, 0o700);
    } catch (err) {
      // @silent-fallback-ok: logged; provenance is observability — its dir init
      // failing must never break the decision path it audits (writes will
      // surface as writeErrors in status()).
      this.log(`[JudgmentProvenanceLog] dir init failed (observability only, non-fatal): ${(err as Error).message}`);
    }
  }

  /**
   * One row per judgment call. Returns the row id (null = sampled out / failed).
   *
   * TOTAL by contract (§3.4): this method NEVER throws into the decision path.
   * A caller may invoke it inline in a gating verdict; a provenance failure
   * (unserializable context, a throwing getter, a full buffer) surfaces as a
   * `writeErrors`/`bufferDropped` counter, never a propagated exception.
   */
  recordDecision(input: DecisionRowInput): string | null {
    try {
      const now = this.nowFn();
      const id = `jp-${now.toString(36)}-${(this.seq++).toString(36)}`;
      // §3.2a — sampling-EXEMPTION is a DECISION-POINT PROPERTY (looked up from
      // the PROVENANCE_REQUIRED allowlist by identity), NOT a caller argument. A
      // high-stakes gate/kill verdict is logged at effective sampling 0.0. The
      // legacy `arbiter` flag stays honored for the SpawnAdmission/J1/J2 rows.
      const highStakes = isHighStakesDecisionPoint(input.decisionPoint);
      const exemptFromSampling = highStakes || !!input.arbiter;
      // Deterministic sampling (non-exempt rows only): hash the row identity.
      if (!exemptFromSampling && this.sampling < 1) {
        const bucket = (fnv1a(id) % 10_000) / 10_000;
        if (bucket >= this.sampling) {
          this.counters.decisionsSampledOut++;
          return null;
        }
      }
      let contextRedacted: string;
      try {
        contextRedacted = JSON.stringify(scrub(input.context)).slice(0, REDACTED_CONTEXT_CLAMP);
      } catch {
        // @silent-fallback-ok: a circular ref / throwing getter in context must
        // never break the audited decision path (§3.4) — record a marker.
        contextRedacted = '[unserializable-context]';
      }
      let contextFull: unknown = input.context;
      // §3.4 — clampRow JSON.stringify's the whole row; a circular/throwing
      // context would throw there. Pre-empt it: if the raw context can't
      // serialize, store a defensive skeleton in contextFull too (the redacted
      // marker above already covers the served field).
      try {
        JSON.stringify(input.context);
      } catch {
        contextFull = { unserializable: true };
      }
      let row: ProvenanceRow = {
        id,
        ts: new Date(now).toISOString(),
        kind: 'decision',
        component: input.component,
        decisionPoint: input.decisionPoint,
        contextFull,
        contextRedacted,
        optionsPresented: input.optionsPresented,
        decision: input.decision,
        reason: scrubString(input.reason),
        floor: input.floor,
        fallbackRung: input.fallbackRung,
        arbiter: input.arbiter ?? false,
        highStakes,
        model: input.model,
        door: input.door,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        latencyMs: input.latencyMs,
      };
      row = this.clampRow(row);
      this.enqueue(row);
      this.counters.decisionsWritten++;
      return id;
    } catch (err) {
      // §3.4 fail-open TOTALITY — the ultimate backstop: no provenance failure
      // may throw into the decision path. Record the error and return null.
      this.counters.writeErrors++;
      this.log(`[JudgmentProvenanceLog] recordDecision failed (observability only, non-fatal): ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Ground-truth annotation referencing a decision row (§3.3 / §3.5 outcome
   * annotation). IDEMPOTENT: exactly ONE terminal outcome per `decisionId`; a
   * second annotate for the same id is REJECTED (returns false) so a retry /
   * re-fire never smears a decision row with a second, possibly-contradictory
   * outcome. Returns true when the outcome was appended.
   *
   * TOTAL by contract (§3.4): never throws into the caller's path — a failure
   * surfaces as `writeErrors`.
   */
  annotateOutcome(decisionId: string, component: string, outcome: Record<string, unknown>): boolean {
    try {
      // §3.3 idempotency — first writer wins; a second annotate is rejected.
      if (this.annotatedDecisionIds.has(decisionId)) {
        this.counters.outcomesRejectedDuplicate++;
        return false;
      }
      this.annotatedDecisionIds.add(decisionId);
      const now = this.nowFn();
      let row: ProvenanceRow = {
        id: `jp-${now.toString(36)}-${(this.seq++).toString(36)}`,
        ts: new Date(now).toISOString(),
        kind: 'outcome',
        component,
        decisionId,
        outcome: scrub(outcome),
      };
      row = this.clampRow(row);
      this.enqueue(row);
      this.counters.outcomesWritten++;
      return true;
    } catch (err) {
      this.counters.writeErrors++;
      this.log(`[JudgmentProvenanceLog] annotateOutcome failed (observability only, non-fatal): ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 64KB per-row byte clamp — truncate the full context, flag it, never drop.
   *
   * §3.4 FAIL-OPEN TOTALITY: every `JSON.stringify` here is wrapped so a
   * circular ref / throwing getter that survived into the row can NEVER throw
   * synchronously into the decision path. On any serialization failure the row
   * degrades to a defensive skeleton (the served fields are already scrubbed
   * strings; the only throwing source is `contextFull`/`outcome`, which the
   * skeleton drops). The absolute backstop is `recordDecision`/`annotateOutcome`'s
   * own try/catch, but making clampRow total removes the one uncaught path.
   */
  private clampRow(row: ProvenanceRow): ProvenanceRow {
    const skeleton = (): ProvenanceRow => ({
      id: row.id,
      ts: row.ts,
      kind: row.kind,
      component: row.component,
      decisionPoint: row.decisionPoint,
      contextRedacted: (row.contextRedacted ?? '').slice(0, 512),
      decision: row.decision,
      fallbackRung: row.fallbackRung,
      highStakes: row.highStakes,
      decisionId: row.decisionId,
      truncated: true,
    });
    let json: string;
    try {
      json = JSON.stringify(row);
    } catch {
      // A throwing getter / circular ref in contextFull|outcome — the served
      // fields are safe scrubbed strings; fall to the skeleton (drops the
      // machine-local full context, keeps the audit).
      return skeleton();
    }
    if (Buffer.byteLength(json, 'utf8') <= PROVENANCE_ROW_BYTE_CLAMP) return row;
    let clamped: ProvenanceRow;
    try {
      clamped = {
        ...row,
        contextFull: { truncated: true, head: JSON.stringify(row.contextFull ?? row.outcome ?? '').slice(0, 8_192) },
        outcome: row.kind === 'outcome' ? { truncated: true } : undefined,
        truncated: true,
      };
      json = JSON.stringify(clamped);
    } catch {
      return skeleton();
    }
    if (Buffer.byteLength(json, 'utf8') <= PROVENANCE_ROW_BYTE_CLAMP) return clamped;
    // Degenerate oversize (a single huge string field) — keep the skeleton.
    return skeleton();
  }

  /**
   * Async buffered appends only (§3.5 write discipline), into the §5 TWO-RING
   * buffer. A high-stakes row rides the high-stakes ring (cap 5,000); everything
   * else rides the background ring (cap 20,000). Each ring is drop-oldest and
   * INDEPENDENT: a background overflow drops a background row (counter only), a
   * high-stakes overflow drops a high-stakes row (deduped operator notice). A
   * high-stakes row is NEVER dropped to make room for a background row.
   */
  private enqueue(row: ProvenanceRow): void {
    if (row.highStakes === true) {
      this.highStakesBuffer.push(row);
      if (this.highStakesBuffer.length > HIGH_STAKES_RING_CAP) {
        // Drop oldest high-stakes rows to the cap.
        const overflow = this.highStakesBuffer.length - HIGH_STAKES_RING_CAP;
        this.highStakesBuffer.splice(0, overflow);
        this.counters.highStakesBufferDropped += overflow;
        // §5 — a lost process-kill/gate audit crosses housekeeping→signal: ONE
        // deduped operator notice (the ONLY provenance condition that pages).
        try {
          this.onHighStakesBufferDrop?.({ dropped: overflow, decisionPoint: row.decisionPoint });
        } catch {
          /* @silent-fallback-ok: the notice surface is best-effort — its failure must never break the audited path. */
        }
      }
    } else {
      this.backgroundBuffer.push(row);
      if (this.backgroundBuffer.length > BACKGROUND_RING_CAP) {
        const overflow = this.backgroundBuffer.length - BACKGROUND_RING_CAP;
        this.backgroundBuffer.splice(0, overflow);
        this.counters.backgroundBufferDropped += overflow;
      }
    }
    const total = this.highStakesBuffer.length + this.backgroundBuffer.length;
    if (total >= FLUSH_MAX_ROWS) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    }
  }

  /**
   * Serialized flush — appends ride one promise chain so rows never interleave.
   *
   * §5 — a flush does NOT drain the rings while a PRIOR flush is still in
   * flight: under a sustained disk stall the backpressure stays in the two-ring
   * buffer (where enqueue's drop-oldest + per-ring cap apply), rather than
   * ballooning an unbounded promise chain. When the in-flight write settles it
   * re-arms a follow-up flush, so buffered rows are drained as soon as the disk
   * recovers. This is what makes the §5 ring cap a REAL bound (not decorative).
   */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.isFlushing) {
      // A write is already in flight — leave rows in the ring (bounded) and let
      // the settling write re-arm a follow-up flush.
      this.reflushQueued = true;
      return this.flushing;
    }
    // §5 — drain BOTH rings this pass, written in global insertion order (the
    // `-<seq36>` id suffix is a monotonic per-log counter, so sorting by it
    // restores the chronological order the two-ring split scrambled).
    const rows = [...this.highStakesBuffer, ...this.backgroundBuffer];
    if (rows.length === 0) return this.flushing;
    this.highStakesBuffer = [];
    this.backgroundBuffer = [];
    rows.sort((a, b) => seqOf(a.id) - seqOf(b.id));
    this.isFlushing = true;
    this.flushing = this.flushing.then(async () => {
      try {
        const file = this.fileForDay(new Date(this.nowFn()));
        const payload = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
        await fsp.appendFile(file, payload, { mode: 0o600 });
        await this.retentionSweep();
      } catch (err) {
        this.counters.writeErrors++;
        this.log(`[JudgmentProvenanceLog] append failed (observability only, rows dropped): ${(err as Error).message}`);
      } finally {
        this.isFlushing = false;
        // If rows accumulated (or a flush was requested) while this write was in
        // flight, drain them now that the disk has settled.
        if (this.reflushQueued || this.highStakesBuffer.length > 0 || this.backgroundBuffer.length > 0) {
          this.reflushQueued = false;
          void this.flush();
        }
      }
    });
    return this.flushing;
  }

  private fileForDay(d: Date): string {
    const day = d.toISOString().slice(0, 10);
    return path.join(this.dir, `${day}.jsonl`);
  }

  /** Delete day-files older than retention — once per day, via SafeFsExecutor. */
  private async retentionSweep(): Promise<void> {
    const today = new Date(this.nowFn()).toISOString().slice(0, 10);
    if (this.lastRetentionSweepDay === today) return;
    this.lastRetentionSweepDay = today;
    try {
      const cutoff = this.nowFn() - this.retentionDays * 86_400_000;
      const files = await fsp.readdir(this.dir);
      for (const f of files) {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!m) continue;
        const fileDayMs = Date.parse(`${m[1]}T00:00:00.000Z`);
        if (Number.isFinite(fileDayMs) && fileDayMs < cutoff) {
          await SafeFsExecutor.safeUnlink(path.join(this.dir, f), {
            operation: `judgment-provenance retention (${this.retentionDays}d)`,
          });
        }
      }
    } catch (err) {
      this.log(`[JudgmentProvenanceLog] retention sweep failed (non-fatal): ${(err as Error).message}`);
    }
  }

  /**
   * The ONLY read surface (`GET /judgment-provenance`): REDACTED rows, newest
   * first. The full context never crosses this method — redaction happens by
   * OMISSION of the machine-local field plus the write-time scrub of everything
   * else (redact-on-serving-machine, §3.5).
   *
   * §3.1a UNTRUSTED-DATA ENVELOPE (surface (a)): every free-text field is
   * HTML-escaped before it leaves this method, so a browser/dashboard renders a
   * `<script>` / `</untrusted>`-style breakout payload as INERT text. The stored
   * bytes are unchanged (machine-local `contextFull` is verbatim); only the
   * SERVED form is enveloped.
   */
  async readRedacted(opts?: { limit?: number; sinceMs?: number }): Promise<RedactedProvenanceRow[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1_000);
    const sinceMs = opts?.sinceMs;
    await this.flush();
    const out: RedactedProvenanceRow[] = [];
    let files: string[];
    try {
      files = (await fsp.readdir(this.dir))
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .reverse();
    } catch {
      // @silent-fallback-ok: no readable provenance dir → the honest empty
      // read (a fresh install has no rows); status() carries writeErrors.
      return [];
    }
    for (const f of files) {
      if (out.length >= limit) break;
      let content: string;
      try {
        content = await fsp.readFile(path.join(this.dir, f), 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split('\n').filter((l) => l.trim().length > 0).reverse();
      for (const line of lines) {
        if (out.length >= limit) break;
        try {
          const row = JSON.parse(line) as ProvenanceRow;
          if (sinceMs && Date.parse(row.ts) < sinceMs) continue;
          const { contextFull: _full, ...redacted } = row;
          // §3.1a — HTML-escape free-text fields so the HTTP consumer renders
          // attacker-influenceable content inertly (contextFull already dropped).
          out.push(envelopeRedactedRowForHttp(redacted) as RedactedProvenanceRow);
        } catch {
          /* @silent-fallback-ok: a torn/corrupt row is skipped — the read surface is observability. */
        }
      }
    }
    return out;
  }

  status(): {
    dir: string;
    retentionDays: number;
    sampling: number;
    buffered: number;
    /** §5 — per-ring buffer depth + drop counters (priority isolation is visible here). */
    rings: {
      highStakes: { buffered: number; cap: number; bufferDropped: number };
      background: { buffered: number; cap: number; bufferDropped: number };
    };
    counters: Record<string, number>;
  } {
    return {
      dir: this.dir,
      retentionDays: this.retentionDays,
      sampling: this.sampling,
      buffered: this.highStakesBuffer.length + this.backgroundBuffer.length,
      rings: {
        highStakes: {
          buffered: this.highStakesBuffer.length,
          cap: HIGH_STAKES_RING_CAP,
          bufferDropped: this.counters.highStakesBufferDropped,
        },
        background: {
          buffered: this.backgroundBuffer.length,
          cap: BACKGROUND_RING_CAP,
          bufferDropped: this.counters.backgroundBufferDropped,
        },
      },
      counters: { ...this.counters },
    };
  }

  /** Flush pending rows (shutdown path). */
  async close(): Promise<void> {
    await this.flush();
  }
}
