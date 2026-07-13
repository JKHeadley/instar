/**
 * ExternalHogDecisionStore — the DURABLE per-ledgerKey decision record behind the external-hog
 * kill/leave grading (docs/specs/llm-decision-quality-meter.md §5.3 + §5.4.5; the review
 * established the carrier this grading needs did not exist: the P19 kill-ledger state is
 * in-memory-only, kill-records-only, with a 1h retention — shorter than the 6h evidence window).
 *
 * On-disk: `<stateDir>/state/external-hog-decisions.json` — the `.instar/state/` runtime-state
 * subdir (rides the existing gitignore; the same subdir the judgment-provenance log uses).
 * At-rest posture mirrors ExternalHogArmStore exactly: 0600 via atomic tmp + fsync + rename
 * writes, FAIL-CLOSED reads (missing / unreadable / corrupt / wrong-shape → empty store, never a
 * throw; a malformed individual record is dropped, never half-trusted). Contents are content-free
 * (hashes, pids, timestamps, enums) — never argv, never model output. The file is
 * backup-excluded (BLOCKED_PATH_PREFIXES + NEVER_BACKUP_PATH_SEGMENTS, P1) and NEVER_SERVED
 * (fileRoutes, P1): it is grading GROUND TRUTH — serve-deny implies edit-deny.
 *
 * SLOT SEMANTICS (§5.3, ADV r3): per ledgerKey the store holds the LATEST decision PLUS the most
 * recent in-window ENACTED-kill decision retained ALONGSIDE — a kill's evidence slot is never
 * evicted by later same-key decisions before its window closes, so a same-commandHash flood
 * cannot force a premature `unknown` on a kill.
 *
 * GRADE-ON-SUPERSEDE (§5.3, ADV/DC r3): writing a new decision for ledgerKey K FIRST applies the
 * positive-evidence rules against the OUTGOING record(s) — the supersede event IS the
 * positive-evidence event for the recurrence rules; within-tick ordering is pinned, not assumed —
 * and returns any grade results to the caller BEFORE replacement. A superseded record whose rules
 * yield nothing ages out as `unknown` (stated, not silent).
 *
 * RETENTION (§5.3, DC r3): pruned on write at
 * `max(evidenceWindowMs + gradingSlackMs, killLedgerBreakerWindowMs)` — the grading slack
 * (default 2h ≥ 2× the grading job's hourly cadence) closes the race where an entry becomes
 * gradeable at exactly the age it becomes prunable; the evidence window is the config knob
 * (`provenance.quality.evidenceWindowHours`, inline default 6h — deliberately unseeded, §5.7) and
 * retention DERIVES from it, so tuning the window can never silently outrun the carrier.
 *
 * CLOCK: the store keeps its OWN injected WALL clock (epoch ms, default Date.now) — the scan
 * tick's monotonic hrtime clock must never be persisted (it restarts at 0 with the process).
 *
 * The pure evidence-rule predicates (§5.4.5) are exported at module level: the positive-evidence
 * rules (`hog-respawn-wrong-v1`, `hog-leave-recurrence-v1`) run in scan ticks via
 * grade-on-supersede here; the window-close rule (`hog-sustained-right-v1`, owner
 * `DecisionGrading`) is exported for the P9 grading endpoint to drive over `list()` — this store
 * NEVER emits sustained-right events itself (the sentinel is not that rule's registered owner).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ProcTableRow } from './ExternalHogProcTable.js';
import { lstartToEpochMs } from './ExternalHogFactBuilder.js';
import { getRule } from '../data/provenanceCoverage.js';
import type {
  HogDecisionSeed, HogEnactedDisposition, HogTargetTuple, HogOwnerTuple, ScanOutcome,
} from './ExternalHogScanTick.js';

// ── Registered evidence-rule ids (§5.4.5 — immutable, versioned) ────────────

export const HOG_RESPAWN_WRONG_RULE_ID = 'hog-respawn-wrong-v1';
export const HOG_LEAVE_RECURRENCE_RULE_ID = 'hog-leave-recurrence-v1';
export const HOG_SUSTAINED_RIGHT_RULE_ID = 'hog-sustained-right-v1';
export const HOG_ENACTED_DISPOSITION_RULE_ID = 'hog-enacted-disposition-v1';

/** The sentinel's registered owning component for its rules (§5.4.2 — the
 *  annotate chokepoint rejects an annotation whose gradedBy.component is not
 *  the ruleId's registered owner; a unit test pins this against RULE_REGISTRY). */
