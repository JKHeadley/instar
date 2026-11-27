/**
 * Pairing outcome watches (docs/specs/mobile-pairing-outcome-notice.md §3.2–§3.4).
 *
 * One durable entry per pairing link minted with a `topicId`. A reconciler pass reads the device
 * registry (strictly: an unreadable registry decides nothing new), decides the link's outcome,
 * freezes the one plain line for it, and sends that line to the topic through the ordinary
 * automation reply path with a stable logical send id. A send the outbox takes over is followed by
 * its operation outcome. A line that cannot be posted is closed with one attention item per topic.
 *
 * Machine-local by design (§3.5): the pairing code lives only in the minting process.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { outcomeLine, type PairingOutcome } from './PairingOutcomeText.js';
import { topicRef } from '../messaging/shared/topicRef.js';

export type WatchState = 'watching' | 'due' | 'sending' | 'handed-off' | 'sent' | 'failed';

export interface OutcomeWatch {
  id: string;
  topicId: number;
  label: string | null;
  mintedAt: string;
  codeExpiresAt: string;
  codeEpoch: string;
  /** The operator's message the link answers (§3.4); absent ⇒ the line goes to the quiet feed. */
  anchorInboundId?: string;
  /** Set the first time a pass sees the joined device (immutable once set). */
  device?: { name: string | null; fingerprint: string | null };
  /** Latest registry status a pass observed for the joined device. */
  lastSeen?: { status: string; at: string };
  /** Set the first time a pass sees the device active (immutable). */
  approvedSeenAt?: string;
  /** A phone took the code at redeem (§3.2). */
  takenAt?: string;
  /** A phone took the code but the redeem was then refused (§3.2). */
  refusedAt?: string;
  state: WatchState;
  outcome?: PairingOutcome;
  text?: string;
  decidedAt?: string;
  attempts: number;
  nextAttemptAt?: string;
  /** The outbox operation that owns the send (state `handed-off`). */
  operationId?: string;
  sentAt?: string;
  lastError?: string;
  /** The failure may have been a send that still landed ("may not have been posted"). */
  uncertain?: boolean;
  escalated?: boolean;
  endedAt?: string;
}

/** The registry view a pass needs (a strict read: throws when the file exists but cannot be read). */
export interface WatchedDevice {
  id: string;
  status: string;
  deviceName: string | null;
  label: string | null;
  fingerprint?: string;
  expiresAt?: string;
  pendingDeadline?: string;
  approvedAt?: string;
  wrongCodes?: string[];
  outcomeWatchId?: string;
}

/** What a send attempt came back with, already classified by the caller's adapter (§3.4 table). */
export type SendResult =
  | { kind: 'sent' }
  | { kind: 'quiet' }
  | { kind: 'handed-off'; operationId: string }
  | { kind: 'retry'; error: string }
  | { kind: 'failed'; error: string };

/** What the outbox says about a handed-off operation (`quiet`: filed in the quiet feed; `unknown` includes pending). */
export type OperationResult = 'delivered' | 'quiet' | 'failed' | 'unknown';

export interface OutcomeWatchDeps {
  stateDir: string;
  agentName: () => string;
  /** Strict registry read (throws on an unreadable file). */
  listDevices: () => WatchedDevice[];
  /** The current code epoch (this process's boot id). */
  codeEpoch: () => string;
  /** Send one line to a topic; classified result. `anchorInboundId` absent ⇒ an ordinary (quiet) notice. */
  send: (topicId: number, text: string, logicalSendId: string, anchorInboundId: string | null) => Promise<SendResult>;
  /** Read a handed-off operation's outcome. */
  checkOperation: (operationId: string) => Promise<OperationResult>;
  /** Upsert the one attention item for a topic's undeliverable outcomes. Resolves true when recorded. */
  escalate: (topicId: number, lines: string[]) => Promise<boolean>;
  /** Kill switch, read live. */
  enabled: () => boolean;
  reportDegradation?: (what: string, err: unknown) => void;
  now?: () => number;
}

