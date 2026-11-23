/** Identified, ephemeral confirmation controls. Prose never grants consent.
 * Governed by profile-confirmation-clarity: only exact yes + a delivered reply id.
 */
import { randomBytes } from 'node:crypto';
import type { ProfileProposalOwnerTurns } from './ProfileProposalOwnerTurns.js';
import type { ProfilePatchInput } from './topicProfileValidation.js';
import type { ProfileWriteResult } from './topicProfileWriteSurface.js';

export interface ProfileProposalItem { target: string; patch: ProfilePatchInput; core: string; contextStamp: string; baselineStamp?: string }
export interface ProfileProposalSendOptions {
  ownerTurn?: { registry: ProfileProposalOwnerTurns; handle: string; principal: string; inboundId: string };
  constituents?: readonly string[];
  fresh?: boolean;
}
export function proposalItems(p: ProfileProposal): ProfileProposalItem[] {
  return JSON.parse(JSON.stringify(p.items ?? [{ target: p.target, patch: p.patch, core: p.core, contextStamp: p.contextStamp }])) as ProfileProposalItem[];
}
export interface ProfileProposal {
  items?: ProfileProposalItem[];
  id: string;
  source: string;
  target: string;
  patch: ProfilePatchInput;
  core: string;
  contextStamp: string;
  armedAt: number;
  /** Immutable advertised instant; never recomputed from a later configuration. */
  expiresAt: number;
  consumed: boolean;
  /** Internal single-use reservation; never supplied by the HTTP proposal body. */
  applyClaim?: string;
  receipts: Array<{ messageId: number; text: string }>;
}
interface Attempt { id: string; text: string; done: Promise<void>; finish: () => void; onDelivery: (messageId: number | null) => void }
interface Stored extends ProfileProposal { replyReservation?: string; constituents?: Stored[]; attempts: Map<string, Attempt>; ordinal: number; lastDeliveredSequence: number }
export type ProposalSend = { ok: true; request: ProfileProposal; attemptId: string; text: string; created: boolean; ownerTurnReservation?: string; onDelivery: (messageId: number | null) => void }
  | { ok: false; reason: 'send-budget' | 'fresh-proposal-needed' | 'invalid-format' | 'invalid-items' | 'invalid-owner-turn' };
export interface ProposalReply { matched: boolean; result?: ProfileWriteResult; reason?: string }
export interface ProposalFailureSummary {
  requestId: string; attemptId: string; sequence: number; generation: string;
  reason: 'delivery-unconfirmed';
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return JSON.stringify(v);
};

