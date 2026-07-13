/**
 * AutonomousRunStore — SERVER-OWNED autonomous run records.
 *
 * The persistence substrate for the Autonomous Scope-Accretion Completion
 * Discipline (docs/specs/autonomous-scope-accretion-completion.md). Every
 * load-bearing fact the accretion gate reads lives HERE — written only by the
 * server, never transported from the session's environment and never read from
 * files the session routinely edits (R11/R12).
 *
 * Layout (all under `<stateDir>/state/autonomous-server/`):
 *   - `<topicId>.<runId>.json`             — one run record (R30)
 *   - `<topicId>.<runId>.archived.json`    — lazily-archived predecessor (R28)
 *   - `<topicId>.<runId>.artifacts.jsonl`  — the ADVISORY tool-event ledger (R18)
 *   - `session-map.json`                   — sessionId ↔ topicId/runId map (§2.3)
 *   - `conformance-invocations.json`       — server-recorded ceremony evidence (R32)
 *
 * Lifecycle (R43): ACTIVE from registration until TERMINAL — a met:true final
 * verdict marks it `met`; `endAt` passage marks it expired (lazily observed);
 * the run-end call (R44) marks it `ended`. One registration per active run:
 * re-register for a topic is refused while the existing record is non-terminal
 * AND unexpired; otherwise the old record is lazily archived.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';

/** Snapshot of the scopeAccretion config sub-object taken at registration (R13). */
export interface ScopeAccretionSnapshot {
  enabled: boolean;
  breakerK: number;
}

/** A swept base root with its registration-time anchor SHA (R31). */
export interface SweepBaseRoot {
  root: string;
  /** `git rev-parse HEAD` at registration; null when the root is not a git repo. */
  startSha: string | null;
  /**
   * R48 attribution scope: the SHARED agent-home root is attributed HEAD-only
   * (+ porcelain); the run's own work_dir root and in-run worktrees get the
   * full `--branches --not <startSHA>` arm.
   */
  shared: boolean;
}

export interface RatificationRecord {
  via: 'pin' | 'conversation';
  at: string;
  artifacts: string[];
  enumerationMessageId?: number;
  confirmationMessageId?: number;
  /** sha256 of the verified operator uid — never the raw uid (audit discipline §4). */
  verifiedOperatorUidHash?: string;
}

export interface EnumerationRecord {
  /** sha256 over the sorted enumerated set — the dedupe key (§2.6). */
  setHash: string;
  messageId: number;
  at: string;
  artifacts: string[];
}

export interface ScopeAccretionBreakerState {
  accretedSetHash: string;
  firstSeenAt: string;
  consecutiveHolds: number;
  lastProgressAt: string;
  /** Count of cleared (corroborated+ratified) paths at the last hold — a change resets (R26). */
  clearedCount: number;
  tripped: boolean;
  trippedAt?: string;
}

export type AutonomousRunStatus = 'active' | 'met' | 'ended' | 'expired' | 'archived';

export interface UnbuiltArtifactEntry {
  path: string;
  cls: string;
  deleted: boolean;
  firstSeenAt: string;
}

export interface AutonomousRunRecord {
  runId: string;
  topicId: string;
  /** The SERVER-REGISTERED condition — the judge's authority (R36). */
  condition: string;
  declaredDeliverables: string[];
  workDir: string;
  startedAt: string;
  /** Duration ceiling, CLAMPED server-side to now + maxDurationMs (R43/R49). */
  endAt: string;
  registeredAt: string;
  sessionId?: string;
  scopeAccretion: ScopeAccretionSnapshot;
  /** Operator PIN override (R14) — wins over the registration snapshot. */
  scopeAccretionOverride?: { enabled: boolean; reason: string; at: string };
  baseRoots: SweepBaseRoot[];
  /** Worktrees first seen at sweep time → their first-sight anchor SHA (R31). */
  worktreeFirstSeen: Record<string, string>;
  status: AutonomousRunStatus;
  endedAt?: string;
  endReason?: string;
  /** Monotone positive corroborations — a merged PR stays merged (R21). */
  corroborated: Record<string, { by: string; at: string; detail?: string }>;
  /** Negative-corroboration cache — 5-minute TTL entries (R22). */
  negativeCache: Record<string, string>;
  ratifiedArtifacts: string[];
  ratifications: RatificationRecord[];
  enumerations: EnumerationRecord[];
  /** Persisted defer-vocabulary trigger events from the live receive path (R45). */
  triggers: Array<{ at: string; messageId: number; phrase: string }>;
  breaker: ScopeAccretionBreakerState;
  /** The last sweep's unbuilt set — what enumeration/ratification binds against. */
  lastUnbuilt: UnbuiltArtifactEntry[];
  lastSweepAt?: string;
  /** Mid-run condition divergence between body and registered text — flagged once (R36). */
  conditionDivergenceFlagged?: boolean;
  /**
   * LLM-Decision Quality Meter §5.3: the router-minted correlation id of the
   * run's LAST completion-judge decision (`completion-evaluate`), persisted at
   * mint time so the realcheck path can annotate deterministic ground truth
   * against the decision row later (rule `completion-realcheck-v1`). Rides
   * this durable record, so it survives restarts. ADDITIVE — absent on
   * pre-meter records; never read by the accretion gate.
   */
  lastCompletionCorrelationId?: string;
  /** ISO timestamp of the `lastCompletionCorrelationId` write. */
  lastCompletionCorrelationAt?: string;
  /** Same as `lastCompletionCorrelationId`, for the P13 `completion-stop-rationale` point. */
  lastStopRationaleCorrelationId?: string;
  /** ISO timestamp of the `lastStopRationaleCorrelationId` write. */
  lastStopRationaleCorrelationAt?: string;
}