export const EXTERNAL_HOG_SENTINEL_COMPONENT = 'ExternalHogSentinel';

/**
 * Sanity guard the tests pin: the sentinel-emitted rules must be registered to
 * EXTERNAL_HOG_SENTINEL_COMPONENT (and sustained-right must NOT be — it belongs
 * to the grading job). Drift here would silently zero the hog grades at the
 * chokepoint's owner check.
 */
export function hogRuleRegistryAgrees(): boolean {
  const sentinelOwned = [HOG_RESPAWN_WRONG_RULE_ID, HOG_LEAVE_RECURRENCE_RULE_ID, HOG_ENACTED_DISPOSITION_RULE_ID]
    .every((id) => getRule(id)?.owningComponent === EXTERNAL_HOG_SENTINEL_COMPONENT);
  const gradingOwned = getRule(HOG_SUSTAINED_RIGHT_RULE_ID)?.owningComponent === 'DecisionGrading';
  return sentinelOwned && gradingOwned;
}

// ── Record + evidence types ─────────────────────────────────────────────────

/** Enacted dispositions that COUNT as an enacted kill (§5.3 — the ONLY entries
 *  to the kill-grading rules; everything else ages out `unknown`). */
export const HOG_KILL_ENACTED: ReadonlySet<HogEnactedDisposition> = new Set(['killed', 'sigterm-exited']);

/**
 * One durable per-ledgerKey decision record (§5.3 pinned shape + the
 * store-internal `reFlaggedAtMs` bookkeeping member).
 */
export interface HogDecisionRecord {
  readonly verdict: 'kill' | 'leave' | 'alert' | 'decider-unavailable';
  readonly enacted: HogEnactedDisposition;
  readonly correlationId: string | null;
  /** WALL epoch ms — stamped by the store's injected clock at write. */
  readonly atMs: number;
  readonly targetTuple: HogTargetTuple;
  /** Member-wise (ADV r4/r5): parentPid ALWAYS present on ENACTED kills;
   *  where-derivable otherwise (a floor-VETOED null-parse kill verdict
   *  legitimately has none — never hard-asserted). */
  readonly ownerTuple: HogOwnerTuple;
  readonly floorPermitted: boolean;
  readonly commandHash: string;
  /** The evidence window IN FORCE at decision time (recorded per §5.4.5 so
   *  grade aggregates never silently mix window semantics). */
  readonly effectiveWindowMs: number;
  /** Store bookkeeping (not part of the §5.3 identity fields): a same-ledgerKey
   *  candidate re-flagged at this wall time while this record's evidence window
   *  was open — destroys the negative-evidence `right` at window close
   *  (hog-sustained-right-v1 preconditions on its absence). */
  readonly reFlaggedAtMs?: number;
}

/** One graded outcome produced by grade-on-supersede, for the §5.4 chokepoint. */
export interface HogGradeEvent {
  readonly ruleId: typeof HOG_RESPAWN_WRONG_RULE_ID | typeof HOG_LEAVE_RECURRENCE_RULE_ID;
  readonly grade: 'wrong' | 'unknown';
  /** The GRADED (outgoing) decision's correlation id — null means the decision
   *  was never enrolled/minted and the grade has nothing to attach to (the
   *  caller counts it, never fabricates a join). */
  readonly correlationId: string | null;
  readonly ledgerKey: string;
  /** The graded record's effective window (recorded per outcome row, §5.4.5). */
  readonly windowMs: number;
  /** Bounded, content-free evidence note (enums + ids only). */
  readonly evidenceNote: string;
}

