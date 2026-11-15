/**
 * Mobile push (docs/specs/mobile-push.md): notify paired phones when the Attention hub posts, and
 * when the agent replies in a native app conversation (mobile-native-conversations §4.7, no
 * Telegram needed). iPhones go through Apple's push service with the operator's APNs key; Android
 * phones go through Firebase Cloud Messaging with the operator's Firebase service-account key
 * (docs/specs/mobile-android-app.md §2.3). Direct from this agent; no relay.
 *
 * Bounds are durable and per device (`.instar/state/mobile-push-state.json`): a 2-minute fold,
 * hourly after 40 sends in any rolling 24 h, an URGENT bypass of the hourly wait (10 more per
 * 24 h), and a persisted APNs 429 backoff that wins over both. Nothing is dropped, only folded.
 * The payload never carries item text; the phone fetches the title itself.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';
import type { DeviceRecord, DeviceRegistry } from './MobileDeviceKeys.js';

export const FOLD_MS = 2 * 60_000;
export const HOURLY_MS = 60 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;
export const THRESHOLD_24H = 40;
export const URGENT_EXTRA_24H = 10;
export const BACKOFF_MS = 10 * 60_000;
export const DEDUPE_MS = 10 * 60_000;
const JWT_TTL_MS = 50 * 60_000;
const PAUSE_RECHECK_MS = 30 * 60_000;
const BUNDLE_ID = 'io.sagemindai.instar';
/** FCM (mobile-android-app §2.3). */
export const FCM_DEADLINE_MS = 30_000;
export const FCM_MISMATCH_BACKOFF_MS = DAY_MS;
export const FCM_BACKOFF_CAP_MS = HOURLY_MS;
export const FCM_TRIAL_BASE_MS = 30 * 60_000;
export const FCM_MAX_TRIALS = 6;
const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_ACCESS_TTL_MS = 50 * 60_000;
const FCM_MAX_BODY = 64 * 1024;

export interface PushTrigger {
  /** `reply`: an agent reply appended to a native app conversation (mobile-native-conversations §4.7). */
  kind: 'item' | 'notice' | 'reply';
  itemId?: string;
  /** For `reply`: the app conversation's UUID, so the phone can open it. Never the reply's text. */
  conversationKey?: string;
  /** For `reply`: the reply's message id, so the phone can ask for its preview (chat-media §4.11). */
  messageId?: string;
  /**
   * For `notice`: what is waiting, so the alert says it instead of "Something needs you" (operator
   * 2026-11-09: the notification detail "is terrible"). Fixed wording per subject, never caller text.
   */
  subject?: PushSubject;
  dedupeKey: string;
  priority?: string;
  sourceMachine: string;
}

/** A notice the alert names. The device's own (caller-chosen) name is never put in an alert. */
export type PushSubject = 'browser-approval' | 'phone-approval';
const SUBJECT_TEXT: Record<PushSubject, string> = {
  'browser-approval': 'A new browser wants to use your conversations. Tap to approve with Face ID.',
  'phone-approval': 'A new phone wants to pair. Tap to approve with Face ID.',
};
/** Android text never says "Face ID" (mobile-android-app §2.3 Message). */
const FCM_SUBJECT_TEXT: Record<PushSubject, string> = {
  'browser-approval': 'A new browser wants to use your conversations. Tap to approve.',
  'phone-approval': 'A new phone wants to pair. Tap to approve.',
};
export type PushProvider = 'apns' | 'fcm';

export interface ApnsCredentials { keyPem: string; keyId: string; teamId: string }
export interface ApnsAnswer { status: number; reason?: string }
export type ApnsTransport = (env: 'sandbox' | 'production', token: string, headers: Record<string, string>, body: string) => Promise<ApnsAnswer>;

/** A parsed Firebase service-account key (vault `fcm_service_account_json`). */
export interface FcmCredentials { projectId: string; clientEmail: string; privateKey: string; hash: string }
/**
 * The FCM v1 answer, read from the structured error only: `errorCode` is the `FcmError.errorCode`
 * enum, `tokenFieldViolation` is a `BadRequest` field violation on exactly `message.token`.
 * `malformed` = a non-200 whose body was missing, too large or not JSON (never read as a verdict).
 */
export interface FcmAnswer { status: number; errorCode?: string; tokenFieldViolation: boolean; retryAfterSec?: number; malformed?: boolean }
export type FcmTransport = (projectId: string, accessToken: string, body: string) => Promise<FcmAnswer>;
/** The OAuth token exchange answer. A throw = a network error or timeout. */
export interface FcmOAuthAnswer { status: number; accessToken?: string; error?: string }
export type FcmOAuthExchange = (assertion: string) => Promise<FcmOAuthAnswer>;

interface DeviceState {
  sendLog: number[];
  urgentLog: number[];
  lastSendAt: number | null;
  pending: { count: number; hasUrgent: boolean } | null;
  dueAt: number | null;
  backoffUntil: number | null;
  lastSend: { at: string; outcome: string } | null;
}
interface FcmPause { reason: string; credHash: string; at: number; checkedAt: number; refusedTrials: number; nextTrialAt: number | null }
interface PushState {
  devices: Record<string, DeviceState>;
  dedupe: Record<string, number>;
  /** The APNs pause, unchanged. */
  paused: { reason: string; credHash: string; at: number; checkedAt: number } | null;
  /** The FCM pause, kept apart so an FCM problem (or a revert) never pauses iPhones. */
  pausedFcm: FcmPause | null;
  /** The last FCM credential hash seen, so a key change clears `sender-id-mismatch` backoffs. */
  fcmKeyHash: string | null;
  fanout: { sent: number; received: number; deduped: number; refused: number };
}

export interface MobilePushDeps {
  stateDir: string;
  registry: DeviceRegistry;
  agentId: string;
  agentName: string;
  machineId: string;
  enabled: () => boolean;
  credentials: () => ApnsCredentials | null;
  transport?: ApnsTransport;
  /** The raw vault entry `fcm_service_account_json` (JSON text or an object); absent ⇒ no FCM key. */
  fcmKey?: () => unknown;
  fcmTransport?: FcmTransport;
  fcmOAuth?: FcmOAuthExchange;
  /** The overall per-device FCM deadline (tests shorten it). */
  fcmDeadlineMs?: number;
  /**
   * May this phone answer an approval notice (mobile-android-app §2.3): active owner phone with a
   * presence key. Read for FCM devices only; absent ⇒ no FCM device gets approval notices.
   */
  canApprove?: (deviceId: string) => boolean;
  fanOut?: (t: PushTrigger) => void;
  reportDegradation?: (what: string, err: unknown) => void;
  now?: () => number;
  /**
   * People and roles §3.4: may this phone hear about a reply in this conversation? A phone that may
   * not use the conversation gets no push for it at all (not even "New reply" with its id).
   * Absent ⇒ every phone, as before.
   */
  mayNotify?: (deviceId: string, conversationKey: string, messageId?: string) => boolean;
  /** Whether a phone gets anything but reply pushes. A team phone does not (team-roles-and-access §3.7). */
  receivesNotices?: (deviceId: string) => boolean;
  /** Is this phone's person still here? A held aggregate is dropped if not. */
  phoneStillCounts?: (deviceId: string) => boolean;
  /**
   * Unread (mobile-unread-messages §3.6): the receiving phone's unread total over app conversations,
   * carried as `aps.badge` on a reply push. Null (or absent) ⇒ no badge; the push still sends.
   */
  badgeFor?: (deviceId: string, conversationKey: string, messageId: string | undefined) => number | null;
}

