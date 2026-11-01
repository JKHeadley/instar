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
}

export class AppConversationService {
  readonly store: AppConversationStore;
  readonly channels: SessionChannelRegistry;
  private lastLease: boolean | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
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
    // Aliases are derived per machine from the replicated store and rebuildable at any time.
    this.reconcileAliases();
    this.leaseTick();
    try { this.recoverStranded(); } catch (err) { this.report('boot recovery', err); }
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.leaseTick();
      try { this.recoverStranded(); } catch (err) { this.report('recovery', err); }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

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
    for (const ev of events) {
      if (!ev) continue;
      try {
        const r = this.store.ingestReplicated(ev);
        if (r?.appended) { added++; this.onReplicatedEvent(ev); }
      } catch (err) { this.report('replicated ingest', err); }
    }
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
    } catch (err) { this.report('lease binding', err); } // @silent-fallback-ok — reported through the reportDegradation callback (DegradationReporter in production); retried on the next lease change
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
    for (const rec of this.deps.requests.stranded(STRANDED_REQUEST_AGE_MS)) {
      const x = rec.extra;
      if (!x || !x.op) continue; // a Telegram chat request: the inherited outcome-unknown answer stands
      const key = x.conversationKey;
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
  }
}