/** A current-scan candidate as the evidence rules see it (identity only). */
export interface HogEvidenceCandidate {
  readonly pid: number;
  readonly startTimeMs: number | null;
  readonly commandHash: string;
}

/**
 * The current scan's evidence view: this tick's fully-identified candidates
 * (same-commandHash respawn detection) + a live-process lookup for the
 * §5.4.5 kill-time ordering re-test.
 */
export interface HogEvidenceScanView {
  readonly candidates: ReadonlyArray<HogEvidenceCandidate>;
  /**
   * Epoch-ms start time of the CURRENTLY-ALIVE process at `pid`:
   * a number = alive + orderable; null = alive but un-orderable lstart;
   * undefined = NO live process at that pid.
   */
  aliveStartTimeMs(pid: number): number | null | undefined;
}

/** Build the evidence view from one tick's outcomes + the tick's parsed table. */
export function buildScanEvidenceView(outcomes: ReadonlyArray<ScanOutcome>, table: readonly ProcTableRow[]): HogEvidenceScanView {
  const candidates: HogEvidenceCandidate[] = outcomes.map((o) => ({
    pid: o.decision.targetTuple.pid,
    startTimeMs: o.decision.targetTuple.startTimeMs,
    commandHash: o.decision.commandHash,
  }));
  return {
    candidates,
    aliveStartTimeMs: (pid) => {
      const row = table.find((r) => r.pid === pid);
      if (!row) return undefined; // no live process at that pid
      return lstartToEpochMs(row.startTime); // number = orderable; null = un-orderable
    },
  };
}

// ── The pure §5.4.5 evidence-rule predicates ────────────────────────────────

/** Are these the SAME stored decision? (Reference equality dies at hydration —
 *  latest and kill may be two parses of one record; compare identity fields.) */
function sameStoredDecision(a: HogDecisionRecord, b: HogDecisionRecord): boolean {
  return a.atMs === b.atMs && a.correlationId === b.correlationId
    && a.enacted === b.enacted && a.commandHash === b.commandHash
    && a.targetTuple.pid === b.targetTuple.pid;
}

/** Is `candidate` provably the SAME process as the record's target (pid + orderable equal start)? */
function isSameProcess(candidate: HogEvidenceCandidate, target: HogTargetTuple): boolean {
  return candidate.pid === target.pid
    && candidate.startTimeMs !== null
    && target.startTimeMs !== null
    && candidate.startTimeMs === target.startTimeMs;
}

/** Is the record's evidence window still open at `nowMs`? (Negative/skewed clocks fail closed → not in window.) */
function inWindow(record: HogDecisionRecord, nowMs: number): boolean {
  const age = nowMs - record.atMs;
  return Number.isFinite(age) && age >= 0 && age <= record.effectiveWindowMs;
}

/**
 * `hog-respawn-wrong-v1` (deterministic-proof; §5.4.5): a kill is graded `wrong` ONLY IF, within
 * the bounded window, a same-commandHash CANDIDATE respawns AND the kill-time ordering test
 * re-runs TRUE at evidence time — a currently-alive process sits at the killed process's recorded
 * parent pid with a start-time ≤ the killed child's recorded start-time, proving the orphan
 * determination was false. Spoof-proof in both directions (start-times cannot be forged old):
 * a respawn under a genuinely NEW owner (the operator reopened the editor — the live parent
 * started AFTER the killed child, or no live parent exists) fails the ordering test and grades
 * `unknown`, never `wrong`; un-orderable start-times → `unknown`.
 *
 * Preconditions: verdict 'kill' actually ENACTED (`killed`/`sigterm-exited`) — would-kill /
 * deferred / aborted / decider-unavailable / breaker-held decisions are NEVER graded by this rule
 * (they age out `unknown`). Returns null when no evidence event applies (no respawn, out of
 * window, preconditions unmet).
 */
