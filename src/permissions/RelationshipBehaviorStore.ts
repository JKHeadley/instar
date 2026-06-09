/**
 * RelationshipBehaviorStore — the durable, deterministic behavioral baseline per
 * principal (Pillar 3, §7.1). This is the substrate the RelationshipAnomalyScorer
 * reads to answer "does this request feel like THEM?".
 *
 * Why a dedicated store (vs reusing RelationshipManager):
 *   RelationshipManager is generic, cross-platform relationship memory (themes,
 *   notes, a free-text communicationStyle). It has no structured per-request history
 *   — no action-tier histogram, no time-of-day distribution, no message-shape stats
 *   — which is exactly what a CHEAP, DETERMINISTIC anomaly baseline needs. Rather
 *   than retrofit privacy-sensitive structured tracking onto the generic manager,
 *   this module keeps a small, Slack-permission-scoped, privacy-respecting baseline:
 *   SHAPE only (which action labels, what tier, what hour, how long the message was),
 *   NEVER message content. The seam mirrors the rest of the permissions module — it
 *   depends on nothing in core; the gate/observer inject it.
 *
 * Privacy: we store action LABELS, tier counts, hour-of-day counts, and coarse
 * message-length stats. We do NOT store message text, topics, or any free text.
 *
 * State category: `slack-relationship-baselines` (state-coherence-registry.json).
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §7.1–7.2, §7.6.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A single recorded interaction's SHAPE (never content). */
export interface BehaviorObservation {
  /** Action label from the intent classifier (e.g. 'read', 'prod-deploy'). */
  action: string;
  /** Sensitivity tier 0..4. */
  tier: number;
  /** Local hour-of-day 0..23 the request arrived. */
  hour: number;
  /** Message length in characters (coarse style signal). */
  length: number;
  /** Whether the message carried urgency/pressure language (cheap style signal). */
  urgent: boolean;
}

/**
 * The aggregated, privacy-respecting baseline for one principal. All counts; no
 * content. Persisted as JSON; cheap to read and update.
 */
export interface PrincipalBehaviorProfile {
  slackUserId: string;
  /** Total observations recorded — the DEPTH of the baseline (drives confidence). */
  interactionCount: number;
  /** Count per action label — the principal's normal repertoire. */
  actionCounts: Record<string, number>;
  /** Count per sensitivity tier (index 0..4). */
  tierCounts: number[];
  /** Count per local hour-of-day (index 0..23) — the principal's normal rhythm. */
  hourCounts: number[];
  /** Running mean + count of message length, for a coarse style baseline (Welford-free, count-weighted). */
  lengthSum: number;
  lengthSqSum: number;
  /** How often this principal uses urgency language at baseline (0..1 derived from count). */
  urgentCount: number;
  /** First / last observation ISO timestamps. */
  firstSeen: string;
  lastSeen: string;
}

function emptyProfile(slackUserId: string, now: string): PrincipalBehaviorProfile {
  return {
    slackUserId,
    interactionCount: 0,
    actionCounts: {},
    tierCounts: [0, 0, 0, 0, 0],
    hourCounts: new Array(24).fill(0),
    lengthSum: 0,
    lengthSqSum: 0,
    urgentCount: 0,
    firstSeen: now,
    lastSeen: now,
  };
}

