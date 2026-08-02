/**
 * TopicAwareness — the temporal projection over Topic Intent evidence.
 *
 * Topic Intent confidence tiers answer "how well supported is this ref?".
 * These three awareness levels answer the orthogonal question "over what
 * horizon is the conversation moving?": whole topic, most-recent arc, and
 * current work.  The projection is orientation only; it never promotes a ref
 * or grants authority.
 */

export type AwarenessSpeaker = 'user' | 'agent';

export interface AwarenessLayerDraft {
  goal: string;
  trend: string;
  themes: string[];
}

export interface ArcTransitionDraft {
  kind: 'continue' | 'new';
  /** Exact excerpt from the current USER message that grounds a requested transition. */
  evidenceQuote?: string;
}

export interface AwarenessDraft {
  topic: AwarenessLayerDraft;
  recentArc: AwarenessLayerDraft;
  currentWork: AwarenessLayerDraft;
  arcTransition?: ArcTransitionDraft;
}

export interface AwarenessLayer extends AwarenessLayerDraft {
  updatedAt: string;
  sourceMessageId: string;
  sourceSpeaker: AwarenessSpeaker;
  sourceTurn: number;
}

export interface TopicAnchor {
  goal: string;
  capturedAt: string;
  sourceMessageId: string;
  /** Conversation order, so completion order cannot choose the origin. */
  sourceTurn: number;
}

export interface TopicAwarenessArc {
  arcId: string;
  /** Stable conversation-order ordinal; 1 retains the legacy arc id. */
  sequence: number;
  status: 'active' | 'closed';
  startedAt: string;
  startedTurn: number;
  boundaryKind: 'initial' | 'explicit' | 'implicit';
  boundaryMessageId: string;
  endedAt?: string;
  endedTurn?: number;
  layer: AwarenessLayer;
}

/**
 * Bounded reorder journal for the semantic arc dimension. LLM calls run
 * concurrently, so a later completion can arrive before an earlier boundary.
 * Keeping the last two rate windows lets us refold that boundary in
 * conversation order without serialising the intelligence calls.
 */
export interface RecentArcEvent {
  messageId: string;
  at: string;
  turn: number;
  speaker: AwarenessSpeaker;
  layer: AwarenessLayerDraft;
  requestedNew: boolean;
  grounded: boolean;
  explicit: boolean;
}

export interface PendingArcCandidate {
  goal: string;
  firstSeenAt: string;
  lastSeenAt: string;
  confirmations: number;
}

export interface TopicAwarenessState {
  version: 1;
  /** Immutable first user-grounded topic goal. Evolution never overwrites it. */
  anchor: TopicAnchor;
  /** Evolving whole-topic view. */
  topic: AwarenessLayer;
  /** Compact semantic arc history; exactly one arc is active. */
  arcs: TopicAwarenessArc[];
  currentArcId: string;
  /** Immediate work view, updated independently of the broader arc. */
  currentWork: AwarenessLayer;
  /** Hysteresis for an implicit (not explicitly phrased) arc transition. */
  pendingArcCandidate?: PendingArcCandidate;
  /** Bounded completion-reorder journal; never an authority/evidence store. */
  recentArcEvents: RecentArcEvent[];
  /** Closed arcs omitted from `arcs` by the hard history cap. */
  archivedArcCount: number;
  updatedAt: string;
  turnAtUpdate: number;
}

export interface AwarenessUpdateInput {
  topicId: number;
  messageId: string;
  messageText: string;
  fromUser: boolean;
  at: string;
  turn: number;
}

export interface AwarenessUpdateResult {
  state: TopicAwarenessState;
  effectiveArcId: string;
  transitioned: boolean;
  /** False when a slower, older extraction completed after newer state. */
  applied: boolean;
  stale: boolean;
  /** A stale completion may still move the anchor monotonically earlier. */
  anchorCorrected: boolean;
  /** True when stale input still changed the bounded order journal/arcs. */
  stateReconciled: boolean;
}

const MAX_GOAL_CHARS = 500;
const MAX_TREND_CHARS = 600;
const MAX_THEME_CHARS = 240;
const MAX_THEMES = 5;
/** 30 captures/minute × 60s provider wall; 64 covers the full inversion window. */
export const MAX_RECENT_ARC_EVENTS = 64;
/** Initial arc + 63 most-recent arcs; older closed history is counted, not retained. */
export const MAX_RETAINED_ARCS = 64;
const EXPLICIT_SHIFT = /\b(?:instead|now|switch(?:ing|ed)?|move(?:d|ing)? on|next|new (?:goal|phase|focus|task)|different (?:goal|phase|focus|task)|no longer|from here)\b/i;