const emptyDevice = (): DeviceState => ({ sendLog: [], urgentLog: [], lastSendAt: null, pending: null, dueAt: null, backoffUntil: null, lastSend: null });

export class MobilePushService {
  private readonly file: string;
  private readonly now: () => number;
  private state: PushState | null = null;
  private stateError = false;
  private jwt: { credHash: string; token: string; at: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly transport: ApnsTransport;
  private readonly fcmTransport: FcmTransport;
  private readonly fcmOAuth: FcmOAuthExchange;
  /** In memory only: losing it on a restart only delays a trial (`nextTrialAt` is persisted). */
  private fcmTrialArmed = false;
  private fcmAccess: { hash: string; token: string; at: number } | null = null;
  private readonly fcmExchanges = new Map<string, Promise<{ kind: 'ok'; token: string } | { kind: 'refused'; reason: string } | { kind: 'failed' }>>();
  private fcmParsed: { raw: string; cred: FcmCredentials | null } | null = null;
  private fcmUnreadableReported = false;
  private fcmMismatchReported = false;
  private readonly busy: Record<PushProvider, boolean> = { apns: false, fcm: false };

  constructor(private readonly deps: MobilePushDeps) {
    this.file = path.join(deps.stateDir, 'state', 'mobile-push-state.json');
    this.now = deps.now ?? Date.now;
    this.transport = deps.transport ?? createHttp2Transport();
    this.fcmTransport = deps.fcmTransport ?? createFcmTransport();
    this.fcmOAuth = deps.fcmOAuth ?? createFcmOAuthExchange();
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    // @silent-fallback-ok — a failed tick is reported through DegradationReporter
    this.timer = setInterval(() => { void this.tick().catch((err) => this.deps.reportDegradation?.('MobilePush.tick', err)); }, intervalMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // ── State ──────────────────────────────────────────────────────────────────────
  private load(): PushState | null {
    if (this.state) return this.state;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PushState>;
      this.state = {
        devices: raw.devices ?? {}, dedupe: raw.dedupe ?? {}, paused: raw.paused ?? null,
        pausedFcm: readFcmPause(raw.pausedFcm), fcmKeyHash: typeof raw.fcmKeyHash === 'string' ? raw.fcmKeyHash : null,
        fanout: raw.fanout ?? { sent: 0, received: 0, deduped: 0, refused: 0 },
      };
    } catch (err) { // @silent-fallback-ok — absent = empty state; unreadable is reported and sends nothing
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = { devices: {}, dedupe: {}, paused: null, pausedFcm: null, fcmKeyHash: null, fanout: { sent: 0, received: 0, deduped: 0, refused: 0 } };
      } else {
        // Unknown allowance: send nothing and say so once (spec 3b).
        if (!this.stateError) this.deps.reportDegradation?.('MobilePush.state', err);
        this.stateError = true;
        return null;
      }
    }
    return this.state;
  }
  private save(): void {
    if (!this.state) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
  }
  private dev(st: PushState, id: string): DeviceState {
    return (st.devices[id] ??= emptyDevice());
  }

  // ── Triggers ───────────────────────────────────────────────────────────────────
  /** A hub post on this machine: notify own devices and fan out to peers. */
  onHubPost(t: Omit<PushTrigger, 'sourceMachine'>): void {
    const trig: PushTrigger = { ...t, sourceMachine: this.deps.machineId };
    if (!this.deps.enabled()) return;
    // Nothing here may throw into the hub post, and no rejection may reach the process handler.
    try {
      const st = this.load();
      if (st && this.deps.fanOut) { st.fanout.sent++; this.deps.fanOut(trig); }
    } catch (err) { this.deps.reportDegradation?.('MobilePush.fanOut', err); }
    void this.receive(trig, false).catch((err) => this.deps.reportDegradation?.('MobilePush.receive', err));
  }

  /**
   * A trigger only phones on THIS machine can act on, so it is not fanned out (mobile-pairing-approve
   * §6: a waiting phone is held here, and only an owner phone paired here can approve it).
   */
  notifyHere(t: Omit<PushTrigger, 'sourceMachine'>): void {
    if (!this.deps.enabled()) return;
    void this.receive({ ...t, sourceMachine: this.deps.machineId }, false).catch((err) => this.deps.reportDegradation?.('MobilePush.receive', err));
  }

  /**
   * An agent reply appended to a native app conversation (mobile-native-conversations §4.7): one
   * push per reply, through the same budgets, folding and dedupe as a hub post, fanned out so a
   * phone paired on another machine hears it too. Needs no Telegram.
   */
  onAppReply(conversationKey: string, messageId: string): void {
    this.onHubPost({ kind: 'reply', conversationKey, messageId, dedupeKey: `app-reply:${messageId}` });
  }

  /** A trigger from this machine or a peer. Returns 'deduped' or 'accepted'. */
  async receive(t: PushTrigger, fromPeer: boolean): Promise<'deduped' | 'accepted' | 'off'> {
    if (!this.deps.enabled()) return 'off';
    const st = this.load();
    if (!st) return 'off';
    const t0 = this.now();
    for (const [k, at] of Object.entries(st.dedupe)) if (t0 - at > DEDUPE_MS) delete st.dedupe[k];
    if (fromPeer) st.fanout.received++;
    if (st.dedupe[t.dedupeKey] !== undefined) { st.fanout.deduped++; this.save(); return 'deduped'; }
    st.dedupe[t.dedupeKey] = t0;
    this.save();
    const urgent = (t.priority ?? '').toUpperCase() === 'URGENT';
    const payload: PushPayloadInput = { kind: t.kind, itemId: t.kind === 'item' ? t.itemId : undefined, conversationKey: t.kind === 'reply' ? t.conversationKey : undefined, messageId: t.kind === 'reply' ? t.messageId : undefined, ...(t.kind === 'notice' && t.subject ? { subject: t.subject } : {}), machine: t.sourceMachine, count: 1 };
    const apns: DeviceRecord[] = [];
    const fcm: DeviceRecord[] = [];
    for (const d of this.pushDevices()) {
      if (t.kind === 'reply' && t.conversationKey && this.deps.mayNotify) {
        let may = false;
        try { may = this.deps.mayNotify(d.id, t.conversationKey, t.messageId); } catch { may = false; } // @silent-fallback-ok — fail closed: an unanswerable check sends nothing to that phone
        if (!may) continue;
      }
      if (t.kind !== 'reply' && this.deps.receivesNotices && !this.deps.receivesNotices(d.id)) continue;
      if ((d.pushProvider ?? 'apns') === 'fcm') {
        // Approval notices go only to an Android phone that can approve (mobile-android-app §2.3).
        if (t.kind === 'notice' && t.subject && SUBJECT_TEXT[t.subject]) {
          let can = false;
          try { can = !!this.deps.canApprove?.(d.id); } catch { can = false; } // @silent-fallback-ok — fail closed: a phone that may not approve is not asked to
          if (!can) continue;
        }
        fcm.push(d);
      } else apns.push(d);
    }
    // iPhones never wait for Android: the two lists go side by side, each one device after another.
    const apnsPass = async () => {
      for (const d of apns) {
        const ds = this.dev(st, d.id);
        prune(ds, t0);
        if (!ds.pending && this.dueFor(ds, urgent) <= t0) {
          await this.send(d.id, payload, urgent && this.throttled(ds));
        } else {
          ds.pending = { count: (ds.pending?.count ?? 0) + 1, hasUrgent: (ds.pending?.hasUrgent ?? false) || urgent };
          ds.dueAt = this.dueFor(ds, ds.pending.hasUrgent);
          this.save();
        }
      }
    };
    const fcmPass = async () => {
      if (!fcm.length) return;
      // A key change is noticed before any backoff is read, so a fixed key reaches mismatched phones now.
      const cred = this.fcmCredentials();
      if (cred) this.noteFcmKey(st, cred.hash);
      for (const d of fcm) {
        // Re-read at this device's turn: an earlier device's await may have let time and state move.
        const ds = this.dev(st, d.id);
        const now = this.now();
        prune(ds, now);
        if (!ds.pending && this.dueFor(ds, urgent) <= now) {
          const out = await this.sendFcm(d.id, payload, urgent && this.throttled(ds));
          if (out.keep) this.mergeFold(ds, { count: 1, hasUrgent: urgent });
        } else {
          this.mergeFold(ds, { count: 1, hasUrgent: urgent });
        }
      }
    };
    await Promise.all([apnsPass(), fcmPass()]);
    return 'accepted';
  }

  /** Keep a fold after an await: add to whatever arrived meanwhile, OR the URGENT mark, recompute the due time. */
  private mergeFold(ds: DeviceState, held: { count: number; hasUrgent: boolean }): void {
    ds.pending = { count: (ds.pending?.count ?? 0) + held.count, hasUrgent: (ds.pending?.hasUrgent ?? false) || held.hasUrgent };
    ds.dueAt = this.dueFor(ds, ds.pending.hasUrgent);
    this.save();
  }

  noteRefused(): void { const st = this.load(); if (st) { st.fanout.refused++; this.save(); } }

  /** Send due aggregates. */
  async tick(): Promise<void> {
    const st = this.load();
    if (!st) return;
    await this.maybeUnpause(st);
    this.fcmPauseTick(st);
    const t0 = this.now();
    const apnsIds: string[] = [];
    const fcmIds: string[] = [];
    for (const [id, ds] of Object.entries(st.devices)) {
      if (!ds.pending || ds.dueAt === null || ds.dueAt > t0) continue;
      ((this.deps.registry.get(id)?.pushProvider ?? 'apns') === 'fcm' ? fcmIds : apnsIds).push(id);
    }
    // One guard per provider: an unfinished FCM pass never holds back an APNs fold, and the reverse.
    const passes: Promise<void>[] = [];
    if (apnsIds.length && !this.busy.apns) {
      this.busy.apns = true;
      passes.push(this.apnsTick(st, apnsIds, t0).finally(() => { this.busy.apns = false; }));
    }
    if (fcmIds.length && !this.busy.fcm) {
      this.busy.fcm = true;
      passes.push(this.fcmTick(st, fcmIds).finally(() => { this.busy.fcm = false; }));
    }
    await Promise.all(passes);
  }

  private async apnsTick(st: PushState, ids: string[], t0: number): Promise<void> {
    for (const id of ids) {
      const ds = st.devices[id];
      if (!ds || !ds.pending || ds.dueAt === null || ds.dueAt > t0) continue;
      if (this.deps.phoneStillCounts && !this.deps.phoneStillCounts(id)) { ds.pending = null; ds.dueAt = null; this.save(); continue; }
      const held = ds.pending;
      const dueAt = ds.dueAt;
      const urgentBypass = held.hasUrgent && this.throttled(ds);
      ds.pending = null; ds.dueAt = null;
      this.save();
      const out = await this.send(id, { kind: 'aggregate', count: held.count }, urgentBypass);
      // Paused or no key: keep the fold so it goes out once sending works again.
      if (out === 'paused' || out === 'no-key') { ds.pending = held; ds.dueAt = dueAt; this.save(); }
    }
  }

  private async fcmTick(st: PushState, ids: string[]): Promise<void> {
    const cred = this.fcmCredentials();
    if (cred) this.noteFcmKey(st, cred.hash);
    for (const id of ids) {
      const ds = st.devices[id];
      const now = this.now();
      if (!ds || !ds.pending || ds.dueAt === null || ds.dueAt > now) continue;
      if (this.deps.phoneStillCounts && !this.deps.phoneStillCounts(id)) { ds.pending = null; ds.dueAt = null; this.save(); continue; }
      // Paused (no trial armed) or keyless: leave the fold in place, no send, no write.
      if ((st.pausedFcm && !this.fcmTrialArmed) || !this.fcmCredentials()) continue;
      prune(ds, now);
      const held = ds.pending;
      if (this.dueFor(ds, held.hasUrgent) > now) { ds.dueAt = this.dueFor(ds, held.hasUrgent); this.save(); continue; }
      const urgentBypass = held.hasUrgent && this.throttled(ds);
      ds.pending = null; ds.dueAt = null;
      const out = await this.sendFcm(id, { kind: 'aggregate', count: held.count }, urgentBypass);
      if (out.keep) this.mergeFold(ds, held);
      else if (out.label === 'skipped' || out.label === 'state-unreadable') this.save();
    }
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────────
  private throttled(ds: DeviceState): boolean { return ds.sendLog.length >= THRESHOLD_24H; }

  /** The earliest time this device may be sent to (spec 2.4). */
  private dueFor(ds: DeviceState, urgent: boolean): number {
    const last = ds.lastSendAt ?? -Infinity;
    let due = last + FOLD_MS;
    const urgentOk = urgent && ds.urgentLog.length < URGENT_EXTRA_24H;
    if (this.throttled(ds) && !urgentOk) due = Math.max(due, last + HOURLY_MS);
    if (ds.backoffUntil) due = Math.max(due, ds.backoffUntil);
    return due;
  }

  private pushDevices(): DeviceRecord[] {
    return this.deps.registry.list().filter((d) => d.status === 'active' && !!d.pushToken);
  }

  // ── Sending ────────────────────────────────────────────────────────────────────
  private async send(deviceId: string, p: PushPayloadInput, urgentBypass: boolean): Promise<string> {
    const st = this.load();
    if (!st) return 'state-unreadable';
    const ds = this.dev(st, deviceId);
    const d = this.deps.registry.get(deviceId);
    // Re-check at send time, including a fold firing later (spec 2.4).
    if (!this.deps.enabled() || !d || d.status !== 'active' || !d.pushToken || !d.pushEnvironment) return 'skipped';
    if (st.paused) return 'paused';
    const cred = this.deps.credentials();
    if (!cred) { ds.lastSend = { at: new Date(this.now()).toISOString(), outcome: 'no-key' }; this.save(); return 'no-key'; }
    const version = d.pushVersion ?? 0;
    // Reserve before the request goes out: failed and uncertain sends count.
    const t0 = this.now();
    ds.sendLog.push(t0); ds.lastSendAt = t0;
    if (urgentBypass) ds.urgentLog.push(t0);
    this.save();
    let badge: number | null = null;
    if (p.kind === 'reply' && p.conversationKey && this.deps.badgeFor) {
      try { badge = this.deps.badgeFor(deviceId, p.conversationKey, p.messageId); } catch { badge = null; } // @silent-fallback-ok — a badge that cannot be computed is left out; the push still sends
    }
    const body = JSON.stringify(buildPayload(this.deps.agentName, this.deps.agentId, deviceId, badge === null ? p : { ...p, badge }));
    let outcome = await this.attempt(cred, d.pushEnvironment, d.pushToken, body, false);
    if (outcome.kind === 'jwt-retry') outcome = await this.attempt(cred, d.pushEnvironment, d.pushToken, body, true);
    switch (outcome.kind) {
      case 'sent': break;
      case 'clear-token': this.deps.registry.clearPushIfVersion(deviceId, version); break;
      case 'backoff': ds.backoffUntil = this.now() + BACKOFF_MS; break;
      case 'pause': case 'jwt-retry':
        st.paused = { reason: outcome.reason, credHash: credHash(cred), at: this.now(), checkedAt: this.now() };
        this.deps.reportDegradation?.('MobilePush.apnsCredentials', new Error(`APNs refused the key: ${outcome.reason}`));
        break;
      default: break;
    }
    const label = outcome.kind === 'sent' ? 'sent' : outcome.kind === 'jwt-retry' ? 'failed' : outcome.kind;
    ds.lastSend = { at: new Date(t0).toISOString(), outcome: label };
    this.save();
    return label;
  }

  private async attempt(cred: ApnsCredentials, env: 'sandbox' | 'production', token: string, body: string, fresh: boolean):
    Promise<{ kind: 'sent' } | { kind: 'clear-token' } | { kind: 'backoff' } | { kind: 'pause'; reason: string } | { kind: 'jwt-retry'; reason: string } | { kind: 'failed' }> {
    let ans: ApnsAnswer;
    try {
      ans = await this.transport(env, token, {
        authorization: `bearer ${this.jwtFor(cred, fresh)}`, 'apns-topic': BUNDLE_ID, 'apns-push-type': 'alert', 'apns-priority': '10',
      }, body);
    } catch { return { kind: 'failed' }; } // @silent-fallback-ok — recorded as the device's lastSend outcome; no retry by design
    if (ans.status === 200) return { kind: 'sent' };
    const reason = ans.reason ?? '';
    if (ans.status === 410 || (ans.status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'))) return { kind: 'clear-token' };
    if (ans.status === 429) return { kind: 'backoff' };
    if (ans.status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')) return fresh ? { kind: 'pause', reason } : { kind: 'jwt-retry', reason };
    if (ans.status === 403) return { kind: 'pause', reason: reason || 'Forbidden' };
    return { kind: 'failed' };
  }

  private jwtFor(cred: ApnsCredentials, fresh: boolean): string {
    const h = credHash(cred);
    const t = this.now();
    if (!fresh && this.jwt && this.jwt.credHash === h && t - this.jwt.at < JWT_TTL_MS) return this.jwt.token;
    const token = signApnsJwt(cred, Math.floor(t / 1000));
    this.jwt = { credHash: h, token, at: t };
    return token;
  }

  private async maybeUnpause(st: PushState): Promise<void> {
    if (!st.paused || this.now() - st.paused.checkedAt < PAUSE_RECHECK_MS) return;
    st.paused.checkedAt = this.now();
    const cred = this.deps.credentials();
    if (cred && credHash(cred) !== st.paused.credHash) st.paused = null;
    this.save();
  }

  status(): Record<string, unknown> {
    const st = this.load();
    const t0 = this.now();
    return {
      enabled: this.deps.enabled(),
      keyConfigured: !!this.deps.credentials(),
      pausedReason: st?.paused?.reason ?? null,
      fcmConfigured: !!this.fcmCredentials(),
      pausedReasons: { apns: st?.paused?.reason ?? null, fcm: st?.pausedFcm?.reason ?? null },
      ...(st?.pausedFcm ? { fcmTrials: { refused: st.pausedFcm.refusedTrials, nextAt: st.pausedFcm.nextTrialAt === null ? null : new Date(st.pausedFcm.nextTrialAt).toISOString() } } : {}),
      stateReadable: !!st,
      devices: this.deps.registry.list().filter((d) => d.status === 'active' && d.pushToken).map((d) => {
        const ds = st?.devices[d.id] ?? emptyDevice();
        prune(ds, t0);
        const provider = d.pushProvider ?? 'apns';
        return {
          id: d.id, deviceName: d.deviceName, provider, environment: provider === 'fcm' ? null : d.pushEnvironment, sent24h: ds.sendLog.length, throttled: this.throttled(ds),
          backoffUntil: ds.backoffUntil ? new Date(ds.backoffUntil).toISOString() : null, pending: ds.pending?.count ?? 0, lastSend: ds.lastSend,
        };
      }),
      fanout: st?.fanout ?? null,
    };
  }

  /**
   * The register answer's `ready` (mobile-android-app §2.3): push switched on, this machine holds
   * that provider's key, and that provider is not paused. A reading, not a promise.
   */
  readyFor(provider: PushProvider): boolean {
    if (!this.deps.enabled()) return false;
    const st = this.load();
    if (!st) return false;
    if (provider === 'fcm') return !!this.fcmCredentials() && !st.pausedFcm;
    return !!this.deps.credentials() && !st.paused;
  }

  // ── FCM (mobile-android-app §2.3) ───────────────────────────────────────────────
  /** Parse the vault entry; an entry present but unusable is `no-key` with one report. */
  fcmCredentials(): FcmCredentials | null {
    let raw: unknown;
    try { raw = this.deps.fcmKey?.(); } catch { raw = undefined; } // @silent-fallback-ok — an unreadable vault reads as no key; status shows fcmConfigured false
    if (raw === undefined || raw === null || raw === '') return null;
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (this.fcmParsed && this.fcmParsed.raw === text) return this.fcmParsed.cred;
    const cred = parseFcmServiceAccount(raw);
    this.fcmParsed = { raw: text, cred };
    if (!cred && !this.fcmUnreadableReported) {
      this.fcmUnreadableReported = true;
      this.deps.reportDegradation?.('MobilePush.fcmKey', new Error('The Firebase key in the vault (fcm_service_account_json) is unreadable: it needs project_id, client_email and a PEM private_key.'));
    }
    if (cred) this.fcmUnreadableReported = false;
    return cred;
  }

  /** A key change clears `sender-id-mismatch` backoffs, so a fixed key reaches the phones at once. */
  private noteFcmKey(st: PushState, hash: string): void {
    if (st.fcmKeyHash === hash) return;
    const changed = st.fcmKeyHash !== null;
    st.fcmKeyHash = hash;
    if (changed) this.clearMismatchBackoffs(st);
    this.save();
  }

  private clearMismatchBackoffs(st: PushState): void {
    for (const ds of Object.values(st.devices)) {
      if (ds.lastSend?.outcome === 'sender-id-mismatch' && ds.backoffUntil) ds.backoffUntil = null;
    }
    this.fcmMismatchReported = false;
  }

  /** Every tick: notice a new key (every 30 minutes), and arm one trial once `nextTrialAt` passed. */
  /* @self-action-controller: fcm-pause-trial-retry */
  private fcmPauseTick(st: PushState): void {
    const p = st.pausedFcm;
    if (!p) return;
    const t = this.now();
    if (t - p.checkedAt >= PAUSE_RECHECK_MS) {
      p.checkedAt = t;
      const cred = this.fcmCredentials();
      if (cred && cred.hash !== p.credHash) { st.pausedFcm = null; this.fcmTrialArmed = false; this.noteFcmKey(st, cred.hash); this.save(); return; }
      this.save();
    }
    if (!this.fcmTrialArmed && p.nextTrialAt !== null && t >= p.nextTrialAt) {
      const cred = this.fcmCredentials();
      if (cred && cred.hash === p.credHash) this.fcmTrialArmed = true;
    }
  }

  /**
   * `POST /mobile/push/recheck` (mobile-android-app §2.3): after the agent fixed a cause, re-arm the
   * trials (persisted, so it survives a restart) and clear `sender-id-mismatch` backoffs.
   */
  recheckFcm(): { armed: boolean; reason?: 'not-paused' | 'no-key' | 'state-unreadable' } {
    const st = this.load();
    if (!st) return { armed: false, reason: 'state-unreadable' };
    this.clearMismatchBackoffs(st);
    if (!this.fcmCredentials()) { this.save(); return { armed: false, reason: 'no-key' }; }
    if (!st.pausedFcm) { this.save(); return { armed: false, reason: 'not-paused' }; }
    st.pausedFcm.refusedTrials = 0;
    st.pausedFcm.nextTrialAt = this.now();
    this.save();
    return { armed: true };
  }

  private async sendFcm(deviceId: string, p: PushPayloadInput, urgentBypass: boolean): Promise<{ label: string; keep: boolean }> {
    const st = this.load();
    if (!st) return { label: 'state-unreadable', keep: false };
    const ds = this.dev(st, deviceId);
    const d = this.deps.registry.get(deviceId);
    if (!this.deps.enabled() || !d || d.status !== 'active' || !d.pushToken || (d.pushProvider ?? 'apns') !== 'fcm') return { label: 'skipped', keep: false };
    if (st.pausedFcm && !this.fcmTrialArmed) return { label: 'paused', keep: true };
    const cred = this.fcmCredentials();
    if (!cred) {
      if (ds.lastSend?.outcome !== 'no-key') { ds.lastSend = { at: new Date(this.now()).toISOString(), outcome: 'no-key' }; this.save(); }
      return { label: 'no-key', keep: true };
    }
    this.noteFcmKey(st, cred.hash);
    // One trial covers all devices: consumed (and nextTrialAt nulled) before the request goes out.
    const trial = !!st.pausedFcm;
    if (trial) { this.fcmTrialArmed = false; st.pausedFcm!.nextTrialAt = null; }
    const version = d.pushVersion ?? 0;
    const token = d.pushToken;
    // Reserve synchronously, before the first await (the token exchange included).
    const t0 = this.now();
    ds.sendLog.push(t0); ds.lastSendAt = t0;
    if (urgentBypass) ds.urgentLog.push(t0);
    this.save();
    let badge: number | null = null;
    if (p.kind === 'reply' && p.conversationKey && this.deps.badgeFor) {
      try { badge = this.deps.badgeFor(deviceId, p.conversationKey, p.messageId); } catch { badge = null; } // @silent-fallback-ok — a badge that cannot be computed is left out; the push still sends
    }
    const parts = payloadParts(this.deps.agentId, deviceId, badge === null ? p : { ...p, badge });
    const body = JSON.stringify(buildFcmMessage(token, this.deps.agentName, parts.instar, fcmBodyText(p), parts.badge ?? null));
    const outcome = await withDeadline(this.fcmAttempt(cred, body), this.deps.fcmDeadlineMs ?? FCM_DEADLINE_MS, { kind: 'failed' as const });
    let label: string;
    let keep = false;
    let clearsTrial = false;
    switch (outcome.kind) {
      case 'sent': label = 'sent'; clearsTrial = true; break;
      case 'clear-token': this.deps.registry.clearPushIfVersion(deviceId, version); label = 'clear-token'; clearsTrial = true; break;
      case 'backoff': {
        const wait = Math.min(Math.max((outcome.retryAfterSec ?? 0) * 1000, BACKOFF_MS), FCM_BACKOFF_CAP_MS);
        // A 429 is given only after the key, project and permission were accepted; a 503 proves nothing.
        ds.backoffUntil = this.now() + wait; label = 'backoff'; clearsTrial = outcome.status === 429; break;
      }
      case 'mismatch': ds.backoffUntil = this.now() + FCM_MISMATCH_BACKOFF_MS; label = 'sender-id-mismatch'; break;
      case 'pause': label = 'failed'; break;
      case 'bad-request': label = 'failed'; this.deps.reportDegradation?.('MobilePush.fcmSend', new Error(`Firebase refused the message${outcome.errorCode ? ` (${outcome.errorCode})` : ''}; the token was kept.`)); break;
      default: label = 'failed'; break;
    }
    if (trial) {
      if (clearsTrial) { st.pausedFcm = null; }
      else if (st.pausedFcm) {
        // A refused trial: keep the pause and the fold, count it, no new report.
        const pf = st.pausedFcm;
        pf.refusedTrials += 1;
        // The latest reason is recorded (an enum or our own label, never Google's text).
        pf.reason = outcome.kind === 'pause' ? outcome.reason : outcome.kind === 'backoff' ? 'unavailable' : label;
        pf.nextTrialAt = nextFcmTrialAt(pf.refusedTrials, this.now());
        keep = true;
      }
    } else if (outcome.kind === 'pause') {
      // One pause, one report: a send already in flight when another device paused FCM keeps that pause.
      if (!st.pausedFcm) {
        st.pausedFcm = { reason: outcome.reason, credHash: cred.hash, at: this.now(), checkedAt: this.now(), refusedTrials: 0, nextTrialAt: this.now() + FCM_TRIAL_BASE_MS };
        this.fcmTrialArmed = false;
        this.deps.reportDegradation?.('MobilePush.fcmCredentials', new Error(fcmRecoveryText(outcome.reason)));
      }
      keep = true;
    } else if (clearsTrial && st.pausedFcm && st.pausedFcm.credHash === cred.hash) {
      // A send that was already in flight when the pause was set, and that Google accepted with the
      // same key: the key, project and permission work, so the pause goes now instead of at a trial.
      st.pausedFcm = null;
      this.fcmTrialArmed = false;
    }
    ds.lastSend = { at: new Date(t0).toISOString(), outcome: outcome.kind === 'pause' ? outcome.reason : label };
    if (label === 'sender-id-mismatch' && !trial) this.maybeReportMismatch(st);
    this.save();
    return { label, keep };
  }

  /** Every FCM device here in `sender-id-mismatch` points at the key: one report naming both causes. */
  private maybeReportMismatch(st: PushState): void {
    const fcmDevs = this.pushDevices().filter((d) => (d.pushProvider ?? 'apns') === 'fcm');
    if (!fcmDevs.length || this.fcmMismatchReported) return;
    if (fcmDevs.every((d) => st.devices[d.id]?.lastSend?.outcome === 'sender-id-mismatch')) {
      this.fcmMismatchReported = true;
      this.deps.reportDegradation?.('MobilePush.fcmCredentials', new Error(fcmRecoveryText('sender-id-mismatch')));
    }
  }

  private async fcmAttempt(cred: FcmCredentials, body: string):
    Promise<{ kind: 'sent' } | { kind: 'clear-token' } | { kind: 'backoff'; status: number; retryAfterSec?: number } | { kind: 'mismatch' } | { kind: 'pause'; reason: string } | { kind: 'bad-request'; errorCode?: string } | { kind: 'failed' }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await this.fcmAccessToken(cred, attempt > 0);
      if (tok.kind === 'refused') return { kind: 'pause', reason: tok.reason };
      if (tok.kind === 'failed') return { kind: 'failed' };
      let ans: FcmAnswer;
      try { ans = await this.fcmTransport(cred.projectId, tok.token, body); } catch { return { kind: 'failed' }; } // @silent-fallback-ok — recorded as the device's lastSend outcome; no retry by design
      if (ans.status === 401) {
        // Discard the cached token so other sends do not reuse it; one retry with a fresh one.
        if (this.fcmAccess?.hash === cred.hash) this.fcmAccess = null;
        if (attempt === 0) continue;
        return { kind: 'pause', reason: 'unauthenticated' };
      }
      return classifyFcmAnswer(ans);
    }
    return { kind: 'failed' };
  }

  private fcmAccessToken(cred: FcmCredentials, fresh: boolean): Promise<{ kind: 'ok'; token: string } | { kind: 'refused'; reason: string } | { kind: 'failed' }> {
    const t = this.now();
    if (!fresh && this.fcmAccess && this.fcmAccess.hash === cred.hash && t - this.fcmAccess.at < FCM_ACCESS_TTL_MS) return Promise.resolve({ kind: 'ok', token: this.fcmAccess.token });
    const inFlight = this.fcmExchanges.get(cred.hash);
    if (inFlight) return inFlight;
    const p = (async () => {
      let ans: FcmOAuthAnswer;
      try { ans = await this.fcmOAuth(signFcmJwt(cred, Math.floor(this.now() / 1000))); } catch { return { kind: 'failed' as const }; } // @silent-fallback-ok — a network error or timeout: this send fails, no pause
      if (ans.status === 200 && typeof ans.accessToken === 'string' && ans.accessToken) {
        this.fcmAccess = { hash: cred.hash, token: ans.accessToken, at: this.now() };
        return { kind: 'ok' as const, token: ans.accessToken };
      }
      if ((ans.status === 400 || ans.status === 401) && (ans.error === 'invalid_grant' || ans.error === 'invalid_client')) return { kind: 'refused' as const, reason: ans.error };
      return { kind: 'failed' as const };
    })().finally(() => { this.fcmExchanges.delete(cred.hash); });
    this.fcmExchanges.set(cred.hash, p);
    return p;
  }
}

/**
 * When the next automatic FCM trial runs after `refusedTrials` refused ones (mobile-android-app §2.3):
 * 30 minutes × 2^refused (1, 2, 4, 8, 16 hours after the first), none after 6. A recheck re-arms.
 */
export function nextFcmTrialAt(refusedTrials: number, now: number): number | null {
  return refusedTrials >= FCM_MAX_TRIALS ? null : now + FCM_TRIAL_BASE_MS * 2 ** refusedTrials;
}

function readFcmPause(v: unknown): FcmPause | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.reason !== 'string' || typeof o.credHash !== 'string' || typeof o.at !== 'number' || typeof o.checkedAt !== 'number') return null;
  return {
    reason: o.reason, credHash: o.credHash, at: o.at, checkedAt: o.checkedAt,
    refusedTrials: typeof o.refusedTrials === 'number' && Number.isSafeInteger(o.refusedTrials) && o.refusedTrials >= 0 ? o.refusedTrials : 0,
    nextTrialAt: typeof o.nextTrialAt === 'number' ? o.nextTrialAt : null,
  };
}

/** Read Google's typed answer; never the `message` text (mobile-android-app §2.3 Answers). */
export function classifyFcmAnswer(ans: FcmAnswer):
  { kind: 'sent' } | { kind: 'clear-token' } | { kind: 'backoff'; status: number; retryAfterSec?: number } | { kind: 'mismatch' } | { kind: 'pause'; reason: string } | { kind: 'bad-request'; errorCode?: string } | { kind: 'failed' } {
  if (ans.status === 200) return { kind: 'sent' };
  if (ans.status === 429 || ans.status === 503) return { kind: 'backoff', status: ans.status, ...(ans.retryAfterSec !== undefined ? { retryAfterSec: ans.retryAfterSec } : {}) };
  if (ans.malformed) return ans.status === 400 ? { kind: 'bad-request' } : { kind: 'failed' };
  if (ans.status === 404 && ans.errorCode === 'UNREGISTERED') return { kind: 'clear-token' };
  if (ans.status === 400 && ans.errorCode === 'INVALID_ARGUMENT' && ans.tokenFieldViolation) return { kind: 'clear-token' };
  if (ans.status === 400) return { kind: 'bad-request', ...(ans.errorCode ? { errorCode: ans.errorCode } : {}) };
  if (ans.status === 403 && ans.errorCode === 'SENDER_ID_MISMATCH') return { kind: 'mismatch' };
  if (ans.status === 403) return { kind: 'pause', reason: 'permission-denied' };
  if (ans.status === 404) return { kind: 'pause', reason: 'project-not-found' };
  return { kind: 'failed' };
}

/** The pause report names the agent's own recovery for its reason, never a chore for a person. */
export function fcmRecoveryText(reason: string): string {
  if (reason === 'sender-id-mismatch') return 'Google says these phones belong to a different Firebase project than the key. Recovery: check whether the installed app is a build for another project (a debug build) and whether the vault key is for the Instar Firebase project; fix the one that is wrong, then call POST /mobile/push/recheck.';
  if (reason === 'permission-denied') return 'Google refused the send permission. Recovery: in the Instar Firebase project, turn the Firebase Cloud Messaging API on and give the push service account the Cloud Messaging role, then call POST /mobile/push/recheck; the next trial clears the pause.';
  if (reason === 'project-not-found') return 'The key names a Firebase project that does not exist. Recovery: make a new key in the Instar Firebase project and store it as fcm_service_account_json; the pause clears within 30 minutes.';
  return 'Google refused the Firebase key. Recovery: make a new key for the Instar push service account in the Instar Firebase project with the operator\'s Google browser profile and store it as fcm_service_account_json; the pause clears within 30 minutes.';
}

/** Parse a Firebase service-account key (JSON text or an object); null when any field is unusable. */
export function parseFcmServiceAccount(raw: unknown): FcmCredentials | null {
  let obj: unknown = raw;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
    try { obj = JSON.parse(raw); } catch { return null; } // @silent-fallback-ok — unparseable is no-key; the caller reports it once
  } else if (raw && typeof raw === 'object') {
    text = JSON.stringify(raw);
  } else return null;
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const projectId = o.project_id; const clientEmail = o.client_email; const privateKey = o.private_key;
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) return null;
  if (typeof clientEmail !== 'string' || !/^[^\s@]{1,128}@[^\s@]{1,253}\.[^\s@]{2,63}$/.test(clientEmail)) return null;
  if (typeof privateKey !== 'string') return null;
  try { crypto.createPrivateKey(privateKey); } catch { return null; } // @silent-fallback-ok — a key that does not parse is no-key
  return { projectId, clientEmail, privateKey, hash: crypto.createHash('sha256').update(text).digest('hex') };
}

