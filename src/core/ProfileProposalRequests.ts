/** Identified, ephemeral confirmation controls. Prose never grants consent.
 * Governed by profile-confirmation-clarity: only exact yes + a delivered reply id.
 */
import { randomBytes } from 'node:crypto';
import type { ProfilePatchInput } from './topicProfileValidation.js';
import type { ProfileWriteResult } from './topicProfileWriteSurface.js';

export interface ProfileProposal {
  id: string;
  source: string;
  target: string;
  patch: ProfilePatchInput;
  core: string;
  contextStamp: string;
  armedAt: number;
  consumed: boolean;
  receipts: Array<{ messageId: number; text: string }>;
}
interface Attempt { id: string; text: string; done: Promise<void>; finish: () => void }
interface Stored extends ProfileProposal { attempts: Map<string, Attempt>; ordinal: number }
export type ProposalSend = { ok: true; request: ProfileProposal; attemptId: string; text: string; created: boolean }
  | { ok: false; reason: 'send-budget' | 'fresh-proposal-needed' };
export interface ProposalReply { matched: boolean; result?: ProfileWriteResult; reason?: string }
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return JSON.stringify(v);
};

export class ProfileProposalRequests {
  private requests = new Map<string, Stored>();
  private sends = new Map<string, number[]>();
  private replies = new Map<string, { at: number; complete: boolean; promise: Promise<ProposalReply> }>();
  private readonly now: () => number;
  constructor(private readonly options: {
    now?: () => number; ttlMs?: () => number; maxSends?: number; windowMs?: number;
    receiptWaitMs?: number;
  } = {}) { this.now = options.now ?? Date.now; }
  private ttl(): number { return this.options.ttlMs?.() ?? 300_000; }
  private snapshot(r: Stored): ProfileProposal {
    const { attempts: _attempts, ordinal: _ordinal, ...p } = r;
    return copy(p);
  }
  private cleanup(): void {
    const now = this.now();
    for (const [id, r] of this.requests) if (now - r.armedAt > this.ttl()) {
      for (const a of r.attempts.values()) a.finish();
      this.requests.delete(id);
    }
    for (const [id, r] of this.replies) if (r.complete && now - r.at > this.ttl()) this.replies.delete(id);
    for (const [topic, times] of this.sends) {
      const kept = times.filter(t => now - t < (this.options.windowMs ?? 600_000));
      if (kept.length) this.sends.set(topic, kept); else this.sends.delete(topic);
    }
  }
  list(source: string): ProfileProposal[] {
    this.cleanup();
    return [...this.requests.values()].filter(r => r.source === source && !r.consumed && this.now() - r.armedAt <= this.ttl()).map(r => this.snapshot(r));
  }
  get(source: string, id: string): ProfileProposal | null {
    return this.list(source).find(r => r.id === id) ?? null;
  }
  validAtCommit(proposal: ProfileProposal): boolean {
    const r = this.requests.get(proposal.id);
    return !!r && r.source === proposal.source && this.now() - r.armedAt <= this.ttl();
  }
  begin(source: string, target: string, patch: ProfilePatchInput, core: string, contextStamp: string): ProposalSend {
    this.cleanup();
    let r = [...this.requests.values()].find(p => p.source === source && p.target === target && !p.consumed
      && this.now() - p.armedAt <= this.ttl() && p.contextStamp === contextStamp && p.core === core && canonical(p.patch) === canonical(patch));
    const created = !r;
    if (!r) {
      r = { id: `R-${randomBytes(8).toString('hex')}`, source, target, patch: copy(patch), core,
        contextStamp, armedAt: this.now(), consumed: false, receipts: [], attempts: new Map(), ordinal: 0 };
    }
    const send = this.attempt(r, created);
    if (send.ok) this.requests.set(r.id, r);
    return send;
  }
  remind(source: string, id: string, core: string, contextStamp: string): ProposalSend {
    this.cleanup();
    const r = this.requests.get(id);
    if (!r || r.source !== source || r.consumed || this.now() - r.armedAt > this.ttl()
      || r.core !== core || r.contextStamp !== contextStamp) return { ok: false, reason: 'fresh-proposal-needed' };
    return this.attempt(r, false);
  }
  private attempt(r: Stored, created: boolean): ProposalSend {
    if (!this.reserveNotice(r.source)) return { ok: false, reason: 'send-budget' };
    const ordinal = ++r.ordinal;
    const text = `${ordinal > 1 ? `Reminder ${ordinal}.\n` : ''}${r.core}\nRequest ${r.id}.\nReply to this message with yes.`;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const id = randomBytes(12).toString('hex');
    r.attempts.set(id, { id, text, done, finish });
    return { ok: true, request: this.snapshot(r), attemptId: id, text, created };
  }
  /** Clarification has delivery authority only and shares the question budget. */
  reserveNotice(source: string): boolean {
    const times = (this.sends.get(source) ?? []).filter(t => this.now() - t < (this.options.windowMs ?? 600_000));
    if (times.length >= (this.options.maxSends ?? 5)) return false;
    times.push(this.now()); this.sends.set(source, times);
    return true;
  }
  complete(source: string, id: string, attemptId: string, messageId: number | null): void {
    const r = this.requests.get(id);
    const a = r?.attempts.get(attemptId);
    if (!r || r.source !== source || !a) return;
    if (messageId !== null && Number.isSafeInteger(messageId) && messageId > 0) r.receipts.push({ messageId, text: a.text });
    r.attempts.delete(attemptId); a.finish();
    if (!r.receipts.length && !r.attempts.size) this.requests.delete(id);
  }
  pending(source: string): boolean {
    return [...this.requests.values()].some(r => r.source === source && r.attempts.size > 0);
  }
  latestReceipt(source: string): number | null {
    const ids = [...this.requests.values()].filter(r => r.source === source).flatMap(r => r.receipts.map(x => x.messageId));
    return ids.length ? Math.max(...ids) : null;
  }
  async settle(source: string): Promise<boolean> {
    const waits = [...this.requests.values()].filter(r => r.source === source).flatMap(r => [...r.attempts.values()].map(a => a.done));
    if (!waits.length) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.all(waits).then(() => true), new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), this.options.receiptWaitMs ?? 15_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  /** Reserve before any await. The cached result excludes acknowledgment delivery. */
  reply(source: string, input: { text: string; messageId: number; replyTo: number; forwarded: boolean },
    apply: (p: ProfileProposal) => Promise<ProfileWriteResult>): Promise<ProposalReply> {
    if (input.forwarded || input.text.trim() !== 'yes' || !Number.isSafeInteger(input.messageId) || input.messageId <= 0 || !Number.isSafeInteger(input.replyTo) || input.replyTo <= 0) return Promise.resolve({ matched: false, reason: 'not-exact-consent' });
    this.cleanup();
    const key = `${source}:${input.messageId}`;
    const old = this.replies.get(key);
    if (old) return old.promise;
    const promise = Promise.resolve().then(async (): Promise<ProposalReply> => {
      const find = () => [...this.requests.values()].find(p => p.source === source && p.receipts.some(x => x.messageId === input.replyTo));
      // A known native reply is independent of another request's pending send.
      let r = find();
      if (!r && !(await this.settle(source))) return { matched: true, reason: 'delivery-timeout', result: {
        ok: false, reply: 'I could not verify that delivery in time. Ask me for a fresh question if it has expired.', refusal: { reason: 'delivery-timeout' },
      } };
      r ??= find();
      if (!r) return { matched: false, reason: 'unknown-request' };
      if (r.consumed || this.now() - r.armedAt > this.ttl() || input.messageId <= input.replyTo) return {
        matched: true, reason: 'inactive-request', result: { ok: false,
          reply: 'I did not apply a profile change from this reply. Ask me for a fresh question if needed.', refusal: { reason: 'inactive-request' } },
      };
      r.consumed = true;
      return { matched: true, result: await apply(this.snapshot(r)) };
    }).catch((): ProposalReply => ({ matched: true, reason: 'write-failed', result: {
      ok: false, reply: 'I could not confirm that this change was saved. Ask me to check the current settings before trying again.',
      refusal: { reason: 'write-failed' },
    } }));
    const entry = { at: this.now(), complete: false, promise };
    this.replies.set(key, entry);
    void promise.then(() => { entry.complete = true; });
    return promise;
  }
}
