/**
 * The account-path approval, run by the serving-lease holder (trust-journey decisions 5 and 13).
 *
 * The agent proposes an exact change. The server writes the request card, sends it into the
 * person's own direct chat, and waits. Only a platform receipt from the adapter's own inbound path,
 * replying `approve <code>` to that card from the person's account under a current acceptance, is
 * consumed. Consumption is recorded durably first; then the proof is issued and the change applied
 * through its owner; then the person gets a threaded reply carrying the disclosure.
 */
import { newApprovalCode, acceptanceStatement, isAcceptanceReply, parseApproveCommand, receiptApproves, renderRequestCard, DISCLOSURE,
  type AdapterKind, type Receipt, type RequestRecord } from './accountPath.js';
import { issueOperatorProofFromConsumedReceipt, proposalHashOf, type OperatorProof } from '../TrustRaiseGuard.js';
import type { TrustChange, TrustJourneyStore } from './TrustJourneyStore.js';

export interface DirectChatPort {
  /** Sends into the person's direct chat. Returns the chat id and message id, or null when it could not be delivered. */
  sendDirect(platformUserId: string, text: string): Promise<{ chatId: string; messageId: string } | null>;
  /** A threaded reply to one message in that chat. Returns false when the platform refused it. */
  replyTo(chatId: string, messageId: string, text: string): Promise<boolean>;
}

export interface AccountPathDeps {
  store: TrustJourneyStore;
  adapters: Partial<Record<AdapterKind, DirectChatPort>>;
  /** The owner's platform id per adapter, read only from config no route writes. */
  ownerPlatformId: (adapter: AdapterKind) => string | null;
  installationId: string;
  /** What this change would widen right now; empty means it is not a raise. */
  raisesOf: (change: TrustChange) => string[];
  /** Plain sentences the card shows, written by the server from the change. */
  summarize: (change: TrustChange) => string[];
  /** Applies the change through its owner with the proof. Throws or returns ok:false on failure. */
  apply: (change: TrustChange, proof: OperatorProof) => Promise<{ ok: boolean; detail?: string }>;
  cardTtlDays: () => number;
  now?: () => Date;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** The exact value a proof names for a change: the same shape the trust owners hash. */
export function proofSubject(change: TrustChange): unknown {
  switch (change.kind) {
    case 'trust-grant': return { kind: 'trust-grant', service: change.service, operation: change.operation, level: change.level };
    case 'autonomy-profile': return { kind: 'autonomy-profile', from: change.from, to: change.to };
    case 'trust-recovery': return { kind: 'trust-recovery', incidentId: change.incidentId };
    default: return change;
  }
}

export type ProposeResult =
  | { status: 'not-a-raise' }
  | { status: 'no-approver'; message: string }
  | { status: 'awaiting-acceptance' | 'sent'; requestId: string; code: string; expiresAt: string; deduped?: boolean }
  | { status: 'undelivered'; message: string }
  | { status: 'not-recorded'; message: string }
  | { status: 'too-large' | 'too-many-open'; message: string };

/** The card's change lines may not exceed this (the card must fit whole in one message). */
export const MAX_CARD_SUMMARY = 3000;
/** Open, unexpired requests one person may have at a time. */
export const MAX_OPEN_REQUESTS = 3;

export type ReceiptOutcome =
  | 'duplicate' | 'not-recorded' | 'acceptance-recorded' | 'not-for-us' | 'instruction-sent' | 'refused' | 'approved' | 'apply-failed';

export class AccountPathService {
  private readonly now: () => Date;
  constructor(private readonly d: AccountPathDeps) { this.now = d.now ?? (() => new Date()); }

  /** Which adapter reaches the owner: Telegram first, then Slack. */
  private ownerAdapter(): AdapterKind | null {
    for (const a of ['telegram', 'slack'] as AdapterKind[]) if (this.d.adapters[a] && this.d.ownerPlatformId(a)) return a;
    return null;
  }