export const DEFAULT_PROFILE_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export class ProfileProposalRequests {
  private acknowledgmentClaims = new Set<string>();
  private acknowledgmentEligible = new Map<string, number>();
  private requests = new Map<string, Stored>();
  private sends = new Map<string, number[]>();
  private sequences = new Map<string, number>();
  private failures = new Map<string, ProposalFailureSummary>();
  private listeners = new Map<string, Set<() => void>>();
  private readonly generation = randomBytes(12).toString('hex');
  private replies = new Map<string, { at: number; expiresAt: number; complete: boolean; promise: Promise<ProposalReply> }>();
  private readonly now: () => number;
  constructor(private readonly options: {
    now?: () => number; ttlMs?: () => number; maxSends?: number; windowMs?: number;
    receiptWaitMs?: number;
    validateFormat?: (text: string) => boolean;
    timeZone?: (source: string) => string | undefined;
    sourceExists?: (source: string) => boolean | undefined;
    audit?: (event: Record<string, unknown>) => void;
  } = {}) { this.now = options.now ?? Date.now; }
  private deadline(armedAt: number): number {
    const configured = this.options.ttlMs?.() ?? DEFAULT_PROFILE_PROPOSAL_TTL_MS;
    const rounded = Math.ceil((armedAt + configured) / 1000) * 1000;
    if (Number.isFinite(configured) && configured > 0 && Number.isSafeInteger(rounded)
      && Number.isFinite(new Date(rounded).getTime())) return rounded;
    this.emit({ type: 'proposal-invalid-lifetime', reason: 'invalid-duration' });
    return Math.ceil((armedAt + DEFAULT_PROFILE_PROPOSAL_TTL_MS) / 1000) * 1000;
  }
  private deadlineText(r: Stored): string {
    try {
      const timeZone = this.options.timeZone?.(r.source);
      if (timeZone) return new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium', timeStyle: 'long', timeZone,
      }).format(r.expiresAt);
    } catch { /* Invalid/missing owner preference cannot prevent a safe UTC question. */ }
    return new Date(r.expiresAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  }
  private snapshot(r: Stored): ProfileProposal {
    const { attempts: _attempts, ordinal: _ordinal, lastDeliveredSequence: _lastDeliveredSequence, constituents: _constituents, replyReservation: _replyReservation, ...p } = r;
    return copy(p);
  }
  private cleanup(): void {
    const now = this.now();
    for (const source of this.failures.keys()) if (this.options.sourceExists?.(source) === false) this.failures.delete(source);
    for (const [id, r] of this.requests) if (now >= r.expiresAt) {
      for (const a of r.attempts.values()) a.finish();
      this.requests.delete(id);
      this.emit({ type: r.consumed ? 'proposal-consumed-retention-ended' : 'proposal-expired', topic: r.source, targetTopic: r.target, requestId: id });
      this.notify(r.source);
    }
    for (const [id, r] of this.replies) if (now >= r.expiresAt) this.replies.delete(id);
    for (const [id, expiresAt] of this.acknowledgmentEligible) if (now >= expiresAt) {
      this.acknowledgmentEligible.delete(id); this.acknowledgmentClaims.delete(id);
    }
    for (const [topic, times] of this.sends) {
      const kept = times.filter(t => now - t < (this.options.windowMs ?? 600_000));
      if (kept.length) this.sends.set(topic, kept); else this.sends.delete(topic);
    }
  }
  list(source: string): ProfileProposal[] {
    this.cleanup();
    return [...this.requests.values()].filter(r => r.source === source && !r.consumed && this.now() < r.expiresAt).map(r => this.snapshot(r));
  }
  get(source: string, id: string): ProfileProposal | null {
    return this.list(source).find(r => r.id === id) ?? null;
  }
  validAtCommit(proposal: ProfileProposal): boolean {
    const r = this.requests.get(proposal.id);
    return !!r && r.source === proposal.source && r.consumed && !!proposal.applyClaim
      && r.applyClaim === proposal.applyClaim && this.now() < r.expiresAt
      && r.expiresAt === proposal.expiresAt && r.core === proposal.core
      && canonical(proposalItems(r)) === canonical(proposalItems(proposal));
  }
  begin(source: string, target: string, patch: ProfilePatchInput, core: string, contextStamp: string, options?: ProfileProposalSendOptions): ProposalSend {
    return this.beginBatch(source, [{ target, patch, core, contextStamp }], core, options);
  }
  beginBatch(source: string, items: readonly ProfileProposalItem[], core: string, options: ProfileProposalSendOptions = {}): ProposalSend {
    this.cleanup();
    if (!items.length || new Set(items.map(i => i.target)).size !== items.length
      || items.some(i => !i.target || !i.core || !i.contextStamp || !i.patch)) return { ok: false, reason: 'invalid-items' };
    const constituents: Stored[] = [];
    for (const id of options.constituents ?? []) {
      const c = this.requests.get(id);
      if (!c || c.source !== source || c.consumed || this.now() >= c.expiresAt || constituents.includes(c)) return { ok: false, reason: 'fresh-proposal-needed' };
      constituents.push(c);
    }
    if (constituents.length && !options.fresh) {
      const union = new Map<string, ProfileProposalItem>();
      for (const c of constituents) for (const i of proposalItems(c)) {
        const old = union.get(i.target);
        if (old && canonical(old) !== canonical(i)) return { ok: false, reason: 'invalid-items' };
        union.set(i.target, i);
      }
      if (union.size !== items.length || items.some(i => canonical(union.get(i.target)) !== canonical(i))) return { ok: false, reason: 'invalid-items' };
    }
    let r = !options.fresh && !constituents.length ? [...this.requests.values()].find(p => p.source === source && !p.consumed
      && this.now() < p.expiresAt && p.core === core && canonical(proposalItems(p)) === canonical(items)) : undefined;
    const created = !r;
    if (!r) {
      const armedAt = this.now(); const first = items[0];
      r = { id: `R-${randomBytes(8).toString('hex')}`, source, target: first.target, patch: copy(first.patch), core,
        contextStamp: first.contextStamp, items: copy([...items]),
        armedAt, expiresAt: constituents.length && !options.fresh ? Math.min(...constituents.map(c => c.expiresAt)) : this.deadline(armedAt),
        consumed: false, receipts: [], attempts: new Map(), ordinal: 0, lastDeliveredSequence: 0,
        ...(constituents.length ? { constituents } : {}) };
    }
    const send = this.attempt(r, created, options);
    if (send.ok) this.requests.set(r.id, r);
    return send;
  }
  remind(source: string, id: string, core: string, contextStamp: string, options?: ProfileProposalSendOptions): ProposalSend {
    this.cleanup();
    const r = this.requests.get(id);
    if (!r || r.source !== source || r.consumed || this.now() >= r.expiresAt
      || r.core !== core || r.contextStamp !== contextStamp) return { ok: false, reason: 'fresh-proposal-needed' };
    return this.attempt(r, false, options);
  }
  private attempt(r: Stored, created: boolean, options: ProfileProposalSendOptions = {}): ProposalSend {
    const ordinal = r.ordinal + 1;
    const text = `${ordinal > 1 ? `Reminder ${ordinal}.\n` : ''}${r.core}\nRequest ${r.id}.\nReply to this message with yes. I can apply this change until ${this.deadlineText(r)}.\nIf this request becomes unavailable, I’ll check it and send a fresh question when I can verify the change.`;
    try { if (this.options.validateFormat && !this.options.validateFormat(text)) return { ok: false, reason: 'invalid-format' }; }
    catch { return { ok: false, reason: 'invalid-format' }; }
    let ownerTurnReservation: string | undefined;
    if (options.ownerTurn) {
      const o = options.ownerTurn;
      ownerTurnReservation = o.registry.claim(o.handle, { source: r.source, principal: o.principal, inboundId: o.inboundId }) ?? undefined;
      if (!ownerTurnReservation) return { ok: false, reason: 'invalid-owner-turn' };
    } else if (!this.reserveNotice(r.source)) return { ok: false, reason: 'send-budget' };
    r.ordinal = ordinal;
    const sequence = (this.sequences.get(r.source) ?? 0) + 1;
    this.sequences.set(r.source, sequence);
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const id = randomBytes(12).toString('hex');
    let completed = false;
    const onDelivery = (messageId: number | null): void => {
      if (completed) return;
      completed = true;
      if (ownerTurnReservation) options.ownerTurn?.registry.seal(ownerTurnReservation);
      const delivered = messageId !== null && Number.isSafeInteger(messageId) && messageId > 0;
      let active = this.requests.get(r.id) === r && !r.consumed && this.now() < r.expiresAt;
      if (active && delivered && r.constituents?.length) {
        const valid = r.constituents.every(c => this.requests.get(c.id) === c && !c.consumed && !c.replyReservation && this.now() < c.expiresAt);
        if (!valid) { active = false; this.requests.delete(r.id); }
        else {
          // No await between validating every constituent and retiring them.
          for (const c of r.constituents) c.consumed = true;
          r.constituents = undefined;
        }
      }
      this.emit({ type: delivered ? active ? 'proposal-delivered' : 'proposal-delivered-inactive' : 'proposal-delivery-unconfirmed',
        topic: r.source, targetTopic: r.target, requestId: r.id, attemptId: id, sequence,
        ...(delivered ? { messageId } : {}), ...(this.now() >= r.expiresAt ? { reason: 'expired' } : r.consumed ? { reason: 'already-consumed' } : !active ? { reason: 'request-unavailable' } : {}) });
      if (active && delivered) {
        r.receipts.push({ messageId: messageId!, text });
        r.lastDeliveredSequence = Math.max(r.lastDeliveredSequence, sequence);
        const failure = this.failures.get(r.source);
        if (failure?.requestId === r.id && failure.generation === this.generation && sequence > failure.sequence) this.failures.delete(r.source);
      } else if (active && !delivered && sequence > r.lastDeliveredSequence && this.options.sourceExists?.(r.source) !== false) {
        const failure = this.failures.get(r.source);
        if (!failure || sequence > failure.sequence) this.failures.set(r.source, {
          requestId: r.id, attemptId: id, sequence, generation: this.generation, reason: 'delivery-unconfirmed',
        });
      }
      r.attempts.delete(id); finish();
      if (this.requests.get(r.id) === r && !r.receipts.length && !r.attempts.size) this.requests.delete(r.id);
      this.notify(r.source);
    };
    r.attempts.set(id, { id, text, done, finish, onDelivery });
    this.emit({ type: 'proposal-prepared', topic: r.source, targetTopic: r.target, requestId: r.id, attemptId: id, sequence, expiresAt: r.expiresAt });
    return { ok: true, request: this.snapshot(r), attemptId: id, text, created, ...(ownerTurnReservation ? { ownerTurnReservation } : {}), onDelivery };
  }
  private emit(event: Record<string, unknown>): void {
    try { this.options.audit?.(event); }
    catch { console.error('[profile-proposal-audit-unavailable]', JSON.stringify(event)); }
  }
  private notify(source: string): void {
    for (const listener of [...(this.listeners.get(source) ?? [])]) listener();
  }
  recordUnidentifiedReply(source: string, messageId: number | null): void {
    if (!messageId || !Number.isSafeInteger(messageId)) return;
    const failure = this.failures.get(source);
    this.emit({ type: 'proposal-reply-unidentified', topic: source, messageId,
      reason: 'no-native-identification', outcome: 'no-application',
      ...(failure ? { contextRequestId: failure.requestId } : {}) });
  }
  /** Diagnostic latest-status projection only: never contains a patch or permission. */
  failure(source: string): ProposalFailureSummary | null {
    this.cleanup();
    const summary = this.failures.get(source); return summary ? { ...summary } : null;
  }
  /** Clarification has delivery authority only and shares the question budget. */
  reserveNotice(source: string): boolean {
    const times = (this.sends.get(source) ?? []).filter(t => this.now() - t < (this.options.windowMs ?? 600_000));
    if (times.length >= (this.options.maxSends ?? 5)) return false;
    times.push(this.now()); this.sends.set(source, times);
    return true;
  }
  complete(source: string, id: string, attemptId: string, messageId: number | null): void {
    const request = this.requests.get(id);
    if (request?.source === source) request.attempts.get(attemptId)?.onDelivery(messageId);
  }
  pending(source: string): boolean {
    return [...this.requests.values()].some(r => r.source === source && r.attempts.size > 0);
  }
  latestReceipt(source: string): number | null {
    const ids = [...this.requests.values()].filter(r => r.source === source).flatMap(r => r.receipts.map(x => x.messageId));
    return ids.length ? Math.max(...ids) : null;
  }
  async settle(source: string, anchorReady?: () => boolean): Promise<boolean> {
    if (anchorReady?.() || !this.pending(source)) return true;
    return new Promise<boolean>(resolve => {
      const listeners = this.listeners.get(source) ?? new Set<() => void>();
      this.listeners.set(source, listeners);
      let timer: ReturnType<typeof setTimeout>;
      const finish = (ready: boolean) => {
        clearTimeout(timer); listeners.delete(wake);
        if (!listeners.size) this.listeners.delete(source);
        resolve(ready);
      };
      const wake = () => { if (anchorReady?.() || !this.pending(source)) finish(true); };
      listeners.add(wake);
      timer = setTimeout(() => finish(false), this.options.receiptWaitMs ?? 15_000);
      wake();
    });
  }
  claimAcknowledgment(source: string, inboundId: number): boolean {
    const key = `${source}:${inboundId}`;
    this.cleanup();
    if (!this.acknowledgmentEligible.has(key) || this.acknowledgmentClaims.has(key)) return false;
    this.acknowledgmentClaims.add(key); return true;
  }
  /** Reserve before any await. The cached result excludes acknowledgment delivery. */
  reply(source: string, input: { text: string; messageId: number; replyTo: number; forwarded: boolean },
    apply: (p: ProfileProposal, recordSaved: (result: ProfileWriteResult) => void) => Promise<ProfileWriteResult>,
    authorize?: (p: ProfileProposal) => boolean): Promise<ProposalReply> {
    if (input.forwarded || input.text.trim() !== 'yes' || !Number.isSafeInteger(input.messageId) || input.messageId <= 0 || !Number.isSafeInteger(input.replyTo) || input.replyTo <= 0) return Promise.resolve({ matched: false, reason: 'not-exact-consent' });
    this.cleanup();
    const key = `${source}:${input.messageId}`;
    const old = this.replies.get(key);
    if (old) return old.promise;
    const known = [...this.requests.values()].find(p => p.source === source && p.receipts.some(x => x.messageId === input.replyTo));
    // A known native reply claims its constituent before yielding to a send
    // callback that might otherwise replace it with an aggregate question.
    const authorized = (p: Stored): boolean => { try { return !authorize || authorize(this.snapshot(p)) === true; } catch { return false; } };
    if (known && authorized(known) && !known.consumed && !known.replyReservation && this.now() < known.expiresAt && input.messageId > input.replyTo) known.replyReservation = key;
    let savedOutcome: ProfileWriteResult | undefined;
    const promise = Promise.resolve().then(async (): Promise<ProposalReply> => {
      const find = () => [...this.requests.values()].find(p => p.source === source && p.receipts.some(x => x.messageId === input.replyTo));
      // A known native reply is independent of another request's pending send.
      let r = find();
      if (!r && !(await this.settle(source, () => !!find()))) {
        this.emit({ type: 'proposal-reply-result', topic: source, messageId: input.messageId, replyToMessageId: input.replyTo, outcome: 'refused', reason: 'delivery-timeout' });
        return { matched: true, reason: 'delivery-timeout', result: {
        ok: false, reply: 'I could not verify that delivery in time. Ask me for a fresh question if it has expired.', refusal: { reason: 'delivery-timeout' },
      } };
      }
      r ??= find();
      if (!r) {
        this.emit({ type: 'proposal-reply-unidentified', topic: source, messageId: input.messageId, replyToMessageId: input.replyTo, reason: 'unknown-request', outcome: 'no-application' });
        return { matched: false, reason: 'unknown-request' };
      }
      if (!authorized(r)) {
        this.emit({ type: 'proposal-reply-result', topic: source, requestId: r.id, messageId: input.messageId,
          replyToMessageId: input.replyTo, outcome: 'no-application', reason: 'not-authorized' });
        return { matched: false, reason: 'not-authorized' };
      }
      if (r.consumed || (r.replyReservation && r.replyReservation !== key) || this.now() >= r.expiresAt || input.messageId <= input.replyTo) {
        this.emit({ type: 'proposal-reply-result', topic: source, messageId: input.messageId, requestId: r.id, outcome: 'refused', reason: 'inactive-request' });
        return {
        matched: true, reason: 'inactive-request', result: { ok: false,
          reply: 'I did not apply a profile change from this reply. Ask me for a fresh question if needed.', refusal: { reason: 'inactive-request' } },
      };
      }
      r.consumed = true; r.applyClaim = randomBytes(12).toString('hex');
      const result = await apply(this.snapshot(r), saved => { savedOutcome = copy(saved); });
      this.emit({ type: 'proposal-reply-result', topic: source, targetTopic: r.target, requestId: r.id,
        messageId: input.messageId, outcome: result.ok ? 'accepted' : 'refused', settingsSaved: result.settingsSaved === true,
        ...(result.refusal ? { reason: result.refusal.reason } : {}) });
      return { matched: true, result };
    }).catch((): ProposalReply => {
      this.emit({ type: 'proposal-reply-result', topic: source, messageId: input.messageId, replyToMessageId: input.replyTo,
        outcome: savedOutcome ? 'saved-effect-unconfirmed' : 'refused', reason: savedOutcome ? 'post-save-callback' : 'write-failed' });
      return savedOutcome ? { matched: true, reason: 'post-save-callback',
        result: { ...savedOutcome, runtimeOutcome: 'unknown', effectFailure: 'post-save-callback' } } : { matched: true, reason: 'write-failed', result: {
        ok: false, reply: 'I could not confirm that this change was saved. I need to check the current settings before trying again.',
        refusal: { reason: 'write-failed' },
      } };
    });
    const at = this.now();
    const request = [...this.requests.values()].find(p => p.source === source && p.receipts.some(x => x.messageId === input.replyTo));
    const entry = { at, expiresAt: request?.expiresAt ?? this.deadline(at), complete: false, promise };
    this.replies.set(key, entry);
    void promise.then(result => { entry.complete = true;
      // A valid save may finish after the original question expires. Delivery
      // authority for its result is separate from the now-expired apply grant.
      if (result.matched && result.result && !this.acknowledgmentEligible.has(key)) this.acknowledgmentEligible.set(key, this.deadline(this.now()));
      if (!result.matched && result.reason !== 'not-authorized' && this.replies.get(key) === entry) this.replies.delete(key); });
    return promise;
  }
}
