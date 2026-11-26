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
import type { TopicIntentStore, EstablishedRef, ProjectionResult } from './TopicIntent.js';
import type { TopicIntentExtractor, ExtractorInput, ReferentCandidate, ReferentStubProposal } from './TopicIntentExtractor.js';
import type { MessageProvenance } from '../messaging/shared/MessageProvenance.js';

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
/** True when an agent line is a machine-emitted status/heartbeat/proxy line, never conversation. */
export function isAgentSentinelLine(text: string): boolean {
  return AGENT_SENTINEL_RE.test(text.trim());
}

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
  /** Structural origin stamped at the send/receive seam. `automation` is not captured. */
  provenance?: MessageProvenance;
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
  /**
   * Context-budget layer brakes (§6.4, decision 7): a per-topic and
   * per-component daily token ceiling. Over a ceiling the turn is DEFERRED —
   * counted (`budget_deferred`) and visible — never silently skipped.
   */
  layerBudget?: { admit(topicKey: string, tokens: number): { ok: true } | { ok: false; reason: string } };
  /**
   * Called after a capture that CHANGED the awareness projection (the layer
   * projection hangs here). Never called when the extractor degraded, the
   * awareness was invalid, or a stale completion was ignored — a layer must
   * never be re-stamped fresh from an awareness that did not move.
   */
  onCaptured?: (topicId: number, entry: CaptureTurnEntry) => void;
  /**
   * Context-budget §6 row U (layers on only): refresh the topic's protected
   * user corpus from its sender rows on every turn, offer an operator
   * message's referent candidates to the SAME extractor call, and hand the
   * call's stub back for deterministic validation. Absent ⇒ the extractor
   * input carries no candidate field at all (byte-identical prompt).
   */
  /**
   * Context-budget §6.1/§6.2 (layers on only): the Anchor and the
   * decisions/evolutions ledger, re-derived after every turn of a topic from
   * the refs this turn's extraction wrote, U's labels and the referent stubs.
   * An automated agent message is not a natural reply, so it never surfaces
   * an evolution. Absent ⇒ nothing runs. Never affects the outcome.
   */
  anchorLedger?: {
    afterTurn(topicId: number, entry: { messageId: string | number; fromUser: boolean; automated?: boolean; timestamp?: string | number }): void;
  };
  userCorpus?: {
    refresh(topicId: number, opts?: { messageId?: number }): unknown;
    /** null = not a protected operator row; [] = an operator row with no agent message to name. */
    stubCandidates(topicId: number, messageId: number): ReferentCandidate[] | null;
    acceptStub(topicId: number, messageId: number, userText: string, proposal: ReferentStubProposal | null | undefined): unknown;
    /** An operator row that got no stub, and why (coverage stays interpretable). */
    noteNoStub(reason: NoStubReason): void;
  };
  /**
   * Measurement only (context budget §11): told how every capture attempt that
   * reached the layer path ended — a turn past the pre-filter or a tick — and
   * by which trigger. Never affects capture; a throw is swallowed.
   */
  onLayerOutcome?: (topicId: number, trigger: 'turn' | 'tick', outcome: CaptureOutcome) => void;
  now?: () => number;
}

/** Why an operator row got no stub request. */
export type NoStubReason = 'no-candidates' | 'skipped-prefilter' | 'skipped-automation' | 'skipped-shed' | 'skipped-rate' | 'deferred-budget' | 'degraded';

/** The capture statuses that reached the layer path (a turn past every pre-LLM skip, or a tick). */
const LAYER_PATH_STATUSES: ReadonlySet<CaptureStatus> = new Set(['captured', 'deferred-budget', 'skipped-shed', 'degraded']);

function noteLayerOutcome(deps: CaptureLoopDeps, topicId: number | undefined, trigger: 'turn' | 'tick', outcome: CaptureOutcome): void {
  if (!deps.onLayerOutcome || topicId === undefined || !LAYER_PATH_STATUSES.has(outcome.status)) return;
  try { deps.onLayerOutcome(topicId, trigger, outcome); } catch { /* @silent-fallback-ok — a measurement observer never affects capture */ }
}