export function evaluateHogRespawnWrong(
  record: HogDecisionRecord,
  scan: HogEvidenceScanView,
  nowMs: number,
): 'wrong' | 'unknown' | null {
  if (record.verdict !== 'kill') return null; // grades attribute to the LLM verdict (§5.3)
  if (!HOG_KILL_ENACTED.has(record.enacted)) return null; // only ENACTED kills enter kill-grading
  if (!inWindow(record, nowMs)) return null; // out of window → the window-close rule's territory
  // Trigger: a same-commandHash CANDIDATE that is not provably the killed process itself.
  const respawned = scan.candidates.some(
    (c) => c.commandHash === record.commandHash && !isSameProcess(c, record.targetTuple),
  );
  if (!respawned) return null; // no evidence event
  // The kill-time ordering test, re-run at evidence time.
  const parentPid = record.ownerTuple.parentPid;
  if (parentPid === undefined) return 'unknown'; // un-evaluable (never occurs on enacted kills by construction)
  const aliveParentStartMs = scan.aliveStartTimeMs(parentPid);
  if (aliveParentStartMs === undefined) return 'unknown'; // no live parent → new/ownerless respawn → never wrong
  if (aliveParentStartMs === null || record.targetTuple.startTimeMs === null) return 'unknown'; // un-orderable
  return aliveParentStartMs <= record.targetTuple.startTimeMs ? 'wrong' : 'unknown';
}

/**
 * `hog-sustained-right-v1` (negative-evidence; §5.4.5): a kill whose commandHash did NOT re-flag
 * as a CANDIDATE within the window, where the floor recorded the owner dead at kill time
 * (floorPermitted ⟹ the owner-dead invariant held), grades `right` at WINDOW CLOSE. Sensor
 * bound, stated: candidate visibility is sustained-CPU processes only — a quiet respawn is
 * invisible, so this grade carries negative-evidence strength, never proof.
 *
 * Owner: `DecisionGrading` (the P9 grading endpoint drives this over `list()`); the sentinel
 * never emits it. Returns null while the window is open, on any non-enacted-kill record, or when
 * a re-flag was recorded inside the window.
 */
export function evaluateHogSustainedRight(record: HogDecisionRecord, nowMs: number): 'right' | null {
  if (record.verdict !== 'kill') return null;
  if (!HOG_KILL_ENACTED.has(record.enacted)) return null;
  if (!record.floorPermitted) return null; // precondition: floor recorded owner dead at kill time
  const age = nowMs - record.atMs;
  if (!Number.isFinite(age) || age <= record.effectiveWindowMs) return null; // window not closed yet
  if (record.reFlaggedAtMs !== undefined && record.reFlaggedAtMs - record.atMs <= record.effectiveWindowMs) {
    return null; // a same-key candidate re-flagged in-window → negative evidence destroyed
  }
  return 'right';
}

/**
 * `hog-leave-recurrence-v1` (recurrence-proxy; §5.4.5): applies ONLY to decisions where
 * `verdict === 'leave'` AND `enacted === 'alert-only-model-spared'` (a kill-verdict held by the
 * breaker/governor/floor is NEVER graded against the classifier) AND `floorPermitted` was true at
 * decision time (sparing an owner-alive hog is correct behavior with no gradeable
 * counterfactual). Within those preconditions: the SAME PROCESS (matching targetTuple pid +
 * start-time) re-flagging as a sustained hog within the window grades the leave `wrong`; a
 * DIFFERENT process with the same commandHash grades `unknown` (a lookalike spawned by any
 * same-uid process is not a counterfactual for the specific process the classifier spared — and
 * cannot fabricate a `wrong`). No-recurrence `right` at window close belongs to the grading job,
 * not this predicate.
 *
 * `nowMs` bounds the check to the record's evidence window (additive to the spec's pinned
 * signature — the predicate is window-bounded by §5.4.5 and must not rely on caller discipline).
 */
