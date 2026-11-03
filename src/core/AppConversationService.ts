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
import { appInjectionTag, type AppInboundDispatch } from './appInboundDispatch.js';
import { ledgerViewKey, verifyRecordedOrigin, type MachineKeyLookup, type MachineSigner, type OriginVerdict, type VerifiableRecord } from './AppRecordSignatures.js';
import type { MobileDeviceKeyLedger } from './MobileDeviceKeyLedger.js';
import { AppMediaStore, DEFAULT_MAX_STORE_BYTES } from './AppMediaStore.js';
import { MAX_PURGE_BATCH, MAX_TRANSCRIPT_CHARS, displayName, sessionLine, type AppAttachment } from './appMediaTypes.js';
import { TranscriptionUnavailableError } from './VoiceTranscription.js';
import { AppMediaReplicator, OWNER_PULL_WAIT_MS, PENDING_DELIVERY_TTL_MS } from './AppMediaReplicator.js';
import path from 'node:path';

export const STRANDED_REQUEST_AGE_MS = 5 * 60_000;

interface PendingRow { attachmentId: string; messageId: string; conversationKey: string; sha256: string; displayName: string; caption: string; createdAt: number; state: 'waiting' | 'ready' | 'expired'; path: string | null }

/** The first 40 characters of a caption, safe inside the line's quotes. */
export function captionSnippet(caption: string): string {
  return Array.from(caption.replace(/[\x00-\x1f\x7f"[\]]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 40).join('');
}

export function availableLine(filePath: string, caption: string): string {
  return `[file now available: ${filePath}]${caption ? ` (for the message "${caption}")` : ''}`;
}

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
  /**
   * Server-side voice transcription (docs/specs/mobile-native-chat-media.md §4.5.1, increment 2):
   * the shared `transcribeAudioFile` Telegram voice notes use. Rejects with
   * `TranscriptionUnavailableError` when no provider is configured. Absent ⇒ every voice note
   * without a phone transcript reads "transcription unavailable".
   */
  transcribeVoice?: (filePath: string, mediaType: string) => Promise<string>;
  /** How long one dispatch waits for a server transcript (default 60 s, the spec's fixed deadline). */
  transcribeDeadlineMs?: number;
}

/** §4.5.1: server transcription has a 60-second limit. */
export const VOICE_TRANSCRIBE_DEADLINE_MS = 60_000;

/**
 * The session line for a voice note the phone did not transcribe: Telegram's form with the
 * server transcript on one line, or an honest note when there is none.
 */
export function voiceLineWithTranscript(filePath: string, transcript: string): string {
  const oneLine = transcript.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `[voice:${filePath}] ${oneLine ? Array.from(oneLine).slice(0, MAX_TRANSCRIPT_CHARS).join('') : '(no speech recognized)'}`;
}

export function voiceLineUnavailable(filePath: string, reason: string): string {
  return `[voice:${filePath}] (transcription unavailable: ${reason}; the audio file is at that path)`;
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
  /** Copies blobs between the agent's machines (§4.12); idle until a mesh transport is attached. */
  readonly replicator: AppMediaReplicator;
  /**
   * Types one line into the conversation's live session, never spawning (the "now available"
   * follow-up of §4.12). Wired where the dispatch is; absent ⇒ the line waits for the next delivery.
   */
  private followUp: ((alias: number, line: string) => boolean) | null = null;
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
    this.replicator = new AppMediaReplicator({
      media: this.media, store: this.store, selfId: deps.machineId, now: this.now,
      report: (detail) => deps.reportDegradation?.('AppMediaReplicator', detail),
      raiseAttention: (item) => deps.raiseAttention?.(item),
      clearAttention: (key) => deps.clearAttention?.(key),
      onBlobLanded: (sha) => { void this.resolvePending(sha); },
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
    this.replicator.start();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.mediaTimer) clearInterval(this.mediaTimer);
    this.timer = null;
    this.mediaTimer = null;
    this.replicator.stop();
  }

  /** The hourly media sweep, then the capacity notices (§4.7). Never throws. */
  async sweepMedia(): Promise<void> {
    try {
      await this.media.sweep((id) => this.store.hasMessage(id));
      this.expirePending();
      this.replicator.evaluateUnrecoverable();
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

  // ── Delivering media the owner does not hold yet (§4.12) ─────────────────────────

  setFollowUp(fn: ((alias: number, line: string) => boolean) | null): void { this.followUp = fn; }

  /**
   * The session lines for a media message on the machine that delivers it (§4.5, §4.12): a private
   * copy per attachment; a blob not held here is pulled first, for at most 60 seconds in all; past
   * that the line reads `[file still copying: <name>]` and a durable row turns into one
   * `[file now available: <path>]` line when the blob lands.
   */
  async sessionLinesFor(conversationKey: string, messageId: string, attachments: ReadonlyArray<AppAttachment>, caption: string, waitMs = OWNER_PULL_WAIT_MS): Promise<string[]> {
    const missing = attachments.filter((a) => !this.media.locateBlob(a.sha256));
    if (missing.length > 0) await Promise.all(missing.map((a) => this.replicator.awaitBlob(a.sha256, waitMs)));
    // A voice note's server transcription runs in parallel with the other files (§4.5.1).
    const lines: Array<string | Promise<string>> = [];
    for (const a of attachments) {
      const copy = await this.media.sessionCopy(messageId, a).catch((err: unknown) => { // @silent-fallback-ok — reported through deps.reportDegradation; the line says the file is unavailable
        this.report('session copy', err);
        return null;
      });
      if (copy) { lines.push(a.kind === 'voice' && !a.transcript ? this.voiceLine(copy, a.mediaType) : sessionLine(a, copy)); continue; }
      // Held here but the copy failed: not a copying problem (reported above).
      if (this.media.locateBlob(a.sha256)) { lines.push(`[file unavailable: ${displayName(a.filename)}]`); continue; }
      lines.push(`[file still copying: ${displayName(a.filename)}]`);
      try {
        this.media.indexDb.prepare(`INSERT OR IGNORE INTO pending_deliveries (attachmentId, messageId, conversationKey, sha256, displayName, caption, createdAt, state, path) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL)`)
          .run(a.attachmentId, messageId, conversationKey, a.sha256, displayName(a.filename), captionSnippet(caption), this.now());
      } catch (err) { this.report('pending delivery', err); } // @silent-fallback-ok — reported through deps.reportDegradation; the line already says the file is still copying
      this.replicator.want(a.sha256);
    }
    return Promise.all(lines);
  }

  /**
   * Transcribe one voice note with the shared Telegram transcriber, bounded by the 60 s deadline.
   * Never rejects: no provider, a failure or the deadline all become an honest line with the path.
   */
  private async voiceLine(copy: string, mediaType: string): Promise<string> {
    const transcribe = this.deps.transcribeVoice;
    if (!transcribe) return voiceLineUnavailable(copy, 'no voice transcription on this machine');
    const deadlineMs = this.deps.transcribeDeadlineMs ?? VOICE_TRANSCRIBE_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), deadlineMs); });
    try {
      const out = await Promise.race([transcribe(copy, mediaType), deadline]);
      if (out === 'deadline') {
        this.report('voice transcription', new Error(`no transcript within ${Math.round(deadlineMs / 1000)} s`));
        return voiceLineUnavailable(copy, 'transcription took too long');
      }
      return voiceLineWithTranscript(copy, out);
    } catch (err) {
      if (err instanceof TranscriptionUnavailableError) return voiceLineUnavailable(copy, 'no transcription provider is configured');
      this.report('voice transcription', err);
      return voiceLineUnavailable(copy, 'the transcription service failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A blob landed: each waiting row gets its session copy and one follow-up line. */
  async resolvePending(sha: string): Promise<void> {
    const rows = this.media.indexDb.prepare(`SELECT * FROM pending_deliveries WHERE sha256 = ? AND state = 'waiting'`).all(sha) as PendingRow[];
    for (const r of rows) {
      try {
        const ev = this.store.getMessageEvent(r.conversationKey, r.messageId);
        const a = ev && ev.kind === 'media-message' ? ev.attachments.find((x) => x.attachmentId === r.attachmentId) : undefined;
        const copy = a ? await this.media.sessionCopy(r.messageId, a) : null;
        if (!copy) continue;
        // Claim the row first, so two landings never produce two lines (§4.12: de-duplicated by attachment).
        const claimed = this.media.indexDb.prepare(`UPDATE pending_deliveries SET state = 'ready', path = ? WHERE attachmentId = ? AND state = 'waiting'`).run(copy, r.attachmentId);
        if (claimed.changes !== 1) continue;
        const alias = this.deps.registry.appAliasFor(r.conversationKey);
        const title = this.store.getConversation(r.conversationKey)?.title ?? 'Untitled';
        const sent = alias !== null && this.ownsAlias(alias)
          && this.followUp?.(alias, `${appInjectionTag(alias, title, this.ownerName(), 'none')} ${availableLine(copy, r.caption)}`) === true;
        if (sent) this.media.indexDb.prepare('DELETE FROM pending_deliveries WHERE attachmentId = ?').run(r.attachmentId);
      } catch (err) { this.report('pending resolve', err); }
    }
  }

  /**
   * Lines for the next delivery's context: files that became available with no live session to
   * tell, and files that could not be copied within 7 days. `ack` removes them once delivered.
   */
  pendingContext(conversationKey: string): { lines: string[]; ack: () => void } {
    const rows = this.media.indexDb.prepare(`SELECT * FROM pending_deliveries WHERE conversationKey = ? AND state IN ('ready','expired') ORDER BY createdAt`).all(conversationKey) as PendingRow[];
    const lines = rows.map((r) => (r.state === 'ready' && r.path ? availableLine(r.path, r.caption) : `(a file from ${new Date(r.createdAt).toISOString().slice(0, 10)}, ${r.displayName}, could not be copied to this machine)`));
    return {
      lines,
      ack: () => { for (const r of rows) this.media.indexDb.prepare('DELETE FROM pending_deliveries WHERE attachmentId = ? AND state = ?').run(r.attachmentId, r.state); },
    };
  }

  /** Waiting rows older than 7 days become a line in the session's next context (§4.12). */
  private expirePending(): void {
    try { this.media.indexDb.prepare(`UPDATE pending_deliveries SET state = 'expired' WHERE state = 'waiting' AND createdAt <= ?`).run(this.now() - PENDING_DELIVERY_TTL_MS); } catch (err) { this.report('pending expiry', err); }
  }

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

  /**
   * How the phone that signed this record was approved (`telegram-dm` / `dashboard-pin`), from
   * THIS machine's ledger, so the app can show "approved on dashboard" (§4.4, §4.6). Only for a
   * record whose verdict is `verified` or `redacted`; otherwise (or unreadable) null.
   */
  originApprovedVia(record: Pick<VerifiableRecord, 'origin'>, verdict: OriginVerdict): string | null {
    const o = record.origin as { keyHash?: unknown; deviceId?: unknown } | undefined;
    if (!o || typeof o.keyHash !== 'string' || typeof o.deviceId !== 'string') return null;
    if (verdict !== 'verified' && verdict !== 'redacted') return null;
    try { return this.deps.keyLedger?.view()?.get(ledgerViewKey(o.keyHash, o.deviceId))?.approvedVia ?? null; } catch { return null; } // @silent-fallback-ok — display detail only; the verdict is unaffected
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
        if (r?.appended && (ev.kind === 'media-message' || ev.kind === 'purge')) {
          this.replicator.markWantedDirty(ev.kind === 'media-message' ? ev.attachments.map((a) => a.sha256) : undefined);
        }
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
