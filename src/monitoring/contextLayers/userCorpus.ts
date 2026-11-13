/**
 * U — the protected user corpus, with its referent stubs
 * (context-budget-layered-summaries §6 row U, §6.2 stub `kind`, §8, §14, §15).
 *
 * Source: TopicMemory SENDER ROWS, never transcript roles (§8: hook
 * injections arrive as "user" in the transcript and are not the user). Every
 * `from_user=1` row and every row that arrived through another agent is
 * listed, each as a PROTECTED `u` record holding only a row reference
 * (message id, sha256, length), its time and a label — never the words:
 *
 *   - `operator`    — the operator's own typed row: `from_user=1`, `forwarded`
 *                     not 1, no relay/A2A origin, the sender resolved as the
 *                     operator. The protected class; `authority: operator`.
 *   - `forwarded`   — `forwarded=1`. Kept, labelled, `authority: none`.
 *   - `relay`       — a relay or A2A origin. Kept, labelled, `authority: none`.
 *   - `third-party` — any other sender (including one the binding cannot
 *                     resolve). Kept, labelled, `authority: none`.
 *
 * U bodies are re-derived from rows on the owning machine and never
 * replicate (the `u` type maps to no replicated kind); only the stubs do (§14).
 *
 * Referent stubs ride the extractor's EXISTING per-message call (§6.4: never
 * a second call, same brakes). The model's proposal is validated here,
 * deterministically, after the call (§15, tier 1); a rejected stub is counted
 * and dropped and the message itself is unaffected. A valid stub is written
 * as a derived `u-stub` record keyed beside (never into) its quote, `author:
 * derived`, bound to the quote's hash, and replicates. A quote that changes
 * (a relabel) withdraws its stub with a replicated record. Later slices read
 * a stub ONLY through `stubFor`, which returns it only while it still belongs
 * to a protected operator quote.
 *
 * Listing is bounded per turn (`REFRESH_ROWS`, the current message's own row
 * first) from a persisted per-topic watermark, so a restart never re-reads a
 * long topic and a long backfill never stalls one message.
 *
 * Large pastes: a row over `PASTED_ARTIFACT_CHARS` is flagged
 * `pastedArtifact` and kept whole; the excerpt-and-pointer handling once
 * superseded arrives with the Phase 2 folds. <!-- tracked: CMT-1536 -->
 *
 * Signal-only: nothing here decides about a message or a session. The
 * Anchor, the ledger and confirmations (later slices) read `authority`;
 * this module only labels.
 */
import type { TopicMessage } from '../../memory/TopicMemory.js';
import { REFERENT_STUB_KINDS, type ReferentCandidate, type ReferentStubKind, type ReferentStubProposal } from '../../core/TopicIntentExtractor.js';
import { isAgentSentinelLine, type NoStubReason } from '../../core/TopicIntentCapture.js';
import { rowRefFor, type LayerStore, type StoredRecord } from './LayerStore.js';

export type UserCorpusLabel = 'operator' | 'forwarded' | 'relay' | 'third-party';
export const USER_CORPUS_LABELS: readonly UserCorpusLabel[] = ['operator', 'forwarded', 'relay', 'third-party'];

/**
 * Over this many characters a row is a pasted artifact, kept whole until
 * superseded (§8). basis: one extractor message window (MAX_MESSAGE_CHARS);
 * a paste longer than the extractor can read whole is the class §8 names.
 */
export const PASTED_ARTIFACT_CHARS = 4000;
/** §15: a stub is one line of at most ~160 characters. */
export const MAX_STUB_CHARS = 160;
/** A user sentence at least this long (normalised) found inside a stub is a copied quote. */
export const QUOTE_MIN_CHARS = 12;
/** A run of this many consecutive user words found inside a stub is a copied quote. */
export const QUOTE_MIN_WORDS = 5;
/**
 * Rows listed per refresh: the rest of a backfill continues on the next turn.
 * basis: event-loop cost; each row is one read, one hash and (when new) one
 * small write, and the current message's own row is always listed first.
 */