  async propose(change: TrustChange, principal = 'owner'): Promise<ProposeResult> {
    if (this.d.raisesOf(change).length === 0) return { status: 'not-a-raise' };
    const adapter = this.ownerAdapter();
    if (!adapter) {
      return { status: 'no-approver', message: 'No direct chat reaches the owner: set the owner id for Telegram (messaging telegram config ownerUserId) or Slack (mobilePairing.slackOwnerUserId) in the setup conversation.' };
    }
    const ownerId = this.d.ownerPlatformId(adapter)!;
    const proposalHash = proposalHashOf(proofSubject(change));
    const dup = this.d.store.openRequests().find((r) => r.proposalHash === proposalHash && r.principal === principal);
    if (dup && new Date(dup.expiresAt) > this.now()) {
      return { status: dup.cardMessageId ? 'sent' : 'awaiting-acceptance', requestId: dup.requestId, code: dup.code, expiresAt: dup.expiresAt, deduped: true };
    }
    const code = newApprovalCode((c) => this.d.store.codeTaken(c));
    const expiresAt = new Date(this.now().getTime() + this.d.cardTtlDays() * 86_400_000).toISOString();
    const requestId = `tr-${proposalHash.slice(0, 12)}-${code}`;
    const summary = this.d.summarize(change);
    if (summary.join('\n').length > MAX_CARD_SUMMARY) {
      return { status: 'too-large', message: 'This change is too large to show whole on one card, so no card was sent. Split it into smaller changes.' };
    }
    // At most a few open requests per person, so the person is never flooded toward approving.
    if (this.d.store.openRequests().filter((r) => r.principal === principal && new Date(r.expiresAt) > this.now()).length >= MAX_OPEN_REQUESTS) {
      return { status: 'too-many-open', message: `There are already ${MAX_OPEN_REQUESTS} requests waiting for the person; no new card is sent until one is answered or expires.` };
    }
    const base = { requestId, code, proposalHash, principal, adapter, approverPlatformId: ownerId, expiresAt, status: 'open', change, summary };

    if (!this.d.store.acceptance(principal, adapter)) {
      const w = await this.d.store.write('request', { ...base, cardMessageId: '', cardChatId: '' });
      if (!w.ok) return { status: 'not-recorded', message: 'The request could not be recorded durably, so nothing was sent.' };
      if (!(await this.sendAcceptanceStatement(principal, adapter, ownerId))) {
        return { status: 'undelivered', message: 'The acceptance message could not be delivered to the owner\'s direct chat (they may not have opened a chat with the bot yet), so no card can follow. Nothing was approved.' };
      }
      return { status: 'awaiting-acceptance', requestId, code, expiresAt };
    }
    return this.sendCard(base as unknown as RequestRecord & { summary: string[] });
  }

  /** True when the statement is in the person's chat (sent now, or within the last day). */
  private async sendAcceptanceStatement(principal: string, adapter: AdapterKind, ownerId: string): Promise<boolean> {
    const sent = this.d.store.acceptanceStatementSent(principal, adapter);
    if (sent && this.now().getTime() - new Date(sent.at).getTime() < 86_400_000) return true;
    const statement = acceptanceStatement({ adapter, accountId: ownerId, installationId: this.d.installationId });
    const text = [
      'Before I can ask you to approve changes to what I may do on my own, I need your acceptance once.',
      'If you agree, send this sentence back to me exactly as written:',
      '',
      statement,
    ].join('\n');
    const r = await this.d.adapters[adapter]!.sendDirect(ownerId, text);
    if (r) { await this.d.store.write('acceptance-sent', { principal, adapter, statementMessageId: r.messageId }); return true; }
    this.d.log?.('trust-acceptance-undelivered', { adapter });
    return false;
  }