/** Which enrolled completion decision point a correlation id belongs to (§5.3).
 * Structurally identical to CompletionEvaluator's CompletionDecisionKind —
 * kept local so the store stays import-free of the evaluator module. */
export type DecisionCorrelationKind = 'completion' | 'stop-rationale';

/** Correlation ids are seam-minted (`d-`/`b-` prefix + uuid, optionally a
 * machineId8 segment) — anything outside this shape is refused at the write
 * (ids arrive via callback plumbing, so jail them like the filename ids). */
const CORRELATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface RegisterRunInput {
  topicId: string;
  condition: string;
  workDir: string;
  declaredDeliverables?: string[];
  startedAt: string;
  endAt?: string;
  sessionId?: string;
  scopeAccretion: ScopeAccretionSnapshot;
  baseRoots: SweepBaseRoot[];
  maxDurationMs: number;
}

export type RegisterRunResult =
  | { ok: true; runId: string; endAt: string; clamped: boolean }
  | { ok: false; conflict: true; existingRunId: string };

const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const ARCHIVE_AFTER_END_MS = 24 * 60 * 60 * 1000;
/** Retention clamp on conformance invocation timestamps per slug. */
const MAX_INVOCATIONS_PER_SLUG = 50;

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable hash over a path set — the enumeration/breaker dedupe key. */
export function hashPathSet(paths: string[]): string {
  return sha256Hex([...paths].sort().join('\n'));
}

