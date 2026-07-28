/**
 * TopicIntent — per-topic semantic state tracking via continuous confidence.
 *
 * Layer 1 of the Topic Intent Layer spec (v14 CLEAN, approved 2026-05-22).
 * See docs/specs/topic-intent-layer.md.
 *
 * Tracks candidate facts and decisions extracted from conversation. Each
 * EstablishedRef accumulates evidence over multi-turn exchange; confidence
 * is computed on read as a deterministic projection over the append-only
 * event log.
 *
 * Framework-agnostic: pure JSON persistence, pure math projection. Reachable
 * from Claude Code and Codex sessions alike.
 *
 * Storage: {stateDir}/topic-intent/<topicId>.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SafeFsExecutor } from './SafeFsExecutor.js';

// ── Types ────────────────────────────────────────────────────────────────

export type RefKind = 'fact' | 'decision' | 'method' | 'audience' | 'goal';

/**
 * Task-context kinds (rung 1) describe the *working frame* of the active task
 * — how it's being done, who it's for, what it's trying to achieve — as opposed
 * to facts/decisions the conversation asserts. They are the category that caused
 * the founding methodology-drift incident ("we're testing over Telegram").
 */
export const TASK_CONTEXT_KINDS: ReadonlySet<RefKind> = new Set<RefKind>(['method', 'audience', 'goal']);

export function isTaskContextKind(kind: RefKind): boolean {
  return TASK_CONTEXT_KINDS.has(kind);
}
export type RefStatus = 'live' | 'conflicted';

export type EvidenceKind =
  | 'extract-user'              // initial extraction from user message  → +0.40, userAuthored
  | 'extract-agent'             // initial extraction from agent message → +0.10, NOT userAuthored
  | 'user-reref'                // user re-references the refId          → +0.10 per episode, cap +0.30, userAuthored
  | 'agent-reref'               // agent re-references; user doesn't contradict → +0.01 per occurrence, cap +0.05, NOT userAuthored
  | 'user-affirm'               // explicit user affirmation anchored to refId → +0.30, userAuthored
  | 'pending-confirm-positive'  // pending confirmation answered yes      → +0.50, userAuthored
  | 'pending-confirm-negative'  // pending confirmation answered no       → -0.70, userAuthored
  | 'contradiction'             // user contradicts the refId             → -0.60, userAuthored
  | 'conflict-mark'             // automatic flag when two refs conflict
  | 'sharpen-retry-issued';     // bookkeeping when ArcCheck retries an ambiguous answer

export interface EvidenceEvent {
  eventId: string;              // UUID
  refId: string;
  kind: EvidenceKind;
  sourceMessageId: string;      // for per-message dedup; deterministic per ingestion path
  userAuthored: boolean;        // gates authority — see authority hard rule
  at: string;                   // ISO8601
  delta: number;                // raw confidence change (before caps)
  meta?: Record<string, unknown>;
}

