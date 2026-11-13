/**
 * A and G — the Anchor and the decisions/evolutions ledger
 * (context-budget-layered-summaries §6 rows A and G, §6.1, §6.2, decisions 3
 * and 15, §12, §14).
 *
 * ANCHOR (§6.1). The first substantive operator-authored message row(s) of the
 * topic: a U record labelled `operator` (from_user=1, forwarded not 1, no
 * relay/A2A origin, the sender resolved to the operator through memory
 * privacy — U's labels are the only source), an opening greeting skipped. A
 * framing burst — further substantive operator rows before the agent's first
 * reply — joins it (at most `MAX_FRAMING_ROWS`). A topic with no such row is
 * `status: no-anchor`, and no evolution is recorded until one frames it. The
 * protected record holds ROW REFERENCES ONLY (message id, sha256, length),
 * never the words; it is rewritten only when its rows stop being protected
 * operator rows (a relabel) — "Updated: once".
 *
 * LEDGER G (§6.1, §6.2). One protected `ledger-entry` record per entry, keyed
 * per entry so it replicates per entry (§14), `type: evolution | decision`,
 * routed through the TopicIntent evidence model (topic-intent-layer v14), not
 * a separate authority:
 *
 *  - an EVOLUTION is a `goal` ref the extractor created from a message AFTER
 *    the Anchor. `cause` is `user-directed` when that message is a protected
 *    operator row (the row is bound: the entry's row reference), otherwise
 *    `insight-derived` with its evidence message id. `effect` is the
 *    extractor's own read, logged as a SIGNAL with its evidence: `narrowing`
 *    when the same message contradicted a goal or decision ref (the
 *    contradiction events are the evidence), `additive` when an operator
 *    message carried none. An entry not bound to an operator row (an agent
 *    message, a third party's or a forwarded row) is always held as
 *    `narrowing` (the stricter rule: explicit yes after surfacing). The
 *    effect never acts alone: it only chooses which user episode may confirm.
 *    Supersession needs operator standing (a bound row or an operator
 *    confirmation); otherwise `supersedes` is a signal only.
 *  - a DECISION is a `decision` ref. Row binding proves who wrote the text;
 *    the DECISION TRANSITION is separate: only a bound operator row whose
 *    referent stub (`stubFor`, S5) has kind `answer` or `directive` settles,
 *    as `derived-settled`, and only when the row post-dates the entry it
 *    supersedes. Anything else (agent-proposed, a third-party or forwarded
 *    row, no stub, a `question | hypothetical | rejection | other` stub, a
 *    row older than what it supersedes) is `pending` and never renders as
 *    settled. A later qualifying operator episode (re-reference, affirmation
 *    or a positive confirmation, v14) promotes `derived-settled` to `settled`.
 *
 * THE BOUND ROW IS THE SOLE WRITE PATH to A and to every settled state in G:
 * a settled or confirmed status is only ever derived from a protected
 * operator row (the binding, or the operator episode's own row), never from
 * the stub writer, the extractor or a session's assertion, which are signals.
 *
 * Statuses are DERIVED on every reconcile from the evidence (append-only), the
 * U labels and the stubs; only three facts are stored because they cannot be
 * re-derived: when the confirmation was surfaced, when its clock expired, and
 * that it was requested. Entries are never deleted: withdrawn, expired,
 * unconfirmed and superseded entries stay listed.
 *
 * BACKFILL (§6.1, decision 9, S7; only while `contextBudget.backfill.enabled`
 * is on). History is every message before the ledger's first live pass on
 * the topic (`ledgerFromMessageId`) or, for a topic the backfill lane rebuilt
 * before any live pass, every message up to and including
 * `historyThroughMessageId`. An entry from history is written only when it is
 * bound to a protected operator row (§15's tier-1 validator; other history
 * refs are counted and left out), with `status: backfilled-unconfirmed`: fully
 * usable, labelled, its normal derivation kept beside it
 * (`backfillDerivedStatus`). A withdrawal or supersession still applies, and
 * the first operator episode after history (re-reference, affirmation or a
 * positive confirmation) gives the entry its normal status. The topic gets ONE
 * `kind: backfill` confirmation: the briefing renders it only once the user
 * has written since it went outstanding, folded into the agent's reply, never
 * as a message of its own; it surfaces and expires on the evolution clock, and
 * it settles when no backfilled-unconfirmed entry is left. Expiry removes only
 * the question: the entries stay usable and labelled.
 *
 * Surfacing uses `TopicIntentPendingConfirm`, extended (`kind: evolution`):
 * every tentative evolution has one (requested on write, and again if lost),
 * the first agent reply after a later user turn marks it SURFACED, and its
 * 7-day clock runs only from there and only after a user message since. On expiry a `user-directed` entry with
 * its bound quote becomes `unconfirmed` (the user's own words never revert by
 * timeout); an `insight-derived` one becomes `expired`.
 *
 * Signal-only toward messages and sessions: nothing here blocks, sends or
 * edits anything. Writers run behind `contextBudget.enabled` only.
 */
import type { EstablishedRef, EvidenceEvent, EvidenceKind, TopicIntentFile } from '../../core/TopicIntent.js';
import type { PendingConfirmationManager } from '../../core/TopicIntentPendingConfirm.js';
import { isSubstantiveTurn } from '../../core/TopicIntentCapture.js';
import { rowRefMatches, type LayerStore, type RowRef, type StoredRecord } from './LayerStore.js';
import { entryKeyFor, stubFor, tokensForChars } from './userCorpus.js';

export const LEDGER_TYPES = ['evolution', 'decision'] as const;
export type LedgerType = typeof LEDGER_TYPES[number];
export const LEDGER_STATUSES = [
  'tentative', 'confirmed', 'withdrawn', 'expired', 'unconfirmed', 'backfilled-unconfirmed',
  'derived-settled', 'settled', 'pending', 'superseded',
] as const;
export type LedgerStatus = typeof LEDGER_STATUSES[number];
export type EvolutionCause = 'user-directed' | 'insight-derived';
export type EvolutionEffect = 'additive' | 'narrowing';
export type EffectBasis = 'extractor-contradiction' | 'extractor-no-contradiction' | 'unread-held-as-narrowing';

/** The Anchor's one record key. */
export const ANCHOR_KEY = 'current';
/** A framing burst: the first substantive operator row and the ones after it before the agent replies. */
export const MAX_FRAMING_ROWS = 3;
/** §8: the last N operator turns (a floor, default 20); a settled entry re-referenced within them never archives. */
export const RECENT_OPERATOR_TURNS = 20;
/** §6 row G: the live set's token target (a writer target, never a truncation gate on the floor). */
export const LIVE_SET_TOKENS = 3_000;
/** topic-intent-layer v14: no more than 3 distinct refs may take an affirmation from one user message. */
export const AFFIRM_REFS_PER_MESSAGE = 3;
/** A full re-derive at least this often per topic even when nothing it reads appears to have changed (a relabel, a late stub). */
export const FULL_RECONCILE_EVERY_TURNS = 20;
/** The refId of a topic's one backfill confirmation (it names the rebuilt history, not a ref). */
export const backfillRefId = (topicId: number): string => `backfill-${topicId}`;
/** Backfilled refs named in the confirmation's one line (the rest are counted). */
export const BACKFILL_CONFIRM_NAMED = 3;
/** Anchor-record facts the backfill keeps across Anchor rewrites. */
const BACKFILL_FIELDS = ['historyThroughMessageId', 'backfilledAt', 'backfillConfirmRequestedAt', 'backfillConfirmSurfacedAt', 'backfillConfirmExpiredAt', 'backfillConfirmSettledAt'] as const;
const carryBackfill = (prev: StoredRecord | null): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of BACKFILL_FIELDS) if (typeof prev?.data[k] === 'number') out[k] = prev.data[k] as number;
  return out;
};
/** The derived statuses a history entry carries as `backfilled-unconfirmed` (it asserts something to confirm). */
const BACKFILL_RELABELLED: Readonly<Record<LedgerType, ReadonlySet<string>>> = {
  decision: new Set(['derived-settled', 'settled']),
  evolution: new Set(['tentative', 'confirmed']),
};
/** A backfill question is asked once; it counts as awaiting an answer this long after it was asked (the evolution clock). */
export const BACKFILL_ASKED_WINDOW_MS = 7 * 24 * 3600_000;
/** Stub kinds that may settle a decision (§6.2). */
export const SETTLING_STUB_KINDS: ReadonlySet<string> = new Set(['answer', 'directive']);

