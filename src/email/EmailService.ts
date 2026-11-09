/**
 * Sending email to the owner (docs/specs/backup-email-sending.md).
 *
 * `sendToOwner` has no recipient parameter: the recipient is the owner-typed address in the vault, and each
 * transport refuses any other. Every subject and body passes the credential-exposure guard before an outbox row
 * is written. Only the lease holder sends; it re-checks at fire time. One transport attempt per row, then the
 * fallback: the report goes to its topic with one plain line on why. A lost report is the failure this exists to
 * prevent; a duplicate copy is accepted and said on the page.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  EMAIL_PROVIDER_ACCOUNT_SECRET, EMAIL_RECIPIENT_SECRET, EMAIL_SECRET, buildSubject, credentialVersion, emailDay,
  fallbackLine, isCredentialRefusal, maskRecipient, providerCap, readEmailCredential, recipientHash, sha256, toPlainText,
  type EmailCredential, type EmailFixedReason, type EmailShape, type TransportResult,
} from './emailCore.js';
import { buildTransport, type EmailTransport, type SmtpClientFactory } from './transports.js';
import { TERMINAL_STATUSES, type EmailOutbox, type FallbackCause, type OutboxRow } from './EmailOutbox.js';
import { PROOF_RETRIES_SHAPE_B, PROOF_RETRY_GAP_MS, type EmailOptInStore } from './emailOptIn.js';

export const STATUS_WINDOW_DEFAULT_MIN = 30;
export const STATUS_WINDOW_MAX_MIN = 60;
export const TRANSPORT_TIMEOUT_DEFAULT_S = 15;
export const FALLBACK_REFUSED_DEADLINE_MS = 120_000;
export const FALLBACK_BACKOFF_MIN = [1, 2, 4, 8, 15];
export const FALLBACK_BREAKER_MS = 24 * 60 * 60_000;
export const POLL_BACKOFF_S = [5, 10, 20, 40];
export const POLL_STEADY_MS = 5 * 60_000;
export const FALLBACK_LINE_EVERY_DEFAULT_MS = 24 * 60 * 60_000;
export const FALLBACK_LINE_EVERY_FLOOR_MS = 60 * 60_000;
export const PROOF_SUBJECT = 'Your agent can now email you';
/** A row's copies offered to the relay queue before only the direct send is retried. */
export const RELAY_MAX_TRIES = 3;

/**
 * The fallback retry brake (spec: falling-back row, judgment-candidate): 1, 2, 4, 8, 15 minutes, then every 15,
 * and after 24 hours in falling-back the timer stops (null) until a resume event. The clock is the row's first
 * `fallingBackSince`; nothing in the retry path resets it. Pure, so the self-action convergence ratchet drives it.
 */
export function fallbackRetryDelayMs(tries: number, fallingBackSinceMs: number, nowMs: number): number | null {
  if (nowMs - fallingBackSinceMs >= FALLBACK_BREAKER_MS) return null;
  const mins = tries >= 1 && tries <= FALLBACK_BACKOFF_MIN.length ? FALLBACK_BACKOFF_MIN[tries - 1] : 15;
  return mins * 60_000;
}
export const CHECKPOINT_PER_SECOND = 10;

export type EmailReadiness = 'working' | 'unproven' | 'not-set-up' | 'not-set-up-here' | 'disabled';

export interface TopicDeliveryResult {
  ok: boolean;
  messageId?: string | number;
}

export interface EmailServiceDeps {
  outbox: EmailOutbox;
  optIn: EmailOptInStore;
  machineId: string;
  /** Keys the recipient hash (this machine's identity key, or a stable stand-in in tests). */
  recipientKey: string | Buffer;
  agentName: string;
  readSecret: (name: string) => string | null;
  /** `email.enabled` (default on once set up; the recipe's proving list keeps it dark). */
  enabled: () => boolean;
  /** The owner's yes for email stands on this machine. */
  hasGrant: () => boolean;
  /** The recipient hash the standing yes recorded. A stored address that does not match it never sends. */
  grantRecipientHash?: () => string | null | undefined;
  /** This machine is the one voice. An unreadable lease reads as not held. */
  holdsLease: () => boolean;
  /** The existing deterministic credential-exposure guard. True means a live secret is in the text. */
  detectCredential: (text: string) => boolean;
  /** Sends a copy straight to the row's topic (a job's own report path, or the session's topic). */
  deliverToTopic: (row: OutboxRow, text: string) => Promise<TopicDeliveryResult>;
  /**
   * Accepts a copy into the durable relay queue under `relayId` (the row id plus an attempt number, so a retry after
   * the sentinel gave one up is a new entry). Returns false when nothing new was queued.
   */
  relayEnqueue?: (row: OutboxRow, relayId: string, text: string) => boolean;
  /** The topic a row's copy goes to (a job's topic may exist only after its first report). */
  topicOf?: (row: OutboxRow) => number | null;
  /** How many scheduled emailed reports are still due today in the email timezone. */
  reservedForReports?: () => number;
  timezone: () => string | undefined;
  statusWindowMinutes?: () => number | undefined;
  transportTimeoutSeconds?: () => number | undefined;
  fallbackLineEveryMs?: () => number | undefined;
  /** A credential refusal is an internal failure first: re-run the check, reopen setup through the existing machinery. */
  onCredentialRefused?: () => void;
  report?: (what: string, detail: string) => void;
  fetch?: typeof fetch;
  createSmtpClient?: SmtpClientFactory;
  /** Tests inject a transport; real servers build one from the vault. */
  transportFor?: (credential: EmailCredential, recipient: string, timeoutMs: number) => EmailTransport;
  now?: () => number;
  stateDir: string;
}

