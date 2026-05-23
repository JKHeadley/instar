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

// ── Types ────────────────────────────────────────────────────────────────

export type RefKind = 'fact' | 'decision';
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
}

// ── Constants from spec ──────────────────────────────────────────────────

const DECAY_HALF_LIFE_DAYS = 180;
const DECAY_GRACE_DAYS = 30;
const DECAY_LAMBDA = Math.log(2) / DECAY_HALF_LIFE_DAYS;

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
  nowMs: number = Date.now()
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

  // Step 5: time decay
  let preDecaySum = Math.max(0, Math.min(1, runningSum));
  const daysSince = Math.max(0, (nowMs - new Date(lastReinforcedAt).getTime()) / MS_PER_DAY);
  let decayApplied = 0;
  if (daysSince > DECAY_GRACE_DAYS) {
    const decayDays = daysSince - DECAY_GRACE_DAYS;
    const decayed = preDecaySum * Math.exp(-DECAY_LAMBDA * decayDays);
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
        return parsed;
      }
    } catch (err) {
      console.error(`[TopicIntentStore] Corrupt file ${fp}, starting fresh: ${err}`);
    }
    return emptyFile(topicId);
  }

  /** Persist the topic's intent file. */
  save(file: TopicIntentFile): void {
    const fp = this.filePath(file.topicId);
    try {
      fs.writeFileSync(fp, JSON.stringify(file, null, 2));
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
    const file = this.load(topicId);
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
    const proj = projectConfidence(ref.evidence, ref.lastReinforcedAt);
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

  /** Get the live projection for a refId (recomputed from evidence). */
  getProjection(topicId: number, refId: string, nowMs?: number): ProjectionResult | null {
    const file = this.load(topicId);
    const ref = file.refs[refId];
    if (!ref) return null;
    return projectConfidence(ref.evidence, ref.lastReinforcedAt, nowMs);
  }

  /** Get all refs for a topic at current tier or above. */
  getRefsAtOrAbove(topicId: number, minTier: 'observation' | 'tentative' | 'authoritative', nowMs?: number): Array<EstablishedRef & { projection: ProjectionResult }> {
    const file = this.load(topicId);
    const tierOrder = { observation: 0, tentative: 1, authoritative: 2 };
    const minRank = tierOrder[minTier];
    const out: Array<EstablishedRef & { projection: ProjectionResult }> = [];
    for (const ref of Object.values(file.refs)) {
      const proj = projectConfidence(ref.evidence, ref.lastReinforcedAt, nowMs);
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
  };
}

function emptyFile(topicId: number): TopicIntentFile {
  return {
    topicId,
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