export class AutonomousRunStore {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'state', 'autonomous-server');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* @silent-fallback-ok — store dir creation failure surfaces on first write; the
         gate degrades to inert (legacy behavior), never blocks the server boot. */
    }
  }

  get storeDir(): string {
    return this.dir;
  }

  // ── Record IO ─────────────────────────────────────────────────────────

  private recordPath(topicId: string, runId: string): string {
    return path.join(this.dir, `${sanitizeId(topicId)}.${sanitizeId(runId)}.json`);
  }

  private writeRecord(rec: AutonomousRunRecord): void {
    const file = this.recordPath(rec.topicId, rec.runId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, file);
  }

  private readRecordFile(file: string): AutonomousRunRecord | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AutonomousRunRecord;
      if (!parsed || typeof parsed.runId !== 'string' || typeof parsed.topicId !== 'string') return null;
      return parsed;
    } catch {
      /* @silent-fallback-ok — a corrupt/unreadable record reads as absent: the
         accretion gate degrades toward INERT (legacy behavior, no false hold and
         no false done); tamper-class rewrites are the documented R12 bound. */
      return null;
    }
  }

  /** All records for a topic (non-archived files). */
  private recordFilesForTopic(topicId: string): string[] {
    const prefix = `${sanitizeId(topicId)}.`;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      /* @silent-fallback-ok — a missing store dir means no records exist yet;
         the gate stays inert (fail toward keep-working, never a false done). */
      return [];
    }
    return names
      .filter((n) => n.startsWith(prefix) && n.endsWith('.json') && !n.endsWith('.archived.json') && !n.endsWith('.tmp'))
      .filter((n) => !n.endsWith('.artifacts.jsonl'))
      .map((n) => path.join(this.dir, n));
  }

  /** The topic's current record (active or terminal-but-not-yet-archived), or null. */
  getRecord(topicId: string): AutonomousRunRecord | null {
    const files = this.recordFilesForTopic(topicId);
    let best: AutonomousRunRecord | null = null;
    for (const f of files) {
      const rec = this.readRecordFile(f);
      if (!rec) continue;
      if (!best || rec.registeredAt > best.registeredAt) best = rec;
    }
    return best;
  }

  /** Record by exact (topicId, runId) pair — the runId cross-check (§6). */
  getByPair(topicId: string, runId: string): AutonomousRunRecord | null {
    const rec = this.readRecordFile(this.recordPath(topicId, runId));
    return rec;
  }

  /** Is the record ACTIVE right now (non-terminal AND unexpired)? (R43) */
  isActive(rec: AutonomousRunRecord, now: number = Date.now()): boolean {
    if (rec.status !== 'active') return false;
    const end = Date.parse(rec.endAt);
    if (Number.isFinite(end) && now > end) return false;
    return true;
  }

  /** Every currently-active registered run on this server (R35 arming). */
  listActive(now: number = Date.now()): AutonomousRunRecord[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      /* @silent-fallback-ok — an unreadable store dir yields zero active runs;
         R35 arming then treats the caller as legacy (gate inert, logged) — the
         safe, non-blocking direction. */
      return [];
    }
    const out: AutonomousRunRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json') || n.endsWith('.archived.json') || n.includes('.artifacts.')) continue;
      if (n === 'session-map.json' || n === 'conformance-invocations.json' || n === 'index.json') continue;
      const rec = this.readRecordFile(path.join(this.dir, n));
      if (rec && this.isActive(rec, now)) out.push(rec);
    }
    return out;
  }

  // ── Registration (R30/R43/R49) ────────────────────────────────────────

  register(input: RegisterRunInput, now: number = Date.now()): RegisterRunResult {
    const existing = this.getRecord(input.topicId);
    if (existing && this.isActive(existing, now)) {
      // One registration per active run: refuse while non-terminal + unexpired.
      return { ok: false, conflict: true, existingRunId: existing.runId };
    }
    if (existing) {
      // Lazy archive of the predecessor (R28a). An expired-but-active record is
      // also given its every-exit-loud enumeration by the daily sweep backstop —
      // archiving here just clears the name; the sweep owns the loud part.
      this.archive(existing);
    }

    const runId = `run-${now.toString(36)}-${randomBytes(4).toString('hex')}`;
    // endAt clamp (R43/R49): a session cannot register an unbounded run.
    const ceiling = now + input.maxDurationMs;
    let endMs = Date.parse(input.endAt ?? '');
    let clamped = false;
    if (!Number.isFinite(endMs) || endMs <= now || endMs > ceiling) {
      if (Number.isFinite(endMs) && endMs > ceiling) clamped = true;
      endMs = Math.min(Number.isFinite(endMs) && endMs > now ? endMs : ceiling, ceiling);
    }
    const endAt = new Date(endMs).toISOString();

    const rec: AutonomousRunRecord = {
      runId,
      topicId: String(input.topicId),
      condition: input.condition,
      declaredDeliverables: (input.declaredDeliverables ?? []).map(String).slice(0, 100),
      workDir: input.workDir,
      startedAt: input.startedAt,
      endAt,
      registeredAt: new Date(now).toISOString(),
      sessionId: input.sessionId,
      scopeAccretion: input.scopeAccretion,
      baseRoots: input.baseRoots,
      worktreeFirstSeen: {},
      status: 'active',
      corroborated: {},
      negativeCache: {},
      ratifiedArtifacts: [],
      ratifications: [],
      enumerations: [],
      triggers: [],
      breaker: {
        accretedSetHash: '',
        firstSeenAt: '',
        consecutiveHolds: 0,
        lastProgressAt: '',
        clearedCount: 0,
        tripped: false,
      },
      lastUnbuilt: [],
    };
    this.writeRecord(rec);
    if (input.sessionId) this.mapSession(input.sessionId, rec.topicId, runId);
    return { ok: true, runId, endAt, clamped };
  }

  /** Load-modify-save under the single-server assumption (one writer: this process). */
  update(topicId: string, runId: string, mutate: (rec: AutonomousRunRecord) => void): AutonomousRunRecord | null {
    const rec = this.getByPair(topicId, runId);
    if (!rec) return null;
    mutate(rec);
    this.writeRecord(rec);
    return rec;
  }

  markTerminal(topicId: string, runId: string, status: 'met' | 'ended' | 'expired', reason?: string): AutonomousRunRecord | null {
    return this.update(topicId, runId, (rec) => {
      // Terminality is one-way (R43): never demote a terminal record back to active,
      // and never overwrite one terminal status with another (first exit wins).
      if (rec.status !== 'active') return;
      rec.status = status;
      rec.endedAt = new Date().toISOString();
      if (reason) rec.endReason = reason.slice(0, 500);
    });
  }

  private archive(rec: AutonomousRunRecord): void {
    const from = this.recordPath(rec.topicId, rec.runId);
    const to = from.replace(/\.json$/, '.archived.json');
    try {
      fs.renameSync(from, to);
    } catch {
      /* @silent-fallback-ok — a failed archive rename leaves the old record in place;
         registration proceeds regardless (the new record has a distinct runId name). */
    }
  }

  /**
   * Daily sweep (R28b) — archive records whose endAt passed >24h ago. Returns the
   * reaped records so the CALLER can run the every-exit-loud enumeration (R40):
   * "late-but-loud beats never". Piggybacked on the autonomous routes rather than
   * a background timer (each call is cheap; the 24h gate below dedupes).
   */
  private lastDailySweepAt = 0;

  dailySweep(now: number = Date.now(), force = false): AutonomousRunRecord[] {
    if (!force && now - this.lastDailySweepAt < 60 * 60 * 1000) return [];
    this.lastDailySweepAt = now;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      /* @silent-fallback-ok — the daily sweep is the R28b BACKSTOP; a failed
         readdir just means this pass reaps nothing and the next call retries. */
      return [];
    }
    const reaped: AutonomousRunRecord[] = [];
    for (const n of names) {
      if (!n.endsWith('.json') || n.endsWith('.archived.json') || n.includes('.artifacts.')) continue;
      if (n === 'session-map.json' || n === 'conformance-invocations.json' || n === 'index.json') continue;
      const rec = this.readRecordFile(path.join(this.dir, n));
      if (!rec) continue;
      const end = Date.parse(rec.endAt);
      if (!Number.isFinite(end) || now - end < ARCHIVE_AFTER_END_MS) continue;
      // A still-'active' record reaped here is the crash/tamper case — the caller
      // enumerates its unbuilt set loudly before it disappears into the archive.
      if (rec.status === 'active') reaped.push(rec);
      this.archive(rec);
    }
    return reaped;
  }

  // ── Decision correlation ids (llm-decision-quality-meter §5.3) ────────

  /**
   * Persist the router-minted correlation id of a completion/stop-rationale
   * judgment onto the run record — the durable join key the realcheck path
   * annotates through (`completion-realcheck-v1`). Satisfies the evaluator's
   * `CompletionCorrelationSink` structurally. Best-effort by contract: a
   * refused id or a missing record returns false and mutates nothing (later
   * annotation then honestly ages out `unknown`); it never throws into the
   * judgment path.
   */
  recordDecisionCorrelation(
    topicId: string,
    runId: string,
    kind: DecisionCorrelationKind,
    correlationId: string,
    now: number = Date.now(),
  ): boolean {
    if (typeof correlationId !== 'string' || !CORRELATION_ID_RE.test(correlationId)) return false;
    try {
      const updated = this.update(topicId, runId, (rec) => {
        const at = new Date(now).toISOString();
        if (kind === 'completion') {
          rec.lastCompletionCorrelationId = correlationId;
          rec.lastCompletionCorrelationAt = at;
        } else {
          rec.lastStopRationaleCorrelationId = correlationId;
          rec.lastStopRationaleCorrelationAt = at;
        }
      });
      return updated !== null;
    } catch {
      /* @silent-fallback-ok — a failed correlation write only degrades later
         outcome annotation to age-out-unknown (honest, §5.4.6); the judgment
         path and the accretion gate are untouched. */
      return false;
    }
  }

  // ── Corroboration persistence (R21/R22) ───────────────────────────────

  recordCorroboration(topicId: string, runId: string, artifact: string, by: string, detail?: string): void {
    this.update(topicId, runId, (rec) => {
      if (!rec.corroborated[artifact]) {
        rec.corroborated[artifact] = { by, at: new Date().toISOString(), detail: detail?.slice(0, 200) };
      }
      delete rec.negativeCache[artifact];
    });
  }

  recordNegative(topicId: string, runId: string, artifact: string): void {
    this.update(topicId, runId, (rec) => {
      rec.negativeCache[artifact] = new Date().toISOString();
    });
  }

  isNegativeCached(rec: AutonomousRunRecord, artifact: string, now: number = Date.now()): boolean {
    const at = rec.negativeCache[artifact];
    if (!at) return false;
    const t = Date.parse(at);
    return Number.isFinite(t) && now - t < NEGATIVE_TTL_MS;
  }

  // ── Session map (§2.3) ────────────────────────────────────────────────

  private get sessionMapFile(): string {
    return path.join(this.dir, 'session-map.json');
  }

  mapSession(sessionId: string, topicId: string, runId: string): void {
    try {
      let map: Record<string, { topicId: string; runId: string }> = {};
      try {
        map = JSON.parse(fs.readFileSync(this.sessionMapFile, 'utf8'));
      } catch {
        map = {};
      }
      map[sessionId] = { topicId: String(topicId), runId };
      // Bounded: keep the most recent 200 entries.
      const keys = Object.keys(map);
      if (keys.length > 200) {
        for (const k of keys.slice(0, keys.length - 200)) delete map[k];
      }
      const tmp = `${this.sessionMapFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
      fs.renameSync(tmp, this.sessionMapFile);
    } catch {
      /* @silent-fallback-ok — the session map feeds the ADVISORY ledger only (R19);
         a write failure degrades attribution detail, never the blocking sweep. */
    }
  }

  resolveSession(sessionId: string): { topicId: string; runId: string } | null {
    try {
      const map = JSON.parse(fs.readFileSync(this.sessionMapFile, 'utf8')) as Record<string, { topicId: string; runId: string }>;
      return map[sessionId] ?? null;
    } catch {
      return null;
    }
  }

  // ── Advisory tool-event ledger (R18) ──────────────────────────────────

  appendAdvisoryArtifact(topicId: string, runId: string, entry: { filePath: string; toolName: string; sessionId?: string }): void {
    try {
      const file = path.join(this.dir, `${sanitizeId(topicId)}.${sanitizeId(runId)}.artifacts.jsonl`);
      fs.appendFileSync(
        file,
        JSON.stringify({ ts: new Date().toISOString(), filePath: entry.filePath.slice(0, 1000), toolName: entry.toolName.slice(0, 50), sessionId: entry.sessionId }) + '\n',
      );
    } catch {
      /* @silent-fallback-ok — advisory-only layer (R18/R19): a ledger write failure
         degrades attribution detail; the git-truth sweep is unaffected. */
    }
  }

  // ── Conformance-check invocation records (R32) ────────────────────────

  private get invocationsFile(): string {
    return path.join(this.dir, 'conformance-invocations.json');
  }

  recordConformanceInvocation(slug: string, at: string = new Date().toISOString()): void {
    try {
      let map: Record<string, string[]> = {};
      try {
        map = JSON.parse(fs.readFileSync(this.invocationsFile, 'utf8'));
      } catch {
        map = {};
      }
      const key = sanitizeId(slug).slice(0, 120);
      const arr = Array.isArray(map[key]) ? map[key] : [];
      arr.push(at);
      map[key] = arr.slice(-MAX_INVOCATIONS_PER_SLUG);
      const tmp = `${this.invocationsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
      fs.renameSync(tmp, this.invocationsFile);
    } catch {
      /* @silent-fallback-ok — a missed ceremony record only delays a spec's arm-(a)
         clearing (fail toward keep-working, the safe direction per R21/R22). */
    }
  }

  conformanceInvocationsInWindow(slug: string, startIso: string, endIso: string): number {
    try {
      const map = JSON.parse(fs.readFileSync(this.invocationsFile, 'utf8')) as Record<string, string[]>;
      const arr = map[sanitizeId(slug).slice(0, 120)];
      if (!Array.isArray(arr)) return 0;
      const start = Date.parse(startIso);
      const end = Date.parse(endIso);
      return arr.filter((ts) => {
        const t = Date.parse(ts);
        return Number.isFinite(t) && (!Number.isFinite(start) || t >= start) && (!Number.isFinite(end) || t <= end);
      }).length;
    } catch {
      /* @silent-fallback-ok — missing/corrupt ceremony records only DELAY a
         spec's arm-(a) clearing (fail toward keep-working per R21/R22). */
      return 0;
    }
  }
}

/** Filename-component sanitizer — ids come from network bodies; jail them hard. */
function sanitizeId(id: string): string {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Standalone helper for callers that don't hold a store instance (the
 * conformance-check route lives in specReviewRoutes.ts with its own deps).
 */
export function recordConformanceInvocationAt(stateDir: string, slug: string): void {
  new AutonomousRunStore(stateDir).recordConformanceInvocation(slug);
}