/** RS256 assertion for Google's OAuth token endpoint (the key file's own token_uri is ignored). */
export function signFcmJwt(c: FcmCredentials, iatSec: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const claims = enc({ iss: c.clientEmail, sub: c.clientEmail, aud: FCM_TOKEN_URL, scope: FCM_SCOPE, iat: iatSec, exp: iatSec + 3600 });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), c.privateKey);
  return `${head}.${claims}.${sig.toString('base64url')}`;
}

function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms);
    timer.unref?.();
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(onTimeout); });
  });
}

function prune(ds: DeviceState, t0: number): void {
  ds.sendLog = ds.sendLog.filter((x) => t0 - x < DAY_MS);
  ds.urgentLog = ds.urgentLog.filter((x) => t0 - x < DAY_MS);
  if (ds.backoffUntil && ds.backoffUntil <= t0) ds.backoffUntil = null;
}

export interface PushPayloadInput { kind: 'item' | 'notice' | 'reply' | 'aggregate'; subject?: PushSubject; itemId?: string; conversationKey?: string; messageId?: string; machine?: string; count: number; /** The app-conversation unread total for this phone (mobile-unread-messages §3.6). */ badge?: number }

export function buildPayload(agentName: string, agentId: string, deviceId: string, p: PushPayloadInput): Record<string, unknown> {
  const body = bodyText(p, SUBJECT_TEXT);
  const { instar, badge: b } = payloadParts(agentId, deviceId, p);
  const badge = b !== undefined ? { badge: b } : {};
  return {
    aps: { alert: { title: agentName, body }, sound: 'default', 'mutable-content': 1, 'thread-id': agentName, ...badge },
    instar,
  };
}

