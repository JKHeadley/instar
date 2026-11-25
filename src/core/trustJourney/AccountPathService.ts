/**
 * The account-path approval, run by the serving-lease holder (trust-journey decisions 5 and 13).
 *
 * The agent proposes an exact change. The server writes the request card, sends it into the
 * person's own direct chat, and waits. Only a platform receipt from the adapter's own inbound path,
 * replying `approve <code>` to that card from the person's account under a current acceptance, is
 * consumed. Consumption is recorded durably first; then the proof is issued and the change applied
 * through its owner; then the person gets a threaded reply carrying the disclosure.
 */
import crypto from 'node:crypto';
import { newApprovalCode, acceptanceStatement, isAcceptanceReply, parseApproveCommand, receiptApproves, renderRequestCard, DISCLOSURE,
  deviceApprovalDisclosure, SET_UP_APPROVALS_TEXT, UNKNOWN_OUTCOME_TEXT,
  type AdapterKind, type Receipt, type RequestRecord } from './accountPath.js';
import { issueOperatorProofFromConsumedReceipt, proposalHashOf, type OperatorProof } from '../TrustRaiseGuard.js';
import type { DeviceAcceptanceRecord, TrustChange, TrustJourneyStore } from './TrustJourneyStore.js';

/**
 * A paired device as the trust journey reads it (app-trust-approval §A): read fresh from the device
 * registry on every check, never from a request body.
 */
export interface DeviceSnapshot {
  deviceId: string;
  name: string | null;
  /** An active owner device whose device key is not revoked. */
  active: boolean;
  /** The device key's fingerprint (`deviceFingerprint`), or null. */
  keyFingerprint: string | null;
  /** SHA-256 hex of the enrolled presence key, or null when none is enrolled. */
  presenceKeyHash: string | null;
  deviceKind: 'computer' | 'phone';
  /** Paired by the Instar app on the agent's own computer: `approvedVia: 'local-install'` with a `localBinding`. */
  localInstall: boolean;
  /**
   * May take the first acceptance: the local-install device itself, or a phone that device approved
   * (the iPhone the Mac app pairs during setup when the Mac has no Touch ID; app-trust-approval §A).
   */
  firstPairing?: boolean;
}

/** The device registry, seen from the trust journey. */
export interface DeviceDirectory {
  get(deviceId: string): DeviceSnapshot | null;
  /** Fresh local native owner devices; pairing permits delivery, not approval. */
  list?(): DeviceSnapshot[];
  /** A contentless push notice to the paired devices (optional; fixed wording per subject). */
  notify?(subject: 'trust-request' | 'trust-device-change', dedupeKey: string): void;
  /** False when approving from a device is switched off (`mobilePairing.trustApproval`): no device approves then. */
  enabled?(): boolean;
}

/**
 * A verified device authorization (app-trust-approval §B): built by the route only after `proven`
 * consumed the single-use `approve-widening` challenge and checked the presence signature. The
 * service never sees or consumes the challenge itself.
 */
export interface DeviceAuthorization {
  deviceId: string;
  keyFingerprint: string;
  host: string;
  requestId: string;
  proposalHash: string;
  challengeId: string;
}

export type DeviceApprovalResult =
  | { status: 'applied'; requestId: string; message: string; detail?: string }
  | { status: 'not-applied'; requestId: string; message: string }
  /** Consumed, but the outcome could not be recorded: never guessed, never retried. */
  | { status: 'unknown'; requestId: string; message: string }
  | { status: 'already-approved' | 'not-recorded' | 'not-holder' | 'refused'; reason: string; message: string };

export type DeviceAcceptanceResult =
  | { status: 'recorded'; acceptanceId: string; via: DeviceAcceptanceRecord['via']; withdrew?: string }
  | { status: 'already-accepted'; acceptanceId: string }
  | { status: 'refused' | 'not-holder' | 'not-recorded'; reason: string; message: string };

const KEY_POLICIES = new Set(['biometryCurrentSet', 'userPresence']);
const HOLDER_MESSAGE = 'This machine is not the one deciding approvals right now. Try again in a moment.';

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
  /** Is this machine the serving-lease holder (absent: a single machine, always true). */
  holdsLease?: () => boolean;
  /** The paired devices (app-trust-approval); absent means no device can approve. Settable later with `bindDevices`. */
  devices?: DeviceDirectory | null;
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
  | { status: 'no-approver'; message: string; requestId?: string }
  | { status: 'not-holder'; message: string }
  | { status: 'awaiting-acceptance' | 'sent'; requestId: string; code: string; expiresAt: string; deduped?: boolean; via?: 'chat' | 'device'; message?: string }
  | { status: 'undelivered'; message: string }
  | { status: 'not-recorded'; message: string }
  | { status: 'too-large' | 'too-many-open' | 'too-many-undelivered' | 'withdrawn-recently'; message: string };

/** The card's change lines may not exceed this (the card must fit whole in one message). */
export const MAX_CARD_SUMMARY = 3000;

/** Compatibility with the shipped native decoder: 40 lines of 400 Characters.
 * Code points are at least as numerous as Swift grapheme clusters. Never truncate
 * disclosure, including requests persisted by older servers.
 */
export function appApprovalSummaryLines(summary: readonly string[]): string[] | null {
  if (summary.length <= 40 && summary.every((line) => Array.from(line).length <= 400)) return [...summary];
  const text = summary.join('\n');
  if (Array.from(text).length > 40 * 400) return null;
  const lines: string[] = [];
  let line = '', count = 0;
  // Native views render each entry separately. Keep flags, combining marks and
  // ZWJ sequences together rather than changing their displayed meaning.
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const size = Array.from(segment).length;
    if (size > 400) return null;
    if (count + size > 400) { lines.push(line); line = ''; count = 0; }
    line += segment; count += size;
  }
  if (line) lines.push(line);
  if (lines.length > 40) return null;
  return lines;
}

/** Open, unexpired requests one person may have at a time. */
export const MAX_OPEN_REQUESTS = 3;

export type ReceiptOutcome =
  | 'duplicate' | 'not-recorded' | 'acceptance-recorded' | 'not-for-us' | 'instruction-sent' | 'refused' | 'approved' | 'apply-failed';

export class AccountPathService {
  private readonly now: () => Date;
  private devices: DeviceDirectory | null;
  private proposalTail: Promise<void> = Promise.resolve();
  private readonly deliveryReservations = new Map<string, string>();
  constructor(private readonly d: AccountPathDeps) { this.now = d.now ?? (() => new Date()); this.devices = d.devices ?? null; }

