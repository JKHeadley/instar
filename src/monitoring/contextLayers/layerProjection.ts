/**
 * H1 and H2 from the topic-intent awareness projection
 * (context-budget-layered-summaries §6 rows H1/H2, §6.3, §6.4).
 *
 * H1 (recent effort) is the awareness "current work" level; H2 (the current
 * phase) is the active arc's level, PRESENT ONLY WHEN A PHASE EXISTS (§6.3):
 * deterministic on the extractor's arc structure — the active arc has been
 * updated across more than one milestone (at least `PHASE_MIN_TURNS` turns
 * since it started). A topic that is a stream of unrelated small requests has
 * no H2, and its record is removed so the packet can say so.
 *
 * Each record carries `author` and `asOf` (§6), and `origin: tool` with the
 * sampled count when the update came from a transcript-growth tick (§6.4).
 *
 * Freshness: every rendered layer line states `as of <time>, <n> messages
 * behind`, computed against TopicMemory. An unknown distance reads
 * `stale: unknown`, never fresh.
 */
import type { TopicAwarenessState, AwarenessLayer } from '../../core/TopicAwareness.js';
import type { LayerStore, LayerAuthor, StoredRecord } from './LayerStore.js';

export const PHASE_MIN_TURNS = 2;
/** §Defaults "Layer freshness target": H1 ≤ 2 user turns behind. */
export const H1_TARGET_USER_TURNS = 2;

export interface ProjectionContext {
  machine: string;
  model: string | null;
  sessionId: string | null;
  /** The TopicMemory message id this update covers (null for a tick with no new message). */
  lastMessageId: number | null;
  origin: 'message' | 'tool';
  /** For a tick: tool results sampled into the update. */
  sampled?: number;
}

function layerData(l: AwarenessLayer, ctx: ProjectionContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: l.goal, trend: l.trend, themes: [...l.themes],
    sourceMessageId: l.sourceMessageId, sourceSpeaker: l.sourceSpeaker, sourceTurn: l.sourceTurn,
    origin: ctx.origin,
    ...(ctx.origin === 'tool' ? { disclosure: `${ctx.sampled ?? 0} results sampled` } : {}),
    ...extra,
  };
}

/**
 * §6.3: a phase is a stretch of work with its own goal spanning more than one
 * milestone. Deterministic on the arc structure: the active arc was opened by
 * a real boundary (explicit or detected, never the topic's initial arc — a
 * stream of unrelated small requests stays on its initial arc and has no H2)
 * and has run across at least PHASE_MIN_TURNS turns.
 */
export function phasePresent(a: TopicAwarenessState): boolean {
  const arc = a.arcs.find((x) => x.arcId === a.currentArcId);
  if (!arc || arc.status !== 'active' || arc.boundaryKind === 'initial') return false;
  return a.turnAtUpdate - arc.startedTurn >= PHASE_MIN_TURNS;
}

export interface ProjectionResult {
  h1: 'written' | 'failed';
  h2: 'written' | 'absent' | 'failed';
}

/** Mirror the awareness projection into the layer store. Never throws. */
export function projectAwareness(store: LayerStore, topicKey: string, a: TopicAwarenessState, ctx: ProjectionContext): ProjectionResult {
  const author: LayerAuthor = { sessionId: ctx.sessionId, machine: ctx.machine, model: ctx.model, kind: 'derived' };
  const at = Date.parse(a.updatedAt);
  const asOf = { at: Number.isFinite(at) ? at : Date.now(), lastMessageId: ctx.lastMessageId };
  const out: ProjectionResult = { h1: 'failed', h2: 'failed' };
  try {
    const r = store.writeDerived(topicKey, 'h1', 'current', layerData(a.currentWork, ctx, { turn: a.turnAtUpdate }), { author, asOf, status: ctx.origin === 'tool' ? 'tool' : 'live' });
    out.h1 = r.written ? 'written' : 'failed';
  } catch { /* @silent-fallback-ok — reported as failed to the caller, which counts it */ }
  try {
    const arc = a.arcs.find((x) => x.arcId === a.currentArcId);
    const prev = store.read(topicKey, 'h2', 'current');
    if (arc && phasePresent(a)) {
      // §6 "Updated: every arc change": rewritten (and re-replicated) only when the phase moved.
      const same = prev?.status === 'live' && prev.data.arcId === arc.arcId && prev.data.goal === arc.layer.goal
        && prev.data.trend === arc.layer.trend && JSON.stringify(prev.data.themes) === JSON.stringify(arc.layer.themes);
      if (same) { out.h2 = 'written'; }
      else {
        const r = store.writeDerived(topicKey, 'h2', 'current', layerData(arc.layer, ctx, { arcId: arc.arcId, startedTurn: arc.startedTurn, sequence: arc.sequence, ...(arc.boundaryMessageId ? { boundaryMessageId: arc.boundaryMessageId } : {}) }), { author, asOf, status: 'live' });
        out.h2 = r.written ? 'written' : 'failed';
      }
    } else {
      // No phase: an explicit `absent` record (it replicates, unlike a local delete), so every machine — and the packet — says so.
      if (prev?.status !== 'absent') store.writeDerived(topicKey, 'h2', 'current', { present: false }, { author, asOf, status: 'absent' });
      out.h2 = 'absent';
    }
  } catch { /* @silent-fallback-ok — reported as failed to the caller, which counts it */ }
  return out;
}

export interface Freshness {
  asOf: number;
  /** Messages stored after the stamp; null = unknown. */
  messagesBehind: number | null;
  userTurnsBehind: number | null;
  stale: boolean | 'unknown';
  line: string;
}

/** The freshness of a stored layer record against TopicMemory (§6, §Defaults freshness target). */
export function layerFreshness(
  record: Pick<StoredRecord, 'asOf'>,
  countAfter: (lastMessageId: number) => { total: number; fromUser: number } | null,
  targetUserTurns = H1_TARGET_USER_TURNS,
): Freshness {
  const asOf = record.asOf.at;
  const when = new Date(asOf).toISOString();
  if (record.asOf.lastMessageId === null) {
    return { asOf, messagesBehind: null, userTurnsBehind: null, stale: 'unknown', line: `as of ${when}, stale: unknown` };
  }
  let c: { total: number; fromUser: number } | null = null;
  try { c = countAfter(record.asOf.lastMessageId); } catch { c = null; /* @silent-fallback-ok — unknown distance renders as stale: unknown */ }
  if (!c) return { asOf, messagesBehind: null, userTurnsBehind: null, stale: 'unknown', line: `as of ${when}, stale: unknown` };
  return {
    asOf, messagesBehind: c.total, userTurnsBehind: c.fromUser, stale: c.fromUser > targetUserTurns,
    line: `as of ${when}, ${c.total} messages behind`,
  };
}