function bodyText(p: PushPayloadInput, subjects: Record<PushSubject, string>): string {
  return p.kind === 'aggregate' ? `${p.count} more ${p.count === 1 ? 'thing needs' : 'things need'} you`
    : p.kind === 'reply' ? 'New reply'
    : p.kind === 'notice' && p.subject && subjects[p.subject] ? subjects[p.subject] : 'Something needs you';
}

/** The generic body text for an Android notification: the APNs text, with no "Face ID". */
export function fcmBodyText(p: PushPayloadInput): string { return bodyText(p, FCM_SUBJECT_TEXT); }

/** The `instar` block and the reply badge, shared by both providers. */
export function payloadParts(agentId: string, deviceId: string, p: PushPayloadInput): { instar: Record<string, unknown>; badge?: number } {
  const instar: Record<string, unknown> = { kind: p.kind, agentId, deviceId, count: p.count };
  // The app opens the waiting approval when this is tapped.
  if (p.kind === 'notice' && p.subject && SUBJECT_TEXT[p.subject]) instar.subject = p.subject;
  if (p.kind === 'item' && p.itemId) { instar.itemId = p.itemId; instar.machine = p.machine; }
  // The conversation to open; never the reply's text (the phone fetches it itself).
  if (p.kind === 'reply' && p.conversationKey) {
    instar.conversationKey = p.conversationKey;
    // Lets the phone fetch the preview from the agent; the text itself never goes through Apple.
    if (p.messageId && /^[a-z0-9._:-]{1,128}$/.test(p.messageId)) { instar.messageId = p.messageId; instar.machine = p.machine; }
  }
  const ok = p.kind === 'reply' && typeof p.badge === 'number' && Number.isSafeInteger(p.badge) && p.badge >= 0;
  return ok ? { instar, badge: p.badge } : { instar };
}