  private async sendCard(req: RequestRecord & { summary: string[]; change?: TrustChange }): Promise<ProposeResult> {
    const port = this.d.adapters[req.adapter]!;
    const text = renderRequestCard({ summary: { lines: req.summary }, code: req.code, expiresAt: req.expiresAt });
    const sent = await port.sendDirect(req.approverPlatformId, text);
    if (!sent) {
      return { status: 'undelivered', message: 'The request card could not be delivered to the owner\'s direct chat (they may not have opened a chat with the bot yet). Nothing was approved.' };
    }
    const w = await this.d.store.write('request', { ...req, cardMessageId: sent.messageId, cardChatId: sent.chatId, status: 'open' }, `tj:request:${req.requestId}:card`);
    if (!w.ok) return { status: 'not-recorded', message: 'The card was sent but could not be recorded, so a reply to it will not approve anything.' };
    return { status: 'sent', requestId: req.requestId, code: req.code, expiresAt: req.expiresAt };
  }

  /** A receipt from the adapter's own inbound path. Called on the holder. */
  /**
   * The cheap checks, before anything is written: is this the owner, in their own direct chat, sending
   * the acceptance sentence, the approve command, or a reply to a known card? Everything else is not
   * for the account path and is never recorded (a stranger's DM, or the owner's ordinary messages).
   */
  claims(r: Receipt): boolean {
    const ownerId = this.d.ownerPlatformId(r.adapter);
    const direct = r.adapter === 'telegram' ? (r.chatType === 'private' && r.chatId === r.senderId) : r.chatType === 'im';
    if (!ownerId || r.senderId !== ownerId || !direct || r.senderIsBot || r.forwarded) return false;
    if (isAcceptanceReply(r.text, acceptanceStatement({ adapter: r.adapter, accountId: ownerId, installationId: this.d.installationId }))) return true;
    if (parseApproveCommand(r.text)) return true;
    return !!(r.replyToMessageId && this.d.store.requestByCard(r.adapter, r.replyToMessageId));
  }

  /** Requests being consumed right now: claimed before any wait, so two quick replies apply once. */
  private inFlight = new Set<string>();

  async onReceipt(r: Receipt): Promise<ReceiptOutcome> {
    if (this.d.store.receipt(r.uniqueKey)) return 'duplicate';
    if (!this.claims(r)) return 'not-for-us';
    const w = await this.d.store.write('receipt', { ...r }, `tj:receipt:${r.uniqueKey}`);
    if (!w.ok) return 'not-recorded';
    return this.process(r);
  }

  /** The holder processing a receipt another machine already wrote to the replicated store. */
  async onReceiptFromStore(r: Receipt): Promise<ReceiptOutcome> {
    if (this.d.store.receiptConsumed(r.uniqueKey)) return 'duplicate';
    return this.process(r);
  }

  private async process(r: Receipt): Promise<ReceiptOutcome> {
    const adapter = r.adapter;
    const ownerId = this.d.ownerPlatformId(adapter);
    const direct = adapter === 'telegram' ? (r.chatType === 'private' && r.chatId === r.senderId) : r.chatType === 'im';
    if (!ownerId || r.senderId !== ownerId || !direct || r.senderIsBot || r.forwarded) return 'not-for-us';

    // 1. Acceptance: the person sends the statement back unchanged in their direct chat.
    const statement = acceptanceStatement({ adapter, accountId: ownerId, installationId: this.d.installationId });
    if (isAcceptanceReply(r.text, statement)) {
      const principal = 'owner';
      if (!this.d.store.acceptance(principal, adapter)) {
        await this.d.store.write('acceptance', { acceptanceId: `acc-${r.uniqueKey}`, principal, adapter, accountId: ownerId, acceptedAt: this.now().toISOString(), messageId: r.messageId });
      }
      await this.d.adapters[adapter]?.replyTo(r.chatId, r.messageId, 'Recorded. Your replies from this account now count as your approval. You can withdraw this at any time by saying so.');
      for (const q of this.d.store.openRequests().filter((x) => x.principal === principal && x.adapter === adapter && !x.cardMessageId)) {
        await this.sendCard(q);
      }
      return 'acceptance-recorded';
    }

    // 2. A reply to a request card.
    const req = r.replyToMessageId ? this.d.store.requestByCard(adapter, r.replyToMessageId) : null;
    if (!req) {
      return parseApproveCommand(r.text) ? this.instruct(r, 'To approve, reply to the request card itself with the code it shows.') : 'not-for-us';
    }
    const acceptance = this.d.store.acceptance(req.principal, adapter);
    const verdict = receiptApproves(r, req, acceptance, this.now(), (k) => this.d.store.receiptConsumed(k));
    if (!verdict.ok) {
      if (verdict.reason === 'not-the-approve-command' || verdict.reason === 'wrong-code') {
        return this.instruct(r, `That approves nothing. To approve, reply to the card with exactly: approve ${req.code}`);
      }
      if (verdict.reason === 'request-expired') {
        await this.d.store.write('request-status', { requestId: req.requestId, status: 'expired' });
        return this.instruct(r, 'This request has expired, so nothing was approved. The agent can send a fresh one.');
      }
      if (verdict.reason === 'no-current-acceptance') {
        await this.sendAcceptanceStatement(req.principal, adapter, ownerId);
        return 'refused';
      }
      this.d.log?.('trust-receipt-refused', { requestId: req.requestId, reason: verdict.reason });
      return 'refused';
    }

    // 3. Approve: claim the request before any wait, so a second reply arriving meanwhile is refused.
    if (this.inFlight.has(req.requestId)) return 'refused';
    this.inFlight.add(req.requestId);
    try {
      return await this.consume(r, req, acceptance!);
    } finally {
      this.inFlight.delete(req.requestId);
    }
  }