export type CaptureStatus =
  | 'captured'
  | 'skipped-prefilter'
  | 'skipped-automation'
  | 'skipped-shed'
  | 'skipped-rate'
  | 'deferred-budget'
  | 'no-topic'
  | 'degraded';

export interface CaptureOutcome {
  status: CaptureStatus;
  emitted?: number;
  createdRefs?: number;
  /** True only when this capture changed the awareness projection. */
  awarenessUpdated?: boolean;
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
 * Upper bound on how many existing refs are rendered into one extraction
 * prompt. The store keeps every ref a topic has ever established, so without
 * a cap the prompt grows with the topic's lifetime: a long-running topic with
 * 858 refs made every captured turn a ~40k-token call. The extractor only
 * needs the refs it might reinforce or contradict, which are the confident
 * and recently-reinforced ones. Refs outside the window stay in the store
 * untouched; they are simply not offered as anchors for this turn.
 */
export const MAX_PROMPT_REFS = 40;

const TIER_RANK: Record<ProjectionResult['tier'], number> = { observation: 0, tentative: 1, authoritative: 2 };

/**
 * Pick the refs offered to the extractor: highest projected tier first, then
 * most recently reinforced, bounded by `max`. Pure and deterministic (ties
 * break on refId) so the same store state always yields the same prompt.
 */
export function selectPromptRefs<T extends EstablishedRef & { projection: ProjectionResult }>(
  refs: T[],
  max: number = MAX_PROMPT_REFS,
): T[] {
  if (refs.length <= max) return refs;
  const at = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  };
  return [...refs]
    .sort((a, b) =>
      TIER_RANK[b.projection.tier] - TIER_RANK[a.projection.tier]
      || at(b.lastReinforcedAt) - at(a.lastReinforcedAt)
      || (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0))
    .slice(0, Math.max(0, max));
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
  const outcome = await captureTurnInner(deps, entry, rateState);
  noteLayerOutcome(deps, typeof entry.topicId === 'number' ? entry.topicId : undefined, 'turn', outcome);
  if (deps.anchorLedger && typeof entry.topicId === 'number') {
    try {
      deps.anchorLedger.afterTurn(entry.topicId, { messageId: entry.messageId, fromUser: entry.fromUser, automated: entry.provenance === 'automation', ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}) });
    } catch { /* @silent-fallback-ok — the ledger is a derived layer that counts its own failures; capture's outcome is unaffected */ }
  }
  return outcome;
}