/**
 * The FCM v1 message (mobile-android-app §2.3 Message): data-only, so the app builds the
 * notification after fetching the real text. No ttl, no collapse_key (APNs sets neither). Data
 * values are strings; title and body are placeholders the app replaces.
 */
export function buildFcmMessage(token: string, agentName: string, instar: Record<string, unknown>, body: string, badge: number | null): Record<string, unknown> {
  const data: Record<string, string> = { instar: JSON.stringify(instar), title: agentName, body };
  if (badge !== null && instar.kind === 'reply') data.badge = String(badge);
  return { message: { token, android: { priority: 'HIGH' }, data } };
}

export function credHash(c: ApnsCredentials): string {
  return crypto.createHash('sha256').update(`${c.keyId}\n${c.teamId}\n${c.keyPem}`).digest('hex');
}

export function signApnsJwt(c: ApnsCredentials, iatSec: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'ES256', kid: c.keyId });
  const claims = enc({ iss: c.teamId, iat: iatSec });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: c.keyPem, dsaEncoding: 'ieee-p1363' });
  return `${head}.${claims}.${sig.toString('base64url')}`;
}

/** One lazy HTTP/2 session per environment, closed after 5 idle minutes, at most 20 in flight. */
export function createHttp2Transport(): ApnsTransport {
  const sessions = new Map<string, { s: http2.ClientHttp2Session; idle: ReturnType<typeof setTimeout> | null }>();
  let inFlight = 0;
  const host = (env: string) => (env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');
  const get = (env: string) => {
    const cur = sessions.get(env);
    if (cur && !cur.s.closed && !cur.s.destroyed) return cur;
    const s = http2.connect(host(env));
    const entry = { s, idle: null as ReturnType<typeof setTimeout> | null };
    const drop = () => { if (sessions.get(env) === entry) sessions.delete(env); };
    s.on('goaway', drop); s.on('close', drop); s.on('error', drop);
    s.unref?.();
    sessions.set(env, entry);
    return entry;
  };
  return (env, token, headers, body) => new Promise<ApnsAnswer>((resolve, reject) => {
    if (inFlight >= 20) { reject(new Error('apns-in-flight-cap')); return; }
    const entry = get(env);
    if (entry.idle) { clearTimeout(entry.idle); entry.idle = null; }
    inFlight++;
    const req = entry.s.request({ ':method': 'POST', ':path': `/3/device/${token}`, 'content-type': 'application/json', ...headers });
    let status = 0; let data = ''; let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      inFlight--;
      entry.idle = setTimeout(() => entry.s.close(), 5 * 60_000);
      entry.idle.unref?.();
      fn();
    };
    req.setTimeout(10_000, () => { req.close(http2.constants.NGHTTP2_CANCEL); done(() => reject(new Error('apns-timeout'))); });
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', (c) => { data += c; });
    req.on('end', () => done(() => {
      let reason: string | undefined;
      try { reason = (JSON.parse(data) as { reason?: string }).reason; } catch { /* @silent-fallback-ok — a 200 has no body */ }
      resolve({ status, reason });
    }));
    req.on('error', (e) => done(() => reject(e)));
    req.end(body);
  });
}