  private async consume(r: Receipt, req: RequestRecord & { summary: string[]; change: TrustChange }, acceptance: { acceptanceId: string }): Promise<ReceiptOutcome> {
    const adapter = r.adapter;
    // Threaded "recording" first; no unthreaded fallback (spec section 5, One transaction).
    if (!(await this.d.adapters[adapter]!.replyTo(r.chatId, r.messageId, 'Recording your approval now.'))) {
      this.d.log?.('trust-approval-reply-refused', { requestId: req.requestId });
      return 'refused';
    }
    const consumptionId = `c:${r.receiptId}`;
    const c = await this.d.store.write('consumption', {
      consumptionId, requestId: req.requestId, receiptId: r.receiptId, acceptanceId: acceptance.acceptanceId,
      proposalHash: req.proposalHash, principal: req.principal,
    }, `tj:consumption:${req.requestId}`);
    if (!c.ok) {
      await this.d.adapters[adapter]!.replyTo(r.chatId, r.messageId, 'Your approval could not be recorded, so nothing changed. The request is still open; reply again to try once more.');
      return 'not-recorded';
    }
    const proof = issueOperatorProofFromConsumedReceipt({ proposalHash: req.proposalHash, receiptRef: consumptionId, acceptanceRef: acceptance.acceptanceId, principal: req.principal });
    let applied: { ok: boolean; detail?: string };
    try { applied = await this.d.apply(req.change, proof); }
    catch (err) { applied = { ok: false, detail: err instanceof Error ? err.message : String(err) }; } // @silent-fallback-ok: the failure is told to the person just below and the request stays unapplied
    if (!applied.ok) {
      await this.d.adapters[adapter]!.replyTo(r.chatId, r.messageId, `Your approval was recorded, but the change did not take effect (${applied.detail ?? 'unknown reason'}). Nothing else changed; the agent will need to ask again.`);
      return 'apply-failed';
    }
    await this.d.adapters[adapter]!.replyTo(r.chatId, r.messageId, `Done: ${req.summary.join('; ')}. This was ${DISCLOSURE}.`);
    return 'approved';
  }

  private async instruct(r: Receipt, text: string): Promise<ReceiptOutcome> {
    await this.d.adapters[r.adapter]?.replyTo(r.chatId, r.messageId, text);
    return 'instruction-sent';
  }

  /** The person withdraws their acceptance (a narrowing: stops new consumption, keeps committed grants). */
  async withdrawAcceptance(principal: string, adapter: AdapterKind): Promise<boolean> {
    const a = this.d.store.acceptance(principal, adapter);
    if (!a) return false;
    return (await this.d.store.write('acceptance-withdrawn', { acceptanceId: a.acceptanceId, principal, adapter })).ok;
  }
}