export const REFRESH_ROWS = 200;
/** Agent rows scanned back for referent candidates, and candidates offered. */
const CANDIDATE_SCAN = 12;
const CANDIDATES = 3;
/** The entry key of a topic's persisted listing watermark (its own `u-mark` record type, never a `u` row). */
export const WATERMARK_KEY = 'watermark';
/** Token estimate for a row: the same chars/4 the capture brakes use. */
export const tokensForChars = (chars: number): number => Math.ceil(chars / 4);

/** The minimal TopicMemory surface U reads. */
export interface UserCorpusRowSource {
  getUserCorpusRows(topicId: number, opts?: { afterRowId?: number; limit?: number; messageId?: number }): { rows: Array<{ rowId: number; message: TopicMessage }>; complete: boolean; maxRowId: number };
  messagePrecedes(topicId: number, earlierMessageId: number, laterMessageId: number): boolean | null;
  getAgentMessagesBefore(topicId: number, messageId: number, limit?: number): TopicMessage[];
}

/** The operator binding (MemoryPrivacy): the row's sender key and its resolved profile id. */
export type OperatorResolver = (sender: { senderKey: string | null; userId: string | null }) => boolean;

/** The sender key a row carries, in MemoryPrivacy's shape (`user:<id>`, else `telegram:<id>`). */
export function senderKeyOf(m: Pick<TopicMessage, 'userId' | 'telegramUserId'>): string | null {
  if (m.userId) return `user:${m.userId}`;
  if (typeof m.telegramUserId === 'number' && Number.isFinite(m.telegramUserId)) return `telegram:${m.telegramUserId}`;
  return null;
}

/** Label a sender row. Precedence: another agent's origin, then forwarding, then the operator binding. */
export function classifyRow(m: Pick<TopicMessage, 'fromUser' | 'forwarded' | 'origin' | 'userId' | 'telegramUserId'>, isOperator?: OperatorResolver): { label: UserCorpusLabel; authority: 'operator' | 'none' } {
  if (m.origin === 'relay' || m.origin === 'a2a') return { label: 'relay', authority: 'none' };
  if (m.forwarded === true) return { label: 'forwarded', authority: 'none' };
  if (m.fromUser === true && isOperator) {
    let op = false;
    try { op = isOperator({ senderKey: senderKeyOf(m), userId: m.userId ?? null }); } catch { op = false; /* @silent-fallback-ok — an unresolvable sender is never the operator; it is labelled third-party and carries no authority */ }
    if (op) return { label: 'operator', authority: 'operator' };
  }
  return { label: 'third-party', authority: 'none' };
}

// ── The stub validator (§15 tier 1, deterministic) ─────────────────────────

export type StubRejectReason =
  | 'none-given'
  | 'multi-line'
  | 'too-long'
  | 'not-bracketed'
  | 'unknown-kind'
  | 'bad-reference'
  | 'reference-not-preceding'
  | 'contains-quote';
export const STUB_REJECT_REASONS: readonly StubRejectReason[] = ['none-given', 'multi-line', 'too-long', 'not-bracketed', 'unknown-kind', 'bad-reference', 'reference-not-preceding', 'contains-quote'];

export interface ValidStub { text: string; kind: ReferentStubKind; refersTo: number }

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * True when the stub carries the user's own words: a whole sentence (at least
 * `QUOTE_MIN_CHARS`, normalised) or any run of `QUOTE_MIN_WORDS` consecutive
 * user words. Punctuation- and case-insensitive.
 */
export function stubContainsQuote(stub: string, userText: string): boolean {
  const s = norm(stub);
  if (!s) return false;
  const padded = ` ${s} `;
  const whole = norm(userText);
  if (whole.length >= QUOTE_MIN_CHARS && s.includes(whole)) return true;
  for (const sentence of userText.split(/[.!?;\n\r]+/)) {
    const n = norm(sentence);
    if (n.length >= QUOTE_MIN_CHARS && s.includes(n)) return true;
  }
  const words = whole ? whole.split(' ') : [];
  for (let i = 0; i + QUOTE_MIN_WORDS <= words.length; i++) {
    if (padded.includes(` ${words.slice(i, i + QUOTE_MIN_WORDS).join(' ')} `)) return true;
  }
  return false;
}

