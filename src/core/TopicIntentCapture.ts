/**
 * TopicIntentCapture — the adapter-agnostic capture step that fills the
 * topic-intent store from live conversation (rung 0 of the Continuous Working
 * Awareness north star). Spec: docs/specs/topic-intent-capture-loop.md.
 *
 * This is the "clerk" that was missing: the store, briefing, and ArcCheck all
 * shipped, but nothing ever invoked `ingest()` on a real turn, so the cabinet
 * stayed empty (the textbook "shipped but asleep" bug). This module is the
 * single seam that watches each turn and files what matters.
 *
 * Design invariants (carried from the human-as-detector build + spec):
 *   - Best-effort, NEVER throws into the message/delivery path (acceptance #4).
 *   - Fire-and-forget: extraction runs off the delivery path; capture latency
 *     can never slow a message reaching the user.
 *   - Degrade-safe: no provider, cap breach, or provider error → a counter tick
 *     and a silent no-op, never an error.
 *   - Framework-agnostic: Telegram is merely the first wiring; the helper takes
 *     a generic entry, not a Telegram type.
 *
 * The pre-filter (`isSubstantiveTurn`) is a STATE-DETECTOR per
 * `[[feedback_state_detection_robustness]]`: deterministic + fail-open, shipped
 * with a canary (`runPreFilterCanary`) and registered in
 * docs/specs/06-state-detector-registry.md. Its silent failure mode is
 * sentinel-format drift → over-skip → real captures dropped → the original
 * "no record for the topic" bug recurs.
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import type { TopicIntentStore, EstablishedRef } from './TopicIntent.js';
import type { TopicIntentExtractor, ExtractorInput } from './TopicIntentExtractor.js';

// ── Pre-filter (deterministic state-detector, fail-open) ──────────────────

/**
 * Whole-message acknowledgement patterns. Anchored (^…$) so "ok but actually
 * I think we should switch to X" is NOT treated as a bare ack — only messages
 * that are ENTIRELY an ack are skipped. Fail-open: when unsure, let it through.
 */
const BARE_ACK_RE =
  /^(ok(ay)?|kk?|y(es|ep|eah|up)?|n(o|ope)?|thx|thanks?|thank you|ty|got it|sounds good|gotcha|great|cool|nice|perfect|done|sure|np|👍|🙏|✅|🎉|👌)[.!…\s]*$/i;

/**
 * Agent sentinel / heartbeat / proxy lines. These are machine-emitted status
 * messages, never conversational substance. Matched only on AGENT turns (a
 * user could legitimately type any of these phrases). Conservative — extend
 * deliberately, and keep the canary in lockstep.
 */
const AGENT_SENTINEL_RE = new RegExp(
  [
    '^[🔭⏳🌙📍🛰️]',                                   // status/beacon emoji prefixes
    'is actively (working|implementing)',              // "🔭 Echo is actively working…"
    'your message has been delivered to the session',  // proxy delivery sentinel
    '^(standby|heartbeat)\\b',                          // standby/heartbeat headers
    'resumed \\d+ (watcher|of)',                        // PromiseBeacon resume acks
  ].join('|'),
  'i',
);

/** Minimum length below which a single-token message is treated as trivial. */
const TRIVIAL_MAX_CHARS = 16;

/**
 * Decide whether a turn is worth sending to the extractor. Deterministic and
 * FAIL-OPEN: returns true (capture) unless the turn is high-confidence trivial.
 *
 * Skips: empty / whitespace-only; agent sentinel/heartbeat/proxy lines; short
 * bare acknowledgements. Everything else passes to the LLM, which makes the
 * real significance call with broader context.
 */
export function isSubstantiveTurn(text: string | undefined | null, fromUser: boolean): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length === 0) return false;
  // Agent-emitted status lines are never substance.
  if (!fromUser && AGENT_SENTINEL_RE.test(t)) return false;
  // Short, whole-message acks (either side) — "ok", "thanks!", "👍".
  if (t.length <= TRIVIAL_MAX_CHARS && BARE_ACK_RE.test(t)) return false;
  return true; // fail-open
}

// ── Canary (run at startup + on schedule; guards sentinel-format drift) ────

export interface CanarySample {
  text: string;
  fromUser: boolean;
  /** Expected pre-filter verdict: true = should pass to LLM, false = should skip. */
  expectSubstantive: boolean;
  label: string;
}

/**
 * Known-good samples the pre-filter MUST classify correctly. If a code change
 * (or sentinel-format drift) breaks one of these, the canary fails loudly so we
 * notice BEFORE real captures are silently dropped.
 */
