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

/* ── Serve-discipline (llm-decision-quality-meter §5.2) ─────────────────────
 * The HTTP-served label fields (`decision`, `optionsPresented` entries,
 * `promptId`) on SEAM rows (rows carrying a `correlationId`) must be static,
 * code-authored, enum-like labels. Runtime data interpolated into a
 * caller-authored label cannot reopen the raw-content channel through the
 * served fields — a violating value is REPLACED with the fixed marker and
 * counted, never stored. Legacy rows (no correlationId — the deterministic
 * SpawnAdmission/DuplicateSessionReconciler callsites) are byte-identical
 * to their pre-seam behavior: the clamps do not apply to them.
 * These invariants are code, never config (types.ts provenance doc pin). */

/** The charset/length clamp for caller-authored served labels (§5.2). */
export const SERVED_LABEL_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Seam-authored fixed decision markers — allowed verbatim in `decision`/verdict_class (§5.1.5). */
export const FIXED_VERDICT_MARKERS: ReadonlySet<string> = new Set(['unclassified', '<errored>']);

/** Raw model-output heads live in `context` only, scrubbed + clamped to this (§5.2). */
export const CONTEXT_HEAD_CLAMP = 300;

/**
 * Clamp a served verdict-class/decision label (§5.2): a fixed seam marker or a
 * charset-clean label passes; anything else becomes `'unclassified'` and is
 * flagged. Shared by the JSONL envelope AND the SQLite `decision_quality`
 * write so the two stores can never disagree on what a bounded label is.
 */
export function clampServedVerdictClass(v: string | undefined | null): { value: string; violated: boolean } {
  if (typeof v === 'string' && (FIXED_VERDICT_MARKERS.has(v) || SERVED_LABEL_RE.test(v))) {
    return { value: v, violated: false };
  }
  return { value: 'unclassified', violated: v !== undefined && v !== null };
}

/** Clamp a served promptId (§5.2): violation → the fixed `'unlabeled-prompt'` marker + flagged. */
export function clampServedPromptId(v: string | undefined | null): { value: string | undefined; violated: boolean } {
  if (v === undefined || v === null) return { value: undefined, violated: false };
  if (typeof v === 'string' && SERVED_LABEL_RE.test(v)) return { value: v, violated: false };
  return { value: 'unlabeled-prompt', violated: true };
}

/** Clamp a served optionsPresented entry (§5.2): violation → `'unclassified'` + flagged. */
export function clampServedOptionLabel(v: unknown): { value: string; violated: boolean } {
  if (typeof v === 'string' && SERVED_LABEL_RE.test(v)) return { value: v, violated: false };
  return { value: 'unclassified', violated: true };
}

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
  /* ── Additive seam fields (llm-decision-quality-meter §5.2) ── */
  /**
   * The §5.1 router-minted correlation id. Presence marks a SEAM row: the §5.2
   * serve-discipline clamps apply, and the log's own global sampling knob is
   * BYPASSED — the census volume valve (§5.6) already applied upstream at the
   * settlement write, and double-valving would make the declared volume
   * classes lie. Legacy rows (no correlationId) behave byte-identically.
   */
  correlationId?: string;
  /** Prompt identity — a hash/version tag (charset/length-clamped on seam rows). */
  promptId?: string;
  /** Census content class ('metadata' | 'content-bearing'). */
  contentClass?: string;
  /** Who minted the correlation id ('router'; breaker mints never settle). */
  mintedBy?: string;
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
  /* ── Additive seam fields (llm-decision-quality-meter §5.2) ── */
  /** The §5.1 correlation id — the join key decision AND outcome rows share. */
  correlationId?: string;
  promptId?: string;
  contentClass?: string;
  mintedBy?: string;
  /** Outcome rows only (§5.4): FD3 grade, validated at write (invalid → omitted + counted). */
  grade?: string;
  /** Outcome rows only: the grading component (the ruleId's registered owner). */
  gradedBy?: string;
  /** Outcome rows only: the immutable, versioned evidence-rule id. */
  ruleId?: string;
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

/**
 * FNV-1a 32-bit — cheap deterministic hash for the sampling decision.
 * Exported: the settlement seam's per-point `sampled:<rate>` volume class
 * (llm-decision-quality-meter §5.6) rides this SAME convention
 * (`fnv1aSampleBucket(id) < rate` → write), keyed on the correlation id so a
 * given decision samples identically on replay.
 */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The deterministic sampling bucket in [0,1) — the log's own convention, shared with the seam's volume valve. */