const GREETING_WORDS = new Set([
  'hi', 'hey', 'hello', 'hiya', 'howdy', 'yo', 'sup', 'gm', 'morning', 'afternoon', 'evening', 'good', 'there',
  'all', 'everyone', 'team', 'folks', 'again', 'thanks', 'thank', 'you', 'ok', 'okay', 'cheers', 'welcome', 'back',
]);
const GREETING_OPENERS = new Set(['hi', 'hey', 'hello', 'hiya', 'howdy', 'yo', 'sup', 'gm', 'morning', 'good']);

/**
 * True for an opening greeting with nothing to frame ("hey", "good morning
 * Echo", "hi there!"): every word is a greeting word, or a greeting opener
 * followed by at most two words (a name). Deterministic and fail-open toward
 * substance: anything longer is a candidate.
 */
export function isGreeting(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.every((w) => GREETING_WORDS.has(w))) return true;
  return GREETING_OPENERS.has(words[0]) && words.length <= 3;
}

/** A row that can frame the topic: substantive (the capture pre-filter's rule) and not a greeting. */
export function isFramingCandidate(text: string): boolean {
  return isSubstantiveTurn(text, true) && !isGreeting(text);
}

/** The TopicMemory surface A and G read (satisfied by TopicMemory). */
export interface AnchorRowSource {
  getUserCorpusRows(topicId: number, opts?: { afterRowId?: number; limit?: number; messageId?: number }): { rows: Array<{ rowId: number; message: { messageId: number; text: string } }>; complete: boolean; maxRowId: number };
  messagePrecedes(topicId: number, earlierMessageId: number, laterMessageId: number): boolean | null;
  getAgentMessagesBefore(topicId: number, messageId: number, limit?: number): Array<{ messageId: number }>;
}

/** The TopicIntent surface G reads (satisfied by TopicIntentStore). */
export interface LedgerIntentSource {
  read(topicId: number): TopicIntentFile;
}

export const ledgerKeyFor = (type: LedgerType, refId: string): string => `${type === 'evolution' ? 'ev' : 'dc'}-${refId}`;

const ORIGIN_KINDS: ReadonlySet<EvidenceKind> = new Set(['extract-user', 'extract-agent']);
const WITHDRAW_KINDS: ReadonlySet<EvidenceKind> = new Set(['contradiction', 'pending-confirm-negative']);
const EPISODE_KINDS: ReadonlySet<EvidenceKind> = new Set(['user-reref', 'user-affirm', 'pending-confirm-positive']);
const AGREEMENT_KINDS: ReadonlySet<EvidenceKind> = new Set(['user-affirm', 'pending-confirm-positive']);
/** Evolution statuses that resolve its confirmation (expiry already removed it). */
const RESOLVED: ReadonlySet<LedgerStatus> = new Set(['confirmed', 'withdrawn', 'superseded']);
/** The ref kinds a narrowing evolution contradicts: the purpose itself, or a decision (§6.1). */
const NARROWED_KINDS: ReadonlySet<string> = new Set(['goal', 'decision']);

/** A contradiction the extractor emitted, with the kind of the ref it contradicted. */
interface Contradiction { ev: EvidenceEvent; targetKind: string }

const midOf = (s: string | undefined | null): number | null => (typeof s === 'string' && /^-?\d{1,16}$/.test(s) ? Number(s) : null);
const atMs = (iso: string | undefined): number => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : 0; };

function originOf(ref: EstablishedRef): EvidenceEvent | null {
  return ref.evidence.find((e) => ORIGIN_KINDS.has(e.kind)) ?? null;
}

/** One entry as derived on a reconcile (before it is written). */
interface Derived {
  key: string;
  type: LedgerType;
  ref: EstablishedRef;
  origin: EvidenceEvent;
  originMid: number;
  boundRow: RowRef | null;
  cause: EvolutionCause | null;
  effect: EvolutionEffect | null;
  effectBasis: EffectBasis | null;
  effectEvidence: string[];
  supersedes: string | null;
  postDatesSuperseded: boolean | null;
  stubKind: string | null;
  ownStatus: LedgerStatus;
  statusBasis: string;
  surfacedAt: number | null;
  surfacedAfterMessageId: number | null;
  pendingExpiredAt: number | null;
  pendingRequested: boolean;
  /** The operator episodes counted for this entry (after its origin). */
  episodes: EvidenceEvent[];
}

export interface AnchorLedgerCounters {
  turns: number;
  anchorWrites: number;
  anchorRescans: number;
  entriesWritten: number;
  writeFailed: number;
  evolutionsSkipped: { 'no-anchor': number; framing: number; 'no-message-evidence': number; unordered: number };
  effectSignals: { narrowing: number; additive: number; 'unread-held-as-narrowing': number };
  pendingRequested: Record<'outstanding' | 'queued' | 'deferred' | 'dropped-duplicate', number>;
  pendingRequeued: number;
  /** Confirmations requested again because a tentative evolution had none in the queue. */
  pendingReRequested: number;
  /** Passes skipped because nothing they read had moved. */
  reconcileSkipped: number;
  surfaced: number;
  expired: number;
  settled: number;
  errors: number;
  /** S7: entries written backfilled-unconfirmed, history refs left out, and the one-per-topic confirmation. */
  backfill: {
    topics: number;
    entriesBackfilled: number;
    skippedNotOperator: number;
    confirmRequested: number;
    confirmReRequested: number;
    confirmNoAnchor: number;
    confirmSurfaced: number;
    confirmExpired: number;
    confirmSettled: number;
  };
}

export class AnchorLedger {
  /** Topics whose no-anchor state was scanned this process (a rescan needs a new operator row). */
  private readonly scanned = new Set<number>();
  /** Topics seen while U was backfilling (the Anchor is re-selected once more when it ends). */
  private readonly backfillSeen = new Set<number>();
  readonly counters: AnchorLedgerCounters = {
    turns: 0, anchorWrites: 0, anchorRescans: 0, entriesWritten: 0, writeFailed: 0,
    evolutionsSkipped: { 'no-anchor': 0, framing: 0, 'no-message-evidence': 0, unordered: 0 },
    effectSignals: { narrowing: 0, additive: 0, 'unread-held-as-narrowing': 0 },
    pendingRequested: { outstanding: 0, queued: 0, deferred: 0, 'dropped-duplicate': 0 },
    pendingRequeued: 0, pendingReRequested: 0, reconcileSkipped: 0, surfaced: 0, expired: 0, settled: 0, errors: 0,
    backfill: { topics: 0, entriesBackfilled: 0, skippedNotOperator: 0, confirmRequested: 0, confirmReRequested: 0, confirmNoAnchor: 0, confirmSurfaced: 0, confirmExpired: 0, confirmSettled: 0 },
  };

  constructor(private readonly o: {
    store: LayerStore;
    intent: LedgerIntentSource;
    pending: PendingConfirmationManager;
    rows: AnchorRowSource;
    machine: string;
    /** True while U is still listing older rows for the topic (a no-anchor topic rescans then). */
    backfilling?: (topicId: number) => boolean;
    /** `contextBudget.backfill.enabled` (S7), read live; absent or false ⇒ S6's behaviour exactly. */
    backfill?: () => boolean;
    now?: () => number;
  }) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  private backfillOn(): boolean {
    try { return this.o.backfill?.() === true; } catch { return false; /* @silent-fallback-ok — an unreadable switch reads as off: S6 behaviour */ }
  }

  /** Per-reconcile read cache of U records (one reconcile reads each row's label once). */
  private uCache: Map<string, StoredRecord | null> | null = null;

  private operatorU(topicKey: string, messageId: number): StoredRecord | null {
    const ck = `${topicKey}:${messageId}`;
    let u: StoredRecord | null | undefined = this.uCache?.get(ck);
    if (u === undefined) {
      u = this.o.store.read(topicKey, 'u', entryKeyFor(messageId));
      this.uCache?.set(ck, u);
    }
    return u && u.data.label === 'operator' && u.data.authority === 'operator' && u.rows?.[0] ? u : null;
  }

  private rowText(topicId: number, messageId: number): string | null {
    try {
      const r = this.o.rows.getUserCorpusRows(topicId, { messageId, limit: 1 });
      const m = r.rows[0]?.message;
      return m && typeof m.text === 'string' ? m.text : null;
    } catch { return null; /* @silent-fallback-ok — an unreadable row is never a framing row */ }
  }

  /** No agent message lies between two operator rows (they belong to one burst). */
  private sameBurst(topicId: number, earlier: number, later: number): boolean {
    try {
      const agent = this.o.rows.getAgentMessagesBefore(topicId, later, 1).at(-1);
      if (!agent) return true;
      return this.o.rows.messagePrecedes(topicId, agent.messageId, earlier) === true;
    } catch { return false; /* @silent-fallback-ok — an unanswerable order check ends the burst */ }
  }