export function evaluateHogLeaveRecurrence(
  record: HogDecisionRecord,
  currentCandidateSignature: HogEvidenceCandidate,
  nowMs: number,
): 'wrong' | 'unknown' | null {
  if (record.verdict !== 'leave') return null;
  if (record.enacted !== 'alert-only-model-spared') return null;
  if (!record.floorPermitted) return null;
  if (!inWindow(record, nowMs)) return null;
  if (currentCandidateSignature.commandHash !== record.commandHash) return null; // not an evidence event
  if (isSameProcess(currentCandidateSignature, record.targetTuple)) return 'wrong';
  // Same commandHash but a different process — or same pid with un-orderable
  // start-times (same-ness unconfirmable) → lookalike, never a counterfactual.
  return 'unknown';
}

// ── The durable store ───────────────────────────────────────────────────────

/** Per-ledgerKey slots: the latest decision + the retained in-window enacted kill. */
interface HogDecisionSlot {
  latest?: HogDecisionRecord;
  kill?: HogDecisionRecord;
}

interface StoreFileShape {
  readonly version: 1;
  readonly slots: Record<string, { latest?: unknown; kill?: unknown }>;
}

export function hogDecisionStorePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'external-hog-decisions.json');
}

const HOUR_MS = 60 * 60 * 1000;
const VERDICTS: ReadonlySet<string> = new Set(['kill', 'leave', 'alert', 'decider-unavailable']);
const ENACTED: ReadonlySet<string> = new Set([
  'killed', 'sigterm-exited', 'would-kill', 'deferred', 'aborted',
  'alert-only-model-spared', 'alert-only-floor-veto', 'alert-only-breaker-held',
  'alert-only-governor-hold', 'decider-unavailable',
]);

/** A positive-hours config value, else the inline default (never seeded into config — §5.7). */
function hoursOrDefault(v: unknown, defaultHours: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : defaultHours;
}

/** Validate one parsed record member-wise; null = malformed → dropped (fail closed per record). */
function coerceRecord(raw: unknown): HogDecisionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.verdict !== 'string' || !VERDICTS.has(r.verdict)) return null;
  if (typeof r.enacted !== 'string' || !ENACTED.has(r.enacted)) return null;
  if (r.correlationId !== null && typeof r.correlationId !== 'string') return null;
  if (typeof r.atMs !== 'number' || !Number.isFinite(r.atMs)) return null;
  if (typeof r.floorPermitted !== 'boolean') return null;
  if (typeof r.commandHash !== 'string' || r.commandHash.length === 0) return null;
  if (typeof r.effectiveWindowMs !== 'number' || !Number.isFinite(r.effectiveWindowMs) || r.effectiveWindowMs <= 0) return null;
  const t = r.targetTuple as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object' || typeof t.pid !== 'number' || !Number.isInteger(t.pid)) return null;
  if (t.startTimeMs !== null && (typeof t.startTimeMs !== 'number' || !Number.isFinite(t.startTimeMs))) return null;
  const o = r.ownerTuple as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return null;
  if (o.parentPid !== undefined && (typeof o.parentPid !== 'number' || !Number.isInteger(o.parentPid))) return null;
  if (o.parentStartTimeMs !== undefined && (typeof o.parentStartTimeMs !== 'number' || !Number.isFinite(o.parentStartTimeMs))) return null;
  if (r.reFlaggedAtMs !== undefined && (typeof r.reFlaggedAtMs !== 'number' || !Number.isFinite(r.reFlaggedAtMs))) return null;
  return {
    verdict: r.verdict as HogDecisionRecord['verdict'],
    enacted: r.enacted as HogEnactedDisposition,
    correlationId: r.correlationId as string | null,
    atMs: r.atMs,
    targetTuple: { pid: t.pid as number, startTimeMs: t.startTimeMs as number | null },
    ownerTuple: {
      ...(o.parentPid !== undefined ? { parentPid: o.parentPid as number } : {}),
      ...(o.parentStartTimeMs !== undefined ? { parentStartTimeMs: o.parentStartTimeMs as number } : {}),
    },
    floorPermitted: r.floorPermitted,
    commandHash: r.commandHash,
    effectiveWindowMs: r.effectiveWindowMs,
    ...(r.reFlaggedAtMs !== undefined ? { reFlaggedAtMs: r.reFlaggedAtMs as number } : {}),
  };
}

