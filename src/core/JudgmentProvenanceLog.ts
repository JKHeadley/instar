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

/** Per-row byte clamp (§3.5 write discipline) — a code constant, not config. */
export const PROVENANCE_ROW_BYTE_CLAMP = 64 * 1024;

/** How large the precomputed redacted context view may grow (chars). */
const REDACTED_CONTEXT_CLAMP = 2_000;

/** Flush the append buffer at this many rows or this many ms, whichever first. */
const FLUSH_MAX_ROWS = 50;
const FLUSH_INTERVAL_MS = 1_000;

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
  private buffer: ProvenanceRow[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private seq = 0;
  private lastRetentionSweepDay: string | null = null;
  private counters = { decisionsWritten: 0, decisionsSampledOut: 0, outcomesWritten: 0, writeErrors: 0 };

  constructor(opts: JudgmentProvenanceLogOptions) {
    this.dir = opts.dir;
    this.retentionDays = opts.retentionDays && opts.retentionDays > 0 ? opts.retentionDays : 14;
    this.sampling = typeof opts.sampling === 'number' && opts.sampling >= 0 && opts.sampling <= 1 ? opts.sampling : 1.0;
    this.log = opts.log ?? (() => {});
    this.nowFn = opts.now ?? (() => Date.now());
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

  /** One row per judgment call. Returns the row id (null = sampled out / failed). */
  recordDecision(input: DecisionRowInput): string | null {
    const now = this.nowFn();
    const id = `jp-${now.toString(36)}-${(this.seq++).toString(36)}`;
    // Deterministic sampling (non-arbiter rows only): hash the row identity.
    if (!input.arbiter && this.sampling < 1) {
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
      contextRedacted = '[unserializable-context]';
    }
    let row: ProvenanceRow = {
      id,
      ts: new Date(now).toISOString(),
      kind: 'decision',
      component: input.component,
      decisionPoint: input.decisionPoint,
      contextFull: input.context,
      contextRedacted,
      optionsPresented: input.optionsPresented,
      decision: input.decision,
      reason: scrubString(input.reason),
      floor: input.floor,
      fallbackRung: input.fallbackRung,
      arbiter: input.arbiter ?? false,
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
  }

  /** Ground-truth annotation referencing a decision row (§3.5 outcome annotation). */
  annotateOutcome(decisionId: string, component: string, outcome: Record<string, unknown>): void {
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
  }

  /** 64KB per-row byte clamp — truncate the full context, flag it, never drop. */
  private clampRow(row: ProvenanceRow): ProvenanceRow {
    let json = JSON.stringify(row);
    if (Buffer.byteLength(json, 'utf8') <= PROVENANCE_ROW_BYTE_CLAMP) return row;
    const clamped: ProvenanceRow = {
      ...row,
      contextFull: { truncated: true, head: JSON.stringify(row.contextFull ?? row.outcome ?? '').slice(0, 8_192) },
      outcome: row.kind === 'outcome' ? { truncated: true } : undefined,
      truncated: true,
    };
    json = JSON.stringify(clamped);
    if (Buffer.byteLength(json, 'utf8') <= PROVENANCE_ROW_BYTE_CLAMP) return clamped;
    // Degenerate oversize (a single huge string field) — keep the skeleton.
    return {
      id: row.id,
      ts: row.ts,
      kind: row.kind,
      component: row.component,
      decisionPoint: row.decisionPoint,
      contextRedacted: (row.contextRedacted ?? '').slice(0, 512),
      decision: row.decision,
      fallbackRung: row.fallbackRung,
      truncated: true,
    };
  }

  /** Async buffered appends only (§3.5 write discipline). */
  private enqueue(row: ProvenanceRow): void {
    this.buffer.push(row);
    if (this.buffer.length >= FLUSH_MAX_ROWS) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    }
  }

  /** Serialized flush — appends ride one promise chain so rows never interleave. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const rows = this.buffer;
    if (rows.length === 0) return this.flushing;
    this.buffer = [];
    this.flushing = this.flushing.then(async () => {
      try {
        const file = this.fileForDay(new Date(this.nowFn()));
        const payload = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
        await fsp.appendFile(file, payload, { mode: 0o600 });
        await this.retentionSweep();
      } catch (err) {
        this.counters.writeErrors++;
        this.log(`[JudgmentProvenanceLog] append failed (observability only, rows dropped): ${(err as Error).message}`);
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
          out.push(redacted);
        } catch {
          /* @silent-fallback-ok: a torn/corrupt row is skipped — the read surface is observability. */
        }
      }
    }
    return out;
  }

  status(): { dir: string; retentionDays: number; sampling: number; buffered: number; counters: Record<string, number> } {
    return {
      dir: this.dir,
      retentionDays: this.retentionDays,
      sampling: this.sampling,
      buffered: this.buffer.length,
      counters: { ...this.counters },
    };
  }

  /** Flush pending rows (shutdown path). */
  async close(): Promise<void> {
    await this.flush();
  }
}