  /** The device registry lives in the server, built after this service; the server binds it here. */
  bindDevices(devices: DeviceDirectory | null): void { this.devices = devices; }

  private holds(): boolean { return this.d.holdsLease ? this.d.holdsLease() : true; }

  /** Which adapter reaches the owner: Telegram first, then Slack. */
  private ownerAdapter(): AdapterKind | null {
    for (const a of ['telegram', 'slack'] as AdapterKind[]) if (this.d.adapters[a] && this.d.ownerPlatformId(a)) return a;
    return null;
  }

  /** Current app reachability is distinct from historical chat delivery and from approval consent. */
  async approvalDelivery(principal = 'owner'): Promise<{ state: 'accepted' | 'setup' | 'none' | 'unknown'; message: string }> {
    if (!this.holds()) return { state: 'unknown', message: HOLDER_MESSAGE };
    try {
      if (!this.devices || this.devices.enabled?.() === false) return { state: 'none', message: 'App approvals are unavailable here. A configured private approval chat can still be used.' };
      const accepted = await this.approvingDevices(principal);
      if (!this.holds()) return { state: 'unknown', message: HOLDER_MESSAGE };
      if (accepted.length > 0) return { state: 'accepted', message: 'Review this in the Instar app under Changes to approve. Confirm the exact change with Face ID or Touch ID.' };
      const paired = principal === 'owner' ? (this.devices.list?.() ?? []).filter((d) => d.active && !!d.keyFingerprint) : [];
      if (!paired.length) return { state: 'none', message: 'No eligible owner app device is available. Pair an iPhone through the app on the agent’s computer, or use a locally paired Mac with Touch ID. A reconnected remote phone alone does not restore approval consent.' };
      const firstPhone = paired.some((d) => d.deviceKind === 'phone' && (d.firstPairing || d.localInstall));
      return { state: 'setup', message: firstPhone
        ? 'Open Changes to approve in the Instar iPhone app and turn on approvals before approving this request. Telegram is not required.'
        : 'Open Changes to approve on an already accepted device to allow this one. With no accepted device, pair an iPhone through the local Instar app first. A locally paired Mac with Touch ID can set up or replace its approval key; a Mac without Touch ID needs the iPhone.' };
    } catch (err) {
      // @silent-fallback-ok: unknown refuses routing, never falls through to chat or grants approval.
      this.d.log?.('trust-device-availability-unknown', { error: err instanceof Error ? err.message : String(err) });
      return { state: 'unknown', message: 'I could not check the paired approval devices. The request has not changed. Try again.' };
    }
  }

  async propose(change: TrustChange, principal = 'owner'): Promise<ProposeResult> {
    // Reserve fresh-request admission through the durable write, never across an external chat call.
    const before = this.proposalTail;
    let release!: () => void;
    this.proposalTail = new Promise<void>((done) => { release = done; });
    await before;
    let prepared: ProposeResult | (() => Promise<ProposeResult>);
    try { prepared = await this.prepareProposal(change, principal); } finally { release(); }
    return typeof prepared === 'function' ? prepared() : prepared;
  }