interface ServiceState {
  /** When email delivery was first wired on this machine: the reconciliation sweep's floor. */
  wiredSince?: number;
  breakerOpen?: { at: number; reason: EmailFixedReason };
  recipientRefused?: { at: number };
  lines?: Record<string, number>;
}

/** What a submission becomes. */
export type SubmitResult =
  | { ok: true; id: string; status: OutboxRow['status'] }
  | { ok: false; reason: 'credential-exposure' | 'forward-required' | 'invalid' };

export class EmailService {
  private readonly stateFile: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private stopped = false;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private checkpointDropped = 0;

  constructor(private readonly deps: EmailServiceDeps) {
    this.stateFile = path.join(deps.stateDir, 'state', 'email-service.json');
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private readState(): ServiceState {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as ServiceState; } catch { return {}; } // @silent-fallback-ok — no state yet
  }

  private writeState(patch: (s: ServiceState) => void): void {
    const s = this.readState();
    patch(s);
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, this.stateFile);
  }

  private timeoutMs(): number {
    const s = this.deps.transportTimeoutSeconds?.() ?? TRANSPORT_TIMEOUT_DEFAULT_S;
    return Math.min(60, Math.max(5, Number.isFinite(s) ? s : TRANSPORT_TIMEOUT_DEFAULT_S)) * 1000;
  }

  private windowMs(): number {
    const m = this.deps.statusWindowMinutes?.() ?? STATUS_WINDOW_DEFAULT_MIN;
    return Math.min(STATUS_WINDOW_MAX_MIN, Math.max(1, Number.isFinite(m) ? m : STATUS_WINDOW_DEFAULT_MIN)) * 60_000;
  }

  private day(): string {
    return emailDay(this.now(), this.deps.timezone());
  }

  // ── What is set up ──

  credential(): { raw: string; credential: EmailCredential } | null {
    const raw = this.deps.readSecret(EMAIL_SECRET);
    const credential = readEmailCredential(raw);
    return raw && credential ? { raw, credential } : null;
  }

  recipient(): string | null {
    return this.deps.readSecret(EMAIL_RECIPIENT_SECRET);
  }

  recipientHashOf(recipient: string): string {
    return recipientHash(this.deps.recipientKey, recipient);
  }

  /** The proof version: the stored credential plus the recipient. */
  version(): string | null {
    const c = this.credential();
    const r = this.recipient();
    return c && r ? credentialVersion(c.raw, this.recipientHashOf(r)) : null;
  }

  /** Whether a proof passed for the current version, per shape. A and C also need the owner's code. */
  proven(): { proven: boolean; detail: string } {
    const c = this.credential();
    const r = this.recipient();
    const v = this.version();
    if (!c || !r || !v) return { proven: false, detail: 'Email is not set up yet.' };
    if (this.readState().recipientRefused) return { proven: false, detail: 'The provider refused your address, so it needs to be typed again on the confirm page.' };
    const p = this.deps.optIn.proof(v);
    const shape = c.credential.shape;
    const delivered = shape === 'A' ? p?.delivery === 'delivered' : p?.delivery === 'accepted-unproven' || p?.delivery === 'delivered';
    if (!delivered) return { proven: false, detail: shape === 'A' ? 'Waiting for the proof email to be delivered.' : 'Waiting for the proof email to be sent.' };
    if (shape !== 'B' && !this.deps.optIn.isConfirmed(this.recipientHashOf(r))) return { proven: false, detail: 'Waiting for you to enter the code from the proof email on the confirm page.' };
    return { proven: true, detail: shape === 'A' ? 'The proof email was delivered and you entered its code.' : shape === 'B' ? 'The proof email was accepted by your mail server (accepted, not proven delivered: email gives no delivery receipt).' : 'The proof email was accepted and you entered its code.' };
  }

  readiness(): { state: EmailReadiness; cause?: FallbackCause } {
    if (!this.deps.enabled()) return { state: 'disabled', cause: 'not-set-up' };
    const c = this.credential();
    if (!this.deps.hasGrant()) return c ? { state: 'not-set-up-here', cause: 'not-set-up-here' } : { state: 'not-set-up', cause: 'not-set-up' };
    const r = this.recipient();
    if (!c || !r) return { state: 'not-set-up', cause: 'not-set-up' };
    // The address must be the one the owner's yes recorded (a write that landed without its yes never sends).
    const granted = this.deps.grantRecipientHash?.();
    if (granted && granted !== this.recipientHashOf(r)) return { state: 'unproven', cause: 'unproven' };
    if (!this.proven().proven) return { state: 'unproven', cause: 'unproven' };
    return { state: 'working' };
  }

  /** The reconciliation floor, recorded once on first start and kept on disk. */
  wiredSince(): number {
    const at = this.readState().wiredSince;
    if (typeof at === 'number' && Number.isFinite(at)) return at;
    const now = this.now();
    this.writeState((s) => { s.wiredSince = now; });
    return now;
  }

  breakerOpen(): boolean {
    return !!this.readState().breakerOpen;
  }

  /** Only a verify pass re-arms the breaker. */
  closeBreaker(): void {
    if (this.readState().breakerOpen) this.writeState((s) => { delete s.breakerOpen; });
  }

  private transport(): EmailTransport | null {
    const c = this.credential();
    const r = this.recipient();
    if (!c || !r) return null;
    const timeoutMs = this.timeoutMs();
    return this.deps.transportFor?.(c.credential, r, timeoutMs)
      ?? buildTransport({ credential: c.credential, recipient: r, timeoutMs, fetch: this.deps.fetch, createSmtpClient: this.deps.createSmtpClient });
  }

  /** The regular check: sends nothing. A pass re-arms the breaker. */
  async verifyCredential(): Promise<{ result: 'pass' | 'fail' | 'unknown'; reason: EmailFixedReason; detail: string }> {
    const t = this.transport();
    if (!t) return { result: 'fail', reason: 'not-set-up', detail: 'No email credential or address is stored yet.' };
    const v = await t.verify();
    if (v.result === 'pass') this.closeBreaker();
    return v;
  }

  // ── Submitting ──

  /**
   * Submits one message for the owner. `id` is the idempotency id (an execution id, or a forwarded caller's id):
   * a repeated id answers the existing row. A standby never writes a row: it gets `forward-required`.
   */
  submit(input: {
    id?: string; kind: OutboxRow['kind']; subject: string; ownerText: string; topicText: string;
    fallbackTopicId: number | null; jobSlug?: string;
    /** The reconciliation sweep's row: straight to the topic with the status line. */
    forceFallback?: boolean;
  }): SubmitResult {
    if (!this.deps.holdsLease()) return { ok: false, reason: 'forward-required' };
    const id = input.id ?? `em-${crypto.randomBytes(12).toString('hex')}`;
    if (!/^[a-z0-9-]{8,80}$/.test(id)) return { ok: false, reason: 'invalid' };
    const existing = this.deps.outbox.get(id);
    if (existing || this.deps.outbox.known(id)) return existing ? { ok: true, id, status: existing.status } : { ok: true, id, status: 'fallen-back' };
    const subject = buildSubject(this.deps.agentName, input.subject);
    const ownerText = toPlainText(input.ownerText);
    const statusLine = subject;
    const exposed = this.deps.detectCredential(subject) || this.deps.detectCredential(ownerText);
    if (exposed) {
      // A one-off has one text: nothing is stored at all. A report still reaches its topic, whose own guard reads it again.
      if (input.kind === 'one-off') return { ok: false, reason: 'credential-exposure' };
      // The replicated row carries only the status line: the report itself held the secret.
      const row = this.deps.outbox.admit({ id, kind: input.kind, subjectHash: sha256(subject), textHash: sha256(ownerText), topicText: statusLine, statusLine,
        fallbackTopicId: input.fallbackTopicId, jobSlug: input.jobSlug, status: 'falling-back', cause: 'refused', reason: 'credential-exposure' });
      this.scheduleFallback(row.id, 0);
      return { ok: true, id, status: row.status };
    }
    const ready = input.forceFallback ? { state: 'unproven' as const, cause: 'refused' as FallbackCause } : this.readiness();
    if (ready.state !== 'working') {
      const row = this.deps.outbox.admit({ id, kind: input.kind, subjectHash: sha256(subject), textHash: sha256(ownerText), topicText: input.topicText, statusLine,
        fallbackTopicId: input.fallbackTopicId, jobSlug: input.jobSlug, status: 'falling-back', cause: ready.cause ?? 'not-set-up' });
      this.scheduleFallback(row.id, 0);
      return { ok: true, id, status: row.status };
    }
    const row = this.deps.outbox.admit({ id, kind: input.kind, subjectHash: sha256(subject), textHash: sha256(ownerText), topicText: input.topicText, statusLine,
      fallbackTopicId: input.fallbackTopicId, jobSlug: input.jobSlug, ownerText: `${subject}\u0000${ownerText}` });
    if (row.status === 'falling-back') this.scheduleFallback(row.id, 0);
    else this.enqueue(row.id);
    return { ok: true, id, status: row.status };
  }

  private enqueue(id: string): void {
    this.queue = this.queue.then(() => this.attempt(id)).catch((err) => {
      this.deps.report?.('EmailService.attempt', err instanceof Error ? err.message : String(err));
    });
  }

  /** Resolves when everything queued so far has been attempted (tests and drain). */
  idle(): Promise<void> {
    return this.queue;
  }

  /** The budget for one more attempt now. One-offs may use only what is above today's report reserve. */
  private budgetAllows(kind: OutboxRow['kind'], cap: number): boolean {
    const b = this.deps.outbox.budget(this.day());
    if (b === 'unreadable' || b.exhausted) return false;
    const reserve = kind === 'one-off' ? Math.max(0, this.deps.reservedForReports?.() ?? 0) : 0;
    return b.attempts < cap - reserve;
  }

  /** One transport attempt for a pending row, then the row's next state. */
  private async attempt(id: string): Promise<void> {
    const row = this.deps.outbox.get(id);
    if (!row || row.status !== 'pending' || row.attempts > 0) return;
    // Ownership again at fire time: a row whose holder lost the lease is left for the successor.
    if (!this.deps.holdsLease()) return;
    const stored = this.deps.outbox.readOwnerText(id);
    if (stored === null) { this.toFallingBack(id, 'refused', 'handoff'); return; }
    const sep = stored.indexOf('\u0000');
    const subject = sep >= 0 ? stored.slice(0, sep) : buildSubject(this.deps.agentName, 'Report');
    const text = sep >= 0 ? stored.slice(sep + 1) : stored;
    const ready = this.readiness();
    if (ready.state !== 'working') { this.toFallingBack(id, ready.cause ?? 'not-set-up'); return; }
    if (this.breakerOpen()) { this.toFallingBack(id, 'refused', 'breaker-open'); return; }
    const c = this.credential()!;
    if (!this.budgetAllows(row.kind, providerCap(c.credential))) { this.toFallingBack(id, 'refused', 'budget-exhausted'); return; }
    const transport = this.transport();
    const recipient = this.recipient();
    if (!transport || !recipient) { this.toFallingBack(id, 'not-set-up'); return; }
    // The reservation counts before the attempt, whatever the outcome.
    this.deps.outbox.reserve(this.day());
    this.deps.outbox.update(id, { attempts: row.attempts + 1 });
    let result: TransportResult;
    try {
      result = await transport.send({ to: recipient, subject, text, idempotencyKey: id });
    } catch (err) {
      this.deps.report?.('EmailService.send', err instanceof Error ? err.name : 'send-failed');
      result = { outcome: 'unknown', reason: 'provider-error' };
    }
    this.applySendResult(id, result, transport.kind);
  }

  private applySendResult(id: string, result: TransportResult, kind: 'resend' | 'smtp'): void {
    if (result.outcome === 'accepted' && kind === 'resend' && result.providerId) {
      this.deps.outbox.update(id, { status: 'sent', providerId: result.providerId, sentAt: new Date(this.now()).toISOString(), reason: 'ok' });
      this.schedulePoll(id, 0);
      return;
    }
    if (result.outcome === 'accepted' && kind === 'smtp') {
      // SMTP's 250 is terminal for a report: accepted, never proven delivered.
      this.deps.outbox.update(id, { status: 'accepted', reason: 'ok' });
      return;
    }
    if (result.outcome === 'refused') {
      this.noteRefusal(result.reason);
      this.toFallingBack(id, 'refused', result.reason);
      return;
    }
    this.toFallingBack(id, 'unknown', result.reason);
  }

  private noteRefusal(reason: EmailFixedReason): void {
    if (isCredentialRefusal(reason)) {
      if (!this.breakerOpen()) this.writeState((s) => { s.breakerOpen = { at: this.now(), reason }; });
      try { this.deps.onCredentialRefused?.(); } catch (err) { this.deps.report?.('EmailService.selfHeal', err instanceof Error ? err.message : String(err)); }
    } else if (reason === 'provider-rate-limited') {
      this.deps.outbox.markExhausted(this.day());
    } else if (reason === 'provider-recipient-refused') {
      this.writeState((s) => { s.recipientRefused = { at: this.now() }; });
    }
  }

  /** A fresh setup (new recipient) clears the recipient refusal. */
  clearRecipientRefused(): void {
    if (this.readState().recipientRefused) this.writeState((s) => { delete s.recipientRefused; });
  }

  // ── Delivery status (Resend) ──

  private schedulePoll(id: string, step: number): void {
    if (this.stopped) return;
    const row = this.deps.outbox.get(id);
    if (!row || row.status !== 'sent' || !row.sentAt) return;
    const end = Date.parse(row.sentAt) + this.windowMs();
    const delay = step < POLL_BACKOFF_S.length ? POLL_BACKOFF_S[step] * 1000 : POLL_STEADY_MS;
    const at = Math.min(this.now() + delay, end);
    clearTimeout(this.pollTimers.get(id));
    const t = setTimeout(() => { this.pollTimers.delete(id); void this.poll(id, step + 1); }, Math.max(0, at - this.now()));
    t.unref?.();
    this.pollTimers.set(id, t);
  }

  /** One status read. Delivered ends it; bounced or complained, or the end of the window, falls back. */
  async poll(id: string, step = 0): Promise<void> {
    const row = this.deps.outbox.get(id);
    if (!row || row.status !== 'sent' || !row.providerId || !row.sentAt) return;
    if (!this.deps.holdsLease()) return;
    // Switched off: the row drains to its topic now rather than waiting out its window.
    if (!this.deps.enabled()) { this.toFallingBack(id, 'unknown', 'disabled'); return; }
    const transport = this.transport();
    const s = transport?.status ? await transport.status(row.providerId) : null;
    if (s && s !== 'pending') {
      if (s.delivery === 'delivered') { this.deps.outbox.update(id, { status: 'delivered', reason: 'ok' }); return; }
      if (s.delivery === 'failed') { this.toFallingBack(id, 'refused', s.reason); return; }
    }
    if (this.now() >= Date.parse(row.sentAt) + this.windowMs()) { this.toFallingBack(id, 'unknown', 'status-window-ended'); return; }
    this.schedulePoll(id, step);
  }

  // ── Fallback ──

  private toFallingBack(id: string, cause: FallbackCause, reason?: EmailFixedReason): void {
    const row = this.deps.outbox.get(id);
    if (!row || TERMINAL_STATUSES.has(row.status) || row.status === 'falling-back' || row.status === 'relay-queued') return;
    this.deps.outbox.update(id, { status: 'falling-back', cause, ...(reason ? { reason } : {}), fallingBackSince: new Date(this.now()).toISOString(), fallbackTries: 0 });
    this.deps.outbox.deleteOwnerText(id);
    this.scheduleFallback(id, 0);
  }

  private scheduleFallback(id: string, delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimers.get(id));
    const t = setTimeout(() => { this.retryTimers.delete(id); void this.fallBack(id); }, delayMs);
    t.unref?.();
    this.retryTimers.set(id, t);
  }

  /** The line for this cause and reason, at most once per period (default a day), re-armed when either changes. */
  private lineFor(row: OutboxRow): string | null {
    const cause = row.cause ?? 'refused';
    const key = `${cause}:${row.reason ?? ''}`;
    const every = Math.max(FALLBACK_LINE_EVERY_FLOOR_MS, this.deps.fallbackLineEveryMs?.() ?? FALLBACK_LINE_EVERY_DEFAULT_MS);
    const last = this.readState().lines?.[key];
    // The intended duplicate on `unknown` always says why, so the person is never puzzled by two copies.
    if (cause !== 'unknown' && last !== undefined && this.now() - last < every) return null;
    return fallbackLine(cause, row.reason);
  }

  private noteLine(row: OutboxRow): void {
    const key = `${row.cause ?? 'refused'}:${row.reason ?? ''}`;
    this.writeState((s) => { s.lines = { ...(s.lines ?? {}), [key]: this.now() }; });
  }

  /** Carries the topic copy: Telegram's acknowledgment ends it; otherwise the relay queue; otherwise retry with backoff. */
  async fallBack(id: string): Promise<void> {
    const row = this.deps.outbox.get(id);
    if (!row || row.status !== 'falling-back') return;
    if (!this.deps.holdsLease()) return;
    const line = this.lineFor(row);
    const text = line ? `${row.topicText}\n\n${line}` : row.topicText;
    let sent: TopicDeliveryResult = { ok: false };
    try {
      sent = await this.deps.deliverToTopic(row, text);
    } catch (err) {
      this.deps.report?.('EmailService.fallback', err instanceof Error ? err.message : String(err));
    }
    if (sent.ok) {
      if (line) this.noteLine(row);
      this.deps.outbox.update(id, { status: 'fallen-back', ...(sent.messageId !== undefined ? { messageId: String(sent.messageId) } : {}) });
      return;
    }
    const relayTries = (row.relayTries ?? 0) + 1;
    const relayId = `${id}-r${relayTries}`;
    let queued = false;
    // A row the relay sentinel has given up on a few times keeps only the direct retry: never an endless relay loop.
    if (relayTries <= RELAY_MAX_TRIES) {
      try { queued = this.deps.relayEnqueue?.(row, relayId, text) ?? false; } catch { queued = false; } // @silent-fallback-ok — not queued: the row stays falling-back and retries
    }
    if (queued) {
      if (line) this.noteLine(row);
      this.deps.outbox.update(id, { status: 'relay-queued', relayId, relayTries });
      return;
    }
    const tries = (row.fallbackTries ?? 0) + 1;
    this.deps.outbox.update(id, { fallbackTries: tries });
    // The breaker: after a day the timer stops and waits for a resume event. The row is never discarded.
    /* @self-action-controller: email-fallback-retry */
    const delay = fallbackRetryDelayMs(tries, Date.parse(row.fallingBackSince ?? row.createdAt), this.now());
    if (delay !== null) this.scheduleFallback(id, delay);
  }

  /** The relay sentinel delivered a queued copy (its delivery id is the row id). */
  relayDelivered(relayId: string): void {
    const row = this.rowForRelay(relayId);
    if (row) this.deps.outbox.update(row.id, { status: 'fallen-back' });
  }

  /** The live row whose current relay entry is this one. */
  private rowForRelay(relayId: string): OutboxRow | null {
    return this.deps.outbox.liveRows().find((r) => r.status === 'relay-queued' && r.relayId === relayId) ?? null;
  }

  /**
   * The relay sentinel gave a queued copy up (escalated with its own fixed notice, held by the tone gate, or retired
   * as too old): the report itself never arrived, so the row goes back to falling-back and this holder sends it.
   */
  relayFailed(relayId: string): void {
    const row = this.rowForRelay(relayId);
    if (!row) return;
    const id = row.id;
    // The 24-hour clock keeps its first start: a relay give-up never restarts it.
    this.deps.outbox.update(id, { status: 'falling-back', relayId: undefined });
    this.scheduleFallback(id, 60_000);
  }

  /** Rows retired from the relay queue as too old carry no id, only their topics. */
  relayRetiredForTopics(topicIds: number[]): void {
    for (const row of this.deps.outbox.liveRows()) {
      const topic = this.deps.topicOf?.(row) ?? row.fallbackTopicId;
      if (row.status === 'relay-queued' && row.relayId && topic !== null && topicIds.includes(topic)) this.relayFailed(row.relayId);
    }
  }

  /** A resume event: Telegram's reconnect, the relay sentinel's recovery, or a lease handoff. */
  resume(): void {
    for (const row of this.deps.outbox.liveRows()) {
      if (row.status === 'falling-back' && !this.retryTimers.has(row.id)) this.scheduleFallback(row.id, 0);
    }
  }

  /**
   * Boot or handoff: every live row this holder finds. A row mid-attempt falls back (the provider may have it, the
   * intended duplicate); a never-attempted row keeps its place if this holder has its text; `sent` resumes polling
   * for the rest of its window; a copy another machine queued is sent from here.
   */
  recover(): void {
    if (!this.deps.holdsLease()) return;
    for (const row of this.deps.outbox.liveRows()) {
      switch (row.status) {
        case 'pending':
          if (row.attempts >= 1) this.toFallingBack(row.id, 'unknown', 'handoff');
          else if (this.deps.outbox.readOwnerText(row.id) !== null) this.enqueue(row.id);
          else this.toFallingBack(row.id, 'refused', 'handoff');
          break;
        case 'sent':
          this.schedulePoll(row.id, POLL_BACKOFF_S.length);
          break;
        case 'falling-back':
          this.scheduleFallback(row.id, 0);
          break;
        case 'relay-queued':
          if (row.writer && row.writer !== this.deps.machineId) {
            this.deps.outbox.update(row.id, { status: 'falling-back', relayId: undefined, fallingBackSince: new Date(this.now()).toISOString(), fallbackTries: 0 });
            this.scheduleFallback(row.id, 0);
          }
          break;
        default:
          break;
      }
    }
  }

  /** The holder's hourly sweep: checkpoint live rows and today's budget, write due tombstones. Switched off: drain. */
  hourly(): { written: number; dropped: number; tombstoned: number } {
    if (!this.deps.holdsLease()) return { written: 0, dropped: 0, tombstoned: 0 };
    if (!this.deps.enabled() && this.deps.outbox.liveRows().some((r) => r.status === 'pending' || r.status === 'sent')) {
      void this.drain().catch((err) => this.deps.report?.('EmailService.drain', err instanceof Error ? err.message : String(err)));
    }
    const keys = this.deps.outbox.checkpointKeys(this.day());
    this.pacedCheckpoint(keys);
    const tombstoned = this.deps.outbox.tombstoneDue();
    return { written: keys.length, dropped: 0, tombstoned };
  }

  /**
   * The checkpoint is paced at ten records a second and checked: a record the journal dropped is re-queued for the
   * next tick rather than counted done (spec: A durable outbox, the checkpoint rule).
   */
  private pacedCheckpoint(keys: string[]): void {
    if (this.checkpointTimer || keys.length === 0) return;
    const queue = [...keys];
    const step = (): void => {
      this.checkpointTimer = null;
      if (this.stopped || !this.deps.holdsLease()) return;
      const batch = queue.splice(0, CHECKPOINT_PER_SECOND);
      const dropped = batch.filter((k) => !this.deps.outbox.checkpointOne(k));
      queue.push(...dropped);
      this.checkpointDropped += dropped.length;
      if (queue.length && this.checkpointDropped < keys.length * 10) {
        this.checkpointTimer = setTimeout(step, 1000);
        this.checkpointTimer.unref?.();
      } else {
        this.checkpointDropped = 0;
      }
    };
    step();
  }

  /**
   * Accepted intake must drain: every non-terminal row falls back to its topic now, before a switch-off or a stop.
   * Returns how many rows were still live afterwards (Telegram down leaves them `falling-back` for the next start).
   */
  async drain(): Promise<number> {
    await this.idle();
    for (const row of this.deps.outbox.liveRows()) {
      if (row.status === 'pending' || row.status === 'sent') {
        clearTimeout(this.pollTimers.get(row.id));
        this.toFallingBack(row.id, row.status === 'sent' ? 'unknown' : 'refused', 'disabled');
      }
    }
    for (const row of this.deps.outbox.liveRows()) {
      if (row.status === 'falling-back') {
        clearTimeout(this.retryTimers.get(row.id));
        this.retryTimers.delete(row.id);
        await this.fallBack(row.id);
      }
    }
    return this.deps.outbox.liveRows().filter((r) => r.status === 'falling-back').length;
  }

  stop(): void {
    this.stopped = true;
    for (const t of [...this.pollTimers.values(), ...this.retryTimers.values()]) clearTimeout(t);
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
    this.pollTimers.clear();
    this.retryTimers.clear();
  }

  // ── The proof mail ──

  /**
   * Sends the proof mail for the current credential version (the recipe's `prove`). One passing proof per version:
   * a pass is returned, never re-sent. A failed or unknown proof may be retried ten minutes apart, inside the day's
   * proof bound (A and C: three mails a day to an unconfirmed recipient, the signup mail included) or, for B, three
   * retries.
   */
  async prove(): Promise<{ result: 'pass' | 'fail' | 'unknown' | 'waiting'; detail: string; delivery?: string; awaitingCode?: boolean }> {
    if (!this.deps.hasGrant()) return { result: 'fail', detail: 'Email is not approved on this machine.' };
    if (!this.deps.holdsLease()) return { result: 'unknown', detail: 'Only the machine that answers your messages sends the proof email.' };
    const c = this.credential();
    const r = this.recipient();
    const version = this.version();
    if (!c || !r || !version) return { result: 'fail', detail: 'No email credential or address is stored yet.' };
    const shape = c.credential.shape;
    const rh = this.recipientHashOf(r);
    const prev = this.deps.optIn.proof(version);
    if (prev?.result === 'pass') {
      const p = this.proven();
      return p.proven ? { result: 'pass', detail: p.detail, delivery: prev.delivery } : { result: 'waiting', detail: p.detail, delivery: prev.delivery, awaitingCode: shape !== 'B' };
    }
    // A sent Resend proof still being delivered: read its status rather than send again.
    if (prev?.providerId && prev.result === 'unknown' && this.now() - prev.at < this.windowMs()) {
      return this.refreshProof(version, shape);
    }
    if (prev && this.now() - prev.at < PROOF_RETRY_GAP_MS) return { result: 'unknown', detail: 'A proof email was tried a few minutes ago. Try again in ten minutes.' };
    if (shape === 'B' && (prev?.tries ?? 0) > PROOF_RETRIES_SHAPE_B) return { result: 'fail', detail: 'The proof email failed several times. Something about the mailbox needs a look.' };
    const unconfirmed = shape !== 'B' && !this.deps.optIn.isConfirmed(rh);
    const day = this.day();
    if (unconfirmed && !this.deps.optIn.mayMail(rh, day)) return { result: 'unknown', detail: 'Today’s limit of emails to an address you haven’t confirmed yet is used up. I’ll try again tomorrow.' };
    if (!this.budgetAllows('report', providerCap(c.credential))) return { result: 'unknown', detail: 'Today’s email limit is used up.' };
    const v = await this.verifyCredential();
    if (v.result !== 'pass') return { result: v.result === 'fail' ? 'fail' : 'unknown', detail: v.detail };
    const transport = this.transport();
    if (!transport) return { result: 'fail', detail: 'No email credential or address is stored yet.' };
    const code = shape === 'B' ? null : this.deps.optIn.mint(rh).code;
    const text = [
      `${this.deps.agentName} can now email you.`,
      ...(code ? ['', `Your code is ${code}. Enter it on the confirm page to finish setting up email. It works for 30 minutes.`] : []),
      '', 'If you didn’t expect this, you can ignore it.',
    ].join('\n');
    if (unconfirmed) this.deps.optIn.countMail(rh, day);
    this.deps.outbox.reserve(day);
    let result: TransportResult;
    try {
      result = await transport.send({ to: r, subject: buildSubject(this.deps.agentName, PROOF_SUBJECT), text, idempotencyKey: `proof-${version.slice(0, 16)}-${(prev?.tries ?? 0) + 1}` });
    } catch {
      result = { outcome: 'unknown', reason: 'provider-error' };
    }
    if (result.outcome === 'refused') this.noteRefusal(result.reason);
    if (result.outcome === 'accepted' && transport.kind === 'smtp') {
      this.deps.optIn.recordProof(version, { result: 'pass', at: this.now(), delivery: 'accepted-unproven' });
      return shape === 'B'
        ? { result: 'pass', detail: 'Your mail server accepted the proof email (accepted, not proven delivered: email gives no delivery receipt).', delivery: 'accepted-unproven' }
        : { result: 'waiting', detail: 'The proof email was accepted. It has a code to enter on the confirm page.', delivery: 'accepted-unproven', awaitingCode: true };
    }
    if (result.outcome === 'accepted' && result.providerId) {
      this.deps.optIn.recordProof(version, { result: 'unknown', at: this.now(), providerId: result.providerId });
      return { result: 'waiting', detail: 'The proof email was sent. Its code is in your inbox; enter it on the confirm page.', awaitingCode: true };
    }
    this.deps.optIn.recordProof(version, { result: result.outcome === 'refused' ? 'fail' : 'unknown', at: this.now() });
    return { result: result.outcome === 'refused' ? 'fail' : 'unknown', detail: result.reason === 'provider-recipient-refused' ? 'The provider refused your address: it isn’t the address the account was opened with.' : 'The proof email did not go through.' };
  }

  private async refreshProof(version: string, shape: EmailShape): Promise<{ result: 'pass' | 'fail' | 'unknown' | 'waiting'; detail: string; delivery?: string; awaitingCode?: boolean }> {
    const prev = this.deps.optIn.proof(version);
    const transport = this.transport();
    const s = prev?.providerId && transport?.status ? await transport.status(prev.providerId) : null;
    if (s && s !== 'pending' && s.delivery === 'delivered') {
      this.deps.optIn.recordProof(version, { result: 'pass', at: this.now(), delivery: 'delivered', providerId: prev!.providerId });
      const p = this.proven();
      return p.proven ? { result: 'pass', detail: p.detail, delivery: 'delivered' } : { result: 'waiting', detail: p.detail, delivery: 'delivered', awaitingCode: shape !== 'B' };
    }
    if (s && s !== 'pending' && s.delivery === 'failed') {
      this.deps.optIn.recordProof(version, { result: 'fail', at: this.now(), delivery: 'failed' });
      return { result: 'fail', detail: 'The proof email bounced.' };
    }
    return { result: 'waiting', detail: 'The proof email was sent and is on its way.', awaitingCode: shape !== 'B' };
  }

  /** The owner entered the code on the confirm page. */
  enterCode(code: unknown): 'ok' | 'wrong' | 'expired' | 'locked' | 'none' | 'recipient-changed' | 'not-set-up' {
    const r = this.recipient();
    if (!r) return 'not-set-up';
    return this.deps.optIn.check(this.recipientHashOf(r), code);
  }

  awaitingCode(): boolean {
    const r = this.recipient();
    const c = this.credential();
    return !!r && !!c && c.credential.shape !== 'B' && this.deps.optIn.awaitingCode(this.recipientHashOf(r));
  }

  /**
   * Shape A's signup mail reaches the not-yet-confirmed inbox too, so it counts against the day's and the total
   * bound of proof mails before it is sent.
   */
  countSignupMail(): 'ok' | 'not-set-up' | 'proof-mail-limit' {
    const r = this.recipient();
    if (!r) return 'not-set-up';
    const rh = this.recipientHashOf(r);
    const day = this.day();
    if (!this.deps.optIn.mayMail(rh, day)) return 'proof-mail-limit';
    this.deps.optIn.countMail(rh, day);
    return 'ok';
  }

  /** Forgets the opt-in and the sender's own flags (a switch-off). */
  forget(): void {
    this.deps.optIn.clear();
    this.writeState((s) => { delete s.breakerOpen; delete s.recipientRefused; });
  }

  outboxRows(): OutboxRow[] {
    return this.deps.outbox.rows();
  }

  // ── Status ──

  status(): Record<string, unknown> {
    const c = this.credential();
    const r = this.recipient();
    const b = this.deps.outbox.budget(this.day());
    const ready = this.readiness();
    return {
      state: ready.state,
      shape: c?.credential.shape ?? null,
      transport: c?.credential.transport ?? null,
      recipient: maskRecipient(r),
      proof: this.proven().detail,
      awaitingCode: this.awaitingCode(),
      breakerOpen: this.breakerOpen(),
      budget: b === 'unreadable' ? { day: this.day(), unreadable: true } : { ...b, cap: c ? providerCap(c.credential) : null, reservedForReports: this.deps.reservedForReports?.() ?? 0 },
      liveRows: this.deps.outbox.liveRows().length,
      holdsLease: this.deps.holdsLease(),
    };
  }

  /** Secret names a switch-off removes, when setup stored them. */
  static secretNames(): string[] {
    return [EMAIL_SECRET, EMAIL_RECIPIENT_SECRET, EMAIL_PROVIDER_ACCOUNT_SECRET];
  }
}