function compact(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, max);
}

/** Validate + bound model-authored awareness before it can touch durable state. */
export function normalizeAwarenessDraft(value: unknown): AwarenessDraft | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const layer = (candidate: unknown): AwarenessLayerDraft | null => {
    if (!candidate || typeof candidate !== 'object') return null;
    const c = candidate as Record<string, unknown>;
    const goal = compact(c.goal, MAX_GOAL_CHARS);
    const trend = compact(c.trend, MAX_TREND_CHARS);
    if (!goal || !trend || !Array.isArray(c.themes)) return null;
    const themes = c.themes
      .map((theme) => compact(theme, MAX_THEME_CHARS))
      .filter((theme): theme is string => Boolean(theme))
      .slice(0, MAX_THEMES);
    if (themes.length === 0) return null;
    return { goal, trend, themes };
  };

  const topic = layer(raw.topic);
  const recentArc = layer(raw.recentArc);
  const currentWork = layer(raw.currentWork);
  if (!topic || !recentArc || !currentWork) return null;

  let arcTransition: ArcTransitionDraft | undefined;
  if (raw.arcTransition && typeof raw.arcTransition === 'object') {
    const transition = raw.arcTransition as Record<string, unknown>;
    if (transition.kind === 'continue') {
      arcTransition = { kind: 'continue' };
    } else if (transition.kind === 'new') {
      const evidenceQuote = compact(transition.evidenceQuote, 300);
      arcTransition = { kind: 'new', ...(evidenceQuote ? { evidenceQuote } : {}) };
    }
  }

  return { topic, recentArc, currentWork, arcTransition };
}

function materializeLayer(
  draft: AwarenessLayerDraft,
  input: AwarenessUpdateInput,
): AwarenessLayer {
  return {
    ...draft,
    updatedAt: input.at,
    sourceMessageId: input.messageId,
    sourceSpeaker: input.fromUser ? 'user' : 'agent',
    sourceTurn: input.turn,
  };
}

function normalizedWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4),
  );
}

/** Bounded lexical similarity is used only for transition hysteresis, never meaning/authority. */
export function awarenessGoalSimilarity(a: string, b: string): number {
  const left = normalizedWords(a);
  const right = normalizedWords(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const word of left) if (right.has(word)) intersection++;
  return intersection / new Set([...left, ...right]).size;
}

function quoteIsGrounded(quote: string | undefined, messageText: string): boolean {
  if (!quote) return false;
  return messageText.toLowerCase().includes(quote.toLowerCase());
}

function arcId(topicId: number, sequence: number): string {
  return sequence === 1 ? `arc-${topicId}` : `arc-${topicId}-${sequence}`;
}

function compareArcEvents(a: RecentArcEvent, b: RecentArcEvent): number {
  if (a.turn !== b.turn) return a.turn - b.turn;
  if (a.speaker !== b.speaker) return a.speaker === 'user' ? -1 : 1;
  const byTime = Date.parse(a.at) - Date.parse(b.at);
  if (Number.isFinite(byTime) && byTime !== 0) return byTime;
  return a.messageId.localeCompare(b.messageId);
}

function recordArcEvent(
  state: TopicAwarenessState,
  draft: AwarenessDraft,
  input: AwarenessUpdateInput,
): boolean {
  const requestedNew = input.fromUser && draft.arcTransition?.kind === 'new';
  const quote = draft.arcTransition?.evidenceQuote;
  const grounded = Boolean(requestedNew && quoteIsGrounded(quote, input.messageText));
  const event: RecentArcEvent = {
    messageId: input.messageId,
    at: input.at,
    turn: input.turn,
    speaker: input.fromUser ? 'user' : 'agent',
    layer: draft.recentArc,
    requestedNew,
    grounded,
    explicit: Boolean(grounded && EXPLICIT_SHIFT.test(quote ?? '')),
  };
  const events = state.recentArcEvents ?? [];
  const existingIndex = events.findIndex((candidate) =>
    candidate.messageId === event.messageId && candidate.speaker === event.speaker,
  );
  if (existingIndex >= 0) {
    if (JSON.stringify(events[existingIndex]) === JSON.stringify(event)) return false;
    events[existingIndex] = event;
  } else {
    events.push(event);
  }
  events.sort(compareArcEvents);
  state.recentArcEvents = events.slice(-MAX_RECENT_ARC_EVENTS);
  return true;
}