export interface ExternalHogDecisionStoreOpts {
  readonly stateDir: string;
  /** The agent config object — read for `provenance.quality.{evidenceWindowHours,
   *  gradingSlackHours}` (inline defaults 6h/2h; deliberately unseeded, §5.7). */
  readonly config?: { provenance?: { quality?: { evidenceWindowHours?: number; gradingSlackHours?: number } } };
  /** The P19 kill-ledger breaker window (the sentinel's `opts.breaker.windowMs`) —
   *  retention must cover it (§5.3 retention derivation). */
  readonly killLedgerBreakerWindowMs: number;
  /** WALL clock, epoch ms (default Date.now). NOT the scan tick's monotonic
   *  clock — the store is durable across restarts. Injected for tests. */
  readonly nowMs?: () => number;
  /**
   * Seam dry-run flag (llm-decision-quality-meter §5.2/§5.7). Defaults TRUE —
   * mirroring the recorder's `dryRun !== false` SAFE default (a store built
   * without the flag suppresses writes rather than silently persisting on a dark
   * seam). While dryRun holds, `record()` still runs grade-on-supersede
   * IN-MEMORY (so the annotate seam's would-write soak stays complete) but
   * SUPPRESSES the durable persist — the spec's "dry-run suppresses all durable
   * writes" invariant — emitting a metadata-only would-write log line instead.
   * The caller RESOLVES the value the same way the recorder does
   * (`config.provenance.uniformSeam.dryRun !== false`) and threads it here.
   */
  readonly dryRun?: boolean;
  /** Metadata-only would-write logger for the dryRun stage (default no-op). */
  readonly log?: (msg: string) => void;
}

export class ExternalHogDecisionStore {
  private readonly file: string;
  private readonly clock: () => number;
  private readonly slots = new Map<string, HogDecisionSlot>();
  /** The evidence window in force (config-derived; recorded per record). */
  readonly evidenceWindowMs: number;
  readonly gradingSlackMs: number;
  /** §5.3 derivation: max(evidenceWindowMs + gradingSlackMs, killLedgerBreakerWindowMs). */
  readonly retentionMs: number;
  /** Seam dry-run (§5.2): suppresses the durable persist; grade-on-supersede still runs in-memory. */
  private readonly dryRun: boolean;
  private readonly log: (msg: string) => void;

  constructor(opts: ExternalHogDecisionStoreOpts) {
    this.file = hogDecisionStorePath(opts.stateDir);
    this.clock = opts.nowMs ?? Date.now;
    const quality = opts.config?.provenance?.quality;
    this.evidenceWindowMs = hoursOrDefault(quality?.evidenceWindowHours, 6) * HOUR_MS;
    this.gradingSlackMs = hoursOrDefault(quality?.gradingSlackHours, 2) * HOUR_MS;
    const breakerMs = Number.isFinite(opts.killLedgerBreakerWindowMs) && opts.killLedgerBreakerWindowMs > 0
      ? opts.killLedgerBreakerWindowMs : 0;
    this.retentionMs = Math.max(this.evidenceWindowMs + this.gradingSlackMs, breakerMs);
    // §5.2/§5.7: dryRun defaults TRUE (the recorder's `!== false` safe default) —
    // a store built without the flag suppresses durable writes rather than
    // silently persisting on a dark seam.
    this.dryRun = opts.dryRun !== false;
    this.log = opts.log ?? (() => {});
    this.hydrate(); // fail-closed: any anomaly → empty store
  }