  /** Every protected operator row of the topic, in TopicMemory order. */
  private operatorRows(topicKey: string): Array<{ messageId: number; ref: RowRef; at: number | null; order: number }> {
    return this.o.store.list(topicKey, 'u')
      .filter((u) => u.data.label === 'operator' && u.data.authority === 'operator' && u.rows?.[0])
      .map((u) => ({ messageId: u.rows![0].messageId, ref: u.rows![0], at: typeof u.data.at === 'number' ? u.data.at : null, order: typeof u.data.rowId === 'number' ? u.data.rowId : Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.order - b.order || (a.at ?? 0) - (b.at ?? 0) || a.messageId - b.messageId);
  }

  /** The message whose turn is being processed (the first one becomes the Anchor record's `ledgerFromMessageId`). */
  private turnMessageId: number | null = null;

  private writeAnchor(topicKey: string, status: 'anchored' | 'no-anchor', rows: Array<{ messageId: number; ref: RowRef; at: number | null }>, data: Record<string, unknown>): StoredRecord | null {
    const last = rows.at(-1);
    // Where the ledger started on this topic: refs from earlier messages are history (S7's backfill lane),
    // never a fresh evolution asking for confirmation. Kept across rewrites.
    const prev = this.o.store.read(topicKey, 'anchor', ANCHOR_KEY);
    // A topic the backfill lane rebuilt before any live pass has its history bound already
    // (`historyThroughMessageId`): a later live pass never moves it.
    const from = typeof prev?.data.ledgerFromMessageId === 'number' ? prev.data.ledgerFromMessageId
      : typeof prev?.data.historyThroughMessageId === 'number' ? null : this.turnMessageId;
    const res = this.o.store.writeProtected(topicKey, 'anchor', ANCHOR_KEY, rows.map((r) => r.ref), {
      author: { sessionId: null, machine: this.o.machine, model: null, kind: 'user' },
      asOf: { at: last?.at ?? this.now(), lastMessageId: last?.messageId ?? null },
      status,
    }, { messageIds: rows.map((r) => r.messageId), at: rows.map((r) => r.at), selectedBy: 'first-substantive-operator-rows', ...data, ...carryBackfill(prev), ledgerFromMessageId: from ?? null });
    if (!res.written) { this.counters.writeFailed++; return null; }
    this.counters.anchorWrites++;
    return res.record;
  }

  /** The anchor's rows are all still protected operator rows with their hashes. */
  private anchorValid(topicKey: string, rec: StoredRecord): boolean {
    return (rec.rows ?? []).length > 0 && rec.rows!.every((r) => {
      const u = this.operatorU(topicKey, r.messageId);
      return !!u && u.rows![0].sha256 === r.sha256 && u.rows![0].length === r.length;
    });
  }

  /**
   * Find (or keep) the Anchor. An anchored topic is left alone while its rows
   * stay protected, except that a further substantive operator row of the
   * framing burst (before the agent's first reply) joins it. A no-anchor
   * topic is rescanned only on a new operator row, while U is still listing
   * older rows, or once per process.
   */
  refreshAnchor(topicId: number, currentMessageId?: number): StoredRecord | null {
    const topicKey = String(topicId);
    const rec = this.o.store.read(topicKey, 'anchor', ANCHOR_KEY);
    const currentOp = currentMessageId !== undefined && Number.isSafeInteger(currentMessageId) ? this.operatorU(topicKey, currentMessageId) : null;
    // While U is still listing older rows (an existing topic at rollout), an earlier operator row may yet
    // appear: re-select on every pass then, and once more when the backfill ends.
    const bf = this.o.backfilling?.(topicId) ?? false;
    let reselect = false;
    if (bf) { this.backfillSeen.add(topicId); reselect = true; } else if (this.backfillSeen.delete(topicId)) reselect = true;
    if (rec?.status === 'anchored' && !reselect && this.anchorValid(topicKey, rec)) {
      // Extend a framing burst still arriving.
      const rows = rec.rows!;
      if (currentOp && rows.length < MAX_FRAMING_ROWS && !rows.some((r) => r.messageId === currentMessageId)) {
        const lastMid = rows.at(-1)!.messageId;
        const text = this.rowText(topicId, currentMessageId!);
        if (text !== null && rowRefMatches(currentOp.rows![0], text) && isFramingCandidate(text)
          && this.o.rows.messagePrecedes(topicId, lastMid, currentMessageId!) === true && this.sameBurst(topicId, lastMid, currentMessageId!)) {
          const prevAt = Array.isArray(rec.data.at) ? (rec.data.at as Array<number | null>) : [];
          return this.writeAnchor(topicKey, 'anchored', [
            ...rows.map((r, i) => ({ messageId: r.messageId, ref: r, at: prevAt[i] ?? null })),
            { messageId: currentMessageId!, ref: currentOp.rows![0], at: typeof currentOp.data.at === 'number' ? currentOp.data.at : null },
          ], { skippedGreetings: typeof rec.data.skippedGreetings === 'number' ? rec.data.skippedGreetings : 0 }) ?? rec;
        }
      }
      return rec;
    }
    const wasAnchored = rec?.status === 'anchored';
    if (rec?.status === 'no-anchor' && this.scanned.has(topicId) && !currentOp && !(this.o.backfilling?.(topicId) ?? false)) return rec;
    this.scanned.add(topicId);
    this.counters.anchorRescans++;
    const ops = this.operatorRows(topicKey);
    let skipped = 0;
    let framing: Array<{ messageId: number; ref: RowRef; at: number | null }> = [];
    for (const r of ops) {
      const text = this.rowText(topicId, r.messageId);
      if (text === null || !rowRefMatches(r.ref, text)) continue;
      if (framing.length === 0) {
        if (isFramingCandidate(text)) framing = [r]; else skipped++;
        continue;
      }
      if (framing.length >= MAX_FRAMING_ROWS) break;
      const last = framing.at(-1)!.messageId;
      if (!this.sameBurst(topicId, last, r.messageId)) break;
      if (isFramingCandidate(text)) framing.push(r);
    }
    if (framing.length > 0 && rec?.status === 'anchored' && JSON.stringify((rec.rows ?? []).map((r) => [r.messageId, r.sha256])) === JSON.stringify(framing.map((r) => [r.messageId, r.ref.sha256]))) return rec;
    if (framing.length === 0 && wasAnchored && reselect && this.anchorValid(topicKey, rec!)) return rec;
    if (framing.length > 0) return this.writeAnchor(topicKey, 'anchored', framing, { skippedGreetings: skipped, ...(wasAnchored ? { reanchored: true } : {}) });
    if (rec?.status === 'no-anchor' && rec.data.operatorRows === ops.length && rec.data.skippedGreetings === skipped) return rec;
    return this.writeAnchor(topicKey, 'no-anchor', [], { operatorRows: ops.length, skippedGreetings: skipped });
  }

  /**
   * v14's per-message affirmation cap for this pass: at most `AFFIRM_REFS_PER_MESSAGE` refs
   * may take an affirmation from one message (a single "yes" never mass-promotes);
   * the earliest affirm events of each message are the ones that count.
   */
  private affirmAllowed: Set<string> | null = null;

  /** The operator episodes on a ref after its origin (only protected operator rows count; v14's affirmation cap applies). */
  private operatorEpisodes(topicKey: string, ref: EstablishedRef, origin: EvidenceEvent): EvidenceEvent[] {
    return ref.evidence
      .filter((e) => e.eventId !== origin.eventId && e.sourceMessageId !== origin.sourceMessageId && e.userAuthored && atMs(e.at) >= atMs(origin.at))
      .filter((e) => e.kind !== 'user-affirm' || !this.affirmAllowed || this.affirmAllowed.has(e.eventId))
      .filter((e) => { const m = midOf(e.sourceMessageId); return m !== null && !!this.operatorU(topicKey, m); })
      .sort((a, b) => atMs(a.at) - atMs(b.at));
  }

  /** Derive one entry's own status (before supersession is applied). Pure over the inputs. */
  private derive(topicId: number, ref: EstablishedRef, type: LedgerType, origin: EvidenceEvent, originMid: number,
    contradictions: Map<string, Contradiction[]>, entryForRef: Map<string, string>, prev: StoredRecord | null, originOfKey: Map<string, number>): Derived {
    const topicKey = String(topicId);
    const opU = origin.kind === 'extract-user' ? this.operatorU(topicKey, originMid) : null;
    const boundRow = opU ? opU.rows![0] : null;
    const episodes = this.operatorEpisodes(topicKey, ref, origin);
    // Contradictions the extractor read in the SAME message: the effect signal and the supersedes link.
    const sameMsg = (contradictions.get(origin.sourceMessageId) ?? []).filter((c) => c.ev.refId !== ref.refId);
    const supersedable = sameMsg.map((c) => entryForRef.get(`${type}:${c.ev.refId}`)).filter((k): k is string => !!k);
    const supersedes = supersedable[0] ?? null;
    const pd = prev?.data ?? {};
    const surfacedAt = typeof pd.surfacedAt === 'number' ? pd.surfacedAt : null;
    const d: Derived = {
      key: ledgerKeyFor(type, ref.refId), type, ref, origin, originMid, boundRow,
      cause: null, effect: null, effectBasis: null, effectEvidence: [],
      supersedes, postDatesSuperseded: null, stubKind: null,
      ownStatus: 'pending', statusBasis: '',
      surfacedAt,
      surfacedAfterMessageId: typeof pd.surfacedAfterMessageId === 'number' ? pd.surfacedAfterMessageId : null,
      pendingExpiredAt: typeof pd.pendingExpiredAt === 'number' ? pd.pendingExpiredAt : null,
      pendingRequested: pd.pendingRequested === true,
      episodes,
    };
    if (supersedes) {
      const targetMid = originOfKey.get(supersedes) ?? null;
      d.postDatesSuperseded = targetMid === null ? null : this.o.rows.messagePrecedes(topicId, targetMid, originMid) === true;
    }

    if (type === 'evolution') {
      d.cause = boundRow ? 'user-directed' : 'insight-derived';
      // The effect signal: the extractor's own contradiction read on this message, against the purpose or a decision.
      const narrowed = sameMsg.filter((c) => NARROWED_KINDS.has(c.targetKind));
      if (!boundRow) {
        // Not the operator's own row (an agent message, or a third party's or forwarded row): held to the
        // stricter rule — explicit yes after surfacing — whatever the extractor read.
        d.effect = 'narrowing';
        if (narrowed.length > 0) { d.effectBasis = 'extractor-contradiction'; d.effectEvidence = narrowed.map((c) => c.ev.eventId); } else d.effectBasis = 'unread-held-as-narrowing';
      } else if (narrowed.length > 0) {
        d.effect = 'narrowing'; d.effectBasis = 'extractor-contradiction'; d.effectEvidence = narrowed.map((c) => c.ev.eventId);
      } else {
        d.effect = 'additive'; d.effectBasis = 'extractor-no-contradiction';
      }
      // Who may confirm (§6.1): user-directed ⇒ re-reference, affirmation or a positive confirmation;
      // insight-derived ⇒ agreement (affirmation or a positive confirmation), and when narrowing only
      // after it was surfaced. Silence never confirms; acting on it is never a yes.
      const confirms = (e: EvidenceEvent): boolean => {
        if (d.cause === 'user-directed') return EPISODE_KINDS.has(e.kind);
        if (!AGREEMENT_KINDS.has(e.kind)) return false;
        return d.effect !== 'narrowing' || (surfacedAt !== null && atMs(e.at) >= surfacedAt);
      };
      let status: LedgerStatus = 'tentative';
      let basis = 'written';
      for (const e of episodes) {
        if (WITHDRAW_KINDS.has(e.kind)) { status = 'withdrawn'; basis = `operator-${e.kind}`; }
        else if (confirms(e)) { status = 'confirmed'; basis = `operator-${e.kind}`; }
      }
      if (status === 'tentative' && d.pendingExpiredAt !== null) {
        status = d.cause === 'user-directed' ? 'unconfirmed' : 'expired';
        basis = 'confirmation-expired';
      }
      d.ownStatus = status; d.statusBasis = basis;
      return d;
    }

    // Decision transition (§6.2). The operator's last word on it wins: a later withdrawal undoes it.
    const lastWord = episodes.filter((e) => WITHDRAW_KINDS.has(e.kind) || EPISODE_KINDS.has(e.kind)).at(-1);
    if (lastWord && WITHDRAW_KINDS.has(lastWord.kind)) {
      d.ownStatus = 'withdrawn'; d.statusBasis = `operator-${lastWord.kind}`;
      return d;
    }
    if (!boundRow) {
      d.ownStatus = 'pending';
      d.statusBasis = origin.kind === 'extract-agent' ? 'agent-proposed' : 'not-an-operator-row';
      return d;
    }
    const stub = stubFor(this.o.store, topicKey, originMid);
    d.stubKind = stub?.kind ?? null;
    if (!stub) { d.ownStatus = 'pending'; d.statusBasis = 'no-stub'; return d; }
    if (!SETTLING_STUB_KINDS.has(stub.kind)) { d.ownStatus = 'pending'; d.statusBasis = `stub-kind:${stub.kind}`; return d; }
    if (supersedes && d.postDatesSuperseded !== true) { d.ownStatus = 'pending'; d.statusBasis = 'does-not-post-date-superseded'; return d; }
    const promoted = episodes.find((e) => EPISODE_KINDS.has(e.kind));
    if (promoted) { d.ownStatus = 'settled'; d.statusBasis = `operator-${promoted.kind}`; return d; }
    d.ownStatus = 'derived-settled'; d.statusBasis = `stub-kind:${stub.kind}`;
    return d;
  }

  /**
   * Re-derive every entry of the topic from its goal and decision refs and
   * write the ones that changed (a status change re-emits the record, §14).
   * Requests a confirmation for each new evolution; settles the confirmation
   * of one that left `tentative`.
   */
  reconcile(topicId: number, opts: { force?: boolean } = {}): { written: number; entries: number; skipped?: true } {
    // Skip a pass whose inputs did not move: the topic-intent refs and queue, and the Anchor. A full
    // pass still runs every FULL_RECONCILE_EVERY_TURNS turns (a U relabel moves nothing here).
    const file = this.o.intent.read(topicId);
    const anchor = this.o.store.read(String(topicId), 'anchor', ANCHOR_KEY);
    const p = file.pending;
    let events = 0;
    for (const r of Object.values(file.refs)) events += r.evidence.length;
    const sig = [Object.keys(file.refs).length, events, p.outstanding?.pendingId ?? '-', p.outstanding?.surfacedAtTime ?? '-', p.queue.length, (p.deferred ?? []).length, anchor?.writtenAt ?? '-', this.backfillOn() ? 'bf' : '-'].join('|');
    const memo = this.memo.get(topicId);
    if (!opts.force && memo && memo.sig === sig && memo.turns < FULL_RECONCILE_EVERY_TURNS) {
      memo.turns++;
      this.counters.reconcileSkipped++;
      return { written: 0, entries: 0, skipped: true };
    }
    this.uCache = new Map();
    try {
      const failedBefore = this.counters.writeFailed;
      const out = this.reconcileInner(topicId);
      // A failed write is retried next turn, never parked behind the memo.
      if (this.counters.writeFailed !== failedBefore) { this.memo.delete(topicId); return out; }
      // The memo holds the inputs as they stand AFTER this pass (its own queue changes included).
      const f2 = this.o.intent.read(topicId);
      const p2 = f2.pending;
      let ev2 = 0;
      for (const r of Object.values(f2.refs)) ev2 += r.evidence.length;
      this.memo.set(topicId, { sig: [Object.keys(f2.refs).length, ev2, p2.outstanding?.pendingId ?? '-', p2.outstanding?.surfacedAtTime ?? '-', p2.queue.length, (p2.deferred ?? []).length, this.o.store.read(String(topicId), 'anchor', ANCHOR_KEY)?.writtenAt ?? '-', this.backfillOn() ? 'bf' : '-'].join('|'), turns: 0 });
      return out;
    } finally { this.uCache = null; this.affirmAllowed = null; }
  }

  /** Per topic: the inputs the last full pass saw, and turns skipped since. */
  private readonly memo = new Map<number, { sig: string; turns: number }>();

  private reconcileInner(topicId: number): { written: number; entries: number } {
    const topicKey = String(topicId);
    const prevByKey = new Map(this.o.store.list(topicKey, 'ledger-entry').map((r) => [r.entryKey, r]));
    const file = this.o.intent.read(topicId);
    const anchor = this.o.store.read(topicKey, 'anchor', ANCHOR_KEY);
    const anchorRows = anchor?.status === 'anchored' ? (anchor.rows ?? []) : [];
    const anchorLast = anchorRows.at(-1)?.messageId ?? null;
    const ledgerFrom = typeof anchor?.data.ledgerFromMessageId === 'number' ? anchor.data.ledgerFromMessageId : null;
    const historyThrough = typeof anchor?.data.historyThroughMessageId === 'number' ? anchor.data.historyThroughMessageId : null;
    // History: before the ledger's first live pass, or (a topic the lane rebuilt first) up to and including its bound.
    const histMemo = new Map<number, boolean>();
    const predates = (mid: number): boolean => {
      let h = histMemo.get(mid);
      if (h === undefined) {
        h = (ledgerFrom !== null && mid !== ledgerFrom && this.o.rows.messagePrecedes(topicId, mid, ledgerFrom) === true)
          || (historyThrough !== null && (mid === historyThrough || this.o.rows.messagePrecedes(topicId, mid, historyThrough) === true));
        histMemo.set(mid, h);
      }
      return h;
    };
    // After history: strictly later than every bound (an unknown order is never "after").
    const afterHistory = (mid: number): boolean => !predates(mid)
      && (ledgerFrom === null || mid === ledgerFrom || this.o.rows.messagePrecedes(topicId, ledgerFrom, mid) === true)
      && (historyThrough === null || this.o.rows.messagePrecedes(topicId, historyThrough, mid) === true);
    const bfOn = this.backfillOn();
    const refs = Object.values(file.refs).filter((r) => r.kind === 'goal' || r.kind === 'decision');
    // v14's per-message affirmation cap.
    const affirms = new Map<string, EvidenceEvent[]>();
    for (const r of Object.values(file.refs)) for (const e of r.evidence) if (e.kind === 'user-affirm') affirms.set(e.sourceMessageId, [...(affirms.get(e.sourceMessageId) ?? []), e]);
    this.affirmAllowed = new Set([...affirms.values()].flatMap((l) => l.sort((a, b) => atMs(a.at) - atMs(b.at) || (a.eventId < b.eventId ? -1 : 1)).slice(0, AFFIRM_REFS_PER_MESSAGE).map((e) => e.eventId)));
    // Contradiction events by the message that carried them.
    const contradictions = new Map<string, Contradiction[]>();
    for (const r of Object.values(file.refs)) {
      for (const e of r.evidence) {
        if (e.kind === 'contradiction') contradictions.set(e.sourceMessageId, [...(contradictions.get(e.sourceMessageId) ?? []), { ev: e, targetKind: r.kind }]);
      }
    }
    // Which refs are entries (so a contradiction can name what it supersedes).
    const candidates: Array<{ ref: EstablishedRef; type: LedgerType; origin: EvidenceEvent; originMid: number }> = [];
    const entryForRef = new Map<string, string>();
    const originOfKey = new Map<string, number>();
    for (const ref of refs) {
      const type: LedgerType = ref.kind === 'goal' ? 'evolution' : 'decision';
      const key = ledgerKeyFor(type, ref.refId);
      const existing = prevByKey.get(key) ?? null;
      const origin = originOf(ref);
      const originMid = midOf(origin?.sourceMessageId);
      if (!origin || originMid === null) { if (type === 'evolution') this.counters.evolutionsSkipped['no-message-evidence']++; continue; }
      if (type === 'evolution' && !existing) {
        // An evolution is a change to a framed purpose: never before the Anchor, never the framing itself.
        if (anchorLast === null) { this.counters.evolutionsSkipped['no-anchor']++; continue; }
        if (anchorRows.some((a) => a.messageId === originMid)) { this.counters.evolutionsSkipped.framing++; continue; }
        const after = this.o.rows.messagePrecedes(topicId, anchorLast, originMid);
        if (after === null) { this.counters.evolutionsSkipped.unordered++; continue; }
        if (!after) { this.counters.evolutionsSkipped.framing++; continue; }
      }
      // §15's backfill validator: an entry rebuilt from history is bound to an operator-authored row.
      if (bfOn && !existing && predates(originMid) && !(origin.kind === 'extract-user' && this.operatorU(topicKey, originMid))) {
        this.counters.backfill.skippedNotOperator++;
        continue;
      }
      candidates.push({ ref, type, origin, originMid });
      entryForRef.set(`${type}:${ref.refId}`, key);
      originOfKey.set(key, originMid);
    }
    const derived = candidates.map((c) => this.derive(topicId, c.ref, c.type, c.origin, c.originMid, contradictions, entryForRef,
      prevByKey.get(ledgerKeyFor(c.type, c.ref.refId)) ?? null, originOfKey));
    // Supersession: an entry is superseded by a later one that names it and is itself in force.
    const byKey = new Map(derived.map((d) => [d.key, d]));
    const supersededBy = new Map<string, string>();
    for (const d of derived) {
      if (!d.supersedes || !byKey.has(d.supersedes)) continue;
      // Only an entry with operator standing supersedes: a settled decision (bound operator row), or an
      // evolution that is the operator's own (bound row) or that the operator confirmed. A third party's,
      // a forwarded row's or the agent's unconfirmed entry records `supersedes` as a signal only (§8).
      const inForce = d.type === 'decision'
        ? d.ownStatus === 'derived-settled' || d.ownStatus === 'settled'
        : (d.boundRow !== null || d.ownStatus === 'confirmed') && d.ownStatus !== 'withdrawn' && d.ownStatus !== 'expired';
      if (inForce && d.postDatesSuperseded === true) supersededBy.set(d.supersedes, d.key);
    }
    const pendingRefs = new Set([file.pending.outstanding, ...file.pending.queue, ...(file.pending.deferred ?? [])].filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.refId));
    let written = 0;
    const backfilled: Derived[] = [];
    for (const d of derived) {
      const by = supersededBy.get(d.key) ?? null;
      let status: LedgerStatus = by ? 'superseded' : d.ownStatus;
      let basis = by ? `superseded-by:${by}` : d.statusBasis;
      // S7: an operator entry from history is backfilled-unconfirmed (usable, labelled) until the operator's
      // first episode after history; a withdrawal or supersession still applies.
      const fromHistory = bfOn && predates(d.originMid);
      let backfillDerivedStatus: LedgerStatus | null = null;
      // Only a status that asserts something is relabelled: a history decision that never settled (a quote that
      // is evidence, not a decision, §6.2) stays `pending`; a withdrawal or supersession still applies.
      if (fromHistory && d.boundRow && BACKFILL_RELABELLED[d.type].has(status)
        && !d.episodes.some((e) => EPISODE_KINDS.has(e.kind) && afterHistory(midOf(e.sourceMessageId)!))) {
        backfillDerivedStatus = status;
        status = 'backfilled-unconfirmed';
        basis = `backfilled:${backfillDerivedStatus}`;
        backfilled.push(d);
      }
      // A new evolution requests its confirmation first (dedup-safe), so the record can say so.
      let pendingRequested = d.pendingRequested;
      // A tentative evolution always has a confirmation in the queue: requested on write, and requested
      // again if one was lost (dropped at dequeue, cancelled, or left behind on another machine).
      // A goal from a message that predates the ledger on this topic is history: listed, tentative, never a
      // standalone confirmation (§6.1 backfill: `backfilled-unconfirmed`, folded into a reply — S7).
      const predatesLedger = d.type === 'evolution' && (prevByKey.get(d.key)?.data.predatesLedger === true || predates(d.originMid));
      if (d.type === 'evolution' && !predatesLedger && status === 'tentative' && d.pendingExpiredAt === null && !pendingRefs.has(d.ref.refId)) {
        if (pendingRequested) this.counters.pendingReRequested++;
        const r = this.o.pending.create({
          topicId, arcId: d.ref.arcId, refId: d.ref.refId, kind: 'evolution', currentUserTurn: file.turn ?? 0,
          propositionText: d.ref.text,
          questionText: `Purpose update: ${d.ref.text}. Confirm?`,
          now: new Date(this.now()).toISOString(),
        });
        this.counters.pendingRequested[r.status]++;
        if (r.requeuedPendingId) this.counters.pendingRequeued++;
        pendingRequested = true;
      }
      if (d.type === 'evolution' && RESOLVED.has(status) && pendingRefs.has(d.ref.refId)) {
        if (this.o.pending.settle(topicId, d.ref.refId, status, { currentUserTurn: file.turn ?? 0, now: new Date(this.now()).toISOString() })) this.counters.settled++;
      }
      const data: Record<string, unknown> = {
        type: d.type, refId: d.ref.refId, refKind: d.ref.kind,
        cause: d.cause, effect: d.effect, effectBasis: d.effectBasis, effectEvidence: d.effectEvidence,
        originMessageId: d.originMid, originKind: d.origin.kind, originEventId: d.origin.eventId,
        boundMessageId: d.boundRow ? d.originMid : null,
        evidenceMessageIds: d.boundRow ? [] : [d.originMid],
        agentProposed: d.origin.kind === 'extract-agent',
        stubKind: d.stubKind, statusBasis: basis,
        supersedes: d.supersedes, supersededBy: by, postDatesSuperseded: d.postDatesSuperseded,
        surfacedAt: d.surfacedAt, surfacedAfterMessageId: d.surfacedAfterMessageId,
        pendingExpiredAt: d.pendingExpiredAt, pendingRequested, predatesLedger,
        ...(bfOn ? { fromHistory, backfillDerivedStatus } : {}),
        at: atMs(d.origin.at) || null,
        arcId: /^[A-Za-z0-9_.:-]{1,128}$/.test(d.ref.arcId) ? d.ref.arcId : null,
      };
      const prev = prevByKey.get(d.key) ?? null;
      const rows = d.boundRow ? [d.boundRow] : [];
      if (prev && prev.status === status && JSON.stringify(prev.data) === JSON.stringify(data) && JSON.stringify(prev.rows ?? []) === JSON.stringify(rows)) continue;
      if (!prev && d.type === 'evolution' && d.effectBasis) this.counters.effectSignals[d.effectBasis === 'unread-held-as-narrowing' ? 'unread-held-as-narrowing' : d.effect!]++;
      if (status === 'backfilled-unconfirmed' && prev?.status !== 'backfilled-unconfirmed') this.counters.backfill.entriesBackfilled++;
      const res = this.o.store.writeProtected(topicKey, 'ledger-entry', d.key, rows, {
        author: { sessionId: null, machine: this.o.machine, model: null, kind: d.boundRow ? 'user' : 'derived' },
        asOf: { at: atMs(d.origin.at) || this.now(), lastMessageId: d.originMid },
        status,
      }, data);
      if (res.written) { written++; this.counters.entriesWritten++; } else this.counters.writeFailed++;
    }
    if (bfOn) this.backfillConfirmation(topicId, file, backfilled, pendingRefs);
    else if (pendingRefs.has(backfillRefId(topicId))) {
      // Switched off: a queued or outstanding backfill question leaves the queue (rollback leaves no line behind).
      if (this.o.pending.settle(topicId, backfillRefId(topicId), 'switch-off', { currentUserTurn: file.turn ?? 0, now: new Date(this.now()).toISOString() })) this.counters.backfill.confirmSettled++;
    }
    return { written, entries: derived.length };
  }

  /**
   * The topic's one backfill confirmation (§6.1): requested while any entry is
   * backfilled-unconfirmed (again if it was lost before it was asked), settled
   * when none is left. Requesting it only queues it: the briefing renders it
   * once the user has written since it went outstanding, and the reply that
   * carries it asks it ONCE (surfacing removes it from the queue).
   */
  private backfillConfirmation(topicId: number, file: TopicIntentFile, backfilled: Derived[], pendingRefs: Set<string>): void {
    const refId = backfillRefId(topicId);
    const anchor = this.o.store.read(String(topicId), 'anchor', ANCHOR_KEY);
    const ad = anchor?.data ?? {};
    const nowIso = new Date(this.now()).toISOString();
    if (backfilled.length > 0 && !pendingRefs.has(refId) && typeof ad.backfillConfirmExpiredAt !== 'number' && typeof ad.backfillConfirmSurfacedAt !== 'number') {
      // Its facts live on the Anchor record (written by the pass that precedes every reconcile).
      if (!anchor) { this.counters.backfill.confirmNoAnchor++; return; }
      const evo = backfilled.filter((d) => d.type === 'evolution').length;
      // backfilled holds only asserting entries (settled decisions, held purpose changes).
      const named = backfilled.slice(0, BACKFILL_CONFIRM_NAMED).map((d) => (d.ref.text.length > 100 ? `${d.ref.text.slice(0, 99)}…` : d.ref.text));
      const more = backfilled.length - named.length;
      const r = this.o.pending.create({
        topicId, arcId: backfilled[0].ref.arcId, refId, kind: 'backfill', currentUserTurn: file.turn ?? 0,
        propositionText: `Rebuilt from earlier history, not yet confirmed: ${backfilled.length - evo} decision(s), ${evo} purpose change(s): ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}`,
        questionText: 'I rebuilt this conversation\'s purpose and decisions from its history; tell me if anything is wrong.',
        now: nowIso,
      });
      if (r.status === 'dropped-duplicate') return;
      if (typeof ad.backfillConfirmRequestedAt === 'number') this.counters.backfill.confirmReRequested++; else this.counters.backfill.confirmRequested++;
      this.stampAnchor(topicId, { backfillConfirmRequestedAt: this.now() });
      return;
    }
    if (backfilled.length === 0 && pendingRefs.has(refId)) {
      if (this.o.pending.settle(topicId, refId, 'no-backfilled-entry-left', { currentUserTurn: file.turn ?? 0, now: nowIso })) {
        this.counters.backfill.confirmSettled++;
        this.stampAnchor(topicId, { backfillConfirmSettledAt: this.now() });
      }
    }
  }

  /** Store facts on the Anchor record (the backfill's bound and its confirmation's clock). */
  private stampAnchor(topicId: number, fact: Record<string, number>): boolean {
    const topicKey = String(topicId);
    const prev = this.o.store.read(topicKey, 'anchor', ANCHOR_KEY);
    if (!prev) return false;
    const res = this.o.store.writeProtected(topicKey, 'anchor', ANCHOR_KEY, prev.rows ?? [], {
      author: prev.author, asOf: prev.asOf, ...(prev.status ? { status: prev.status } : {}),
    }, { ...prev.data, ...fact });
    if (!res.written) { this.counters.writeFailed++; return false; }
    return true;
  }

  /**
   * The backfill lane's step for one topic (S7), after U has listed its rows:
   * keep the Anchor, bind history (`historyThroughMessageId`, only on a topic
   * no live pass has reached), and re-derive the ledger. Returns what the
   * topic holds now. Switch off ⇒ nothing runs.
   */
  backfillTopic(topicId: number, o: { historyThroughMessageId: number | null }): { ran: false; reason: 'switch-off' } | { ran: true; anchor: 'anchored' | 'no-anchor' | 'not-yet-evaluated'; entries: number; backfilledUnconfirmed: number; boundWritten: boolean } {
    if (!this.backfillOn()) return { ran: false, reason: 'switch-off' };
    this.turnMessageId = null;
    this.refreshAnchor(topicId);
    const topicKey = String(topicId);
    const anchor = this.o.store.read(topicKey, 'anchor', ANCHOR_KEY);
    let boundWritten = false;
    if (anchor) {
      const fact: Record<string, number> = {};
      if (typeof anchor.data.ledgerFromMessageId !== 'number' && typeof anchor.data.historyThroughMessageId !== 'number' && o.historyThroughMessageId !== null && Number.isSafeInteger(o.historyThroughMessageId)) {
        fact.historyThroughMessageId = o.historyThroughMessageId;
      }
      if (typeof anchor.data.backfilledAt !== 'number') fact.backfilledAt = this.now();
      if (Object.keys(fact).length > 0) boundWritten = this.stampAnchor(topicId, fact) && 'historyThroughMessageId' in fact;
      if (fact.backfilledAt !== undefined) this.counters.backfill.topics++;
    }
    this.reconcile(topicId, { force: true });
    const entries = this.o.store.list(topicKey, 'ledger-entry');
    return { ran: true, anchor: anchorView(this.o.store, topicKey).status, entries: entries.length, backfilledUnconfirmed: entries.filter((r) => r.status === 'backfilled-unconfirmed').length, boundWritten };
  }

  /** Store one fact on an entry (surfacing or expiry) and re-derive. */
  private stampEntry(topicId: number, refId: string, fact: Record<string, number>): void {
    const topicKey = String(topicId);
    const key = ledgerKeyFor('evolution', refId);
    const prev = this.o.store.read(topicKey, 'ledger-entry', key);
    if (!prev) return;
    const res = this.o.store.writeProtected(topicKey, 'ledger-entry', key, prev.rows ?? [], {
      author: prev.author, asOf: prev.asOf, ...(prev.status ? { status: prev.status } : {}),
    }, { ...prev.data, ...fact });
    if (!res.written) this.counters.writeFailed++;
  }

  /**
   * Called once per captured turn (layers on). Never throws. Order matters:
   * an agent turn first SURFACES the evolution already outstanding (so the
   * message that creates an evolution never counts as surfacing it), then the
   * Anchor is kept, the ledger re-derived, and the confirmation clock swept.
   */
  afterTurn(topicId: number, entry: { messageId: string | number; fromUser: boolean; automated?: boolean; timestamp?: string | number }): void {
    this.counters.turns++;
    try {
      const mid = midOf(String(entry.messageId));
      const nowIso = new Date(this.now()).toISOString();
      const file0 = this.o.intent.read(topicId);
      let stamped = false;
      if (!entry.fromUser && !entry.automated && mid !== null) {
        const out = file0.pending.outstanding;
        // Surfaced by the first natural reply AFTER a user turn later than the one it went outstanding at:
        // the reply to the very message that created it was composed before the briefing could carry it.
        if ((out?.kind === 'evolution' || out?.kind === 'backfill') && !out.surfacedAtTime && (file0.turn ?? 0) > out.sentAtTurn) {
          const s = this.o.pending.markSurfaced(topicId, { currentUserTurn: file0.turn ?? 0, afterMessageId: String(mid), now: nowIso });
          // The clock starts at the surfacing reply's own time, so an operator answer that follows it is never
          // older than `surfacedAt` merely because capture ran late.
          const replyAt = typeof entry.timestamp === 'number' ? entry.timestamp : Date.parse(entry.timestamp ?? '');
          const at = Number.isFinite(replyAt) && replyAt <= this.now() ? replyAt : this.now();
          if (s && s.kind === 'backfill') {
            // Asked once, in this reply: it leaves the queue at once, so it is never asked again and never holds
            // the slot (§6.1 "when the agent next replies"). The entries stay backfilled-unconfirmed until the
            // operator's own words after history move them.
            this.counters.backfill.confirmSurfaced++;
            this.stampAnchor(topicId, { backfillConfirmSurfacedAt: at });
            this.o.pending.settle(topicId, s.refId, 'asked', { currentUserTurn: file0.turn ?? 0, now: nowIso });
            stamped = true;
          }
          else if (s) { this.counters.surfaced++; this.stampEntry(topicId, s.refId, { surfacedAt: at, surfacedAfterMessageId: mid }); stamped = true; }
        }
      }
      this.turnMessageId = mid;
      this.refreshAnchor(topicId, entry.fromUser && mid !== null ? mid : undefined);
      this.reconcile(topicId, { force: stamped });
      const file = this.o.intent.read(topicId);
      if (file.pending.outstanding?.kind === 'evolution' || file.pending.outstanding?.kind === 'backfill') {
        const swept = this.o.pending.sweepTtl(topicId, file.turn ?? 0, nowIso);
        if (swept?.kind === 'backfill') {
          // Expiry removes only the question: the entries stay backfilled-unconfirmed, usable and labelled.
          this.counters.backfill.confirmExpired++;
          this.stampAnchor(topicId, { backfillConfirmExpiredAt: this.now() });
          this.reconcile(topicId, { force: true });
        } else if (swept) {
          this.counters.expired++;
          this.stampEntry(topicId, swept.refId, { pendingExpiredAt: this.now() });
          this.reconcile(topicId, { force: true });
        }
      }
    } catch (err) {
      // @silent-fallback-ok — the ledger is a derived layer; a failure never affects capture, is counted, and the next turn re-derives everything
      this.counters.errors++;
      console.warn(`[AnchorLedger] topic ${topicId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  status(): { counters: AnchorLedgerCounters } {
    const c = this.counters;
    return { counters: { ...c, evolutionsSkipped: { ...c.evolutionsSkipped }, effectSignals: { ...c.effectSignals }, pendingRequested: { ...c.pendingRequested }, backfill: { ...c.backfill } } };
  }
}

// ── Reading A and G (the route, the metrics, later the packet) ─────────────

export interface LedgerEntryView {
  key: string;
  type: LedgerType;
  status: string;
  statusBasis: string | null;
  cause: string | null;
  effect: string | null;
  effectBasis: string | null;
  effectEvidence: number;
  refId: string | null;
  boundMessageId: number | null;
  evidenceMessageIds: number[];
  stubKind: string | null;
  supersedes: string | null;
  supersededBy: string | null;
  surfacedAt: number | null;
  pendingExpiredAt: number | null;
  /** S7: what the entry derives to apart from being backfilled (null unless backfilled-unconfirmed). */
  backfillDerivedStatus: string | null;
  at: number | null;
  /** Estimated tokens the entry adds to a packet (its bound row, or a short derived line). */
  tokens: number;
}

export function entryView(r: StoredRecord): LedgerEntryView {
  const d = r.data;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const row = r.rows?.[0];
  return {
    key: r.entryKey, type: d.type === 'evolution' ? 'evolution' : 'decision', status: r.status ?? 'unknown',
    statusBasis: str(d.statusBasis), cause: str(d.cause), effect: str(d.effect), effectBasis: str(d.effectBasis),
    effectEvidence: Array.isArray(d.effectEvidence) ? d.effectEvidence.length : 0,
    refId: str(d.refId), boundMessageId: num(d.boundMessageId),
    evidenceMessageIds: Array.isArray(d.evidenceMessageIds) ? (d.evidenceMessageIds as unknown[]).filter((x): x is number => typeof x === 'number') : [],
    stubKind: str(d.stubKind), supersedes: str(d.supersedes), supersededBy: str(d.supersededBy),
    surfacedAt: num(d.surfacedAt), pendingExpiredAt: num(d.pendingExpiredAt), backfillDerivedStatus: r.status === 'backfilled-unconfirmed' ? str(d.backfillDerivedStatus) : null, at: num(d.at),
    tokens: row ? tokensForChars(row.length) + 12 : 40,
  };
}

export type ArchiveReason = 'status' | 'age';

/**
 * Live-set selection (§6.2), deterministic floor plus the age rung:
 *  1. superseded, withdrawn, expired, and unconfirmed-and-superseded entries
 *     archive first;
 *  2. a settled or confirmed entry whose ref belongs to the current phase
 *     (H2 present and the ref's arc is H2's) or that the operator
 *     re-referenced within the last N operator turns NEVER archives (it may
 *     exceed the budget; `overBudget` says so);
 *  3. the rest, newest first, while the token budget lasts; age is the last
 *     rung. `derived-settled` is not in the floor until promoted.
 * The judgment arbiter above this floor (§12: the handoff audit model) arrives
 * with the folds; this is the floor it may never cut.
 */
export function selectLiveSet(entries: readonly LedgerEntryView[], ctx: {
  phaseArcId: string | null;
  arcOf: (refId: string) => string | null;
  reReferencedRecently: (refId: string) => boolean;
  budgetTokens?: number;
}): { live: string[]; floor: string[]; archived: Array<{ key: string; reason: ArchiveReason }>; tokens: number; overBudget: boolean } {
  const budget = ctx.budgetTokens ?? LIVE_SET_TOKENS;
  const archived: Array<{ key: string; reason: ArchiveReason }> = [];
  const floor: LedgerEntryView[] = [];
  const rest: LedgerEntryView[] = [];
  for (const e of entries) {
    if (e.status === 'superseded' || e.status === 'withdrawn' || e.status === 'expired' || (e.status === 'unconfirmed' && e.supersededBy)) {
      archived.push({ key: e.key, reason: 'status' });
      continue;
    }
    // A backfilled entry keeps the floor its derivation earned (usable, labelled; §6.1).
    const eff = e.status === 'backfilled-unconfirmed' && e.backfillDerivedStatus ? e.backfillDerivedStatus : e.status;
    const protectedStatus = eff === 'settled' || eff === 'confirmed';
    const inPhase = !!(ctx.phaseArcId && e.refId && ctx.arcOf(e.refId) === ctx.phaseArcId);
    if (protectedStatus && (inPhase || (e.refId !== null && ctx.reReferencedRecently(e.refId)))) floor.push(e);
    else rest.push(e);
  }
  let tokens = floor.reduce((n, e) => n + e.tokens, 0);
  const live = floor.map((e) => e.key);
  // Age is the last rung: newest first, and once one does not fit, everything older archives (a strict prefix).
  let full = false;
  for (const e of [...rest].sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || (a.key < b.key ? -1 : 1))) {
    if (!full && tokens + e.tokens <= budget) { live.push(e.key); tokens += e.tokens; } else { full = true; archived.push({ key: e.key, reason: 'age' }); }
  }
  return { live, floor: floor.map((e) => e.key), archived, tokens, overBudget: tokens > budget };
}

export interface AnchorView {
  status: 'anchored' | 'no-anchor' | 'not-yet-evaluated';
  rows: Array<{ messageId: number; length: number; tokens: number; at: number | null }>;
  skippedGreetings: number | null;
  writtenAt: number | null;
}

export function anchorView(store: LayerStore, topicKey: string): AnchorView {
  const rec = store.read(topicKey, 'anchor', ANCHOR_KEY);
  if (!rec) return { status: 'not-yet-evaluated', rows: [], skippedGreetings: null, writtenAt: null };
  const at = Array.isArray(rec.data.at) ? (rec.data.at as unknown[]) : [];
  return {
    status: rec.status === 'anchored' ? 'anchored' : 'no-anchor',
    rows: (rec.rows ?? []).map((r, i) => ({ messageId: r.messageId, length: r.length, tokens: tokensForChars(r.length), at: typeof at[i] === 'number' ? at[i] as number : null })),
    skippedGreetings: typeof rec.data.skippedGreetings === 'number' ? rec.data.skippedGreetings : null,
    writtenAt: rec.writtenAt,
  };
}

/** Counts per status and type (zero-filled), for the route and the metrics. */
export function ledgerCounts(entries: readonly Pick<LedgerEntryView, 'type' | 'status'>[]): { total: number; byType: Record<LedgerType, number>; byStatus: Record<string, number> } {
  const byType = { evolution: 0, decision: 0 } as Record<LedgerType, number>;
  const byStatus = Object.fromEntries(LEDGER_STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const e of entries) { byType[e.type]++; byStatus[e.status] = (byStatus[e.status] ?? 0) + 1; }
  return { total: entries.length, byType, byStatus };
}

/** The confirmation queue's shape for evolutions and refs: never the proposition text. */
export function pendingSummary(file: TopicIntentFile | null): {
  outstanding: { kind: 'ref' | 'evolution' | 'backfill'; refId: string; surfaced: boolean; surfacedAt: string | null; awaitingUserActivity: boolean } | null;
  queued: { evolution: number; backfill: number; ref: number };
  deferred: { evolution: number; backfill: number; ref: number };
  telemetry: { deferredTotal: number; requeuedTotal: number; settledTotal: number; expiredTotal: number };
} | null {
  if (!file) return null;
  const count = (l: Array<{ kind?: string }>) => ({ evolution: l.filter((p) => p.kind === 'evolution').length, backfill: l.filter((p) => p.kind === 'backfill').length, ref: l.filter((p) => p.kind !== 'evolution' && p.kind !== 'backfill').length });
  const o = file.pending.outstanding;
  const t = file.telemetry;
  return {
    outstanding: o ? {
      kind: o.kind === 'evolution' ? 'evolution' : o.kind === 'backfill' ? 'backfill' : 'ref', refId: o.refId, surfaced: !!o.surfacedAtTime, surfacedAt: o.surfacedAtTime ?? null,
      // A backfill confirmation is not shown until the user has written since it went outstanding (§6.1).
      awaitingUserActivity: o.kind === 'backfill' && (file.turn ?? 0) <= o.sentAtTurn,
    } : null,
    queued: count(file.pending.queue),
    deferred: count(file.pending.deferred ?? []),
    telemetry: { deferredTotal: t.pending_confirm_deferred_total ?? 0, requeuedTotal: t.pending_confirm_requeued_total ?? 0, settledTotal: t.pending_confirm_settled_total ?? 0, expiredTotal: t.pending_confirm_expired_total },
  };
}

/**
 * The route's view of one topic's A and G: row references, labels, statuses
 * and counts — never message text. `intent` (the topic's TopicIntent file) is
 * optional; without it the live set has no phase and no re-references, and
 * the confirmation queue is unknown.
 */
export function anchorLedgerView(store: LayerStore, topicKey: string, intent: TopicIntentFile | null, opts: { limit?: number } = {}) {
  const anchor = anchorView(store, topicKey);
  const entries = store.list(topicKey, 'ledger-entry').map(entryView).sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || (a.key < b.key ? -1 : 1));
  // The last N operator turns (U order) for the re-reference floor.
  const ops = store.list(topicKey, 'u')
    .filter((u) => u.data.label === 'operator' && u.data.authority === 'operator' && u.rows?.[0])
    .sort((a, b) => (Number(a.data.rowId) || 0) - (Number(b.data.rowId) || 0));
  const recent = new Set(ops.slice(-RECENT_OPERATOR_TURNS).map((u) => String(u.rows![0].messageId)));
  const h2 = store.read(topicKey, 'h2', 'current');
  const phaseArcId = h2?.status === 'live' && typeof h2.data.arcId === 'string' ? h2.data.arcId : null;
  const refs = intent?.refs ?? {};
  const live = selectLiveSet(entries, {
    phaseArcId,
    arcOf: (refId) => refs[refId]?.arcId ?? null,
    reReferencedRecently: (refId) => (refs[refId]?.evidence ?? []).some((e) => EPISODE_KINDS.has(e.kind) && recent.has(e.sourceMessageId)),
  });
  const liveSet = new Set(live.live);
  const limit = Math.max(0, Math.min(opts.limit ?? 50, 500));
  return {
    anchor,
    counts: ledgerCounts(entries),
    liveSet: { budgetTokens: LIVE_SET_TOKENS, tokens: live.tokens, overBudget: live.overBudget, live: live.live.length, floor: live.floor.length, archived: live.archived.length, archivedByReason: { status: live.archived.filter((a) => a.reason === 'status').length, age: live.archived.filter((a) => a.reason === 'age').length }, phaseArcId, recentOperatorTurns: recent.size },
    pending: pendingSummary(intent),
    backfill: backfillView(store, topicKey, entries),
    entries: entries.slice(0, limit).map((e) => ({ ...e, live: liveSet.has(e.key) })),
  };
}

/**
 * `pending`: requested, waiting for the next reply after user activity;
 * `asked`: asked in a reply, entries still unconfirmed, within the 7-day window;
 * `expired`: asked longer ago than that (or expired by the clock) with entries left;
 * `settled`: nothing left unconfirmed.
 */
export type BackfillConfirmationState = 'none' | 'pending' | 'asked' | 'expired' | 'settled';

export interface BackfillView {
  /** `backfilled`: the lane (or a live pass with the switch on) rebuilt this topic's history. */
  state: 'backfilled' | 'not-backfilled';
  backfilledAt: number | null;
  /** The history bound the lane set (null when a live pass bound history first, via `ledgerFromMessageId`). */
  historyThroughMessageId: number | null;
  ledgerFromMessageId: number | null;
  backfilledUnconfirmed: number;
  /**
   * The one-per-topic confirmation, from the Anchor record's facts. `pending`
   * and `asked` are what the dashboard card and Home count (awaiting the
   * operator's word); see BackfillConfirmationState.
   */
  confirmation: BackfillConfirmationState;
  confirmRequestedAt: number | null;
  confirmSurfacedAt: number | null;
  confirmExpiredAt: number | null;
  confirmSettledAt: number | null;
}

/** The backfill state of one topic, from the layer store alone (replicated Anchor facts and entry statuses). */
export function backfillView(store: LayerStore, topicKey: string, entries?: readonly Pick<LedgerEntryView, 'status'>[], o?: { now?: () => number }): BackfillView {
  const rec = store.read(topicKey, 'anchor', ANCHOR_KEY);
  const d = rec?.data ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const n = (entries ?? store.list(topicKey, 'ledger-entry').map(entryView)).filter((e) => e.status === 'backfilled-unconfirmed').length;
  const requested = num(d.backfillConfirmRequestedAt);
  const expired = num(d.backfillConfirmExpiredAt);
  const settled = num(d.backfillConfirmSettledAt);
  const surfaced = num(d.backfillConfirmSurfacedAt);
  const confirmation: BackfillConfirmationState = requested === null ? 'none'
    : n === 0 ? 'settled'
      : expired !== null ? 'expired'
        : surfaced !== null ? ((o?.now ?? Date.now)() - surfaced >= BACKFILL_ASKED_WINDOW_MS ? 'expired' : 'asked')
          : settled !== null && settled >= requested ? 'settled' : 'pending';
  return {
    state: num(d.backfilledAt) !== null || n > 0 ? 'backfilled' : 'not-backfilled',
    backfilledAt: num(d.backfilledAt), historyThroughMessageId: num(d.historyThroughMessageId), ledgerFromMessageId: num(d.ledgerFromMessageId),
    backfilledUnconfirmed: n, confirmation,
    confirmRequestedAt: requested, confirmSurfacedAt: num(d.backfillConfirmSurfacedAt), confirmExpiredAt: expired, confirmSettledAt: settled,
  };
}

/** Cheap per-topic measure for the metrics: the Anchor's state, the ledger's counts and the backfill. */
export function measureAnchorLedger(store: LayerStore, topicKey: string): { anchor: AnchorView['status']; anchorRows: number; ledger: ReturnType<typeof ledgerCounts>; backfill: { state: BackfillView['state']; backfilledUnconfirmed: number; confirmation: BackfillConfirmationState } } {
  const a = anchorView(store, topicKey);
  const entries = store.list(topicKey, 'ledger-entry').map(entryView);
  const b = backfillView(store, topicKey, entries);
  return { anchor: a.status, anchorRows: a.rows.length, ledger: ledgerCounts(entries), backfill: { state: b.state, backfilledUnconfirmed: b.backfilledUnconfirmed, confirmation: b.confirmation } };
}