export const PRE_FILTER_CANARY_SAMPLES: CanarySample[] = [
  // Must SKIP (trivial / sentinel)
  { text: 'ok', fromUser: true, expectSubstantive: false, label: 'bare ack "ok"' },
  { text: 'thanks!', fromUser: true, expectSubstantive: false, label: 'bare ack "thanks!"' },
  { text: '👍', fromUser: true, expectSubstantive: false, label: 'emoji ack' },
  { text: '   ', fromUser: true, expectSubstantive: false, label: 'whitespace-only' },
  {
    text: '🔭 echo is actively working on something. Your message has been delivered to the session.',
    fromUser: false, expectSubstantive: false, label: 'agent status sentinel',
  },
  { text: '⏳ resumed 2 watchers on this topic.', fromUser: false, expectSubstantive: false, label: 'beacon resume ack' },
  // Must PASS (substantive)
  {
    text: 'Let\'s use Postgres for the user store, not SQLite — we need concurrent writes.',
    fromUser: true, expectSubstantive: true, label: 'user decision',
  },
  {
    text: 'ok but actually I think we should switch the extractor to read the rolling summary too',
    fromUser: true, expectSubstantive: true, label: 'ack-prefixed substantive turn',
  },
  {
    text: 'I built the capture helper and wired it onto onMessageLogged; tests are green.',
    fromUser: false, expectSubstantive: true, label: 'substantive agent turn (no sentinel)',
  },
];

export interface CanaryResult {
  ok: boolean;
  failures: Array<{ label: string; expected: boolean; got: boolean }>;
}

/** Run the pre-filter canary over the known samples. */
export function runPreFilterCanary(): CanaryResult {
  const failures: CanaryResult['failures'] = [];
  for (const s of PRE_FILTER_CANARY_SAMPLES) {
    const got = isSubstantiveTurn(s.text, s.fromUser);
    if (got !== s.expectSubstantive) {
      failures.push({ label: s.label, expected: s.expectSubstantive, got });
    }
  }
  return { ok: failures.length === 0, failures };
}

// ── Transport: queue-backed intelligence (subscription path, never raw API) ─

export type EnqueueFn = (
  lane: 'interactive' | 'background',
  fn: (signal: AbortSignal) => Promise<string>,
  costCents?: number,
) => Promise<string>;

/** Fast-tier per-turn cost estimate (cents) for the daily-cap accounting. */
export const TOPIC_INTENT_CAPTURE_COST_CENTS = 0.2;

/**
 * Wrap an IntelligenceProvider so every call is admitted through the shared
 * LlmQueue (background lane: capture is never user-interactive, and must yield
 * to interactive work). The TRANSPORT stays the injected `intelligence` — which
 * production resolves to the subscription / REPL-pool provider — so this never
 * touches the raw Messages API (`[[feedback_anthropic_path_constraints]]`,
 * acceptance #6). On daily-cap breach the queue THROWS; createLlmExtractFn
 * catches it and degrades to a counter tick.
 */
export function createQueuedIntelligence(
  intelligence: IntelligenceProvider,
  enqueue: EnqueueFn,
  costCents: number = TOPIC_INTENT_CAPTURE_COST_CENTS,
): IntelligenceProvider {
  return {
    evaluate: (prompt: string, options?: IntelligenceOptions): Promise<string> =>
      enqueue('background', () => intelligence.evaluate(prompt, options), costCents),
  };
}

// ── Capture helper ─────────────────────────────────────────────────────────

export interface CaptureTurnEntry {
  /** Server-assigned, non-user-forgeable message id (keys per-message dedup). */
  messageId: string | number;
  topicId?: number;
  text?: string;
  fromUser: boolean;
  /** ISO8601 string or epoch ms. */
  timestamp?: string | number;
}

/** Minimal rolling-summary surface (satisfied by TopicMemory). */
export interface RollingSummaryProvider {
  getTopicSummary(topicId: number): { summary: string } | null;
}

export interface CaptureLoopDeps {
  extractor: TopicIntentExtractor;
  store: TopicIntentStore;
  /** Source of the rolling summary fed to the extractor (broader context). */
  topicMemory?: RollingSummaryProvider | null;
  /** Skip capture under quota pressure (QuotaTracker load-shedding). */
  shouldShed?: () => boolean;
  /** Per-topic extraction rate ceiling (defense beyond the pre-filter). */
  rateCeiling?: { maxPerWindow: number; windowMs: number };
  now?: () => number;
}

export type CaptureStatus =
  | 'captured'
  | 'skipped-prefilter'
  | 'skipped-shed'
  | 'skipped-rate'
  | 'no-topic'
  | 'degraded';