/** Validate a slackUserId for safe use as a filename key (prevents path traversal). */
function isSafeKey(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export class RelationshipBehaviorStore {
  private readonly file: string;
  private readonly now: () => string;

  constructor(stateDir: string, now: () => string = () => new Date().toISOString()) {
    /* state-registry: slack-relationship-baselines */
    this.file = path.join(stateDir, 'slack-relationship-baselines.json');
    this.now = now;
  }

  get path(): string {
    return this.file;
  }

  /**
   * Record an observation for a principal, growing their baseline. Best-effort:
   * a write failure is swallowed (this is observe-only infra; it must never break
   * the message path). No-op for an unsafe key (defensive).
   */
  record(slackUserId: string, obs: BehaviorObservation): void {
    if (!slackUserId || !isSafeKey(slackUserId)) return;
    try {
      const all = this.readAll();
      const now = this.now();
      const prof = all[slackUserId] ?? emptyProfile(slackUserId, now);
      prof.interactionCount += 1;
      prof.actionCounts[obs.action] = (prof.actionCounts[obs.action] ?? 0) + 1;
      const tier = Math.max(0, Math.min(4, Math.floor(obs.tier)));
      prof.tierCounts[tier] = (prof.tierCounts[tier] ?? 0) + 1;
      const hour = Math.max(0, Math.min(23, Math.floor(obs.hour)));
      prof.hourCounts[hour] = (prof.hourCounts[hour] ?? 0) + 1;
      const len = Math.max(0, Math.floor(obs.length));
      prof.lengthSum += len;
      prof.lengthSqSum += len * len;
      if (obs.urgent) prof.urgentCount += 1;
      prof.lastSeen = now;
      all[slackUserId] = prof;
      this.writeAll(all);
    } catch {
      // Observe-only baseline must NEVER break the message path.
    }
  }

  /** The current baseline for a principal, or undefined if none recorded yet. */
  profileFor(slackUserId: string | undefined): PrincipalBehaviorProfile | undefined {
    if (!slackUserId || !isSafeKey(slackUserId)) return undefined;
    try {
      return this.readAll()[slackUserId];
    } catch {
      return undefined;
    }
  }

  /** All profiles (for the read route / inspection). */
  all(): Record<string, PrincipalBehaviorProfile> {
    try {
      return this.readAll();
    } catch {
      return {};
    }
  }

  private readAll(): Record<string, PrincipalBehaviorProfile> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, PrincipalBehaviorProfile>;
    } catch {
      return {};
    }
  }

  private writeAll(all: Record<string, PrincipalBehaviorProfile>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Atomic-ish write: temp + rename so a crash can't truncate the baseline file.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}

// ── Derived baseline metrics (pure helpers; used by the scorer + tests) ──────────

/** Mean message length, or undefined when there is no data. */
export function meanLength(prof: PrincipalBehaviorProfile): number | undefined {
  return prof.interactionCount > 0 ? prof.lengthSum / prof.interactionCount : undefined;
}

/** Population standard deviation of message length, or undefined when <2 samples. */
export function stdLength(prof: PrincipalBehaviorProfile): number | undefined {
  if (prof.interactionCount < 2) return undefined;
  const mean = prof.lengthSum / prof.interactionCount;
  const variance = prof.lengthSqSum / prof.interactionCount - mean * mean;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/** Fraction of baseline interactions in a given hour (0..1). */
export function hourFraction(prof: PrincipalBehaviorProfile, hour: number): number {
  if (prof.interactionCount <= 0) return 0;
  const h = Math.max(0, Math.min(23, Math.floor(hour)));
  return (prof.hourCounts[h] ?? 0) / prof.interactionCount;
}

// ── Bridge to the simpler BaselineProvider interface ─────────────────────────────
// Lets the existing HeuristicAnomalyScorer (which speaks `PrincipalBaseline`) read the
// durable store instead of staying inert with no baselines. The richer signals live in
// RelationshipAnomalyScorer; this bridge keeps the placeholder scorer wired-and-real.

import type { BaselineProvider, PrincipalBaseline } from './AnomalyScorer.js';
import type { Principal } from './types.js';

export class StoreBaselineProvider implements BaselineProvider {
  constructor(private readonly store: RelationshipBehaviorStore) {}

  baselineFor(principal: Principal): PrincipalBaseline | undefined {
    const prof = this.store.profileFor(principal.slackUserId);
    if (!prof) return undefined;
    return {
      typicalActions: Object.keys(prof.actionCounts),
      interactionCount: prof.interactionCount,
    };
  }
}
