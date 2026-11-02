/**
 * AppConversationService — the native app conversation core
 * (docs/specs/mobile-native-conversations.md, increment 1).
 *
 * Holds the conversation store, the registry aliases, the per-machine ownership bindings and the
 * dispatch seam, and implements the parts of §4.1/§4.2/§4.8 that are not HTTP: alias
 * re-derivation at boot, `bind-app`/`unbind-app` on lease changes, boot recovery of interrupted
 * requests, the emergency-stop/pause effects and the reply-side hook point.
 *
 * Ownership (increment 1): the owner is the machine holding the serving lease (single machine:
 * always this one). Pool placement for app conversations, and forwarding a send accepted on a
 * non-owner, are later work: a non-owner answers `503 owner-unavailable` AFTER the message is
 * persisted (§4.8's fallback), so nothing typed is lost.
 */
import type { ConversationRegistry } from './ConversationRegistry.js';
import type { MobileChatRequestStore } from './MobileChatRequests.js';
import { SessionChannelRegistry } from '../messaging/shared/SessionChannelRegistry.js';
import { AppConversationStore, type AppEvent } from './AppConversationStore.js';
import { derivedEventId, isAppConversationKey } from './appConversationText.js';
import type { AppInboundDispatch } from './appInboundDispatch.js';
import { verifyRecordedOrigin, type MachineKeyLookup, type MachineSigner, type OriginVerdict, type VerifiableRecord } from './AppRecordSignatures.js';
import type { MobileDeviceKeyLedger } from './MobileDeviceKeyLedger.js';
import { AppMediaStore, DEFAULT_MAX_STORE_BYTES } from './AppMediaStore.js';
import { MAX_PURGE_BATCH } from './appMediaTypes.js';
import path from 'node:path';

export const STRANDED_REQUEST_AGE_MS = 5 * 60_000;

export interface AppConversationServiceDeps {
  stateDir: string;
  machineId: () => string;
  registry: ConversationRegistry;
  requests: MobileChatRequestStore;
  store?: AppConversationStore;
  holdsLease: () => boolean;
  ownerName: () => string;
  dispatch: () => AppInboundDispatch | null;
  /** Stop / pause the session serving an app conversation (by tmux name). */
  killSession?: (tmuxSession: string) => boolean;
  pauseSession?: (tmuxSession: string) => void;
  /** The emergency-stop side effects shared with the Telegram path (resume queue pause, …). */
  onEmergencyStop?: (alias: number) => void;
  reportDegradation?: (what: string, detail: string) => void;
  now?: () => number;
  /**
   * Signed records (§4.6, increment 2): this machine's identity signer (receipts, redaction
   * attestations, ledger rows), the signing-key history lookup, and the device-key ledger. Any
   * of them absent ⇒ app messages are still stored and delivered, and read `unknown`.
   */
  signer?: MachineSigner | null;
  keyLookup?: MachineKeyLookup | null;
  keyLedger?: MobileDeviceKeyLedger | null;
  /**
   * Media (docs/specs/mobile-native-chat-media.md). The store is built whenever native
   * conversations are on, so a machine with the feature off still keeps and purges what it holds.
   */
  mediaMaxStoreBytes?: () => number | undefined;
  /** One notice per condition (absent ⇒ degradation reports only). */
  raiseAttention?: (item: { conditionKey: string; title: string; body: string }) => void;
  clearAttention?: (conditionKey: string) => void;
}

const MEDIA_SWEEP_MS = 60 * 60_000;
const MEDIA_REFUSAL_SWEEP_GAP_MS = 5 * 60_000;

export class AppConversationService {
  readonly store: AppConversationStore;
  readonly channels: SessionChannelRegistry;
  private lastLease: boolean | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private mediaTimer: ReturnType<typeof setInterval> | null = null;
  readonly media: AppMediaStore;
  private lastRefusalSweep = 0;
  private readonly refusedConditions = new Set<string>();
  /* @self-action-controller: app-media-capacity-notice */
  /** Conditions whose notice is raised: the latch that makes it one notice per episode. */
  private readonly raisedNotices = new Set<string>();
  private readonly now: () => number;
  /** Increment 3 fills this in (push without Telegram); increment 1 records the hook only. */
  pushHook: ((conversationKey: string, messageId: string) => void) | null = null;