interface DerivedBoundary {
  event: RecentArcEvent;
  kind: 'explicit' | 'implicit';
}

function deriveRecentBoundaries(events: RecentArcEvent[]): {
  boundaries: DerivedBoundary[];
  pending?: PendingArcCandidate;
} {
  const boundaries: DerivedBoundary[] = [];
  let pendingEvent: RecentArcEvent | undefined;
  for (const event of events.filter((candidate) => candidate.speaker === 'user').sort(compareArcEvents)) {
    if (event.requestedNew && event.grounded && event.explicit) {
      boundaries.push({ event, kind: 'explicit' });
      pendingEvent = undefined;
      continue;
    }
    if (event.requestedNew && event.grounded) {
      if (pendingEvent && awarenessGoalSimilarity(pendingEvent.layer.goal, event.layer.goal) >= 0.55) {
        boundaries.push({ event, kind: 'implicit' });
        pendingEvent = undefined;
      } else {
        pendingEvent = event;
      }
      continue;
    }
    // A later user continuation/ungrounded proposal disconfirms the candidate.
    pendingEvent = undefined;
  }
  return {
    boundaries,
    ...(pendingEvent ? {
      pending: {
        goal: pendingEvent.layer.goal,
        firstSeenAt: pendingEvent.at,
        lastSeenAt: pendingEvent.at,
        confirmations: 1,
      },
    } : {}),
  };
}

function layerFromEvent(event: RecentArcEvent): AwarenessLayer {
  return {
    ...event.layer,
    updatedAt: event.at,
    sourceMessageId: event.messageId,
    sourceSpeaker: event.speaker,
    sourceTurn: event.turn,
  };
}

function boundaryFingerprint(arcs: TopicAwarenessArc[]): string {
  return arcs
    .map((arc) => `${arc.startedTurn}:${arc.boundaryKind}:${arc.boundaryMessageId}:${arc.sequence}`)
    .join('|');
}

/**
 * Refold the bounded transition journal in conversation order. Existing arcs
 * older than the journal are frozen compact history. Arcs inside the journal
 * are rebuilt, so a late earlier boundary can insert itself and an apparent
 * implicit pair can be withdrawn when its intervening user turn arrives.
 */