/** The OAuth exchange at Google's fixed token URL: 10 seconds, form body, the answer's error code only. */
export function createFcmOAuthExchange(): FcmOAuthExchange {
  return async (assertion) => {
    const r = await fetch(FCM_TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await readBounded(r, FCM_MAX_BODY);
    let j: { access_token?: unknown; error?: unknown } = {};
    try { j = text === null ? {} : JSON.parse(text); } catch { j = {}; } // @silent-fallback-ok — an unreadable answer is neither a token nor a refusal: failed
    return { status: r.status, ...(typeof j.access_token === 'string' ? { accessToken: j.access_token } : {}), ...(typeof j.error === 'string' ? { error: j.error } : {}) };
  };
}

/** FCM v1 send through global fetch: 10 seconds, at most 20 in flight, body read up to 64 KB. */
export function createFcmTransport(): FcmTransport {
  let inFlight = 0;
  return async (projectId, accessToken, body) => {
    if (inFlight >= 20) throw new Error('fcm-in-flight-cap');
    inFlight++;
    try {
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10_000),
      });
      const text = await readBounded(r, FCM_MAX_BODY);
      const ra = r.headers.get('retry-after');
      const retryAfterSec = ra && /^\d{1,9}$/.test(ra.trim()) ? Number(ra.trim()) : undefined;
      return parseFcmError(r.status, text, retryAfterSec);
    } finally { inFlight--; }
  };
}