  constructor(readonly deps: AppConversationServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.store = deps.store ?? new AppConversationStore({
      stateDir: deps.stateDir, machineId: deps.machineId, now: this.now,
      reportDegradation: (what, detail) => deps.reportDegradation?.(what, detail),
    });
    this.channels = new SessionChannelRegistry({ registryPath: path.join(deps.stateDir, 'state', 'app-session-registry.json') });
    this.media = new AppMediaStore({
      stateDir: deps.stateDir, store: this.store, now: this.now,
      maxStoreBytes: () => deps.mediaMaxStoreBytes?.() ?? DEFAULT_MAX_STORE_BYTES,
      reportDegradation: (what, detail) => deps.reportDegradation?.(what, detail),
      onRefused: (error) => this.onMediaRefused(error),
    });
    // Aliases are derived per machine from the replicated store and rebuildable at any time.
    this.reconcileAliases();
    this.leaseTick();
    try { this.recoverStranded(); } catch (err) { this.report('boot recovery', err); } // @silent-fallback-ok — reported through deps.reportDegradation; the 5 s tick repeats it
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.leaseTick();
      try { this.recoverStranded(); } catch (err) { this.report('recovery', err); } // @silent-fallback-ok — reported through deps.reportDegradation; the next tick repeats it
    }, intervalMs);
    this.timer.unref?.();
    void this.sweepMedia();
    this.mediaTimer = setInterval(() => { void this.sweepMedia(); }, MEDIA_SWEEP_MS);
    this.mediaTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.mediaTimer) clearInterval(this.mediaTimer);
    this.timer = null;
    this.mediaTimer = null;
  }

  /** The hourly media sweep, then the capacity notices (§4.7). Never throws. */
  async sweepMedia(): Promise<void> {
    try {
      await this.media.sweep((id) => this.store.hasMessage(id));
      this.updateMediaNotices();
    } catch (err) { this.report('media sweep', err); }
  }

  /** A capacity refusal: self-heal first; the notice is raised only if it did not clear. */
  private onMediaRefused(error: string): void {
    this.refusedConditions.add(error);
    if (this.now() - this.lastRefusalSweep < MEDIA_REFUSAL_SWEEP_GAP_MS) return;
    this.lastRefusalSweep = this.now();
    void this.sweepMedia();
  }

  /**
   * The capacity notices (§4.7), after a sweep. One notice per condition episode: raised once
   * when a refusal persists past the self-heal sweep, never again while it stays raised, and
   * cleared (re-armed) only when the condition is gone.
   */
  private updateMediaNotices(): void {
    const machine = this.deps.machineId();
    const raiseOnce = (key: string, item: { title: string; body: string }) => {
      if (this.raisedNotices.has(key)) return;
      this.raisedNotices.add(key);
      this.deps.raiseAttention?.({ conditionKey: key, ...item });
    };
    const clear = (key: string) => {
      if (!this.raisedNotices.delete(key)) return;
      this.deps.clearAttention?.(key);
    };
    if (this.refusedConditions.has('media-store-full')) {
      if (this.media.usageOverCapFraction(0.9)) {
        const gib = (n: number) => (n / 1024 ** 3).toFixed(1);
        const h = this.media.health();
        raiseOnce('app-media:store-full', {
          title: 'The app media store is full',
          body: `${gib(this.media.liveBytes())} GiB of ${gib(this.media.maxBytes())} GiB is in use and ${gib(Number(h.deletedBytes))} GiB sits in deleted conversations. New files are refused until space is freed: the app's Storage screen can permanently remove files, or the limit can be raised.`,
        });
      } else {
        this.refusedConditions.delete('media-store-full');
        clear('app-media:store-full');
      }
    }
    if (this.refusedConditions.has('media-disk-floor')) {
      const key = `app-media:disk-floor:${machine}`;
      if (this.media.belowDiskFloor()) {
        raiseOnce(key, { title: `${machine} is too low on disk to store app files`, body: 'New files are refused on this machine until its disk has more free space (5% or 2 GiB, whichever is larger).' });
      } else {
        this.refusedConditions.delete('media-disk-floor');
        clear(key);
      }
    }
  }

  /**
   * Write the purge events for these exact attachment sets (§4.7), at most 500 ids each. Event ids
   * derive from the request, so a resume after a crash merges away. Then apply it here.
   */
  applyPurge(deviceId: string, requestId: string, sets: Readonly<Record<string, string[]>>): { ok: true; purged: number; note: string } {
    let purged = 0;
    for (const [key, ids] of Object.entries(sets)) {
      for (let batch = 0; batch * MAX_PURGE_BATCH < ids.length; batch++) {
        const attachmentIds = ids.slice(batch * MAX_PURGE_BATCH, (batch + 1) * MAX_PURGE_BATCH);
        this.store.append({
          eventId: derivedEventId('pg', deviceId, requestId, key, String(batch)), kind: 'purge',
          conversationKey: key.startsWith('app:') ? key.slice(4) : key, attachmentIds,
          at: new Date(this.now()).toISOString(), machineId: this.deps.machineId(),
        });
        purged += attachmentIds.length;
      }
    }
    try { this.media.applyReferences(); } catch (err) { this.report('media purge', err); } // @silent-fallback-ok — reported; the hourly sweep re-applies it
    return { ok: true, purged, note: 'Files were removed from the agent\'s media store. Copies a messaging platform keeps are not affected.' };
  }

  private report(what: string, err: unknown): void {
    try { this.deps.reportDegradation?.('AppConversationService', `${what}: ${err instanceof Error ? err.message : String(err)}`); } catch { /* @silent-fallback-ok — reporting never fails the service */ }
  }

  ownerName(): string { return this.deps.ownerName(); }

  /**
   * The §4.6 verdict for a stored message, against THIS machine's ledger and key history.
   * Never throws; anything that cannot be checked reads `unknown`.
   */
  verify(record: VerifiableRecord): OriginVerdict {
    if (!record.origin) return 'none';
    const ledger = this.deps.keyLedger;
    const lookup = this.deps.keyLookup;
    if (!ledger || !lookup) return 'unknown';
    try { return verifyRecordedOrigin(record, ledger.view(), lookup); } catch (err) {
      this.report('verify', err);
      return 'unknown';
    }
  }

  /** Mint (idempotently) a local alias for every live conversation in the store. */
  reconcileAliases(): void {
    for (const key of this.store.liveConversationKeys()) {
      if (!isAppConversationKey(key)) continue;
      const r = this.deps.registry.mintAppAlias(key);
      if (!r.ok && r.error !== 'conversation-recording-disabled') this.report('alias', new Error(`${key}: ${r.error}`));
    }
  }

  /**
   * Land events received by replication (the `appConversations` kind): each is re-validated by the
   * store, de-duplicated by eventId and given this machine's next ingestSeq. Returns how many were new.
   */
  ingestReplicated(events: ReadonlyArray<AppEvent | null>): number {
    let added = 0;
    let needsMediaPass = false;
    for (const ev of events) {
      if (!ev) continue;
      try {
        const r = this.store.ingestReplicated(ev);
        if (r?.appended) { added++; this.onReplicatedEvent(ev); }
        if (r?.appended && (ev.kind === 'purge' || ev.kind === 'tombstone')) needsMediaPass = true;
      } catch (err) { this.report('replicated ingest', err); }
    }
    if (needsMediaPass) { try { this.media.applyReferences(); } catch (err) { this.report('media references', err); } } // @silent-fallback-ok — reported; the hourly sweep re-applies it
    return added;
  }

  /** A replicated event landed here: a conversation created elsewhere gets its local alias (and binding on the owner). */
  onReplicatedEvent(ev: AppEvent): void {
    if (!isAppConversationKey(ev.conversationKey)) return;
    if (ev.kind === 'tombstone') {
      const alias = this.deps.registry.appAliasFor(ev.conversationKey);
      if (alias !== null) this.deps.registry.unbindApp(alias);
      return;
    }
    if (ev.kind !== 'created') return;
    const r = this.deps.registry.mintAppAlias(ev.conversationKey);
    if (r.ok && this.deps.holdsLease()) this.deps.registry.bindApp(r.id);
  }

  /** On gaining the serving lease, bind every live conversation; on losing it, unbind them. */
  leaseTick(): void {
    const holds = this.deps.holdsLease();
    if (holds === this.lastLease) return;
    this.lastLease = holds;
    try {
      if (holds) {
        this.reconcileAliases();
        for (const key of this.store.liveConversationKeys()) {
          const id = this.deps.registry.appAliasFor(key);
          if (id !== null) this.deps.registry.bindApp(id);
        }
      } else {
        for (const id of this.deps.registry.appBoundIds()) this.deps.registry.unbindApp(id);
      }
    } catch (err) { this.report('lease binding', err); } // @silent-fallback-ok — reported through the injected DegradationReporter (deps.reportDegradation); the next lease change retries
  }

  /** This machine currently owns the conversation behind `alias` (§4.8, pool dark). */
  ownsAlias(alias: number): boolean {
    return this.deps.holdsLease() && this.deps.registry.isAppBound(alias);
  }

  isOwner(): boolean { return this.deps.holdsLease(); }

  /** The live conversation (null when unknown or deleted). */
  liveConversation(key: string) {
    if (!isAppConversationKey(key)) return null;
    const c = this.store.getConversation(key);
    return c && !c.tombstoned ? c : null;
  }

  /** The session serving an app conversation on this machine, or null. */
  sessionFor(conversationKey: string): string | null {
    const alias = this.deps.registry.appAliasFor(conversationKey);
    return alias === null ? null : this.channels.getSessionForChannel(String(alias));
  }

  emergencyStop(conversationKey: string): { stopped: boolean; session: string | null } {
    const session = this.sessionFor(conversationKey);
    let stopped = false;
    if (session) { try { stopped = this.deps.killSession?.(session) === true; } catch { stopped = false; } } // @silent-fallback-ok — the outcome is reported, never claimed
    const alias = this.deps.registry.appAliasFor(conversationKey);
    if (alias !== null) { try { this.deps.onEmergencyStop?.(alias); } catch { /* @silent-fallback-ok — the stop itself already ran */ } }
    return { stopped, session };
  }

  pause(conversationKey: string): boolean {
    const session = this.sessionFor(conversationKey);
    if (!session) return false;
    try { this.deps.pauseSession?.(session); return true; } catch { return false; } // @silent-fallback-ok — reported as paused:false
  }

  /** An agent reply landed in the store: the push trigger of §4.7 (increment 3). */
  onAgentReplyAppended(conversationKey: string, messageId: string): void {
    try { this.pushHook?.(conversationKey, messageId); } catch (err) { this.report('push hook', err); }
  }

  appendDelivery(conversationKey: string, messageId: string, state: 'delivered' | 'refused' | 'intercepted' | 'unknown', seed: string): void {
    const ev: AppEvent = {
      eventId: derivedEventId('dl', seed, state), kind: 'delivery', conversationKey, messageId, state,
      at: new Date(this.now()).toISOString(), machineId: this.deps.machineId(),
    };
    this.store.append(ev);
  }

  /**
   * Boot recovery (§4.2 step 8 and §4.1): `entered` requests older than 5 minutes that no live
   * handler owns. A send whose message row is missing was never dispatched → `not-delivered`; a
   * send whose message exists with no delivery event → an `unknown` delivery and
   * `outcome-unknown` (never re-dispatched). An interrupted create/rename/delete re-applies its
   * event from the reservation (same event id, so it merges away) and records `done`.
   */
  recoverStranded(): void {
    try { this.media.recoverClaims((id) => this.store.hasMessage(id)); } catch (err) { this.report('media claims', err); } // @silent-fallback-ok — reported; the next tick repeats it
    for (const rec of this.deps.requests.stranded(STRANDED_REQUEST_AGE_MS)) {
      const x = rec.extra;
      if (!x || !x.op) continue; // a Telegram chat request: the inherited outcome-unknown answer stands
      const key = x.conversationKey;
      if (x.op === 'purge') {
        // The exact set was recorded first; a repeat merges away by event id (§4.7).
        const sets = JSON.parse(x.sets ?? '{}') as Record<string, string[]>;
        this.deps.requests.finish(rec.deviceId, rec.requestId, { status: 200, body: this.applyPurge(rec.deviceId, rec.requestId, sets) });
        continue;
      }
      if (x.op === 'send') {
        if (!x.messageId || !this.store.hasMessage(x.messageId)) {
          this.deps.requests.finish(rec.deviceId, rec.requestId, { status: 409, body: { error: 'not-delivered', detail: 'This message was not delivered. Send it again.' } });
          continue;
        }
        const state = this.store.deliveryState(x.messageId);
        if (state === 'pending') this.appendDelivery(key, x.messageId, 'unknown', `${rec.deviceId}\u0000${rec.requestId}`);
        this.deps.requests.markUnknown(rec.deviceId, rec.requestId);
        continue;
      }
      if (x.op === 'create') {
        const r = this.applyCreate(rec.deviceId, rec.requestId, key, x.title ?? 'Untitled');
        this.deps.requests.finish(rec.deviceId, rec.requestId, r);
      } else if (x.op === 'rename' && x.title) {
        this.applyRename(rec.deviceId, rec.requestId, key, x.title);
        this.deps.requests.finish(rec.deviceId, rec.requestId, { status: 200, body: { conversationKey: key, title: this.store.getConversation(key)?.title ?? x.title } });
      } else if (x.op === 'delete') {
        this.applyDelete(rec.deviceId, rec.requestId, key);
        this.deps.requests.finish(rec.deviceId, rec.requestId, { status: 200, body: { conversationKey: key, deleted: true } });
      }
    }
  }

  /** Create: alias first (a refusal leaves no store event), then the `created` event, then bind. */
  applyCreate(deviceId: string, requestId: string, conversationKey: string, title: string): { status: number; body: Record<string, unknown> } {
    const mint = this.deps.registry.mintAppAlias(conversationKey);
    if (!mint.ok) {
      if (mint.error === 'conversation-recording-disabled') {
        return { status: 503, body: { error: 'conversation-recording-disabled', detail: 'Conversation recording is turned off on this agent, so a new conversation cannot be created. Turn it back on to use app conversations.' } };
      }
      return { status: 503, body: { error: 'conversation-unavailable', detail: 'The conversation could not be created on this machine. Try again.' } };
    }
    this.store.append({
      eventId: derivedEventId('cr', deviceId, requestId), kind: 'created', conversationKey, title,
      at: new Date(this.now()).toISOString(), machineId: this.deps.machineId(),
    });
    if (this.deps.holdsLease()) this.deps.registry.bindApp(mint.id);
    const c = this.store.getConversation(conversationKey);
    return { status: 200, body: { conversationKey, title: c?.title ?? title } };
  }

  applyRename(deviceId: string, requestId: string, conversationKey: string, title: string): void {
    const at = new Date(this.now()).toISOString();
    this.store.append({ eventId: derivedEventId('lb', deviceId, requestId), kind: 'label', conversationKey, title, setAt: at, at, machineId: this.deps.machineId() });
  }

  applyDelete(deviceId: string, requestId: string, conversationKey: string): void {
    this.store.append({ eventId: derivedEventId('tb', deviceId, requestId), kind: 'tombstone', conversationKey, at: new Date(this.now()).toISOString(), machineId: this.deps.machineId() });
    const alias = this.deps.registry.appAliasFor(conversationKey);
    if (alias !== null) this.deps.registry.unbindApp(alias);
    try { this.media.applyReferences(); } catch (err) { this.report('media references', err); } // @silent-fallback-ok — reported; the hourly sweep re-applies it
  }
}