/**
 * Validate the model's stub against the rules of §6.2/§15. `precedes`
 * answers whether a message id names a TopicMemory row of the topic that
 * precedes the user message (null = no such row).
 */
export function validateReferentStub(
  p: ReferentStubProposal | null | undefined,
  ctx: { userText: string; userMessageId: number; precedes: (refersTo: number) => boolean | null },
): { ok: true; stub: ValidStub } | { ok: false; reason: StubRejectReason } {
  if (!p || typeof p.stub !== 'string' || !p.stub.trim()) return { ok: false, reason: 'none-given' };
  const text = p.stub.trim();
  if (/[\r\n\u2028\u2029]/.test(text)) return { ok: false, reason: 'multi-line' };
  if (text.length > MAX_STUB_CHARS) return { ok: false, reason: 'too-long' };
  if (!text.startsWith('[') || !text.endsWith(']')) return { ok: false, reason: 'not-bracketed' };
  if (!(REFERENT_STUB_KINDS as readonly string[]).includes(p.kind)) return { ok: false, reason: 'unknown-kind' };
  const ref = typeof p.refersTo === 'string' && /^-?\d{1,16}$/.test(p.refersTo.trim()) ? Number(p.refersTo.trim()) : NaN;
  if (!Number.isSafeInteger(ref) || ref === ctx.userMessageId) return { ok: false, reason: 'bad-reference' };
  let before: boolean | null = null;
  try { before = ctx.precedes(ref); } catch { before = null; /* @silent-fallback-ok — an unanswerable precedence check rejects the stub (counted), never accepts it */ }
  if (before !== true) return { ok: false, reason: 'reference-not-preceding' };
  if (stubContainsQuote(text, ctx.userText)) return { ok: false, reason: 'contains-quote' };
  return { ok: true, stub: { text, kind: p.kind as ReferentStubKind, refersTo: ref } };
}

// ── Reading U (the route, the S13 metrics, and S6's ledger) ────────────────

export function entryKeyFor(messageId: number): string { return `m-${messageId}`; }

const isRowRecord = (r: StoredRecord): boolean => (USER_CORPUS_LABELS as readonly string[]).includes(String(r.data.label)) && !!r.rows?.[0];

/** A stub that still belongs to its quote: the `u` row is the operator's, its hash matches, and the stub is not withdrawn. */
function stubBelongs(stub: StoredRecord | null | undefined, u: StoredRecord | null | undefined): boolean {
  if (!stub || !u || stub.status === 'withdrawn' || stub.data.withdrawn === true) return false;
  if (u.data.label !== 'operator' || !u.rows?.[0]) return false;
  return stub.data.quoteSha256 === u.rows[0].sha256;
}

/**
 * The ONE reader later slices use for a message's stub (S6 reads `kind`):
 * returned only while the quote is a protected operator row whose text still
 * hashes to what the stub was written for, and the stub is not withdrawn.
 */
export function stubFor(store: LayerStore, topicKey: string, messageId: number): { text: string; kind: ReferentStubKind; refersTo: number } | null {
  const key = entryKeyFor(messageId);
  const stub = store.read(topicKey, 'u-stub', key);
  if (!stubBelongs(stub, store.read(topicKey, 'u', key))) return null;
  const kind = String(stub!.data.kind);
  if (!(REFERENT_STUB_KINDS as readonly string[]).includes(kind) || typeof stub!.data.refersTo !== 'number') return null;
  return { text: String(stub!.data.stub ?? ''), kind: kind as ReferentStubKind, refersTo: stub!.data.refersTo };
}