async function captureTurnInner(
  deps: CaptureLoopDeps,
  entry: CaptureTurnEntry,
  rateState?: Map<number, number[]>,
): Promise<CaptureOutcome> {
  const now = deps.now ?? (() => Date.now());
  let topicId: number | undefined;
  let stubOnDegrade: (() => void) | null = null;
  try {
    topicId = typeof entry.topicId === 'number' ? entry.topicId : undefined;
    if (topicId === undefined) return { status: 'no-topic' };

    // U lists every sender row, trivial or automated ones included, before any
    // gate. Its file work runs after a yield, never on the caller's synchronous
    // stack (the Telegram onMessageLogged callback is the delivery path).
    let candidates: ReferentCandidate[] | null = null;
    if (deps.userCorpus) {
      await new Promise<void>((r) => setImmediate(r));
      const mid = Number(entry.messageId);
      try { deps.userCorpus.refresh(topicId, Number.isSafeInteger(mid) ? { messageId: mid } : {}); } catch (err) {
        // @silent-fallback-ok — the corpus refresh never affects capture; it is retried on the next turn and the failure is logged
        console.warn(`[TopicIntentCapture] user corpus refresh failed (topic ${topicId}): ${err instanceof Error ? err.message : String(err)}`);
      }
      // The referent stub rides this message's own call (§6.4): candidates only for a protected operator row.
      if (entry.fromUser) {
        try { candidates = deps.userCorpus.stubCandidates(topicId, mid); } catch { candidates = null; /* @silent-fallback-ok — no candidates means no stub is requested; the message is captured as before */ }
      }
    }
    const operatorRow = candidates !== null;
    const stubbable = !!candidates && candidates.length > 0;
    const noStub = (reason: NoStubReason) => {
      if (!operatorRow) return;
      try { deps.userCorpus?.noteNoStub(reason); } catch { /* @silent-fallback-ok — coverage metering never affects capture */ }
    };
    if (operatorRow && !stubbable) noStub('no-candidates');
    if (stubbable) stubOnDegrade = () => noStub('degraded');

    // Count every user turn before any capture gate. Awareness freshness must
    // age honestly when a turn is trivial, shed, rate-limited, or extraction
    // fails; otherwise a stale projection can look current indefinitely.
    const turn = entry.fromUser
      ? deps.store.bumpTurn(topicId)
      : (deps.store.read(topicId).turn ?? 0);

    // Server-generated traffic (job sends, monitor/sentinel notices, standby
    // lines) is not conversation. It was ~64% of extractor tokens and mostly
    // filed near-identical "unmerged branches" facts
    // (docs/research/jev/field-notes/2026-09-30-idea1-intent-skip.md). Keyed on
    // the structural provenance stamp, never on text; a missing stamp (legacy
    // or unstamped path) is still captured. Skipping also skips this message's
    // awareness refresh; the rolling topic summary still covers automated
    // messages, so the next conversational turn's extraction sees them as
    // context.
    if (entry.provenance === 'automation') {
      deps.store.bumpCaptureCounters(topicId, { turns_seen: 1, prefilter_skipped: 1 });
      if (stubbable) noStub('skipped-automation');
      return { status: 'skipped-automation' };
    }

    // Pre-filter — deterministic, fail-open. The pre-filter is a substance
    // filter, not a brake: an operator's bare "yes" right after an agent
    // question is exactly what a referent stub is for, so with U on it still
    // reaches the extractor (the shed, rate and budget brakes below still apply).
    if (!isSubstantiveTurn(entry.text, entry.fromUser) && !(stubbable && (entry.text ?? '').trim().length > 0)) {
      deps.store.bumpCaptureCounters(topicId, { turns_seen: 1, prefilter_skipped: 1 });
      if (stubbable) noStub('skipped-prefilter');
      return { status: 'skipped-prefilter' };
    }

    // Load-shedding under quota pressure.
    if (deps.shouldShed?.()) {
      deps.store.bumpCaptureCounters(topicId, { turns_seen: 1, degraded_shed: 1 });
      if (stubbable) noStub('skipped-shed');
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
        if (stubbable) noStub('skipped-rate');
        return { status: 'skipped-rate' };
      }
      recent.push(tNow);
      rateState.set(topicId, recent);
    }

    // Build broader context: the topic's established refs + rolling summary.
    const at = toIso(entry.timestamp, now);
    const topicFile = deps.store.read(topicId);
    const existingRefs = selectPromptRefs(deps.store.getRefsAtOrAbove(topicId, 'observation'))
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
      existingAwareness: topicFile.awareness,
    };
    if (stubbable && candidates) input.referentCandidates = candidates;

    // Layer brakes: estimate the prompt from its variable parts and reserve it.
    if (deps.layerBudget) {
      const stubChars = input.referentCandidates ? JSON.stringify(input.referentCandidates).length + 1_200 : 0;
      const est = Math.ceil(((entry.text ?? '').length + (rollingSummary ?? '').length + JSON.stringify(existingRefs).length + JSON.stringify(topicFile.awareness ?? {}).length + stubChars) / 4) + 1_500;
      const v = deps.layerBudget.admit(String(topicId), est);
      if (!v.ok) {
        deps.store.bumpCaptureCounters(topicId, { turns_seen: 1, budget_deferred: 1 });
        if (stubbable) noStub('deferred-budget');
        return { status: 'deferred-budget' };
      }
    }

    const result = await deps.extractor.ingest(input);
    deps.store.bumpCaptureCounters(
      topicId,
      {
        turns_seen: 1,
        extractions_attempted: 1,
        extractions_emitted: result.emitted.length > 0 ? 1 : 0,
        refs_created: result.createdRefs.length,
        awareness_invalid: result.awarenessInvalid ? 1 : 0,
      },
      at,
      result.createdRefs.map(r => r.kind),
    );
    stubOnDegrade = null;
    if (input.referentCandidates && deps.userCorpus) {
      try { deps.userCorpus.acceptStub(topicId, Number(entry.messageId), entry.text ?? '', result.referentStub ?? null); } catch { /* @silent-fallback-ok — a stub is a derived signal; its validator counts its own rejections and the message is unaffected */ }
    }
    if (result.awarenessUpdated) {
      try { deps.onCaptured?.(topicId, entry); } catch { /* @silent-fallback-ok — the projection hook never affects capture; it counts its own failures */ }
    }
    return { status: 'captured', emitted: result.emitted.length, createdRefs: result.createdRefs.length, awarenessUpdated: result.awarenessUpdated };
  } catch (err) {
    // Best-effort: a capture failure must NEVER surface on the message path.
    console.error(`[TopicIntentCapture] captureTurn failed (topic ${topicId ?? '?'}): ${err}`);
    try { stubOnDegrade?.(); } catch { /* metering best-effort */ }
    try {
      if (topicId !== undefined) {
        deps.store.bumpCaptureCounters(topicId, { turns_seen: 1, degraded_cap_or_error: 1 });
      }
    } catch { /* metering best-effort */ }
    return { status: 'degraded' };
  }
}