export interface CaptureOutcome {
  status: CaptureStatus;
  emitted?: number;
  createdRefs?: number;
}

function toIso(timestamp: string | number | undefined, now: () => number): string {
  if (typeof timestamp === 'string' && timestamp) return timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  return new Date(now()).toISOString();
}

/** Map a store ref (with projection) to the EstablishedRef the extractor anchors against. */
function toEstablishedRef(r: EstablishedRef): EstablishedRef {
  return r;
}

/**
 * Capture one conversation turn. Pre-filter → (shed/rate gates) → build broader
 * context → extractor.ingest. Never throws; on any unexpected failure it ticks
 * `degraded_cap_or_error` and returns { status: 'degraded' }.
 *
 * `rateState` (topicId → recent attempt timestamps) is owned by the caller
 * (see createCaptureLoop) so the rate ceiling persists across turns.
 */
export async function captureTurn(
  deps: CaptureLoopDeps,
  entry: CaptureTurnEntry,
  rateState?: Map<number, number[]>,
): Promise<CaptureOutcome> {
  const now = deps.now ?? (() => Date.now());
  let topicId: number | undefined;
  try {
    topicId = typeof entry.topicId === 'number' ? entry.topicId : undefined;
    if (topicId === undefined) return { status: 'no-topic' };

    // Pre-filter — deterministic, fail-open.
    if (!isSubstantiveTurn(entry.text, entry.fromUser)) {
      deps.store.bumpCaptureCounters(topicId, { turns_seen: 1, prefilter_skipped: 1 });
      return { status: 'skipped-prefilter' };
    }

    // Load-shedding under quota pressure.
    if (deps.shouldShed?.()) {
      deps.store.bumpCaptureCounters(topicId, { turns_seen: 1, degraded_shed: 1 });
      return { status: 'skipped-shed' };
    }

    // Per-topic rate ceiling (runaway guard beyond the pre-filter).
    if (deps.rateCeiling && rateState) {
      const { maxPerWindow, windowMs } = deps.rateCeiling;
      const tNow = now();
      const recent = (rateState.get(topicId) ?? []).filter(ts => tNow - ts < windowMs);
      if (recent.length >= maxPerWindow) {
        rateState.set(topicId, recent);
        deps.store.bumpCaptureCounters(topicId, { turns_seen: 1, rate_limited: 1 });
        return { status: 'skipped-rate' };
      }
      recent.push(tNow);
      rateState.set(topicId, recent);
    }

    // Build broader context: the topic's established refs + rolling summary.
    const at = toIso(entry.timestamp, now);
    const turn = entry.fromUser
      ? deps.store.bumpTurn(topicId)
      : (deps.store.read(topicId).turn ?? 0);
    const existingRefs = deps.store
      .getRefsAtOrAbove(topicId, 'observation')
      .map(toEstablishedRef);
    let rollingSummary: string | undefined;
    try {
      rollingSummary = deps.topicMemory?.getTopicSummary(topicId)?.summary;
    } catch { /* summary is best-effort context, never block capture */ }

    const input: ExtractorInput = {
      topicId,
      arcId: deps.store.arcIdFor(topicId),
      message: {
        id: String(entry.messageId),
        text: entry.text ?? '',
        fromUser: entry.fromUser,
        turn,
        at,
      },
      existingRefs,
      rollingSummary,
    };

    const result = await deps.extractor.ingest(input);
    deps.store.bumpCaptureCounters(
      topicId,
      {
        turns_seen: 1,
        extractions_attempted: 1,
        extractions_emitted: result.emitted.length > 0 ? 1 : 0,
        refs_created: result.createdRefs.length,
      },
      at,
      result.createdRefs.map(r => r.kind),
    );
    return { status: 'captured', emitted: result.emitted.length, createdRefs: result.createdRefs.length };
  } catch (err) {
    // Best-effort: a capture failure must NEVER surface on the message path.
    console.error(`[TopicIntentCapture] captureTurn failed (topic ${topicId ?? '?'}): ${err}`);
    try {
      if (topicId !== undefined) {
        deps.store.bumpCaptureCounters(topicId, { turns_seen: 1, degraded_cap_or_error: 1 });
      }
    } catch { /* metering best-effort */ }
    return { status: 'degraded' };
  }
}

/**
 * Build a stateful capture closure. The returned function holds the per-topic
 * rate-limit state across turns; wire it onto the inbound message callback.
 */
export function createCaptureLoop(
  deps: CaptureLoopDeps,
): (entry: CaptureTurnEntry) => Promise<CaptureOutcome> {
  const rateState = new Map<number, number[]>();
  return (entry: CaptureTurnEntry) => captureTurn(deps, entry, rateState);
}