export interface UserCorpusMeasure {
  topicKey: string;
  /** Rows listed in U, by label: messages and estimated tokens (chars/4). */
  byLabel: Record<UserCorpusLabel, { messages: number; tokens: number }>;
  /** The protected class (operator rows) only. */
  protected: { messages: number; tokens: number; chars: number };
  pastedArtifacts: number;
  /** Rows that came in through another agent but were written by this agent (its own A2A mirror). */
  agentAuthored: number;
  /** User rows with no sender identity at all (legacy rows): labelled third-party, never protected. */
  unattributed: number;
  stubs: { written: number; withdrawn: number; operatorRowsWithStub: number; coverage: number | null; byKind: Record<string, number> };
  /** Last row listed: its message id and time. */
  lastMessageId: number | null;
  lastAt: number | null;
}

/** One row of U as the route lists it: labels, sizes and the stub's kind — never words. */
export interface UserCorpusEntryView {
  messageId: number | null;
  label: UserCorpusLabel;
  authority: 'operator' | 'none';
  length: number;
  tokens: number;
  at: number | null;
  pastedArtifact: boolean;
  stub: { kind: string; refersTo: number | null } | null;
}

/** Measure and list U in one pass over the store (one listing of `u`, one of `u-stub`). */
export function userCorpusView(store: LayerStore, topicKey: string, limit = 50): { measure: UserCorpusMeasure; entries: UserCorpusEntryView[] } {
  const byLabel = Object.fromEntries(USER_CORPUS_LABELS.map((l) => [l, { messages: 0, tokens: 0 }])) as UserCorpusMeasure['byLabel'];
  const prot = { messages: 0, tokens: 0, chars: 0 };
  let pasted = 0; let agentAuthored = 0; let unattributed = 0;
  let lastMessageId: number | null = null;
  let lastAt: number | null = null;
  const rows = store.list(topicKey, 'u').filter(isRowRecord);
  const stubs = new Map(store.list(topicKey, 'u-stub').map((s) => [s.entryKey, s]));
  const byKind: Record<string, number> = {};
  let withStub = 0; let withdrawn = 0; let live = 0;
  for (const s of stubs.values()) {
    if (s.status === 'withdrawn' || s.data.withdrawn === true) { withdrawn++; continue; }
    live++;
  }
  const entries: UserCorpusEntryView[] = [];
  for (const r of rows) {
    const label = r.data.label as UserCorpusLabel;
    const len = r.rows![0].length;
    byLabel[label].messages++;
    byLabel[label].tokens += tokensForChars(len);
    if (label === 'operator') { prot.messages++; prot.chars += len; prot.tokens += tokensForChars(len); }
    if (r.data.pastedArtifact === true) pasted++;
    if (r.data.agentAuthored === true) agentAuthored++;
    if (r.data.unattributed === true) unattributed++;
    const at = typeof r.data.at === 'number' ? r.data.at : null;
    const mid = r.rows![0].messageId;
    if (at !== null && (lastAt === null || at > lastAt)) { lastAt = at; lastMessageId = mid; }
    const s = stubs.get(r.entryKey);
    const belongs = stubBelongs(s, r);
    if (belongs) {
      withStub++;
      const k = String(s!.data.kind ?? 'other');
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    entries.push({
      messageId: Number.isSafeInteger(mid) ? mid : null, label,
      authority: r.data.authority === 'operator' ? 'operator' : 'none',
      length: len, tokens: tokensForChars(len), at,
      pastedArtifact: r.data.pastedArtifact === true,
      stub: belongs ? { kind: String(s!.data.kind ?? 'other'), refersTo: typeof s!.data.refersTo === 'number' ? s!.data.refersTo : null } : null,
    });
  }
  entries.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return {
    measure: {
      topicKey, byLabel, protected: prot, pastedArtifacts: pasted, agentAuthored, unattributed,
      stubs: { written: live, withdrawn, operatorRowsWithStub: withStub, coverage: prot.messages ? withStub / prot.messages : null, byKind },
      lastMessageId, lastAt,
    },
    entries: entries.slice(0, Math.max(0, limit)),
  };
}

export function measureUserCorpus(store: LayerStore, topicKey: string): UserCorpusMeasure {
  return userCorpusView(store, topicKey, 0).measure;
}

// ── The builder ────────────────────────────────────────────────────────────

export type StubDropReason = StubRejectReason | 'not-operator' | 'row-mismatch' | 'not-a-candidate';

export interface UserCorpusCounters {
  refreshes: number;
  rowsWritten: number;
  rowWriteFailed: number;
  stubsRequested: number;
  stubsWritten: number;
  stubWriteFailed: number;
  stubsWithdrawn: number;
  stubsRejected: Record<StubDropReason, number>;
  /** Operator rows that got no stub request, by reason. */
  noStub: Record<NoStubReason, number>;
}

export class UserCorpus {
  /** Per topic: the last SQLite row id listed; loaded from the persisted watermark on first use. */
  private readonly watermark = new Map<number, number>();
  /** The binding fingerprint each in-memory watermark was made under. */
  private readonly watermarkFp = new Map<number, string>();
  private readonly backfillPending = new Set<number>();
  readonly counters: UserCorpusCounters = {
    refreshes: 0, rowsWritten: 0, rowWriteFailed: 0, stubsRequested: 0, stubsWritten: 0, stubWriteFailed: 0, stubsWithdrawn: 0,
    stubsRejected: { 'none-given': 0, 'multi-line': 0, 'too-long': 0, 'not-bracketed': 0, 'unknown-kind': 0, 'bad-reference': 0, 'reference-not-preceding': 0, 'contains-quote': 0, 'not-operator': 0, 'row-mismatch': 0, 'not-a-candidate': 0 },
    noStub: { 'no-candidates': 0, 'skipped-prefilter': 0, 'skipped-automation': 0, 'skipped-shed': 0, 'skipped-rate': 0, 'deferred-budget': 0, degraded: 0 },
  };

  constructor(private readonly o: {
    store: LayerStore;
    rows: UserCorpusRowSource;
    /** The operator binding; absent ⇒ no row is the operator (every row labelled, none protected). */
    isOperator?: OperatorResolver;
    /**
     * Who counts as the operator, as a fingerprint (MemoryPrivacy). When it
     * differs from the one the listing was made under, U is re-listed from the
     * start (bounded per turn) so every row's label and authority follow the
     * binding.
     */
    bindingFingerprint?: () => string;
    machine: string;
    model?: string | null;
    now?: () => number;
  }) {}

  get operatorBinding(): 'wired' | 'unavailable' { return this.o.isOperator ? 'wired' : 'unavailable'; }

  /** True while a topic's listing has more rows to read than one refresh takes. */
  backfilling(topicId: number): boolean { return this.backfillPending.has(topicId); }

  private now(): number { return (this.o.now ?? Date.now)(); }

  private meta(lastMessageId: number | null, at: number, kind: 'user' | 'derived', status: string) {
    return {
      author: { sessionId: null, machine: this.o.machine, model: kind === 'derived' ? (this.o.model ?? null) : null, kind },
      asOf: { at, lastMessageId },
      status,
    } as const;
  }

  /** List one row. */
  private listRow(topicId: number, rowId: number, m: TopicMessage): 'written' | 'unchanged' | 'failed' | 'refused' {
    if (!Number.isSafeInteger(m.messageId) || typeof m.text !== 'string') return 'unchanged';
    const topicKey = String(topicId);
    const { label, authority } = classifyRow(m, this.o.isOperator);
    const ref = rowRefFor(m.messageId, m.text);
    const key = entryKeyFor(m.messageId);
    const prev = this.o.store.read(topicKey, 'u', key);
    const p0 = prev?.rows?.[0];
    if (p0 && p0.sha256 === ref.sha256 && p0.length === ref.length && prev?.data.label === label) return 'unchanged';
    const at = Date.parse(m.timestamp);
    const res = this.o.store.writeProtected(topicKey, 'u', key, [ref], this.meta(m.messageId, Number.isFinite(at) ? at : this.now(), 'user', authority === 'operator' ? 'protected' : 'labelled'), {
      label, authority,
      origin: m.origin ?? null,
      forwarded: m.forwarded === undefined ? null : m.forwarded,
      at: Number.isFinite(at) ? at : null,
      // Machine-local (U never replicates): where this row sits in this machine's TopicMemory.
      rowId,
      pastedArtifact: m.text.length > PASTED_ARTIFACT_CHARS,
      ...(m.text.length > PASTED_ARTIFACT_CHARS ? { pasteHandling: 'whole-until-superseded' } : {}),
      ...(m.fromUser !== true ? { agentAuthored: true } : {}),
      ...(m.fromUser === true && senderKeyOf(m) === null ? { unattributed: true } : {}),
    });
    // A transient write failure holds the page at this row; a deterministic refusal is counted and skipped.
    if (!res.written) { this.counters.rowWriteFailed++; return res.reason === 'write-failed' ? 'failed' : 'refused'; }
    this.counters.rowsWritten++;
    // A quote that changed (its text or its label) takes its stub with it: the
    // withdrawal is itself a replicated record, so no machine keeps a stale stub.
    if (prev) {
      const stub = this.o.store.read(topicKey, 'u-stub', key);
      if (stub && stub.status !== 'withdrawn' && stub.data.withdrawn !== true) {
        const w = this.o.store.writeDerived(topicKey, 'u-stub', key, { withdrawn: true, quoteMessageId: m.messageId, reason: 'quote-changed' }, this.meta(m.messageId, this.now(), 'derived', 'withdrawn'));
        if (w.written) this.counters.stubsWithdrawn++;
      }
    }
    return 'written';
  }

  private lastFingerprint = '';
  private fingerprint(): string {
    try { this.lastFingerprint = this.o.bindingFingerprint?.() ?? ''; } catch { /* @silent-fallback-ok — an unreadable binding keeps the last one read, so a read error never re-lists U; labels change only on a read that differs */ }
    return this.lastFingerprint;
  }

  private loadWatermark(topicId: number, fp: string): number {
    const mem = this.watermark.get(topicId);
    if (mem !== undefined && this.watermarkFp.get(topicId) === fp) return mem;
    const rec = this.o.store.read(String(topicId), 'u-mark', WATERMARK_KEY);
    const stored = typeof rec?.data.rowId === 'number' && Number.isSafeInteger(rec.data.rowId) ? rec.data.rowId : 0;
    // A changed operator binding re-lists from the start, so labels and authority follow it.
    return String(rec?.data.binding ?? '') === fp ? stored : 0;
  }

  /**
   * List the topic's sender rows into U, incrementally and bounded: the
   * current message's own row first (when named), then up to
   * `REFRESH_ROWS` rows after the persisted watermark. A row whose record
   * already holds the same ref and label is left alone. A changed operator
   * binding (its fingerprint) restarts the listing from row 0, and a row
   * whose label changes is rewritten with its stub withdrawn. A row whose
   * write fails stops the page there: the watermark never moves past it.
   */
  refresh(topicId: number, opts: { messageId?: number } = {}): { listed: number; written: number; complete: boolean } {
    this.counters.refreshes++;
    let written = 0;
    let listed = 0;
    const seen = new Set<number>();
    if (opts.messageId !== undefined && Number.isSafeInteger(opts.messageId)) {
      const one = this.o.rows.getUserCorpusRows(topicId, { messageId: opts.messageId, limit: 1 });
      for (const { rowId, message } of one.rows) {
        listed++;
        const o = this.listRow(topicId, rowId, message);
        if (o === 'written') written++;
        if (o !== 'failed') seen.add(rowId);
      }
    }
    const fp = this.fingerprint();
    let after = this.loadWatermark(topicId, fp);
    let r = this.o.rows.getUserCorpusRows(topicId, { afterRowId: after, limit: REFRESH_ROWS });
    // A rebuilt or restored TopicMemory (every row id below the watermark): list again from the start.
    if (after > r.maxRowId) { after = 0; r = this.o.rows.getUserCorpusRows(topicId, { afterRowId: 0, limit: REFRESH_ROWS }); }
    const start = after;
    let stopped = false;
    for (const { rowId, message } of r.rows) {
      if (!seen.has(rowId)) {
        listed++;
        const o = this.listRow(topicId, rowId, message);
        if (o === 'failed') { stopped = true; break; }
        if (o === 'written') written++;
      }
      after = Math.max(after, rowId);
    }
    const markChanged = after !== start || this.watermarkFp.get(topicId) !== fp || !this.o.store.read(String(topicId), 'u-mark', WATERMARK_KEY);
    this.watermark.set(topicId, after);
    this.watermarkFp.set(topicId, fp);
    if (markChanged) {
      this.o.store.writeProtected(String(topicId), 'u-mark', WATERMARK_KEY, [], this.meta(null, this.now(), 'user', 'watermark'), { kind: 'watermark', rowId: after, binding: fp });
    }
    if (stopped) { this.backfillPending.add(topicId); return { listed, written, complete: false }; }
    if (r.complete) this.backfillPending.delete(topicId); else this.backfillPending.add(topicId);
    return { listed, written, complete: r.complete };
  }

  /**
   * The agent messages an operator message's stub may name: null when the
   * message is not a protected operator row (no stub is requested for it), [] when
   * no conversational agent message precedes it. Status, heartbeat and proxy
   * lines are never candidates.
   */
  stubCandidates(topicId: number, messageId: number): ReferentCandidate[] | null {
    if (!Number.isSafeInteger(messageId)) return null;
    const rec = this.o.store.read(String(topicId), 'u', entryKeyFor(messageId));
    if (rec?.data.label !== 'operator') return null;
    return this.o.rows.getAgentMessagesBefore(topicId, messageId, CANDIDATE_SCAN)
      .filter((m) => Number.isSafeInteger(m.messageId) && typeof m.text === 'string' && m.text.trim() && !isAgentSentinelLine(m.text))
      .slice(-CANDIDATES)
      .map((m) => ({ messageId: m.messageId, text: m.text }));
  }

  noteNoStub(reason: NoStubReason): void {
    if (reason in this.counters.noStub) this.counters.noStub[reason]++;
  }

  /** Validate the stub the extractor's call returned and write it beside its quote. Never throws. */
  acceptStub(topicId: number, messageId: number, userText: string, proposal: ReferentStubProposal | null | undefined): { written: boolean; reason?: StubDropReason | 'write-failed' } {
    this.counters.stubsRequested++;
    const drop = (reason: StubDropReason) => { this.counters.stubsRejected[reason]++; return { written: false, reason }; };
    const topicKey = String(topicId);
    const rec = this.o.store.read(topicKey, 'u', entryKeyFor(messageId));
    if (rec?.data.label !== 'operator') return drop('not-operator');
    const r0 = rec.rows?.[0];
    if (!r0 || r0.length !== userText.length || rowRefFor(messageId, userText).sha256 !== r0.sha256) return drop('row-mismatch');
    const v = validateReferentStub(proposal, {
      userText, userMessageId: messageId,
      precedes: (ref) => this.o.rows.messagePrecedes(topicId, ref, messageId),
    });
    if (!v.ok) return drop(v.reason);
    // The stub names one of the agent messages it was offered, never the operator's own or a third party's row.
    if (!(this.stubCandidates(topicId, messageId) ?? []).some((c) => c.messageId === v.stub.refersTo)) return drop('not-a-candidate');
    const res = this.o.store.writeDerived(topicKey, 'u-stub', entryKeyFor(messageId), {
      stub: v.stub.text, kind: v.stub.kind, refersTo: v.stub.refersTo, quoteMessageId: messageId, quoteSha256: r0.sha256,
    }, this.meta(messageId, this.now(), 'derived', 'derived'));
    if (!res.written) { this.counters.stubWriteFailed++; return { written: false, reason: 'write-failed' }; }
    this.counters.stubsWritten++;
    return { written: true };
  }

  status(): { operatorBinding: 'wired' | 'unavailable'; backfilling: number[]; counters: UserCorpusCounters } {
    return { operatorBinding: this.operatorBinding, backfilling: [...this.backfillPending], counters: { ...this.counters, stubsRejected: { ...this.counters.stubsRejected }, noStub: { ...this.counters.noStub } } };
  }
}