/** Build an FcmAnswer from a status and a body (null = too large or unreadable). Exported for tests. */
export function parseFcmError(status: number, text: string | null, retryAfterSec?: number): FcmAnswer {
  const base: FcmAnswer = { status, tokenFieldViolation: false, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) };
  if (status === 200) return base;
  if (text === null || !text.trim()) return { ...base, malformed: true };
  let j: unknown;
  try { j = JSON.parse(text); } catch { return { ...base, malformed: true }; } // @silent-fallback-ok — never read as a verdict
  const details = (j as { error?: { details?: unknown } })?.error?.details;
  if (!(j as { error?: unknown })?.error || typeof (j as { error?: unknown }).error !== 'object') return { ...base, malformed: true };
  let errorCode: string | undefined;
  let tokenFieldViolation = false;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (!d || typeof d !== 'object') continue;
      const type = (d as Record<string, unknown>)['@type'];
      if (type === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' && typeof (d as { errorCode?: unknown }).errorCode === 'string') errorCode = (d as { errorCode: string }).errorCode;
      if (type === 'type.googleapis.com/google.rpc.BadRequest' && Array.isArray((d as { fieldViolations?: unknown }).fieldViolations)) {
        for (const v of (d as { fieldViolations: unknown[] }).fieldViolations) if (v && typeof v === 'object' && (v as { field?: unknown }).field === 'message.token') tokenFieldViolation = true;
      }
    }
  }
  return { ...base, ...(errorCode && /^[A-Z_]{1,64}$/.test(errorCode) ? { errorCode } : {}), tokenFieldViolation };
}

async function readBounded(r: Response, max: number): Promise<string | null> {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { void reader.cancel().catch(() => { /* @silent-fallback-ok — an oversized body is failed, never read */ }); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