export interface EstablishedRef {
  refId: string;
  arcId: string;
  topicId: number;
  kind: RefKind;
  text: string;                 // the proposition
  confidence: number;           // computed on read; persisted snapshot is informational
  evidence: EvidenceEvent[];    // append-only
  lastReinforcedAt: string;     // ISO8601 — time of last positive evidence
  status: RefStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PendingConfirmation {
  pendingId: string;
  topicId: number;
  arcId: string;
  refId: string;
  propositionText: string;
  questionText: string;
  sentAtTurn: number;
  sentAtTime: string;
  ttl: { turns: number; hours: number };
  retries: number;
  maxRetries: number;
  status: 'pending' | 'answered' | 'expired' | 'abandoned';
  // For revalidation at dequeue and answer-interpretation auditing
  queuedAtTime?: string;
  dequeuedAtTime?: string;
  answeredAtTime?: string;
  answerVerdict?: 'positive' | 'negative' | 'ambiguous' | 'non-responsive';
}

export interface TopicIntentFile {
  topicId: number;
  /** Per-topic monotonic user-turn counter (v1: single arc per topic). Additive; defaulted on read. */
  turn?: number;
  refs: Record<string, EstablishedRef>;  // refId → ref
  pending: {
    outstanding: PendingConfirmation | null;
    queue: PendingConfirmation[];
  };
  telemetry: TelemetryCounters;
  schemaVersion: 1;
}

export interface TelemetryCounters {
  extraction_total: Record<string, number>;       // keyed by `${kind}:${userAuthored}`
  evidence_event_total: Record<string, number>;   // keyed by kind
  confidence_clamp_authority_total: number;
  pending_confirm_created_total: number;
  pending_confirm_queue_dropped_total: number;
  pending_confirm_abandoned_total: number;
  pending_confirm_expired_total: number;
  pending_confirm_answered_total: Record<string, number>; // keyed by verdict
  /**
   * Capture-loop funnel counters (spec §10 — observability across the WHOLE
   * loop: captured → surfaced → used → corrected). Additive; defaulted on read
   * for back-compat with pre-capture-loop files.
   */
  capture?: CaptureCounters;
}

/**
 * Whole-loop capture funnel (spec §10). Capture side meters what we extracted;
 * surface side meters whether what we captured actually reached the agent and
 * changed anything. Pairing this with the HumanAsDetectorLog miss-heat-map is
 * the effectiveness read.
 */
export interface CaptureCounters {
  // ── capture side (did we extract?) ──
  turns_seen: number;                  // turns the capture loop observed
  prefilter_skipped: number;           // turns the deterministic pre-filter dropped before the LLM
  extractions_attempted: number;       // turns that reached the extractor (LLM call attempted)
  extractions_emitted: number;         // turns that produced ≥1 evidence event
  refs_created: number;                // new refs created (cumulative)
  degraded_no_intelligence: number;    // extractor degraded because no provider was configured
  degraded_cap_or_error: number;       // extractor degraded on cap breach / provider error
  degraded_shed: number;               // turns skipped under QuotaTracker load-shedding
  rate_limited: number;                // turns skipped by the per-topic rate ceiling
  // ── surface + use side (did it reach the agent / change anything?) ──
  briefing_served: number;             // session-start briefing fetched for this topic
  briefing_refs_settled: number;       // cumulative authoritative refs carried by briefings
  briefing_refs_tentative: number;     // cumulative tentative refs carried by briefings
  arccheck_fired: number;              // ArcCheck ran on a pre-send draft
  arccheck_signalled: number;          // ArcCheck emitted a confirm-signal (changed next move)
  last_capture_at: string | null;      // ISO8601 of the most recent extraction attempt
  // rung 1: per-RefKind created breakdown (fact/decision/method/audience/goal) so
  // we can see whether task-frame capture is actually working and tune its decay.
  refkind_created?: Record<string, number>;
}

// ── Constants from spec ──────────────────────────────────────────────────

const DECAY_HALF_LIFE_DAYS = 180;
const DECAY_GRACE_DAYS = 30;
const DECAY_LAMBDA = Math.log(2) / DECAY_HALF_LIFE_DAYS;

/**
 * Per-kind decay profiles (rung 1 — the short/medium/long horizon hierarchy).
 * Facts/decisions keep the original long profile EXACTLY (grace 30 / half-life
 * 180), so rung-0 confidence math is provably unchanged. Task-context kinds
 * fade faster: a method ("testing over Telegram") matters intensely this task
 * and should demote in days, not survive 180. Numbers are tunable knobs (the
 * Observability funnel lets us tune them from real data); the per-kind
 * *mechanism* is the design. Spec: docs/specs/topic-intent-task-context-capture.md §3.
 */
export interface DecayProfile { graceDays: number; halfLifeDays: number }

const LONG_PROFILE: DecayProfile = { graceDays: DECAY_GRACE_DAYS, halfLifeDays: DECAY_HALF_LIFE_DAYS };

/** The built-in defaults (the code-constant baseline; config may override). */
const DEFAULT_DECAY_PROFILES: Record<RefKind, DecayProfile> = {
  fact: { ...LONG_PROFILE },
  decision: { ...LONG_PROFILE },
  method: { graceDays: 1, halfLifeDays: 7 },     // short — the active how
  goal: { graceDays: 2, halfLifeDays: 14 },      // short–medium — the active what
  audience: { graceDays: 3, halfLifeDays: 30 },  // medium — who it's for, persists across a task cluster
};

/**
 * The ACTIVE per-kind decay profiles. Starts as the defaults; an operator may
 * override individual kinds via config (`topicIntent.capture.decayProfiles`)
 * once, at startup, through `configureDecayProfiles`. Process-wide policy —
 * decay is a global tuning knob, not per-call state. (Tracked refinement
 * `cwa-decay-profile-config` of the rung-1 spec, docs/specs/topic-intent-task-context-capture.md §3.)
 */
let activeDecayProfiles: Record<RefKind, DecayProfile> = structuredCloneProfiles(DEFAULT_DECAY_PROFILES);

function structuredCloneProfiles(p: Record<RefKind, DecayProfile>): Record<RefKind, DecayProfile> {
  return {
    fact: { ...p.fact }, decision: { ...p.decision }, method: { ...p.method },
    goal: { ...p.goal }, audience: { ...p.audience },
  };
}

/** A partial per-kind override: any subset of kinds, any subset of {graceDays, halfLifeDays}. */
export type DecayProfileOverrides = Partial<Record<RefKind, Partial<DecayProfile>>>;

/**
 * Apply config overrides on top of the defaults (existence-checked: only the
 * fields/kinds present are changed; everything else keeps the default). Invalid
 * values (non-finite, ≤ 0) are ignored so a bad config can never break decay.
 * Idempotent — always re-derives from DEFAULTS, so calling twice with different
 * overrides doesn't compound. Returns the resolved active profiles.
 */
export function configureDecayProfiles(overrides?: DecayProfileOverrides): Record<RefKind, DecayProfile> {
  const next = structuredCloneProfiles(DEFAULT_DECAY_PROFILES);
  if (overrides) {
    for (const kind of Object.keys(next) as RefKind[]) {
      const o = overrides[kind];
      if (!o) continue;
      if (typeof o.graceDays === 'number' && Number.isFinite(o.graceDays) && o.graceDays > 0) {
        next[kind].graceDays = o.graceDays;
      }
      if (typeof o.halfLifeDays === 'number' && Number.isFinite(o.halfLifeDays) && o.halfLifeDays > 0) {
        next[kind].halfLifeDays = o.halfLifeDays;
      }
    }
  }
  activeDecayProfiles = next;
  return structuredCloneProfiles(next);
}

/** Restore the built-in defaults (primarily for test isolation). */
export function resetDecayProfiles(): void {
  activeDecayProfiles = structuredCloneProfiles(DEFAULT_DECAY_PROFILES);
}

/** Resolve the decay profile for a kind; missing/unknown kind → long profile (rung-0 default). */
export function decayProfileFor(kind?: RefKind): DecayProfile {
  return (kind && activeDecayProfiles[kind]) || LONG_PROFILE;
}

const AUTHORITY_THRESHOLD = 0.7;
const AUTHORITY_CLAMP = 0.69;
const TENTATIVE_THRESHOLD = 0.3;

/** Signal-specific caps. Numeric = max cumulative contribution from that kind. */
const SIGNAL_CAPS: Partial<Record<EvidenceKind, number>> = {
  'user-reref': 0.30,
  'agent-reref': 0.05,
  'extract-agent': 0.10, // initial agent-origin extraction capped at single occurrence value
};

/** Affirmation safety: per-refId per 24h cap. */
const AFFIRM_PER_REF_PER_24H_LIMIT = 1;
/** Per single user message, max number of distinct refIds that may receive affirmation bonus. */
const AFFIRM_PER_MESSAGE_REF_LIMIT = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Default signal deltas (used by helpers; raw spec values) ─────────────

export const SIGNAL_DELTA: Record<EvidenceKind, number> = {
  'extract-user': 0.40,
  'extract-agent': 0.10,
  'user-reref': 0.10,
  'agent-reref': 0.01,
  'user-affirm': 0.30,
  'pending-confirm-positive': 0.50,
  'pending-confirm-negative': -0.70,
  'contradiction': -0.60,
  'conflict-mark': 0,        // marker-only, no delta
  'sharpen-retry-issued': 0, // bookkeeping, no delta
};

export const USER_AUTHORED_BY_DEFAULT: Record<EvidenceKind, boolean> = {
  'extract-user': true,
  'extract-agent': false,
  'user-reref': true,
  'agent-reref': false,
  'user-affirm': true,
  'pending-confirm-positive': true,
  'pending-confirm-negative': true,
  'contradiction': true,
  'conflict-mark': false,
  'sharpen-retry-issued': false,
};

// ── Projection (pure math, fully unit-testable) ──────────────────────────

export interface ProjectionResult {
  confidence: number;
  tier: 'observation' | 'tentative' | 'authoritative';
  authorityClampApplied: boolean;
  decayApplied: number;       // amount subtracted by decay (>= 0)
  evidenceCount: number;      // post-dedup
  userAuthoredEpisodes: number;
}

/**
 * Compute the confidence projection for a single EstablishedRef from its
 * evidence array. Pure function — no I/O, no state, fully deterministic.
 *
 * Order of operations:
 *   1. Per-message dedup by (refId, sourceMessageId): on collision, keep the
 *      single largest applicable delta. (Multiple signals from the same user
 *      message about the same refId count as ONE episode.)
 *   2. Apply signal-specific caps (user-reref cumulative <= +0.30, etc.)
 *   3. Apply affirmation caps (per-refId per 24h, per single user message).
 *   4. Sum applicable deltas (with caps).
 *   5. Apply time decay if (now - lastReinforcedAt) > 30 days.
 *   6. Authority hard clamp: if would-be >= 0.7 and no qualifying
 *      user-authored episode exists, clamp at 0.69.
 *   7. Clamp final to [0.0, 1.0].
 */
export function projectConfidence(
  evidence: EvidenceEvent[],
  lastReinforcedAt: string,
  nowMs: number = Date.now(),
  refKind?: RefKind,
): ProjectionResult {
  // Step 1: per-message dedup — keep largest applicable delta per (refId, sourceMessageId)
  const dedupedByMsg = new Map<string, EvidenceEvent>();
  for (const ev of evidence) {
    const key = `${ev.refId}::${ev.sourceMessageId}`;
    const existing = dedupedByMsg.get(key);
    if (!existing || Math.abs(ev.delta) > Math.abs(existing.delta)) {
      dedupedByMsg.set(key, ev);
    }
  }
  const deduped = Array.from(dedupedByMsg.values());

  // Step 2-3: bucket by kind, apply caps
  const bucketedByKind = new Map<EvidenceKind, EvidenceEvent[]>();
  for (const ev of deduped) {
    if (!bucketedByKind.has(ev.kind)) bucketedByKind.set(ev.kind, []);
    bucketedByKind.get(ev.kind)!.push(ev);
  }

  let runningSum = 0;
  let userAuthoredEpisodes = 0;

  for (const [kind, events] of bucketedByKind) {
    const cap = SIGNAL_CAPS[kind];
    if (cap !== undefined && events.length > 0 && events[0].delta > 0) {
      // Positive-delta capped signal: sum and clamp at cap
      const raw = events.reduce((s, e) => s + e.delta, 0);
      runningSum += Math.min(raw, cap);
    } else if (kind === 'user-affirm') {
      // Affirm safety: enforce per-refId per 24h limit
      // and per single source-message limit of distinct refIds (handled at INSERT time,
      // but defensive in projection too)
      const affirmsByDay = new Map<string, EvidenceEvent[]>();
      for (const ev of events) {
        const dayKey = ev.at.slice(0, 10); // YYYY-MM-DD coarse bucket
        if (!affirmsByDay.has(dayKey)) affirmsByDay.set(dayKey, []);
        affirmsByDay.get(dayKey)!.push(ev);
      }
      let appliedAffirms = 0;
      for (const dayEvents of affirmsByDay.values()) {
        // Sort by time and take only the first AFFIRM_PER_REF_PER_24H_LIMIT
        dayEvents.sort((a, b) => a.at.localeCompare(b.at));
        const allowed = dayEvents.slice(0, AFFIRM_PER_REF_PER_24H_LIMIT);
        appliedAffirms += allowed.reduce((s, e) => s + e.delta, 0);
      }
      runningSum += appliedAffirms;
    } else {
      // Uncapped signal: just sum
      runningSum += events.reduce((s, e) => s + e.delta, 0);
    }

    // Count user-authored episodes (those that qualify for authority)
    for (const ev of events) {
      if (ev.userAuthored && qualifiesAsUserAuthoredEpisode(ev.kind)) {
        userAuthoredEpisodes++;
      }
    }
  }

  // Step 5: time decay — per-kind horizon (rung 1). Omitted kind → long profile
  // (rung-0 behavior, byte-for-byte unchanged for fact/decision).
  const profile = decayProfileFor(refKind);
  const lambda = Math.log(2) / profile.halfLifeDays;
  let preDecaySum = Math.max(0, Math.min(1, runningSum));
  const daysSince = Math.max(0, (nowMs - new Date(lastReinforcedAt).getTime()) / MS_PER_DAY);
  let decayApplied = 0;
  if (daysSince > profile.graceDays) {
    const decayDays = daysSince - profile.graceDays;
    const decayed = preDecaySum * Math.exp(-lambda * decayDays);
    decayApplied = preDecaySum - decayed;
    preDecaySum = decayed;
  }

  // Step 6: authority hard clamp
  let authorityClampApplied = false;
  let finalConf = preDecaySum;
  if (finalConf >= AUTHORITY_THRESHOLD && userAuthoredEpisodes === 0) {
    finalConf = AUTHORITY_CLAMP;
    authorityClampApplied = true;
  }

  // Step 7: final clamp
  finalConf = Math.max(0, Math.min(1, finalConf));

  // Tier classification (emergent)
  let tier: 'observation' | 'tentative' | 'authoritative';
  if (finalConf < TENTATIVE_THRESHOLD) tier = 'observation';
  else if (finalConf < AUTHORITY_THRESHOLD) tier = 'tentative';
  else tier = 'authoritative';

  return {
    confidence: finalConf,
    tier,
    authorityClampApplied,
    decayApplied,
    evidenceCount: deduped.length,
    userAuthoredEpisodes,
  };
}

/**
 * Which evidence kinds count as user-authored EPISODES that qualify for
 * authority? (Distinct from the userAuthored boolean, which is broader.)
 *
 * Per spec: "user-authored episodes are the unit of evidence." Only
 * specific kinds qualify — extraction from user, user re-reference,
 * anchored affirmation, positive pending-confirm answer, contradiction
 * (which is also a user-authored episode in the negative direction).
 */
export function qualifiesAsUserAuthoredEpisode(kind: EvidenceKind): boolean {
  return (
    kind === 'extract-user' ||
    kind === 'user-reref' ||
    kind === 'user-affirm' ||
    kind === 'pending-confirm-positive' ||
    kind === 'pending-confirm-negative' ||
    kind === 'contradiction'
  );
}

// ── Helpers for building events ──────────────────────────────────────────

export function buildEvent(
  refId: string,
  kind: EvidenceKind,
  sourceMessageId: string,
  opts?: { at?: string; userAuthored?: boolean; delta?: number; meta?: Record<string, unknown> }
): EvidenceEvent {
  return {
    eventId: randomUUID(),
    refId,
    kind,
    sourceMessageId,
    userAuthored: opts?.userAuthored ?? USER_AUTHORED_BY_DEFAULT[kind],
    at: opts?.at ?? new Date().toISOString(),
    delta: opts?.delta ?? SIGNAL_DELTA[kind],
    meta: opts?.meta,
  };
}

// ── Store (file-based, framework-agnostic) ───────────────────────────────

export class TopicIntentStore {
  private dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'topic-intent');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      console.error(`[TopicIntentStore] Failed to create dir ${this.dir}: ${err}`);
    }
  }

  private filePath(topicId: number): string {
    return path.join(this.dir, `${topicId}.json`);
  }

  /** Load a topic's intent file, returning an empty skeleton if missing or corrupt. */
  load(topicId: number): TopicIntentFile {
    const fp = this.filePath(topicId);
    try {
      if (fs.existsSync(fp)) {
        const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8')) as TopicIntentFile;
        // Ensure required fields exist (defensive for older files)
        if (!parsed.refs) parsed.refs = {};
        if (!parsed.pending) parsed.pending = { outstanding: null, queue: [] };
        if (!parsed.telemetry) parsed.telemetry = emptyTelemetry();
        if (parsed.schemaVersion === undefined) parsed.schemaVersion = 1;
        if (parsed.turn === undefined) parsed.turn = 0;
        if (!parsed.telemetry.capture) parsed.telemetry.capture = defaultCaptureCounters();
        return parsed;
      }
    } catch (err) {
      console.error(`[TopicIntentStore] Corrupt file ${fp}, starting fresh: ${err}`);
    }
    return emptyFile(topicId);
  }

  /**
   * Persist the topic's intent file ATOMICALLY (write to a unique temp file +
   * rename — rename is atomic on POSIX, so a concurrent reader never sees a
   * torn/half-written file). This is the corruption-safety half of the
   * concurrent-write guard; appendEvidence adds the lost-update guard (CAS).
   */
  save(file: TopicIntentFile): void {
    const fp = this.filePath(file.topicId);
    try {
      const tmp = `${fp}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
      fs.renameSync(tmp, fp);
    } catch (err) {
      console.error(`[TopicIntentStore] Failed to save ${fp}: ${err}`);
    }
  }

  /**
   * Append an evidence event to a refId. Creates the ref if it doesn't exist.
   * Updates lastReinforcedAt if the event has positive delta.
   * Updates telemetry counters.
   */
  appendEvidence(topicId: number, refId: string, ev: EvidenceEvent, refInit?: Partial<EstablishedRef>): TopicIntentFile {
    // Hold a cross-process lock around load→mutate→atomic-save so two sessions
    // capturing the same topic can't lose each other's events (the lost-update
    // race). mkdir is atomic across processes; save() is atomic against torn
    // reads. Together they make the append concurrency-safe.
    return this.withTopicLock(topicId, () => this.applyEvidence(topicId, refId, ev, refInit));
  }

  /**
   * Acquire a per-topic lock (atomic mkdir), run fn, release. Bounded spin with
   * stale-lock steal so a crashed holder can't wedge the file forever. Capture
   * runs off the delivery path (queued), so brief contention spin is acceptable.
   */
  private withTopicLock<T>(topicId: number, fn: () => T): T {
    const lockPath = this.filePath(topicId) + '.lock';
    const deadline = Date.now() + 2000;
    let held = false;
    while (Date.now() < deadline) {
      try {
        fs.mkdirSync(lockPath);
        held = true;
        break;
      } catch {
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 5000) {
            SafeFsExecutor.safeRmdirSync(lockPath, { operation: 'TopicIntentStore.withTopicLock:steal-stale' });
            continue;
          }
        } catch { /* lock vanished — retry acquire */ }
        const until = Date.now() + 15;
        while (Date.now() < until) { /* brief spin */ }
      }
    }
    try {
      return fn();
    } finally {
      if (held) {
        try {
          SafeFsExecutor.safeRmdirSync(lockPath, { operation: 'TopicIntentStore.withTopicLock:release' });
        } catch { /* best-effort release */ }
      }
    }
  }

  /** Single load→mutate→atomic-save pass (runs under withTopicLock). */
  private applyEvidence(topicId: number, refId: string, ev: EvidenceEvent, refInit?: Partial<EstablishedRef>): TopicIntentFile {
    const file = this.load(topicId);
    // Idempotency: never append the same event twice (defends retries / replays).
    for (const existing of Object.values(file.refs)) {
      if (existing.evidence.some(e => e.eventId === ev.eventId)) return file;
    }
    let ref = file.refs[refId];
    if (!ref) {
      ref = {
        refId,
        arcId: refInit?.arcId ?? `arc-${topicId}`,
        topicId,
        kind: refInit?.kind ?? 'fact',
        text: refInit?.text ?? '',
        confidence: 0,
        evidence: [],
        lastReinforcedAt: ev.at,
        status: 'live',
        createdAt: ev.at,
        updatedAt: ev.at,
      };
      file.refs[refId] = ref;
    }

    ref.evidence.push(ev);
    if (ev.delta > 0) {
      ref.lastReinforcedAt = ev.at;
    }
    ref.updatedAt = ev.at;

    // Recompute confidence + tier snapshot for visibility (projection runs on read regardless)
    const proj = projectConfidence(ref.evidence, ref.lastReinforcedAt, undefined, ref.kind);
    ref.confidence = proj.confidence;

    // Telemetry
    const extractKey = `${ev.kind}:${ev.userAuthored}`;
    file.telemetry.extraction_total[extractKey] = (file.telemetry.extraction_total[extractKey] ?? 0) + 1;
    file.telemetry.evidence_event_total[ev.kind] = (file.telemetry.evidence_event_total[ev.kind] ?? 0) + 1;
    if (proj.authorityClampApplied) {
      file.telemetry.confidence_clamp_authority_total++;
    }

    this.save(file);
    return file;
  }

  /** The (single, v1) arc id for a topic. */
  arcIdFor(topicId: number): string {
    return `arc-${topicId}`;
  }

  /** Atomically increment and return the per-topic user-turn counter. */
  bumpTurn(topicId: number): number {
    return this.withTopicLock(topicId, () => {
      const file = this.load(topicId);
      file.turn = (file.turn ?? 0) + 1;
      this.save(file);
      return file.turn;
    });
  }

  /**
   * Atomically increment one or more capture-funnel counters (spec §10).
   * Runs under the per-topic lock so concurrent captures / briefing fetches /
   * arccheck calls don't clobber each other's counter writes. Best-effort —
   * metering must never throw into the path that calls it, so all failures are
   * swallowed (the counter is a diagnostic, not correctness-critical).
   *
   * `at` (when provided) sets `last_capture_at`.
   */
  bumpCaptureCounters(
    topicId: number,
    deltas: Partial<Record<NumericCaptureKey, number>>,
    at?: string,
    refKindsCreated?: RefKind[],
  ): void {
    try {
      this.withTopicLock(topicId, () => {
        const file = this.load(topicId);
        if (!file.telemetry.capture) file.telemetry.capture = defaultCaptureCounters();
        const c = file.telemetry.capture;
        for (const [k, v] of Object.entries(deltas)) {
          if (typeof v === 'number' && Number.isFinite(v)) {
            const key = k as NumericCaptureKey;
            c[key] = (c[key] ?? 0) + v;
          }
        }
        if (at) c.last_capture_at = at;
        if (refKindsCreated && refKindsCreated.length > 0) {
          if (!c.refkind_created) c.refkind_created = {};
          for (const k of refKindsCreated) c.refkind_created[k] = (c.refkind_created[k] ?? 0) + 1;
        }
        this.save(file);
      });
    } catch (err) {
      console.error(`[TopicIntentStore] bumpCaptureCounters(${topicId}) failed: ${err}`);
    }
  }

  /** Get the live projection for a refId (recomputed from evidence). */
  getProjection(topicId: number, refId: string, nowMs?: number): ProjectionResult | null {
    const file = this.load(topicId);
    const ref = file.refs[refId];
    if (!ref) return null;
    return projectConfidence(ref.evidence, ref.lastReinforcedAt, nowMs, ref.kind);
  }

  /** Get all refs for a topic at current tier or above. */
  getRefsAtOrAbove(topicId: number, minTier: 'observation' | 'tentative' | 'authoritative', nowMs?: number): Array<EstablishedRef & { projection: ProjectionResult }> {
    const file = this.load(topicId);
    const tierOrder = { observation: 0, tentative: 1, authoritative: 2 };
    const minRank = tierOrder[minTier];
    const out: Array<EstablishedRef & { projection: ProjectionResult }> = [];
    for (const ref of Object.values(file.refs)) {
      const proj = projectConfidence(ref.evidence, ref.lastReinforcedAt, nowMs, ref.kind);
      if (tierOrder[proj.tier] >= minRank) {
        out.push({ ...ref, projection: proj });
      }
    }
    return out;
  }

  /** Full read of a topic's file (for diagnostics endpoint). */
  read(topicId: number): TopicIntentFile {
    return this.load(topicId);
  }
}

// ── Helpers for empty state ──────────────────────────────────────────────

function emptyTelemetry(): TelemetryCounters {
  return {
    extraction_total: {},
    evidence_event_total: {},
    confidence_clamp_authority_total: 0,
    pending_confirm_created_total: 0,
    pending_confirm_queue_dropped_total: 0,
    pending_confirm_abandoned_total: 0,
    pending_confirm_expired_total: 0,
    pending_confirm_answered_total: {},
    capture: defaultCaptureCounters(),
  };
}

export function defaultCaptureCounters(): CaptureCounters {
  return {
    turns_seen: 0,
    prefilter_skipped: 0,
    extractions_attempted: 0,
    extractions_emitted: 0,
    refs_created: 0,
    degraded_no_intelligence: 0,
    degraded_cap_or_error: 0,
    degraded_shed: 0,
    rate_limited: 0,
    briefing_served: 0,
    briefing_refs_settled: 0,
    briefing_refs_tentative: 0,
    arccheck_fired: 0,
    arccheck_signalled: 0,
    last_capture_at: null,
    refkind_created: {},
  };
}

/** Numeric (additive) capture-counter keys — excludes the timestamp field. */
export type NumericCaptureKey = Exclude<keyof CaptureCounters, 'last_capture_at' | 'refkind_created'>;

function emptyFile(topicId: number): TopicIntentFile {
  return {
    topicId,
    turn: 0,
    refs: {},
    pending: { outstanding: null, queue: [] },
    telemetry: emptyTelemetry(),
    schemaVersion: 1,
  };
}

// ── Re-exports for convenience ───────────────────────────────────────────

export const TOPIC_INTENT_CONSTANTS = {
  DECAY_HALF_LIFE_DAYS,
  DECAY_GRACE_DAYS,
  DECAY_LAMBDA,
  AUTHORITY_THRESHOLD,
  AUTHORITY_CLAMP,
  TENTATIVE_THRESHOLD,
  SIGNAL_CAPS,
  AFFIRM_PER_REF_PER_24H_LIMIT,
  AFFIRM_PER_MESSAGE_REF_LIMIT,
  MS_PER_DAY,
};