  /** FAIL-CLOSED hydration (the ArmStore posture): missing / unreadable /
   *  corrupt / wrong-shape file → empty; a malformed record is dropped. */
  private hydrate(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      const slots = (parsed as StoreFileShape).slots;
      if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return;
      for (const [key, raw] of Object.entries(slots)) {
        if (!raw || typeof raw !== 'object') continue;
        const latest = coerceRecord((raw as { latest?: unknown }).latest);
        const kill = coerceRecord((raw as { kill?: unknown }).kill);
        if (!latest && !kill) continue;
        this.slots.set(key, { ...(latest ? { latest } : {}), ...(kill ? { kill } : {}) });
      }
    } catch {
      // @silent-fallback-ok: FAIL-CLOSED read is this store's documented contract (the
      // ExternalHogArmStore posture, spec §5.3): a damaged decision file yields an EMPTY
      // store — decisions then age out `unknown` (honest) rather than grading over
      // half-parsed ground truth. Never a throw into sentinel construction.
      this.slots.clear();
    }
  }

  /** The on-disk shape for the current in-memory slots (shared by persist + the dryRun would-write sizer). */
  private buildShape(): StoreFileShape {
    const shape: StoreFileShape = { version: 1, slots: {} };
    for (const [key, slot] of this.slots) {
      (shape.slots as Record<string, unknown>)[key] = {
        ...(slot.latest ? { latest: slot.latest } : {}),
        ...(slot.kill ? { kill: slot.kill } : {}),
      };
    }
    return shape;
  }

  /** Atomic + durable persist (tmp → fsync → rename, 0600) — the ArmStore write posture. */
  private persist(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const shape = this.buildShape();
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(shape, null, 2));
      fs.fsyncSync(fd); // durable: content on disk before the rename publishes it
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file); // atomic overwrite — a reader sees old-or-new, never partial
  }

  /**
   * §5.2 dryRun stage: the durable persist is suppressed, so emit a METADATA-ONLY
   * would-write line instead — ledgerKey count + serialized byte size, NEVER the
   * record content (the same posture the recorder's would-write line keeps). The
   * in-memory slots have already been mutated by `record()`, so this reflects what
   * WOULD have been written.
   */
  private logWouldPersist(): void {
    let bytes = -1;
    try {
      bytes = Buffer.byteLength(JSON.stringify(this.buildShape()), 'utf8');
    } catch {
      // @silent-fallback-ok: byte sizing feeds a metadata-only would-write log line
      // (the write is already suppressed); an unserializable shape reports -1 rather
      // than throwing into the scan tick the store observes.
      bytes = -1;
    }
    this.log(`[decision-quality] dryRun would-persist hog-store: ledgerKeys=${this.slots.size} bytes=${bytes}`);
  }

  /** Prune on write at the derived retention (per record; empty keys dropped). */
  private prune(nowMs: number): void {
    for (const [key, slot] of this.slots) {
      if (slot.latest && nowMs - slot.latest.atMs > this.retentionMs) delete slot.latest;
      if (slot.kill && nowMs - slot.kill.atMs > this.retentionMs) delete slot.kill;
      if (!slot.latest && !slot.kill) this.slots.delete(key);
    }
  }

  /** The retained slots for one ledgerKey (grading/test read). */
  get(ledgerKey: string): { latest?: HogDecisionRecord; kill?: HogDecisionRecord } | undefined {
    const slot = this.slots.get(ledgerKey);
    if (!slot) return undefined;
    return { ...(slot.latest ? { latest: slot.latest } : {}), ...(slot.kill ? { kill: slot.kill } : {}) };
  }

  /** Every retained record with its key + slot — the P9 grading endpoint's read
   *  (window-close evaluation via evaluateHogSustainedRight over these rows). */
  list(): Array<{ ledgerKey: string; slot: 'latest' | 'kill'; record: HogDecisionRecord }> {
    const out: Array<{ ledgerKey: string; slot: 'latest' | 'kill'; record: HogDecisionRecord }> = [];
    for (const [ledgerKey, slot] of this.slots) {
      if (slot.latest) out.push({ ledgerKey, slot: 'latest', record: slot.latest });
      if (slot.kill && !(slot.latest && sameStoredDecision(slot.kill, slot.latest))) out.push({ ledgerKey, slot: 'kill', record: slot.kill });
    }
    return out;
  }

  /**
   * Write ONE decision (grade-on-supersede FIRST, §5.3): evaluates the positive-evidence
   * predicates against the OUTGOING record(s) for this ledgerKey — the incoming decision IS the
   * same-commandHash re-flag event — and returns the grade events to the caller BEFORE the slot
   * is replaced. Also stamps the retained in-window kill slot's `reFlaggedAtMs` (destroying the
   * window-close negative evidence honestly), applies the slot semantics (an incoming ENACTED
   * kill takes the kill slot; a non-kill NEVER evicts it), prunes at retention, and persists
   * atomically. Throws only on a persist failure (the caller — the sentinel shell — contains it).
   */
  record(seed: HogDecisionSeed, scan: HogEvidenceScanView): HogGradeEvent[] {
    const nowMs = this.clock();
    const events: HogGradeEvent[] = [];
    const incoming: HogDecisionRecord = {
      verdict: seed.verdict,
      enacted: seed.enacted,
      correlationId: seed.correlationId,
      atMs: nowMs,
      targetTuple: seed.targetTuple,
      ownerTuple: seed.ownerTuple,
      floorPermitted: seed.floorPermitted,
      commandHash: seed.commandHash,
      effectiveWindowMs: this.evidenceWindowMs,
    };

    const slot = this.slots.get(seed.ledgerKey);
    if (slot) {
      // ── Grade-on-supersede: the OUTGOING records are graded BEFORE replacement. ──
      if (slot.kill) {
        const grade = evaluateHogRespawnWrong(slot.kill, scan, nowMs);
        if (grade) {
          events.push({
            ruleId: HOG_RESPAWN_WRONG_RULE_ID, grade,
            correlationId: slot.kill.correlationId, ledgerKey: seed.ledgerKey,
            windowMs: slot.kill.effectiveWindowMs,
            evidenceNote: `same-commandHash respawn at supersede; enacted=${slot.kill.enacted}; ordering-test=${grade === 'wrong' ? 'true' : 'false-or-unorderable'}`,
          });
        }
        // The supersede IS a same-key re-flag: stamp it while the kill's window is open
        // so hog-sustained-right-v1 can never grade a re-flagged kill `right`.
        if (inWindow(slot.kill, nowMs) && slot.kill.reFlaggedAtMs === undefined) {
          slot.kill = { ...slot.kill, reFlaggedAtMs: nowMs };
        }
      }
      // (The leave-recurrence preconditions — verdict 'leave' — make a latest-that-IS-the-kill
      // a structural no-op here; the guard just skips the redundant evaluation.)
      if (slot.latest && !(slot.kill && sameStoredDecision(slot.latest, slot.kill))) {
        const grade = evaluateHogLeaveRecurrence(
          slot.latest,
          { pid: seed.targetTuple.pid, startTimeMs: seed.targetTuple.startTimeMs, commandHash: seed.commandHash },
          nowMs,
        );
        if (grade) {
          events.push({
            ruleId: HOG_LEAVE_RECURRENCE_RULE_ID, grade,
            correlationId: slot.latest.correlationId, ledgerKey: seed.ledgerKey,
            windowMs: slot.latest.effectiveWindowMs,
            evidenceNote: `same-commandHash re-flag at supersede; same-process=${grade === 'wrong' ? 'true' : 'false-or-unconfirmable'}`,
          });
        }
      }
    }

    // ── Replace: latest always; the kill slot ONLY for an incoming ENACTED kill
    //    (a same-key flood of non-kill decisions can never evict a kill's
    //    evidence slot before its window closes — ADV r3). ──
    const next: HogDecisionSlot = this.slots.get(seed.ledgerKey) ?? {};
    next.latest = incoming;
    if (HOG_KILL_ENACTED.has(seed.enacted)) next.kill = incoming;
    this.slots.set(seed.ledgerKey, next);

    this.prune(nowMs);
    // §5.2/§5.7: while dryRun holds, ALL durable writes are suppressed (spec
    // Testing: "dry-run suppresses all durable writes") — the hog store's persist
    // included. Grade-on-supersede already ran IN-MEMORY above, so the annotate
    // seam's would-write soak stays complete; only the disk write is withheld
    // until the operator flips dryRun:false.
    if (this.dryRun) {
      this.logWouldPersist();
    } else {
      this.persist();
    }
    return events;
  }
}