/**
 * A transcript-growth tick (context-budget-layered-summaries §6.4): feed a
 * bounded, already-scrubbed digest of recent tool activity to the extractor
 * as an AGENT-side observation, so a tool-heavy session with no messages
 * still refreshes the current-work level. Bypasses the message pre-filter
 * (the digest is not a message) but honours the shed gate and the layer
 * budget like a turn. Never throws.
 */
/** The message-id prefix of a tick's extractor input; an awareness level sourced from one is tool-derived. */
export const TICK_MESSAGE_PREFIX = 'tick-';

export async function captureTick(deps: CaptureLoopDeps, topicId: number, digestText: string): Promise<CaptureOutcome> {
  const outcome = await captureTickInner(deps, topicId, digestText);
  noteLayerOutcome(deps, topicId, 'tick', outcome);
  return outcome;
}

async function captureTickInner(deps: CaptureLoopDeps, topicId: number, digestText: string): Promise<CaptureOutcome> {
  const now = deps.now ?? (() => Date.now());
  try {
    if (deps.shouldShed?.()) {
      deps.store.bumpCaptureCounters(topicId, { degraded_shed: 1 });
      return { status: 'skipped-shed' };
    }
    const topicFile = deps.store.read(topicId);
    const existingRefs = selectPromptRefs(deps.store.getRefsAtOrAbove(topicId, 'observation')).map(toEstablishedRef);
    const at = new Date(now()).toISOString();
    const input: ExtractorInput = {
      topicId,
      arcId: deps.store.arcIdFor(topicId),
      message: { id: `${TICK_MESSAGE_PREFIX}${now()}`, text: digestText, fromUser: false, turn: topicFile.turn ?? 0, at },
      existingRefs,
      existingAwareness: topicFile.awareness,
      // Raw tool output never creates or reinforces a ref (§6.4: awareness only).
      awarenessOnly: true,
    };
    const result = await deps.extractor.ingest(input);
    deps.store.bumpCaptureCounters(topicId, { layer_ticks: 1, extractions_attempted: 1, awareness_invalid: result.awarenessInvalid ? 1 : 0 }, at);
    return { status: 'captured', emitted: 0, createdRefs: 0, awarenessUpdated: result.awarenessUpdated };
  } catch (err) {
    console.error(`[TopicIntentCapture] captureTick failed (topic ${topicId}): ${err}`);
    try { deps.store.bumpCaptureCounters(topicId, { degraded_cap_or_error: 1 }); } catch { /* metering best-effort */ }
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