  private async prepareProposal(change: TrustChange, principal: string): Promise<ProposeResult | (() => Promise<ProposeResult>)> {
    if (!this.holds()) return { status: 'not-holder', message: HOLDER_MESSAGE };
    if (this.d.raisesOf(change).length === 0) return { status: 'not-a-raise' };
    const delivery = await this.approvalDelivery(principal);
    if (delivery.state === 'unknown') return { status: 'not-recorded', message: delivery.message };
    const app = delivery.state === 'accepted' || delivery.state === 'setup';
    const adapter = this.ownerAdapter();
    const proposalHash = proposalHashOf(proofSubject(change));
    const dup = this.d.store.openRequests().find((r) => r.proposalHash === proposalHash && r.principal === principal && new Date(r.expiresAt) > this.now());
    if (dup) {
      const derived = app ? this.derivedSummary(dup) : null;
      if (app && !derived) return { status: 'not-recorded', message: 'This request does not match the change it would make. The existing request is unchanged; ask for a fresh request.' };
      if (app && !appApprovalSummaryLines(derived!)) return { status: 'too-large', message: 'This request cannot be shown whole in this app. The existing request is unchanged; split the change into smaller requests.' };
      if (app) {
        if (dup.adapter !== 'device' && !dup.cardMessageId) {
          if (!this.holds()) return { status: 'not-holder', message: HOLDER_MESSAGE };
          const w = await this.d.store.write('request-carrier', { requestId: dup.requestId, principal: dup.principal, proposalHash: dup.proposalHash, expiresAt: dup.expiresAt, adapter: 'device' }, `tj:request-carrier:${dup.requestId}:device`);
          if (!w.ok && this.d.store.request(dup.requestId)?.adapter !== 'device') return { status: 'not-recorded', message: 'The app delivery update could not be recorded. The original request is unchanged.' };
          if (w.ok && this.holds()) this.notifyDevices('trust-request', `trust-request:${dup.requestId}`);
        }
        return { status: delivery.state === 'accepted' ? 'sent' : 'awaiting-acceptance', via: 'device', requestId: dup.requestId, code: dup.code, expiresAt: dup.expiresAt, deduped: true, message: delivery.message };
      }
      if (dup.adapter === 'device') return { status: 'no-approver', requestId: dup.requestId, message: delivery.message };
      return { status: dup.cardMessageId ? 'sent' : 'awaiting-acceptance', via: 'chat', requestId: dup.requestId, code: dup.code, expiresAt: dup.expiresAt, deduped: true,
        ...(!dup.cardMessageId ? { message: 'Chat delivery is unconfirmed. In your private approval chat, repeat the acceptance statement to resend pending cards. Nothing has been approved.' } : {}) };
    }
    if (!app && !adapter) return { status: 'no-approver', message: `Nothing can approve this yet. ${delivery.message} ${SET_UP_APPROVALS_TEXT}` };
    const recentlyWithdrawn = this.d.store.allRequests().find((r) => r.proposalHash === proposalHash && r.principal === principal && r.status === 'withdrawn' && new Date(r.expiresAt) > this.now());
    if (recentlyWithdrawn) return { status: 'withdrawn-recently', message: `This exact change was withdrawn by the agent and cannot be asked again until ${recentlyWithdrawn.expiresAt}.` };
    const summary = this.d.summarize(change);
    if (summary.join('\n').length > MAX_CARD_SUMMARY || (app && !appApprovalSummaryLines(summary))) return { status: 'too-large', message: 'This change is too large to show whole on one card, so no card was sent. Split it into smaller changes.' };
    const live = this.d.store.openRequests().filter((r) => r.principal === principal && new Date(r.expiresAt) > this.now());
    if (this.deliveryCount(principal) >= MAX_OPEN_REQUESTS) return { status: 'too-many-open', message: `There are already ${MAX_OPEN_REQUESTS} requests waiting for the person; no new card is sent until one is answered or expires.` };
    if (live.filter((r) => !this.delivered(r)).length >= MAX_OPEN_REQUESTS) return { status: 'too-many-undelivered', message: `There are already ${MAX_OPEN_REQUESTS} requests waiting to be delivered. Answer, deliver or let one expire before creating another.` };
    const code = newApprovalCode((c) => this.d.store.codeTaken(c));
    const expiresAt = new Date(this.now().getTime() + this.d.cardTtlDays() * 86_400_000).toISOString();
    const requestId = `tr-${proposalHash.slice(0, 12)}-${code}`;
    const carrier = app ? 'device' as const : adapter!;
    const ownerId = app ? '' : this.d.ownerPlatformId(adapter!)!;
    const base = { requestId, code, proposalHash, principal, adapter: carrier, approverPlatformId: ownerId, expiresAt, status: 'open' as const, change, summary, cardMessageId: '', cardChatId: '' };
    if (!this.holds()) return { status: 'not-holder', message: HOLDER_MESSAGE };
    // Reserve before the durability await so an independent acceptance flush cannot take this slot.
    const creatorReserved = !app && !!this.d.store.acceptance(principal, adapter!);
    if (app || creatorReserved) this.deliveryReservations.set(requestId, principal);
    let w: { ok: boolean };
    try { w = await this.d.store.write('request', base, `tj:request:${requestId}`); }
    catch (err) {
      // @silent-fallback-ok: a failed durable append refuses publication; no send or approval follows.
      this.deliveryReservations.delete(requestId);
      this.d.log?.('trust-request-not-recorded', { requestId, error: err instanceof Error ? err.message : String(err) });
      return { status: 'not-recorded', message: 'The request could not be recorded durably, so nothing was sent.' };
    }
    if (!w.ok) { this.deliveryReservations.delete(requestId); return { status: 'not-recorded', message: 'The request could not be recorded durably, so nothing was sent.' }; }
    if (app) {
      this.deliveryReservations.delete(requestId); // The durable device row now owns the same delivery slot.
      if (!this.holds()) return { status: 'not-holder', message: HOLDER_MESSAGE };
      this.notifyDevices('trust-request', `trust-request:${requestId}`);
      return { status: delivery.state === 'accepted' ? 'sent' : 'awaiting-acceptance', via: 'device', requestId, code, expiresAt, message: delivery.message };
    }
    // The creating invocation alone owns this send. A duplicate observes the pending durable row.
    return async () => {
      try {
      if (!this.holds()) return { status: 'not-holder', message: HOLDER_MESSAGE };
      if (!this.d.store.acceptance(principal, adapter!)) {
        if (!(await this.sendAcceptanceStatement(principal, adapter!, ownerId))) return { status: 'undelivered', message: 'The acceptance message could not be delivered to the owner’s private chat. The request remains visible in Needs-you and in the Instar app. Nothing was approved.' };
        return { status: 'awaiting-acceptance', via: 'chat', requestId, code, expiresAt };
      }
      return await this.sendCard(base, creatorReserved);
      } finally { if (creatorReserved) this.deliveryReservations.delete(requestId); }
    };
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

  private async sendCard(req: RequestRecord & { summary: string[]; change?: TrustChange }, creatorReserved = false): Promise<ProposeResult> {
    if (!this.holds()) return { status: 'not-holder', message: HOLDER_MESSAGE };
    if (req.adapter === 'device') return { status: 'sent', via: 'device', requestId: req.requestId, code: req.code, expiresAt: req.expiresAt };
    if (!creatorReserved && this.deliveryReservations.has(req.requestId)) return { status: 'awaiting-acceptance', via: 'chat', requestId: req.requestId, code: req.code, expiresAt: req.expiresAt, deduped: true, message: 'Delivery of this existing request is already in progress.' };
    const ownsReservation = !creatorReserved;
    if (ownsReservation) {
      if (this.deliveryCount(req.principal) >= MAX_OPEN_REQUESTS) return { status: 'too-many-open', message: 'The existing approval delivery allowance is full. This pending request stays visible until another is answered or expires.' };
      this.deliveryReservations.set(req.requestId, req.principal);
    }
    try {
      const port = this.d.adapters[req.adapter]!;
      const live = this.verified(req);
      if (!live.ok) return { status: 'undelivered', message: 'This request does not match the change it would make, so no card was sent and nothing was approved.' };
      const text = renderRequestCard({ summary: { lines: live.summary }, code: req.code, expiresAt: req.expiresAt });
      const sent = await port.sendDirect(req.approverPlatformId, text);
      if (!sent) return { status: 'undelivered', message: 'The request card could not be delivered to the owner’s private chat. The pending request remains visible; nothing was approved.' };
      const w = await this.d.store.write('request', { ...req, cardMessageId: sent.messageId, cardChatId: sent.chatId, status: 'open' }, `tj:request:${req.requestId}:card`);
      if (!w.ok) return { status: 'not-recorded', message: 'The chat accepted the card but its delivery record is unconfirmed. The pending request remains visible; a reply to that unrecorded card cannot approve anything.' };
      return { status: 'sent', via: 'chat', requestId: req.requestId, code: req.code, expiresAt: req.expiresAt };
    } finally { if (ownsReservation) this.deliveryReservations.delete(req.requestId); }
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

  /**
   * SEC-088: an owner reply that reached a machine that does not hold the lease. Nothing is approved
   * or accepted here, and nothing is written for the holder (a replicated receipt is the writing
   * machine's word, so the holder never takes one as the owner's reply). When the reply would have
   * acted (an acceptance, a reply to a request card, or an approve command), the owner is told once
   * to send it again; the holder then receives it from the chat itself.
   */
  async onReceiptAwayFromHolder(r: Receipt): Promise<ReceiptOutcome> {
    const ownerId = this.d.ownerPlatformId(r.adapter);
    const direct = r.adapter === 'telegram' ? (r.chatType === 'private' && r.chatId === r.senderId) : r.chatType === 'im';
    if (!ownerId || r.senderId !== ownerId || !direct || r.senderIsBot || r.forwarded) return 'not-for-us';
    const statement = acceptanceStatement({ adapter: r.adapter, accountId: ownerId, installationId: this.d.installationId });
    const wouldAct = isAcceptanceReply(r.text, statement)
      || (!!r.replyToMessageId && !!this.d.store.requestByCard(r.adapter, r.replyToMessageId))
      || parseApproveCommand(r.text) !== null;
    if (!wouldAct) return 'not-for-us';
    return this.instruct(r, 'That reply reached one of my machines that is not handling approvals right now, so nothing changed. Please send the same reply again in a minute.');
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
      // The flush is bounded (agent-work-cards-default §5): min(cap − delivered open, undelivered), newest first; the
      // rest stay undelivered and expire at `cardTtlDays`.
      const open = this.d.store.openRequests().filter((x) => x.principal === principal && new Date(x.expiresAt) > this.now());
      const room = Math.max(0, MAX_OPEN_REQUESTS - this.deliveryCount(principal));
      const undelivered = open.filter((x) => x.adapter === adapter && !x.cardMessageId && !this.deliveryReservations.has(x.requestId)).sort((a, b) => (a.expiresAt < b.expiresAt ? 1 : a.expiresAt > b.expiresAt ? -1 : 0));
      for (const q of undelivered.slice(0, room)) {
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
      if (verdict.reason === 'request-consumed') {
        // Approved already (here, or from a paired device): the loser of a race is told so.
        await this.d.adapters[adapter]?.replyTo(r.chatId, r.messageId, 'This request was already approved, so nothing more changed.');
        return 'refused';
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

    // SEC-141: approve only a request whose change still matches its hash; the reply names the change itself.
    const live = this.verified(req);
    if (!live.ok) {
      await this.d.adapters[adapter]?.replyTo(r.chatId, r.messageId, 'This request does not match the change it would make, so nothing was approved. The agent can send a fresh one.');
      return 'refused';
    }

    // 3. Approve: claim the request before any wait, so a second reply arriving meanwhile is refused.
    if (this.inFlight.has(req.requestId)) return 'refused';
    this.inFlight.add(req.requestId);
    try {
      return await this.consume(r, { ...req, summary: live.summary }, acceptance!);
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
    const done = await this.consumeAndApply(req, { consumptionId: `c:${r.receiptId}`, receiptId: r.receiptId, acceptanceId: acceptance.acceptanceId });
    if (!done.recorded) {
      if (done.alreadyApproved) {
        await this.d.adapters[adapter]!.replyTo(r.chatId, r.messageId, 'This request was already approved, so nothing more changed.');
        return 'refused';
      }
      await this.d.adapters[adapter]!.replyTo(r.chatId, r.messageId, 'Your approval could not be recorded, so nothing changed. The request is still open; reply again to try once more.');
      return 'not-recorded';
    }
    const applied = done.applied;
    if (!applied.ok) {
      await this.d.adapters[adapter]!.replyTo(r.chatId, r.messageId, `Your approval was recorded, but the change did not take effect (${applied.detail ?? 'unknown reason'}). Nothing else changed; the agent will need to ask again.`);
      return 'apply-failed';
    }
    await this.d.adapters[adapter]!.replyTo(r.chatId, r.messageId, `Done: ${req.summary.join('; ')}. This was ${DISCLOSURE}.`);
    return 'approved';
  }

  /**
   * The one consumption, shared by the chat and device paths (app-trust-approval §B, One operation
   * owns consumption). Its first durable step writes the consumption under `tj:consumption:<requestId>`:
   * records are immutable and the key is reserved before the durable wait, so that write is the
   * compare-and-set and a second approval of the same request fails here. Then the proof is issued,
   * the change applied through its owner, and the outcome written. A consumption whose outcome was
   * never written stays `unknown`: nothing reconciles or retries it.
   */
  private async consumeAndApply(req: RequestRecord & { summary: string[]; change: TrustChange },
    c: { consumptionId: string; receiptId: string; acceptanceId: string; kind?: 'accepted-device'; deviceId?: string }):
    Promise<{ recorded: false; alreadyApproved: boolean } | { recorded: true; consumptionId: string; applied: { ok: boolean; detail?: string }; outcomeRecorded: boolean }> {
    const w = await this.d.store.write('consumption', {
      consumptionId: c.consumptionId, requestId: req.requestId, receiptId: c.receiptId, acceptanceId: c.acceptanceId,
      proposalHash: req.proposalHash, principal: req.principal,
      ...(c.kind ? { kind: c.kind, deviceId: c.deviceId } : {}),
    }, `tj:consumption:${req.requestId}`);
    if (!w.ok) return { recorded: false, alreadyApproved: this.d.store.requestConsumedOrPending(req.requestId) };
    const proof = issueOperatorProofFromConsumedReceipt({ proposalHash: req.proposalHash, receiptRef: c.consumptionId, acceptanceRef: c.acceptanceId, principal: req.principal, kind: c.kind ?? 'accepted-account' });
    let applied: { ok: boolean; detail?: string };
    try { applied = await this.d.apply(req.change, proof); }
    catch (err) { applied = { ok: false, detail: err instanceof Error ? err.message : String(err) }; } // @silent-fallback-ok: the failure is told to the person by the caller and recorded as not-applied just below
    const o = await this.d.store.write('apply-outcome', {
      requestId: req.requestId, consumptionId: c.consumptionId, outcome: applied.ok ? 'applied' : 'not-applied',
      ...(applied.detail ? { detail: applied.detail.slice(0, 500) } : {}),
    }, `tj:outcome:${req.requestId}`);
    if (!o.ok) this.d.log?.('trust-apply-outcome-not-recorded', { requestId: req.requestId });
    return { recorded: true, consumptionId: c.consumptionId, applied, outcomeRecorded: o.ok };
  }

  private async instruct(r: Receipt, text: string): Promise<ReceiptOutcome> {
    await this.d.adapters[r.adapter]?.replyTo(r.chatId, r.messageId, text);
    return 'instruction-sent';
  }

  /** The person withdraws their acceptance (a narrowing: stops new consumption, keeps committed grants). */
  /** A request counts as delivered when its card is in the person's chat, or it is a device request. */
  private delivered(r: { adapter: string; cardMessageId: string }): boolean { return r.adapter === 'device' || !!r.cardMessageId; }

  /** In-flight reservations count even before their base request is durable; never count a durable row twice. */
  private deliveryCount(principal: string): number {
    const delivered = this.d.store.openRequests().filter((r) => r.principal === principal && new Date(r.expiresAt) > this.now() && this.delivered(r));
    const ids = new Set(delivered.map((r) => r.requestId));
    return delivered.length + [...this.deliveryReservations].filter(([id, who]) => who === principal && !ids.has(id)).length;
  }


  /**
   * agent-work-cards-default §5 (b): withdraw a request the agent raised and that no person has answered. The stored
   * request becomes `withdrawn`, its chat card (when delivered) is told so, a reply with its code is refused, and the
   * same `proposalHash` cannot be re-raised for `cardTtlDays`. A `board-policy` request (the owner's path to the lighter
   * policy) cannot be withdrawn by the agent. Withdrawing never approves anything.
   */
  async withdraw(requestId: string): Promise<{ ok: true; status: 'withdrawn'; cardTold: boolean } | { ok: false; reason: 'not-found' | 'not-open' | 'board-policy-not-withdrawable' | 'not-recorded' }> {
    const req = this.d.store.request(requestId);
    if (!req) return { ok: false, reason: 'not-found' };
    if (req.status !== 'open') return { ok: false, reason: 'not-open' };
    if ((req.change as { kind?: string } | undefined)?.kind === 'board-policy') return { ok: false, reason: 'board-policy-not-withdrawable' };
    const w = await this.d.store.write('request-status', { requestId, status: 'withdrawn' });
    if (!w.ok) return { ok: false, reason: 'not-recorded' };
    this.d.log?.('trust-request-withdrawn', { requestId, proposalHash: req.proposalHash });
    let cardTold = false;
    if (req.adapter !== 'device' && req.cardMessageId) {
      const port = this.d.adapters[req.adapter];
      // The port has no edit verb: the card is told in a threaded reply, which every reader of the card sees.
      cardTold = !!(await port?.replyTo(req.cardChatId, req.cardMessageId, 'The agent withdrew this request. Replying to it approves nothing now.').catch(() => false));
    }
    return { ok: true, status: 'withdrawn', cardTold };
  }

  async withdrawAcceptance(principal: string, adapter: AdapterKind): Promise<boolean> {
    const a = this.d.store.acceptance(principal, adapter);
    if (!a) return false;
    return (await this.d.store.write('acceptance-withdrawn', { acceptanceId: a.acceptanceId, principal, adapter })).ok;
  }
  // ── Approving from a paired device (docs/specs/app-trust-approval.md) ──────────────

  private notifyDevices(subject: 'trust-request' | 'trust-device-change', dedupeKey: string): void {
    try { this.devices?.notify?.(subject, dedupeKey); } catch (err) {
      // @silent-fallback-ok: a push is a courtesy; the request or acceptance is recorded and listed for the app either way
      this.d.log?.('trust-device-notice-failed', { subject, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Why an acceptance no longer holds for the device as it is now, or null when it still does. */
  private acceptanceMismatch(a: DeviceAcceptanceRecord, snap: DeviceSnapshot | null): 'device-not-active' | 'key-changed' | null {
    if (!snap || !snap.active) return 'device-not-active';
    if (snap.keyFingerprint !== a.keyFingerprint || snap.presenceKeyHash !== a.presenceKeyHash) return 'key-changed';
    return null;
  }

  /** Writes the acceptance's withdrawal (idempotent by key). True when it is withdrawn afterwards. */
  private async writeDeviceWithdrawal(a: DeviceAcceptanceRecord, reason: string): Promise<boolean> {
    const w = await this.d.store.write('device-acceptance-withdrawn', {
      acceptanceId: a.acceptanceId, deviceId: a.deviceId, principal: a.principal, withdrawnAt: this.now().toISOString(), reason,
    }, `tj:device-acceptance-withdrawn:${a.acceptanceId}`);
    const done = w.ok || !this.d.store.currentDeviceAcceptances().some((x) => x.acceptanceId === a.acceptanceId);
    if (w.ok) { this.d.log?.('trust-device-acceptance-withdrawn', { deviceId: a.deviceId, reason }); this.notifyDevices('trust-device-change', `trust-device:${a.acceptanceId}:withdrawn`); }
    return done;
  }

  /**
   * The device's current acceptance, checked against the device as the registry holds it now. An
   * acceptance belongs to one key: a revoked, re-paired or re-keyed device's acceptance is withdrawn
   * here, automatically, and null is returned.
   */
  async currentDeviceAcceptance(deviceId: string): Promise<DeviceAcceptanceRecord | null> {
    const a = this.d.store.deviceAcceptance(deviceId);
    if (!a) return null;
    const why = this.acceptanceMismatch(a, this.devices?.get(deviceId) ?? null);
    if (!why) return a;
    await this.writeDeviceWithdrawal(a, why);
    return null;
  }

  /** Every device acceptance with whether it is withdrawn, newest first (the record every accepted device shows). */
  deviceAcceptanceHistory() { return this.d.store.deviceAcceptanceHistory(); }

  /** Withdraws every acceptance whose device no longer matches it; answers the ones still current. */
  /**
   * A device was just paired (any path). When any device acceptance is current, every device push-registered
   * here hears that the set of paired devices changed (app-trust-approval §C: every new pairing is shown).
   */
  async noteDevicePaired(deviceId: string): Promise<void> {
    if ((await this.sweepDeviceAcceptances()).length === 0) return;
    this.d.log?.('trust-device-paired', { deviceId });
    this.notifyDevices('trust-device-change', `trust-device-paired:${deviceId}`);
  }

  async sweepDeviceAcceptances(): Promise<DeviceAcceptanceRecord[]> {
    const out: DeviceAcceptanceRecord[] = [];
    for (const a of this.d.store.currentDeviceAcceptances()) {
      const cur = await this.currentDeviceAcceptance(a.deviceId);
      if (cur && !out.some((x) => x.acceptanceId === cur.acceptanceId)) out.push(cur);
    }
    return out;
  }

  private async approvingDevices(principal: string): Promise<DeviceAcceptanceRecord[]> {
    if (!this.devices || this.devices.enabled?.() === false) return [];
    return (await this.sweepDeviceAcceptances()).filter((a) => a.principal === principal);
  }

  /**
   * A device records its own acceptance (app-trust-approval §A). The route has verified the device's
   * presence signature over `accept-device <deviceId> <keyFingerprint> <disclosureHash>`. Allowed:
   *  - `local-override`: the device paired by the app on this computer replaces its key (the route has
   *    checked loopback); its old acceptance is withdrawn and the new one recorded, whatever other
   *    devices exist. `replaceKey` revokes the old presence key once every check here has passed.
   *  - `accept-device`: an unused, unexpired approval from a currently accepted device names exactly
   *    this device, key fingerprint and disclosure hash; used once.
   *  - `local-install`: the first device, paired by the app on the agent's computer, while no device
   *    acceptance is current (also after every acceptance was withdrawn: a new first pairing).
   */
  async recordDeviceAcceptance(input: {
    deviceId: string; keyFingerprint: string; presenceKeyHash: string; keyPolicy: string; disclosureHash: string;
    principal?: string; override?: { replaceKey: () => { ok: boolean; presenceKeyHash?: string; reason?: string } };
  }): Promise<DeviceAcceptanceResult> {
    const principal = input.principal ?? 'owner';
    const refuse = (reason: string, message: string): DeviceAcceptanceResult => ({ status: 'refused', reason, message });
    if (!this.holds()) return { status: 'not-holder', reason: 'not-holder', message: HOLDER_MESSAGE };
    if (!this.devices) return refuse('devices-unavailable', 'Paired devices are not available on this agent.');
    const snap = this.devices.get(input.deviceId);
    if (!snap || !snap.active) return refuse('device-not-active', 'This device is not an active paired device of the owner.');
    if (snap.keyFingerprint !== input.keyFingerprint) return refuse('key-mismatch', 'This device is not paired with that key.');
    if (!KEY_POLICIES.has(input.keyPolicy)) return refuse('bad-key-policy', 'The approval key policy must be biometryCurrentSet or userPresence.');
    // A computer approves only with Touch ID (the agent may control the computer and know its password).
    if (snap.deviceKind === 'computer' && input.keyPolicy !== 'biometryCurrentSet') return refuse('key-policy-not-allowed', 'A computer can approve only with Touch ID.');
    if (!/^[0-9a-f]{64}$/.test(input.disclosureHash)) return refuse('bad-disclosure-hash', 'The disclosure hash is not valid.');

    let via: DeviceAcceptanceRecord['via'];
    let approvalId: string | undefined;
    let presenceKeyHash = input.presenceKeyHash;
    let withdrawOld: DeviceAcceptanceRecord | null = null;
    if (input.override) {
      if (!snap.localInstall) return refuse('not-local-device', 'Only the app on the agent\'s own computer can replace its approval key.');
      withdrawOld = this.d.store.deviceAcceptance(input.deviceId);
      const replaced = input.override.replaceKey();
      if (!replaced.ok || !replaced.presenceKeyHash) return refuse(replaced.reason ?? 'key-not-replaced', 'The approval key could not be replaced, so nothing changed.');
      presenceKeyHash = replaced.presenceKeyHash;
      via = 'local-override';
    } else {
      if (snap.presenceKeyHash !== input.presenceKeyHash) return refuse('key-mismatch', 'This device is not paired with that approval key.');
      const mine = await this.currentDeviceAcceptance(input.deviceId);
      if (mine && mine.keyFingerprint === input.keyFingerprint && mine.presenceKeyHash === input.presenceKeyHash) return { status: 'already-accepted', acceptanceId: mine.acceptanceId };
      const now = this.now();
      let approval: { approvalId: string } | null = null;
      for (const a of this.d.store.unusedDeviceApprovals(input.deviceId, input.keyFingerprint, input.disclosureHash)) {
        if (new Date(a.expiresAt) <= now) continue;
        // The approving device's own acceptance must be current at this moment, and be the one that approved.
        const approver = await this.currentDeviceAcceptance(a.approverDeviceId);
        if (!approver || approver.acceptanceId !== a.approverAcceptanceId) continue;
        approval = a;
        break;
      }
      if (approval) { via = 'accept-device'; approvalId = approval.approvalId; }
      else if (snap.localInstall || snap.firstPairing) {
        if ((await this.sweepDeviceAcceptances()).length > 0) {
          return refuse('approval-needed', 'Another device already approves for this agent. Approve this device from that one first.');
        }
        via = 'local-install';
      } else {
        return refuse('approval-needed', 'This device needs an approval from a device that already approves for this agent.');
      }
    }
    if (withdrawOld && !(await this.writeDeviceWithdrawal(withdrawOld, 'local-override'))) {
      return { status: 'not-recorded', reason: 'not-recorded', message: 'The old acceptance could not be withdrawn, so the new one was not recorded. Try again.' };
    }
    const acceptanceId = `dacc-${crypto.randomUUID()}`;
    const w = await this.d.store.write('device-acceptance', {
      acceptanceId, principal, deviceId: input.deviceId, keyFingerprint: input.keyFingerprint, presenceKeyHash,
      keyPolicy: input.keyPolicy, disclosureHash: input.disclosureHash, via, ...(approvalId ? { approvalId } : {}),
      acceptedAt: this.now().toISOString(),
    }, approvalId ? `tj:device-acceptance:approval:${approvalId}`
      // A first acceptance takes the next generation's fixed key: of two eligible devices accepting at
      // the same moment, the store's key reservation lets exactly one win (second-pass review).
      : via === 'local-install' ? `tj:device-acceptance:first:${this.d.store.deviceAcceptanceHistory().filter((h) => h.via === 'local-install').length}`
      : `tj:device-acceptance:${acceptanceId}`);
    if (!w.ok) {
      if (via === 'local-install') return refuse('approval-needed', 'Another device already approves for this agent. Approve this device from that one first.');
      return approvalId && this.d.store.unusedDeviceApprovals(input.deviceId, input.keyFingerprint, input.disclosureHash).every((a) => a.approvalId !== approvalId)
        ? refuse('approval-used', 'That approval was already used.')
        : { status: 'not-recorded', reason: 'not-recorded', message: 'The acceptance could not be recorded durably. Try again.' };
    }
    this.d.log?.('trust-device-acceptance-recorded', { deviceId: input.deviceId, via });
    this.notifyDevices('trust-device-change', `trust-device:${acceptanceId}:accepted`);
    return { status: 'recorded', acceptanceId, via, ...(withdrawOld ? { withdrew: withdrawOld.acceptanceId } : {}) };
  }

  /**
   * A currently accepted device approves a new device's acceptance (app-trust-approval §A). The route
   * has consumed the approver's single-use `accept-device` challenge; the approval lives as long as
   * that challenge did (`expiresAt`).
   */
  async recordDeviceApproval(input: { approverDeviceId: string; deviceId: string; keyFingerprint: string; disclosureHash: string; expiresAt: string }): Promise<{ status: 'recorded'; approvalId: string; expiresAt: string } | { status: 'refused' | 'not-holder' | 'not-recorded'; reason: string; message: string }> {
    if (!this.holds()) return { status: 'not-holder', reason: 'not-holder', message: HOLDER_MESSAGE };
    const approver = await this.currentDeviceAcceptance(input.approverDeviceId);
    if (!approver) return { status: 'refused', reason: 'no-acceptance', message: 'This device does not approve for this agent, so it cannot approve another device.' };
    const target = this.devices?.get(input.deviceId) ?? null;
    if (!target || !target.active) return { status: 'refused', reason: 'device-not-active', message: 'That device is not an active paired device of the owner.' };
    if (target.keyFingerprint !== input.keyFingerprint) return { status: 'refused', reason: 'key-mismatch', message: 'That device is not paired with that key.' };
    if (!/^[0-9a-f]{64}$/.test(input.disclosureHash)) return { status: 'refused', reason: 'bad-disclosure-hash', message: 'The disclosure hash is not valid.' };
    const approvalId = `dapp-${crypto.randomUUID()}`;
    const w = await this.d.store.write('device-approval', {
      approvalId, approverDeviceId: input.approverDeviceId, approverAcceptanceId: approver.acceptanceId, deviceId: input.deviceId,
      keyFingerprint: input.keyFingerprint, disclosureHash: input.disclosureHash, expiresAt: input.expiresAt,
    }, `tj:device-approval:${approvalId}`);
    if (!w.ok) return { status: 'not-recorded', reason: 'not-recorded', message: 'The approval could not be recorded durably. Try again.' };
    this.notifyDevices('trust-device-change', `trust-device-approval:${approvalId}`);
    return { status: 'recorded', approvalId, expiresAt: input.expiresAt };
  }

  /** The person withdraws a device's acceptance (a narrowing: stops new device approvals, keeps committed grants). */
  async withdrawDeviceAcceptance(deviceId: string | null, reason = 'withdrawn by the person'): Promise<number> {
    let n = 0;
    for (const a of this.d.store.currentDeviceAcceptances()) {
      if (deviceId !== null && a.deviceId !== deviceId) continue;
      if (await this.writeDeviceWithdrawal(a, reason)) n++;
    }
    return n;
  }

  /**
   * A device approves one open request (app-trust-approval §B). Checked on the deciding machine: the
   * request is open, unexpired and its proposal hash matches; a current acceptance exists for this
   * device with this key; the device is still paired and active with that same key. Then the shared
   * consumption (one key, one compare-and-set), the proof `accepted-device`, the apply and the outcome.
   */
  /**
   * SEC-141: the text a person approves is rebuilt from the change itself, never read from the stored
   * request. A request record is replicated, and its `summary` is a separate field nothing derived
   * again, so a forged record could pair a harmless summary with a dangerous change and a matching
   * hash. A request whose change no longer hashes to its recorded `proposalHash`, or that has no
   * change, is treated as altered and is neither listed as approvable nor approved.
   */
  /** SEC-141: the text for a request rebuilt from its change, or null when the request is altered. */
  derivedSummary(req: { change?: TrustChange; proposalHash: string; requestId: string }): string[] | null {
    const v = this.verified(req);
    return v.ok ? v.summary : null;
  }

  private verified<R extends { change?: TrustChange; proposalHash: string; requestId: string }>(req: R): { ok: true; summary: string[] } | { ok: false } {
    if (!req.change) return { ok: false };
    try {
      if (proposalHashOf(proofSubject(req.change)) !== req.proposalHash) {
        this.d.log?.('trust-request-altered', { requestId: req.requestId });
        return { ok: false };
      }
      return { ok: true, summary: this.d.summarize(req.change) };
    } catch {
      // @silent-fallback-ok — an unreadable change is refused (ok:false), and logged
      this.d.log?.('trust-request-altered', { requestId: req.requestId, reason: 'summarize-failed' });
      return { ok: false };
    }
  }

  async onPresenceApproval(auth: DeviceAuthorization): Promise<DeviceApprovalResult> {
    const refuse = (reason: string, message: string): DeviceApprovalResult => ({ status: 'refused', reason, message });
    if (!this.holds()) return { status: 'not-holder', reason: 'not-holder', message: HOLDER_MESSAGE };
    const req = this.d.store.request(auth.requestId);
    if (!req) return refuse('unknown-request', 'There is no such request.');
    if (req.status === 'consumed' || this.d.store.requestConsumedOrPending(req.requestId) || this.inFlight.has(req.requestId)) {
      return { status: 'already-approved', reason: 'already-approved', message: 'This request was already approved.' };
    }
    if (req.status !== 'open') return refuse(`request-${req.status}`, 'This request is no longer open, so nothing was approved.');
    if (new Date(req.expiresAt).getTime() <= this.now().getTime()) {
      await this.d.store.write('request-status', { requestId: req.requestId, status: 'expired' });
      return refuse('request-expired', 'This request has expired, so nothing was approved. The agent can send a fresh one.');
    }
    if (req.proposalHash !== auth.proposalHash) return refuse('proposal-changed', 'This request is not the one shown on the card, so nothing was approved. Look again.');
    const live = this.verified(req);
    if (!live.ok) return refuse('request-altered', 'This request does not match the change it would make, so nothing was approved. The agent can send a fresh one.');
    if (!appApprovalSummaryLines(live.summary)) return refuse('disclosure-too-large', 'This request cannot be shown whole in this app, so nothing was approved. Ask the agent to split it into smaller requests.');
    const onRecord = this.d.store.deviceAcceptance(auth.deviceId);
    if (!onRecord) {
      return this.d.store.deviceAcceptanceWithdrawn(auth.deviceId)
        ? refuse('acceptance-withdrawn', 'Approvals from this device were turned off, so nothing was approved. Turn them on again in "Changes to approve".')
        : refuse('no-acceptance', `This device has not been set up to approve, so nothing was approved. ${SET_UP_APPROVALS_TEXT}`);
    }
    if (onRecord.principal !== req.principal) return refuse('no-acceptance', 'This device does not approve for this person.');
    if (onRecord.keyFingerprint !== auth.keyFingerprint) {
      await this.writeDeviceWithdrawal(onRecord, 'key-changed');
      return refuse('key-mismatch', 'This device\'s key changed since approvals were set up, so nothing was approved. Turn approvals on again in "Changes to approve".');
    }
    const acceptance = await this.currentDeviceAcceptance(auth.deviceId);
    if (!acceptance) {
      const snap = this.devices?.get(auth.deviceId) ?? null;
      return !snap || !snap.active
        ? refuse('device-not-active', 'This device is no longer paired, so nothing was approved.')
        : refuse('key-mismatch', 'This device\'s key changed since approvals were set up, so nothing was approved. Turn approvals on again in "Changes to approve".');
    }
    if (this.inFlight.has(req.requestId)) return { status: 'already-approved', reason: 'already-approved', message: 'This request is already being approved.' };
    this.inFlight.add(req.requestId);
    try {
      const done = await this.consumeAndApply(req, {
        consumptionId: `c:dev:${auth.challengeId}`, receiptId: `device:${auth.deviceId}:${auth.challengeId}`,
        acceptanceId: acceptance.acceptanceId, kind: 'accepted-device', deviceId: auth.deviceId,
      });
      if (!done.recorded) {
        return done.alreadyApproved
          ? { status: 'already-approved', reason: 'already-approved', message: 'This request was already approved.' }
          : { status: 'not-recorded', reason: 'not-recorded', message: 'Your approval could not be recorded, so nothing changed. The request is still open; try again.' };
      }
      const name = this.devices?.get(auth.deviceId)?.name ?? null;
      if (!done.outcomeRecorded) return { status: 'unknown', requestId: req.requestId, message: UNKNOWN_OUTCOME_TEXT };
      if (!done.applied.ok) return { status: 'not-applied', requestId: req.requestId, message: `Your approval was recorded, but the change did not take effect (${done.applied.detail ?? 'unknown reason'}). Nothing else changed; the agent will need to ask again.` };
      return { status: 'applied', requestId: req.requestId, message: `Done: ${live.summary.join('; ')}. ${deviceApprovalDisclosure(name)}`, ...(done.applied.detail ? { detail: done.applied.detail } : {}) };
    } finally {
      this.inFlight.delete(req.requestId);
    }
  }

  /** Read an exact, currently eligible disclosure for an already authenticated device. */
  openDeviceApprovalDisclosure(deviceId: string, requestId: string):
    { requestId: string; proposalHash: string; summary: string[] } | null {
    if (!this.holds()) return null;
    const request = this.d.store.request(requestId);
    const device = this.devices?.get(deviceId) ?? null;
    const acceptance = this.d.store.deviceAcceptance(deviceId);
    if (!request || request.status !== 'open' || request.adapter !== 'device' ||
      new Date(request.expiresAt).getTime() <= this.now().getTime() ||
      this.d.store.requestConsumedOrPending(requestId) || this.inFlight.has(requestId) ||
      !acceptance || acceptance.principal !== request.principal || this.acceptanceMismatch(acceptance, device)) return null;

    const verified = this.verified(request);
    const summary = verified.ok ? appApprovalSummaryLines(verified.summary) : null;
    return summary ? { requestId, proposalHash: request.proposalHash, summary } : null;
  }

  /**
   * The requests the app lists (app-trust-approval §B, Where it is listed): open ones, and those
   * consumed (or ended) in the last 7 days, each with a status read from the store, so a restarted
   * app shows what the card showed.
   */
  deviceListing(): DeviceRequestRow[] {
    const now = this.now().getTime();
    const weekAgo = now - 7 * 86_400_000;
    const out: DeviceRequestRow[] = [];
    for (const r of this.d.store.allRequests()) {
      // SEC-141: list only requests whose change matches their hash, with text rebuilt from the change.
      const live = this.verified(r);
      if (!live.ok) continue;
      const consumption = this.d.store.consumptionOf(r.requestId);
      const expired = new Date(r.expiresAt).getTime() <= now;
      let status: DeviceRequestRow['status'];
      if (consumption || r.status === 'consumed') {
        if (!consumption || new Date(consumption.at).getTime() < weekAgo) continue;
        status = this.d.store.applyOutcome(r.requestId)?.outcome ?? 'unknown';
      } else if (r.status === 'open' && !expired) status = 'open';
      else {
        if (new Date(r.expiresAt).getTime() < weekAgo) continue;
        status = r.status === 'open' || r.status === 'expired' ? 'expired' : 'declined';
      }
      const outcome = this.d.store.applyOutcome(r.requestId);
      const byDevice = consumption?.kind === 'accepted-device';
      out.push({
        requestId: r.requestId, status, summary: appApprovalSummaryLines(live.summary) ?? ['This request is too large to show whole in this app. It cannot be approved here. Ask the agent to split it into smaller requests.'], proposalHash: r.proposalHash, expiresAt: r.expiresAt,
        changeKind: r.change?.kind ?? null, via: r.adapter === 'device' ? 'device' : 'chat',
        delivery: r.adapter === 'device' ? 'app-listed' : r.cardMessageId ? 'chat-confirmed' : 'chat-unconfirmed',
        ...(consumption ? {
          approvedAt: consumption.at,
          approvedOn: byDevice ? 'device' as const : 'chat' as const,
          disclosure: byDevice ? deviceApprovalDisclosure(this.devices?.get(consumption.deviceId ?? '')?.name ?? null) : `This was ${DISCLOSURE}.`,
        } : {}),
        ...(status === 'unknown' ? { message: UNKNOWN_OUTCOME_TEXT } : {}),
        ...(outcome?.outcome === 'not-applied' && outcome.detail ? { detail: outcome.detail } : {}),
      });
    }
    return out.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.expiresAt.localeCompare(a.expiresAt));
  }
}

export interface DeviceRequestRow {
  requestId: string;
  status: 'open' | 'applied' | 'not-applied' | 'unknown' | 'expired' | 'declined';
  summary: string[];
  proposalHash: string;
  expiresAt: string;
  changeKind: string | null;
  via: 'chat' | 'device';
  delivery: 'app-listed' | 'chat-confirmed' | 'chat-unconfirmed';
  approvedAt?: string;
  approvedOn?: 'chat' | 'device';
  disclosure?: string;
  message?: string;
  detail?: string;
}