export const MAX_OPEN_WATCHES = 50;
export const SEND_WINDOW_MS = 60 * 60_000;
export const OUTBOX_DEADLINE_MS = 6 * 60 * 60_000;
export const RETRY_BASE_MS = 30_000;
export const RETRY_CAP_MS = 5 * 60_000;
export const TERMINAL_KEEP_MS = 30 * 24 * 60 * 60_000;
export const MAX_WRONG_CODES = 3;
export const RECONCILE_INTERVAL_MS = 5_000;
/** Longest link (60 min) + pending wait (30 min) + send window (60 min). */
export const STALE_DECISION_MS = 150 * 60_000;
/** Attention-item upsert attempts per topic per process before one report and a stop (No Unbounded Loops). */
export const MAX_ESCALATION_ATTEMPTS = 12;

/** Delay before the next send (or outbox read) after `attempts` tries: 30 s doubling, 5 min cap. */
export function sendRetryDelayMs(attempts: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** Delay before the next attention-item upsert after `attempts` failures: 30 s doubling, 10 min cap. */
export function escalationRetryDelayMs(attempts: number): number {
  return Math.min(RETRY_CAP_MS * 2, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

const OPEN: ReadonlySet<WatchState> = new Set(['watching', 'due', 'sending', 'handed-off']);

export class PairingOutcomeWatches {
  private readonly file: string;
  private readonly now: () => number;
  private entries = new Map<string, OutcomeWatch>();
  private running = false;
  /** Brakes for work outside the send path (No Unbounded Loops): per-topic escalation backoff, read-failure report spacing. */
  private escalateBackoff = new Map<number, { attempts: number; nextAt: number }>();
  private lastReadFailureReport = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: OutcomeWatchDeps) {
    this.file = path.join(deps.stateDir, 'state', 'mobile-pairing-outcome-watches.json');
    this.now = deps.now ?? Date.now;
    this.load();
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private load(): void {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.reportDegradation?.('MobilePairing.outcomeNotice', err);
      return; // @silent-fallback-ok — a missing file is an empty store; an unreadable one is reported above
    }
    const list = Array.isArray((raw as { watches?: unknown })?.watches) ? (raw as { watches: unknown[] }).watches : [];
    for (const w of list) {
      if (!w || typeof w !== 'object') continue;
      const e = w as OutcomeWatch;
      if (typeof e.id !== 'string' || !Number.isSafeInteger(e.topicId) || typeof e.state !== 'string') continue;
      // §3.4: a send interrupted by a crash is replayed with the same logical id and frozen text.
      if (e.state === 'sending') e.state = 'due';
      this.entries.set(e.id, e);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ watches: [...this.entries.values()] }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private safePersist(): void {
    try { this.persist(); } catch (err) { this.deps.reportDegradation?.('MobilePairing.outcomeNotice', err); }
  }

  /** Open work: non-terminal entries, plus failed ones whose attention item is not yet recorded. */
  openCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (OPEN.has(e.state) || (e.state === 'failed' && !e.escalated)) n++;
    return n;
  }

  // ── Mint / redeem hooks ─────────────────────────────────────────────

  /**
   * Record a watch at mint. Returns the watch id, or a plain reason when none was recorded (the
   * link is minted either way; the response says `outcomeNotice: null` with this reason).
   */
  record(input: { topicId: number; label: string | null; codeExpiresAt: number; anchorInboundId: string | null }):
    { ok: true; id: string } | { ok: false; reason: string } {
    let open = 0;
    for (const e of this.entries.values()) if (OPEN.has(e.state)) open++;
    if (open >= MAX_OPEN_WATCHES) return { ok: false, reason: 'Too many pairing links are waiting for an outcome right now, so no line will be posted for this one.' };
    const id = crypto.randomUUID();
    const entry: OutcomeWatch = {
      id, topicId: input.topicId, label: input.label, mintedAt: new Date(this.now()).toISOString(),
      codeExpiresAt: new Date(input.codeExpiresAt).toISOString(), codeEpoch: this.deps.codeEpoch(), state: 'watching', attempts: 0,
      ...(input.anchorInboundId ? { anchorInboundId: input.anchorInboundId } : {}),
    };
    this.entries.set(id, entry);
    try { this.persist(); } catch (err) {
      this.entries.delete(id);
      this.deps.reportDegradation?.('MobilePairing.outcomeNotice', err);
      return { ok: false, reason: 'The outcome could not be recorded on this machine, so no line will be posted for this link.' };
    }
    return { ok: true, id };
  }

  /**
   * A phone took the code at redeem (§3.2). Called in the same synchronous block as the take and
   * the device write, so no pass (a separate event-loop task) can observe the step in between.
   */
  markTaken(id: string | undefined | null): void {
    const e = id ? this.entries.get(id) : undefined;
    if (!e || e.state !== 'watching' || e.takenAt) return;
    e.takenAt = new Date(this.now()).toISOString();
    this.safePersist();
  }

  /**
   * The redeem route decided the outcome itself (§3.2): refused after the take (`ended`), or the
   * owner's approval message could not be sent and the pending phone was removed (`not-delivered`).
   */
  markOutcome(id: string | undefined | null, outcome: 'ended' | 'not-delivered'): void {
    const e = id ? this.entries.get(id) : undefined;
    if (!e || e.state !== 'watching') return;
    const at = new Date(this.now()).toISOString();
    if (!e.takenAt) e.takenAt = at;
    if (outcome === 'ended') e.refusedAt = at;
    this.decide(e, outcome);
    this.safePersist();
  }

  get(id: string): OutcomeWatch | null { const e = this.entries.get(id); return e ? { ...e } : null; }
  list(): OutcomeWatch[] { return [...this.entries.values()].map((e) => ({ ...e })); }

  /** Recent outcomes for the structured read on GET /mobile/devices (§3.6), newest first. */
  outcomes(): Array<{ watchId: string; topicId: number; outcome?: PairingOutcome; state: WatchState; text?: string; decidedAt?: string; sentAt?: string }> {
    return [...this.entries.values()]
      .sort((a, b) => String(b.mintedAt).localeCompare(String(a.mintedAt)))
      .map((e) => ({ watchId: e.id, topicId: e.topicId, outcome: e.outcome, state: e.state, text: e.text, decidedAt: e.decidedAt, sentAt: e.sentAt }));
  }

  // ── Timer ───────────────────────────────────────────────────────────

  /* @self-action-controller: pairing-outcome-notice-retry */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pass(); }, RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // ── The pass ────────────────────────────────────────────────────────

  /** One reconcile pass. Re-entrant calls return immediately. Returns whether anything ran. */
  async pass(): Promise<boolean> {
    if (this.running) return false;
    if (!this.deps.enabled()) return false;
    if (this.openCount() === 0) { this.prune(); return false; }
    this.running = true;
    try {
      this.decideAll();
      await this.sendDue();
      await this.followHandedOff();
      await this.escalateFailed();
      this.prune();
      return true;
    } finally {
      this.running = false;
    }
  }

  private decideAll(): void {
    const watching = [...this.entries.values()].filter((e) => e.state === 'watching');
    if (watching.length === 0) return;
    let devices: WatchedDevice[];
    try { devices = this.deps.listDevices(); } catch (err) {
      // §3.3: unknown is not an outcome — nothing new is decided until the registry reads again.
      if (this.now() - this.lastReadFailureReport >= RETRY_CAP_MS * 2) { this.lastReadFailureReport = this.now(); this.deps.reportDegradation?.('MobilePairing.outcomeNotice', err); }
      return;
    }
    const byWatch = new Map<string, WatchedDevice>();
    for (const d of devices) if (d.outcomeWatchId) byWatch.set(d.outcomeWatchId, d);
    let changed = false;
    const t = this.now();
    const at = new Date(t).toISOString();
    for (const e of watching) {
      const d = byWatch.get(e.id);
      if (d) {
        if (!e.device) { e.device = { name: d.deviceName, fingerprint: d.fingerprint ?? null }; changed = true; }
        if (e.lastSeen?.status !== d.status) { e.lastSeen = { status: d.status, at }; changed = true; }
        if (d.status === 'active' && !e.approvedSeenAt) { e.approvedSeenAt = at; changed = true; }
      }
      const outcome = classify(e, d, this.deps.codeEpoch(), t);
      if (outcome) { this.decide(e, outcome); changed = true; }
    }
    if (changed) this.safePersist();
  }

  private decide(e: OutcomeWatch, outcome: PairingOutcome): void {
    e.outcome = outcome;
    e.text = outcomeLine({
      outcome, deviceName: e.device?.name ?? null, label: e.label, agent: this.deps.agentName(),
      fingerprint: e.device?.fingerprint ?? null,
    });
    e.decidedAt = new Date(this.now()).toISOString();
    e.state = 'due';
    // §7: an outcome first decided long after the link was made (the switch was off, or this
    // machine was down) is never sent late; it goes to the attention item instead.
    if (this.now() - Date.parse(e.mintedAt) > STALE_DECISION_MS) this.fail(e, 'decided too late to post', false);
  }

  private async sendDue(): Promise<void> {
    const t = this.now();
    for (const e of [...this.entries.values()]) {
      if (e.state !== 'due' || !e.text) continue;
      if (e.nextAttemptAt && Date.parse(e.nextAttemptAt) > t) continue;
      if (e.decidedAt && t - Date.parse(e.decidedAt) > SEND_WINDOW_MS) { this.fail(e, e.lastError ?? 'send window passed', false); this.safePersist(); continue; }
      e.state = 'sending';
      e.attempts += 1;
      this.safePersist();
      let r: SendResult;
      try { r = await this.deps.send(e.topicId, e.text, `mobile-pairing-outcome:${e.id}`, e.anchorInboundId ?? null); } catch (err) {
        r = { kind: 'retry', error: err instanceof Error ? err.message : String(err) };
      }
      this.apply(e, r);
      this.safePersist();
    }
  }

  private apply(e: OutcomeWatch, r: SendResult): void {
    switch (r.kind) {
      case 'sent': this.markSent(e); return;
      case 'quiet':
        // An unanchored line was meant for the quiet feed; an anchored one landing there was seen by nobody.
        if (e.anchorInboundId) this.fail(e, 'filed in the quiet feed', false); else this.markSent(e);
        return;
      case 'handed-off':
        e.state = 'handed-off'; e.operationId = r.operationId; e.attempts = 0;
        e.nextAttemptAt = new Date(this.now() + RETRY_BASE_MS).toISOString();
        return;
      case 'failed': this.fail(e, r.error, false); return;
      case 'retry': {
        e.lastError = r.error;
        const next = this.now() + sendRetryDelayMs(e.attempts);
        if (e.decidedAt && next - Date.parse(e.decidedAt) > SEND_WINDOW_MS) this.fail(e, r.error, false);
        else { e.state = 'due'; e.nextAttemptAt = new Date(next).toISOString(); }
      }
    }
  }

  /** §3.4: an operation the outbox owns is followed by its outcome, up to the outbox's own deadline. */
  private async followHandedOff(): Promise<void> {
    for (const e of [...this.entries.values()]) {
      if (e.state !== 'handed-off' || !e.operationId) continue;
      if (e.nextAttemptAt && Date.parse(e.nextAttemptAt) > this.now()) continue;
      let r: OperationResult = 'unknown';
      try { r = await this.deps.checkOperation(e.operationId); } catch (err) { this.deps.reportDegradation?.('MobilePairing.outcomeNotice', err); }
      if (r === 'delivered') this.markSent(e);
      else if (r === 'quiet') { if (e.anchorInboundId) this.fail(e, 'filed in the quiet feed', false); else this.markSent(e); }
      else if (r === 'failed') this.fail(e, 'the outbox could not deliver it', false);
      else if (e.decidedAt && this.now() - Date.parse(e.decidedAt) > OUTBOX_DEADLINE_MS) this.fail(e, 'the outbox did not confirm it in time', true);
      else {
        // Back off like retries: the read may ask the executing machine (up to 4 s).
        e.attempts += 1;
        e.nextAttemptAt = new Date(this.now() + sendRetryDelayMs(e.attempts)).toISOString();
      }
      this.safePersist();
    }
  }

  private markSent(e: OutcomeWatch): void {
    e.state = 'sent'; e.sentAt = new Date(this.now()).toISOString(); e.endedAt = e.sentAt; delete e.nextAttemptAt;
  }

  private fail(e: OutcomeWatch, error: string, uncertain: boolean): void {
    e.state = 'failed'; e.lastError = error; e.endedAt = new Date(this.now()).toISOString(); e.escalated = false;
    if (uncertain) e.uncertain = true;
    this.deps.reportDegradation?.('MobilePairing.outcomeNotice', new Error(`pairing outcome line not posted in ${topicRef(e.topicId)}: ${error}`));
  }

  /** §3.4 close the loop: one attention item per topic listing every outcome that could not be posted. */
  private async escalateFailed(): Promise<void> {
    const pending = new Map<number, OutcomeWatch[]>();
    for (const e of this.entries.values()) if (e.state === 'failed' && !e.escalated) pending.set(e.topicId, [...(pending.get(e.topicId) ?? []), e]);
    for (const [topicId, owed] of pending) {
      const brake = this.escalateBackoff.get(topicId);
      if (brake && (brake.nextAt > this.now() || brake.attempts >= MAX_ESCALATION_ATTEMPTS)) continue;
      const all = [...this.entries.values()].filter((e) => e.topicId === topicId && e.state === 'failed' && e.text);
      const lines = all.map((e) => `${e.text} ${e.uncertain ? 'I may not have been able to post that in this conversation.' : 'I could not post that in this conversation.'}`);
      let ok = false;
      try { ok = await this.deps.escalate(topicId, lines); } catch (err) { this.deps.reportDegradation?.('MobilePairing.outcomeNotice', err); }
      if (ok) { for (const e of owed) e.escalated = true; this.escalateBackoff.delete(topicId); this.safePersist(); }
      else {
        const attempts = (brake?.attempts ?? 0) + 1;
        this.escalateBackoff.set(topicId, { attempts, nextAt: this.now() + escalationRetryDelayMs(attempts) });
        if (attempts >= MAX_ESCALATION_ATTEMPTS) {
          // Give up for this process: the outcome stays readable in pairingOutcomes, and this is reported once.
          this.deps.reportDegradation?.('MobilePairing.outcomeNotice', new Error(`attention item for ${topicRef(topicId)} could not be recorded after ${attempts} attempts`));
        }
      }
    }
  }

  private prune(): void {
    const t = this.now();
    let changed = false;
    for (const [id, e] of this.entries) {
      if ((e.state === 'sent' || (e.state === 'failed' && e.escalated)) && e.endedAt && t - Date.parse(e.endedAt) > TERMINAL_KEEP_MS) {
        this.entries.delete(id); changed = true;
      }
    }
    if (changed) this.safePersist();
  }
}

/** The §3.3 table. Returns null to keep watching. Pure. */
export function classify(e: OutcomeWatch, d: WatchedDevice | undefined, currentEpoch: string, now: number): PairingOutcome | null {
  if (e.refusedAt) return 'ended';
  if (d) {
    switch (d.status) {
      case 'active': return 'paired';
      case 'revoked': return d.approvedAt || e.approvedSeenAt ? 'paired' : 'ended';
      case 'declined': return (d.wrongCodes?.length ?? 0) >= MAX_WRONG_CODES ? 'declined-wrong-codes' : 'declined';
      case 'expired': {
        const exp = d.expiresAt ? Date.parse(d.expiresAt) : NaN;
        const deadline = d.pendingDeadline ? Date.parse(d.pendingDeadline) : NaN;
        // Boot and lease-loss expiry overwrite expiresAt with "now", earlier than the deadline.
        if (Number.isFinite(exp) && Number.isFinite(deadline) && exp < deadline - 1_000) return 'interrupted';
        return 'expired';
      }
      case 'pending': return null;
      default: return 'unknown';
    }
  }
  // No device row now.
  if (e.approvedSeenAt) return 'paired';
  if (e.device || e.lastSeen || e.takenAt) return 'ended';
  if (e.codeEpoch !== currentEpoch) return 'link-void';
  if (Date.parse(e.codeExpiresAt) <= now) return 'link-expired';
  return null;
}