function reconcileArcs(state: TopicAwarenessState, topicId: number): {
  changed: boolean;
  addedBoundary: boolean;
} {
  const before = boundaryFingerprint(state.arcs);
  const events = [...(state.recentArcEvents ?? [])].sort(compareArcEvents);
  if (events.length === 0) return { changed: false, addedBoundary: false };

  const oldestTurn = events[0].turn;
  const existingArcs = state.arcs.map((arc, index) => ({
    ...arc,
    sequence: arc.sequence ?? index + 1,
    startedTurn: arc.startedTurn ?? (index === 0 ? state.anchor.sourceTurn : state.turnAtUpdate),
    boundaryKind: arc.boundaryKind ?? (index === 0 ? 'initial' : 'explicit'),
    boundaryMessageId: arc.boundaryMessageId ?? arc.layer.sourceMessageId,
  }));

  // The first successful completion is not necessarily the first user turn.
  // When a slower earlier completion corrects the anchor, the initial arc must
  // move with it; otherwise its later startedTurn freezes out real boundaries
  // between the corrected anchor and the first completion.
  if (existingArcs[0]) {
    existingArcs[0] = {
      ...existingArcs[0],
      arcId: arcId(topicId, 1),
      sequence: 1,
      startedAt: state.anchor.capturedAt,
      startedTurn: state.anchor.sourceTurn,
      boundaryKind: 'initial',
      boundaryMessageId: state.anchor.sourceMessageId,
    };
  }

  // Initial history is always retained. Other arcs older than the reorder
  // window are immutable compact history and keep their sequence/id.
  const frozen = existingArcs.filter((arc, index) => index === 0 || arc.startedTurn < oldestTurn);
  const lastFrozenTurn = frozen.reduce((max, arc) => Math.max(max, arc.startedTurn), state.anchor.sourceTurn);
  const { boundaries, pending } = deriveRecentBoundaries(events);
  const derived = boundaries
    .filter(({ event }) => event.turn > lastFrozenTurn)
    .sort((a, b) => compareArcEvents(a.event, b.event));

  const starts: Array<{
    turn: number;
    at: string;
    kind: 'initial' | 'explicit' | 'implicit';
    messageId: string;
    sequence: number;
    existing?: TopicAwarenessArc;
  }> = frozen
    .sort((a, b) => a.startedTurn - b.startedTurn)
    .map((arc) => ({
      turn: arc.startedTurn,
      at: arc.startedAt,
      kind: arc.boundaryKind,
      messageId: arc.boundaryMessageId,
      sequence: arc.sequence,
      existing: arc,
    }));

  if (starts.length === 0) {
    starts.push({
      turn: state.anchor.sourceTurn,
      at: state.anchor.capturedAt,
      kind: 'initial',
      messageId: state.anchor.sourceMessageId,
      sequence: 1,
    });
  }
  // `archivedArcCount` represents omitted middle history. Together with the
  // retained frozen starts it gives the exact next conversation-order ordinal,
  // even after the hard arc cap has pruned old objects.
  let nextSequence = (state.archivedArcCount ?? 0) + starts.length + 1;
  for (const boundary of derived) {
    if (starts.some((start) => start.turn === boundary.event.turn)) continue;
    starts.push({
      turn: boundary.event.turn,
      at: boundary.event.at,
      kind: boundary.kind,
      messageId: boundary.event.messageId,
      sequence: nextSequence++,
    });
  }
  starts.sort((a, b) => a.turn - b.turn || a.sequence - b.sequence);

  let arcs = starts.map((start, index): TopicAwarenessArc => {
    const next = starts[index + 1];
    const candidates = events.filter((event) =>
      event.turn >= start.turn && (!next || event.turn < next.turn),
    );
    const latest = candidates.sort(compareArcEvents).at(-1);
    const fallback = start.existing?.layer
      ?? existingArcs.find((arc) => arc.startedTurn === start.turn)?.layer
      ?? state.arcs.at(-1)?.layer;
    const layer = latest ? layerFromEvent(latest) : fallback;
    // An awareness state always has at least its initial event/layer.
    if (!layer) throw new Error('TopicAwareness reconcile has no layer');
    return {
      arcId: arcId(topicId, start.sequence),
      sequence: start.sequence,
      status: next ? 'closed' : 'active',
      startedAt: start.at,
      startedTurn: start.turn,
      boundaryKind: start.kind,
      boundaryMessageId: start.messageId,
      ...(next ? { endedAt: next.at, endedTurn: next.turn } : {}),
      layer,
    };
  });

  if (arcs.length > MAX_RETAINED_ARCS) {
    const removedArcs = arcs.slice(1, arcs.length - (MAX_RETAINED_ARCS - 1));
    const tail = arcs.slice(-(MAX_RETAINED_ARCS - 1));
    const removed = removedArcs.length;
    arcs = [arcs[0], ...tail];
    state.archivedArcCount = (state.archivedArcCount ?? 0) + removed;
    const cutoffTurn = Math.max(...removedArcs.map((arc) => arc.startedTurn));
    // The pruned boundaries are now represented by archivedArcCount. Drop their
    // reorder events too so a later refold cannot materialize them a second time.
    state.recentArcEvents = state.recentArcEvents.filter((event) => event.turn > cutoffTurn);
  }

  const effective = [...arcs]
    .filter((arc) => arc.startedTurn <= state.turnAtUpdate)
    .sort((a, b) => b.startedTurn - a.startedTurn)[0] ?? arcs[arcs.length - 1];
  state.arcs = arcs;
  state.currentArcId = effective.arcId;
  if (pending) state.pendingArcCandidate = pending;
  else delete state.pendingArcCandidate;

  const after = boundaryFingerprint(arcs);
  const beforeKeys = new Set(before.split('|').filter(Boolean));
  const afterKeys = after.split('|').filter(Boolean);
  return {
    changed: before !== after,
    addedBoundary: afterKeys.some((key) => !beforeKeys.has(key) && !key.includes(':initial:')),
  };
}

function effectiveArcIdForTurn(state: TopicAwarenessState, turn: number): string {
  return [...state.arcs]
    .filter((arc) => arc.startedTurn <= turn)
    .sort((a, b) => b.startedTurn - a.startedTurn)[0]?.arcId ?? state.currentArcId;
}

/**
 * Capture is deliberately fire-and-forget, so LLM completions can arrive out
 * of message order. User-turn number is the primary clock. Within one turn an
 * agent reply follows its user message; same-speaker ties use event time.
 */