export function fnv1aSampleBucket(s: string): number {
  return (fnv1a(s) % 10_000) / 10_000;
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
  private counters = {
    decisionsWritten: 0,
    decisionsSampledOut: 0,
    outcomesWritten: 0,
    writeErrors: 0,
    /** §5.2 serve-discipline: caller-authored served labels replaced by the fixed markers. */
    labelClampViolations: 0,
    /** §5.4/FD3: outcome `grade` values failing the enum at write (field omitted, never stored). */
    invalidGradeDropped: 0,
  };

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
    const seamRow = typeof input.correlationId === 'string' && input.correlationId.length > 0;
    // Deterministic sampling (non-arbiter LEGACY rows only): hash the row
    // identity. Seam rows bypass this knob — their volume valve is the census
    // volume class, already applied at the settlement write (§5.6); applying
    // the legacy global knob on top would double-sample and make the declared
    // classes lie.
    if (!input.arbiter && !seamRow && this.sampling < 1) {
      const bucket = fnv1aSampleBucket(id);
      if (bucket >= this.sampling) {
        this.counters.decisionsSampledOut++;
        return null;
      }
    }
    // §5.2 serve-discipline on SEAM rows: the served label fields are bounded
    // enum-like values — a violation is replaced with the fixed marker and
    // counted, never stored. Legacy rows are byte-identical to pre-seam behavior.
    let decision = input.decision;
    let optionsPresented = input.optionsPresented;
    let promptId = input.promptId;
    if (seamRow) {
      const d = clampServedVerdictClass(input.decision);
      if (d.violated) this.counters.labelClampViolations++;
      decision = d.value;
      optionsPresented = (input.optionsPresented ?? []).map((o) => {
        const c = clampServedOptionLabel(o);
        if (c.violated) this.counters.labelClampViolations++;
        return c.value;
      });
      const p = clampServedPromptId(input.promptId);
      if (p.violated) this.counters.labelClampViolations++;
      promptId = p.value;
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
      optionsPresented,
      decision,
      reason: scrubString(input.reason),
      floor: input.floor,
      fallbackRung: input.fallbackRung,
      arbiter: input.arbiter ?? false,
      model: input.model,
      door: input.door,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      latencyMs: input.latencyMs,
      ...(seamRow
        ? {
            correlationId: input.correlationId,
            promptId,
            contentClass: input.contentClass,
            mintedBy: input.mintedBy,
          }
        : {}),
    };
    row = this.clampRow(row);
    this.enqueue(row);
    this.counters.decisionsWritten++;
    return id;
  }

  /**
   * Ground-truth annotation referencing a decision row (§3.5 outcome
   * annotation; llm-decision-quality-meter §5.4.1 keying). `decisionRef`
   * accepts EITHER the legacy JP row id (the two deterministic
   * SpawnAdmission/DuplicateSessionReconciler callsites — unchanged) OR a §5.1
   * correlation id (`d-`/`b-` mint prefixes) — outcome rows then join their
   * decision row on `correlationId`. `grading` carries the §5.4 write-integrity
   * fields (already validated by the annotate CHOKEPOINT — the JPL re-validates
   * the FD3 grade enum at write: an invalid grade is omitted + counted, never
   * stored).
   */
  annotateOutcome(
    decisionRef: string,
    component: string,
    outcome: Record<string, unknown>,
    grading?: { grade?: string; gradedBy?: string; ruleId?: string },
  ): void {
    const now = this.nowFn();
    const isCorrelationId = /^[db]-/.test(decisionRef);
    let grade = grading?.grade;
    if (grade !== undefined && grade !== 'right' && grade !== 'wrong' && grade !== 'unknown') {
      this.counters.invalidGradeDropped++;
      grade = undefined;
    }
    let row: ProvenanceRow = {
      id: `jp-${now.toString(36)}-${(this.seq++).toString(36)}`,
      ts: new Date(now).toISOString(),
      kind: 'outcome',
      component,
      ...(isCorrelationId ? { correlationId: decisionRef } : { decisionId: decisionRef }),
      outcome: scrub(outcome),
      ...(grade !== undefined ? { grade } : {}),
      ...(grading?.gradedBy !== undefined ? { gradedBy: grading.gradedBy } : {}),
      ...(grading?.ruleId !== undefined ? { ruleId: grading.ruleId } : {}),
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

/* ── Content-class envelope builders (llm-decision-quality-meter §5.2) ──────
 * Enrolling callsites do NOT hand-roll their `options.provenance.context`
 * shape — they build it through the builder matching their census-declared
 * content class, so the containment posture (identity + bounded features,
 * never full bodies) is structural, not remembered. The builders scrub +
 * clamp at BUILD time, so even the machine-local `contextFull` copy holds
 * only bounded, credential-scrubbed values. */

/** Max keys a bounded context envelope keeps (excess is dropped, flagged). */
const BOUNDED_CONTEXT_MAX_KEYS = 64;
/** Max scalar items a bounded array keeps. */
const BOUNDED_ARRAY_MAX_ITEMS = 32;

function boundValue(v: unknown, depth: number): unknown {
  if (v === null) return null;
  switch (typeof v) {
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'string':
      return scrubString(v).slice(0, CONTEXT_HEAD_CLAMP);
    case 'object':
      break;
    default:
      return undefined; // functions/symbols/undefined are dropped
  }
  if (Array.isArray(v)) {
    return v.slice(0, BOUNDED_ARRAY_MAX_ITEMS).map((item) => {
      const b = boundValue(item, depth + 1);
      return b === undefined ? null : b;
    });
  }
  if (depth >= 2) {
    // Too deep for a bounded envelope — collapse to a scrubbed JSON head.
    try {
      return scrubString(JSON.stringify(v) ?? '').slice(0, CONTEXT_HEAD_CLAMP);
    } catch {
      // @silent-fallback-ok: a cyclic/unserializable deep value becomes a fixed
      // marker — the envelope builder must never throw into an enrolling callsite.
      return '[unserializable]';
    }
  }
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (kept >= BOUNDED_CONTEXT_MAX_KEYS) {
      out._truncatedKeys = true;
      break;
    }
    const bounded = boundValue(val, depth + 1);
    if (bounded === undefined) continue;
    out[k.slice(0, 64)] = bounded;
    kept++;
  }
  return out;
}

/**
 * The generic bounded-context builder (content class `metadata`, and the base
 * every content-bearing builder composes over): code-authored facts — ids,
 * hashes, booleans, numbers, enums — plus AT MOST 300-char scrubbed string
 * heads. Strings are credential-scrubbed + clamped, arrays and nesting are
 * bounded, functions/symbols dropped. Deterministic and never throws.
 */
export function buildBoundedContext(fields: Record<string, unknown>): Record<string, unknown> {
  return (boundValue(fields ?? {}, 0) ?? {}) as Record<string, unknown>;
}

/**
 * Keys that would smuggle a full body into a content-bearing envelope — the
 * transcript-slice builder DROPS them from `extra` (§5.2: the provenance store
 * must not become a second transcript/message archive). Identity + bounded
 * features only.
 */
const CONTENT_BODY_KEYS: ReadonlySet<string> = new Set([
  'text',
  'body',
  'raw',
  'transcript',
  'content',
  'message',
  'messages',
  'prompt',
  'output',
  'response',
]);

/**
 * Content-bearing envelope for decisions judged over a transcript/message
 * SLICE (completion judges, sentinels): the slice enters as IDENTITY (hash +
 * bounds) — never text. `extra` (e.g. the StopSignals corroboration block)
 * rides the generic bounded builder with body-shaped keys structurally
 * dropped.
 */
export function buildTranscriptSliceIdentityContext(
  slice: {
    /** Content hash of the exact slice handed to the model. */
    sliceHash: string;
    startOffset?: number;
    endOffset?: number;
    lineCount?: number;
    byteLength?: number;
    /** A bounded label naming the source (e.g. 'autonomous-run-transcript'). */
    source?: string;
  },
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const bounds: Record<string, number> = {};
  for (const k of ['startOffset', 'endOffset', 'lineCount', 'byteLength'] as const) {
    const v = slice[k];
    if (typeof v === 'number' && Number.isFinite(v)) bounds[k] = v;
  }
  const filteredExtra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (CONTENT_BODY_KEYS.has(k.toLowerCase())) continue;
    filteredExtra[k] = v;
  }
  return {
    sliceHash: scrubString(String(slice.sliceHash ?? '')).slice(0, 128),
    sliceBounds: bounds,
    ...(slice.source ? { source: scrubString(String(slice.source)).slice(0, 128) } : {}),
    ...buildBoundedContext(filteredExtra),
  };
}
