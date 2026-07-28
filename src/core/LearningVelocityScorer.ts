/**
 * LearningVelocityScorer — EXO 3.0's KPI inversion (Salim Ismail, "Your KPI
 * System Is Training You to Miss the Future").
 *
 * Backward-looking operational KPIs (throughput, utilization, efficiency) reward
 * the existing model and suppress the weak signals where the future shows up.
 * EXO 3.0 says measure **learning velocity** instead — adaptability,
 * experimentation, capability creation. Instar already emits the raw learning
 * events (registered learnings, Playbook items added, corrections captured,
 * evolution actions); this scorer turns them into a velocity + trend + diversity
 * signal so an org can watch how fast it's *learning*, not just how much it's
 * *producing*.
 *
 * Pure + deterministic so it's testable and reproducible. The route gathers the
 * real events; this computes the metric.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface LearningEvent {
  /** ISO timestamp of the learning event. */
  timestamp: string;
  /** Category: 'learning' | 'playbook' | 'correction' | 'evolution' | 'memory' | string. */
  type: string;
}

export type VelocityTrend = 'accelerating' | 'steady' | 'declining' | 'insufficient-data';

export interface LearningVelocityResult {
  windowDays: number;
  totalEvents: number;
  /** Events per day across the window. */
  eventsPerDay: number;
  /** Count by event type. */
  byType: Record<string, number>;
  /** Distinct learning categories seen (a diversity proxy). */
  typeDiversity: number;
  /** First-half vs second-half comparison of the window. */
  trend: VelocityTrend;
  /** 0–100, blends velocity (capped) and category diversity. */
  adaptabilityScore: number;
  reason: string;
}

// ── Tunables ─────────────────────────────────────────────────────────

const MIN_EVENTS_FOR_TREND = 4;
/** events/day at which the velocity component saturates to 100. */
const VELOCITY_SATURATION = 3;
const KNOWN_TYPES = ['learning', 'playbook', 'correction', 'evolution', 'memory'];

// ── Public API ───────────────────────────────────────────────────────

export function computeLearningVelocity(
  events: LearningEvent[],
  nowIso: string,
  windowDays = 30,
): LearningVelocityResult {
  const now = Date.parse(nowIso);
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  const midpoint = now - windowMs / 2;

  const inWindow = events.filter((e) => {
    const t = Date.parse(e.timestamp);
    return !Number.isNaN(t) && t >= cutoff && t <= now;
  });

  const byType: Record<string, number> = {};
  let firstHalf = 0;
  let secondHalf = 0;
  for (const e of inWindow) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (Date.parse(e.timestamp) >= midpoint) secondHalf++;
    else firstHalf++;
  }

  const totalEvents = inWindow.length;
  const eventsPerDay = windowDays > 0 ? totalEvents / windowDays : 0;
  const typeDiversity = Object.keys(byType).length;

  let trend: VelocityTrend;
  if (totalEvents < MIN_EVENTS_FOR_TREND) {
    trend = 'insufficient-data';
  } else if (secondHalf > firstHalf * 1.2) {
    trend = 'accelerating';
  } else if (secondHalf < firstHalf * 0.8) {
    trend = 'declining';
  } else {
    trend = 'steady';
  }

  // Adaptability: 70% velocity (saturating) + 30% category diversity.
  const velocityComponent = Math.min(1, eventsPerDay / VELOCITY_SATURATION);
  const diversityComponent = Math.min(1, typeDiversity / KNOWN_TYPES.length);
  const adaptabilityScore = Math.round((velocityComponent * 0.7 + diversityComponent * 0.3) * 100);

  const reason =
    totalEvents === 0
      ? `No learning events in the last ${windowDays} days — the org may be optimizing the old model rather than learning. (This metric is the EXO 3.0 antidote to backward-looking KPIs.)`
      : `${totalEvents} learning event(s) over ${windowDays}d (${eventsPerDay.toFixed(2)}/day) across ${typeDiversity} categor${typeDiversity === 1 ? 'y' : 'ies'}; trend ${trend}. Adaptability ${adaptabilityScore}/100.`;

  return { windowDays, totalEvents, eventsPerDay, byType, typeDiversity, trend, adaptabilityScore, reason };
}