function isOlderThanProjection(existing: TopicAwarenessState, input: AwarenessUpdateInput): boolean {
  if (input.turn !== existing.turnAtUpdate) return input.turn < existing.turnAtUpdate;

  const existingFromUser = existing.currentWork.sourceSpeaker === 'user';
  if (input.fromUser !== existingFromUser) {
    // For a shared turn number, user message first, agent reply second.
    return input.fromUser;
  }

  const priorMs = Date.parse(existing.updatedAt);
  const inputMs = Date.parse(input.at);
  if (Number.isFinite(priorMs) && Number.isFinite(inputMs)) return inputMs <= priorMs;
  // With no usable tie-breaker, preserve already-durable state.
  return true;
}

/**
 * Apply one validated projection update.
 *
 * An explicit user shift (grounded by an exact quote containing shift language)
 * transitions immediately. An implicit shift requires two similar consecutive
 * user-grounded candidates. Agent turns can update orientation but can never
 * create the topic anchor or switch arcs by themselves.
 */
export function applyAwarenessUpdate(
  existing: TopicAwarenessState | undefined,
  draft: AwarenessDraft,
  input: AwarenessUpdateInput,
): AwarenessUpdateResult | null {
  const normalized = normalizeAwarenessDraft(draft);
  if (!normalized) return null;

  if (!existing) {
    // Do not let an agent-authored observation become the immutable user anchor.
    if (!input.fromUser) return null;
    const arcId = `arc-${input.topicId}`;
    const topic = materializeLayer(normalized.topic, input);
    const state: TopicAwarenessState = {
      version: 1,
      anchor: {
        goal: normalized.topic.goal,
        capturedAt: input.at,
        sourceMessageId: input.messageId,
        sourceTurn: input.turn,
      },
      topic,
      arcs: [{
        arcId,
        sequence: 1,
        status: 'active',
        startedAt: input.at,
        startedTurn: input.turn,
        boundaryKind: 'initial',
        boundaryMessageId: input.messageId,
        layer: materializeLayer(normalized.recentArc, input),
      }],
      currentArcId: arcId,
      currentWork: materializeLayer(normalized.currentWork, input),
      recentArcEvents: [],
      archivedArcCount: 0,
      updatedAt: input.at,
      turnAtUpdate: input.turn,
    };
    recordArcEvent(state, normalized, input);
    return {
      state,
      effectiveArcId: arcId,
      transitioned: false,
      applied: true,
      stale: false,
      anchorCorrected: false,
      stateReconciled: false,
    };
  }

  if (isOlderThanProjection(existing, input)) {
    const state = structuredClone(existing);
    state.recentArcEvents ??= [];
    state.archivedArcCount ??= 0;
    const anchorCorrected = input.fromUser && input.turn < existing.anchor.sourceTurn;
    if (anchorCorrected) {
      // The projection itself is stale, but the earliest valid user projection
      // wins the origin regardless of LLM completion order. This is monotonic:
      // a later turn can never rewrite the anchor.
      state.anchor = {
        goal: normalized.topic.goal,
        capturedAt: input.at,
        sourceMessageId: input.messageId,
        sourceTurn: input.turn,
      };
    }
    const eventRecorded = recordArcEvent(state, normalized, input);
    const reconciled = reconcileArcs(state, input.topicId);
    return {
      state,
      effectiveArcId: effectiveArcIdForTurn(state, input.turn),
      transitioned: reconciled.addedBoundary,
      applied: false,
      stale: true,
      anchorCorrected,
      stateReconciled: anchorCorrected || eventRecorded || reconciled.changed,
    };
  }

  const state: TopicAwarenessState = structuredClone(existing);
  state.recentArcEvents ??= [];
  state.archivedArcCount ??= 0;
  state.topic = materializeLayer(normalized.topic, input);
  state.currentWork = materializeLayer(normalized.currentWork, input);
  state.updatedAt = input.at;
  state.turnAtUpdate = input.turn;
  recordArcEvent(state, normalized, input);
  const reconciled = reconcileArcs(state, input.topicId);

  return {
    state,
    effectiveArcId: effectiveArcIdForTurn(state, input.turn),
    transitioned: reconciled.addedBoundary,
    applied: true,
    stale: false,
    anchorCorrected: false,
    stateReconciled: reconciled.changed,
  };
}

/** Safe, bounded representation for the extractor's untrusted-data prompt block. */
export function awarenessForPrompt(state: TopicAwarenessState | undefined): string {
  if (!state) return '(no awareness projection yet)';
  const active = state.arcs.find((arc) => arc.arcId === state.currentArcId);
  return JSON.stringify({
    initialTopicAnchor: state.anchor.goal,
    topic: state.topic,
    recentArc: active?.layer ?? null,
    currentWork: state.currentWork,
  }).slice(0, 5000);
}
