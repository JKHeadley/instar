/**
 * AppConversationService — the native app conversation core
 * (docs/specs/mobile-native-conversations.md, increment 1).
 *
 * Holds the conversation store, the registry aliases, the per-machine ownership bindings and the
 * dispatch seam, and implements the parts of §4.1/§4.2/§4.8 that are not HTTP: alias
 * re-derivation at boot, `bind-app`/`unbind-app` on lease changes, boot recovery of interrupted
 * requests, the emergency-stop/pause effects and the reply-side hook point.
 *
 * Ownership: an unmoved conversation's owner is the machine holding the serving lease (single
 * machine: always this one). A moved one has a fenced record naming its machine
 * (docs/specs/app-conversations-in-the-pool.md): `serves`, `mayReply` and `currentOwner` below. A
 * machine that isn't the lease holder answers a phone's send `503 owner-unavailable` AFTER the
 * message is persisted (§4.8's fallback), so nothing typed is lost.
 */
import { safeInboxTarget } from './memorySessionPolicy.js';
import type { ConversationRegistry } from './ConversationRegistry.js';
import type { MobileChatRequestStore } from './MobileChatRequests.js';
import { SessionChannelRegistry } from '../messaging/shared/SessionChannelRegistry.js';
import { AppConversationStore, MAX_STORED_TEXT, transcriptEventId, type AppEvent } from './AppConversationStore.js';
import type { ConversationOwner } from './MobilePeople.js';
import { derivedEventId, isAppConversationKey, removeAuthorityTokens } from './appConversationText.js';
import { appInjectionTag, type AppInboundDispatch } from './appInboundDispatch.js';
import { ledgerViewKey, verifyRecordedOrigin, type MachineKeyLookup, type MachineSigner, type OriginVerdict, type VerifiableRecord } from './AppRecordSignatures.js';
import type { MobileDeviceKeyLedger } from './MobileDeviceKeyLedger.js';
import { AppMediaStore, DEFAULT_MAX_STORE_BYTES } from './AppMediaStore.js';
import { MAX_PURGE_BATCH, MAX_TRANSCRIPT_CHARS, displayName, sessionLine, type AppAttachment } from './appMediaTypes.js';
import { TranscriptionUnavailableError } from './VoiceTranscription.js';
import { AppMediaReplicator, OWNER_PULL_WAIT_MS, PENDING_DELIVERY_TTL_MS } from './AppMediaReplicator.js';
import { MAY_NOT_BE_DELIVERED, type AppPoolHandle } from './appConversationPool.js';
import fs from 'node:fs';
import path from 'node:path';

export const STRANDED_REQUEST_AGE_MS = 5 * 60_000;
/** Past the queue's 30-minute limit, with room for a drain pass: a `waiting` send here has lost its row. */
export const WAITING_OVERDUE_MS = 45 * 60_000;

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
  /** The session pool (app-conversations-in-the-pool). Absent, or `active()` false: the lease holder serves every conversation, as before. */
  pool?: () => AppPoolHandle | null;
  ownerName: () => string;
  dispatch: () => AppInboundDispatch | null;
  /** Stop / pause the session serving an app conversation (by tmux name). */
  killSession?: (tmuxSession: string) => boolean;
  pauseSession?: (tmuxSession: string) => void;
  /** The emergency-stop side effects shared with the Telegram path (resume queue pause, …). */
  onEmergencyStop?: (alias: number, scope?: 'conversation') => void;
  /**
   * The inbox of a confined conversation's scope folder, or null when it is not confined. A confined
   * session cannot read the agent's state, so its files go here (team-roles-and-access §4.1).
   */
  confinedInbox?: (conversationKey: string) => string | null;
  /** A create recovered after a crash gets the same confinement as a normal one. */
  confineStranded?: (conversationKey: string, personKey: string, deviceId: string) => void;
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
  /** Free and total disk for the media store's floor. Absent reads the real disk; tests pass one so they do not depend on the machine. */
  mediaDiskSpace?: () => { free: number; total: number } | null;
  /** One notice per condition (absent ⇒ degradation reports only). */
  raiseAttention?: (item: { conditionKey: string; title: string; body: string }) => void;
  clearAttention?: (conditionKey: string) => void;
  /**
   * Server-side voice transcription (docs/specs/mobile-native-chat-media.md §4.5.1, increment 2):
   * the shared `transcribeAudioFile` Telegram voice notes use. Rejects with
   * `TranscriptionUnavailableError` when no provider is configured. Absent ⇒ every voice note
   * without a phone transcript reads "transcription unavailable".
   */
  transcribeVoice?: (filePath: string, mediaType: string, timeoutMs?: number) => Promise<string>;
  /** How long one dispatch waits for a server transcript (default 60 s, the spec's fixed deadline). */
  transcribeDeadlineMs?: number;
  /** At most this many provider calls run at once in this process (default 3). */
  transcribeConcurrency?: number;
  /**
   * The ceiling on one transcription, queueing included (default 10 minutes): a call still queued
   * at the ceiling ends "timed out waiting"; a running call gets only what is left of it.
   */
  transcribeCeilingMs?: number;
  /** The provider name stored on a transcript event (e.g. `groq`); absent ⇒ `server`. */
  voiceProviderName?: () => string | undefined;
}

/** §4.5.1: server transcription has a 60-second limit. */
export const VOICE_TRANSCRIBE_DEADLINE_MS = 60_000;

/**
 * The session line for a voice note the phone did not transcribe: Telegram's form with the
 * server transcript on one line, or an honest note when there is none.
 */
export function voiceLineWithTranscript(filePath: string, transcript: string): string {
  return `[voice:${filePath}] ${transcriptOneLine(transcript)}`;
}

/** A transcript on one line for a session: control characters removed; a long one says it was cut. */
export function transcriptOneLine(transcript: string): string {
  const oneLine = transcript.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '(no speech recognized)';
  const chars = Array.from(oneLine);
  if (chars.length <= MAX_TRANSCRIPT_CHARS) return oneLine;
  return `${chars.slice(0, MAX_TRANSCRIPT_CHARS).join('')} (transcript cut here; the full transcript is saved with the message)`;
}

export function voiceLineUnavailable(filePath: string, reason: string): string {
  return `[voice:${filePath}] (transcription unavailable: ${reason}; the audio file is at that path)`;
}

/**
 * The line for a voice note whose server transcript was not ready by the deadline (§4.5.1). An app
 * conversation gets the transcript later as one follow-up line; a Telegram or Slack conversation
 * continued from the app keeps it with the message only (no follow-up path reaches those sessions).
 */
export function voiceLinePending(filePath: string, followUp: boolean): string {
  return followUp
    ? `[voice:${filePath}] (transcript not ready after 60 s; it follows in a separate line, and the audio file is at that path)`
    : `[voice:${filePath}] (transcript not ready after 60 s; it is saved with the message if it finishes, and the audio file is at that path)`;
}

/** The follow-up line a late server transcript produces (§4.5.1), once per attachment. */
export function lateTranscriptLine(filePath: string, outcome: VoiceOutcome, caption: string): string {
  const forMsg = caption ? ` (for the message "${caption}")` : '';
  return outcome.ok
    ? `[voice transcript ready: ${filePath}]${forMsg} ${transcriptOneLine(transcriptForDelivery(outcome.text))}`
    : `[voice transcript unavailable: ${filePath}]${forMsg} (transcription unavailable: ${outcome.reason}; the audio file is at that path)`;
}

/** What one server transcription produced. A failure carries a plain reason, never silence. */
export type VoiceOutcome = { ok: true; text: string } | { ok: false; reason: string };

/**
 * How long the provider itself may take (§4.5.1): past the 60 s dispatch deadline the transcript
 * is still wanted, as a late transcript. Bounded: one call per attachment, aborted at this limit.
 */
export const VOICE_TRANSCRIBE_PROVIDER_TIMEOUT_MS = 10 * 60_000;

const CUT_NOTE = ' … (transcript cut here; the audio file has the rest)';

/**
 * A server transcript gets the phone transcript's treatment before it is stored or delivered
 * (§4.3, §4.5.1): `scanInbound` first (so a dictated pending pairing code declines that pairing),
 * then exact-token removal. Text past the store's limit is cut with a note, never refused.
 */
export function scrubServerTranscript(text: string, scan?: ((t: string) => void) | null): { text: string; kinds: string[] } {
  try { scan?.(text); } catch { /* @silent-fallback-ok — the scan only declines leaked pairings; token removal still runs */ }
  const removed = removeAuthorityTokens(text);
  let out = removed.text;
  if (out.length > MAX_STORED_TEXT) out = out.slice(0, MAX_STORED_TEXT - CUT_NOTE.length).replace(/[\uD800-\uDBFF]$/, '') + CUT_NOTE;
  return { text: out, kinds: removed.kinds };
}

interface TranscriptionEntry { done: Promise<VoiceOutcome>; late: boolean; lateArmed: boolean }

/** At most this many server transcriptions call the provider at once, per process (§4.5.1). */
export const VOICE_TRANSCRIBE_CONCURRENCY = 3;

/** A transcription still queued for a provider slot when its ceiling passed. */
class TranscriptionQueueTimeout extends Error { constructor() { super('timed out waiting for a transcription slot'); } }
/** A provider call still running when the ceiling (queue time included) passed. */
class TranscriptionCeilingTimeout extends Error { constructor() { super('the transcription provider ran past the ceiling'); } }

/**
 * A stored transcript as it may be handed to a session or a device: the exact-token removal runs
 * again on READ, so a transcript a peer stored without scrubbing (an older or misbehaving build)
 * can never carry a pairing invite or a desktop code anywhere (second-pass review, finding 2).
 */
export function transcriptForDelivery(text: string): string {
  return removeAuthorityTokens(text).text;
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
  /** Server transcriptions running in this process, by attachment (one per attachment, §4.5.1). */
  private readonly transcriptions = new Map<string, TranscriptionEntry>();
  /** Provider slots in use, and the calls queued for one (a bounded, per-process limit). */
  private transcribeActive = 0;
  private readonly transcribeWaiters: Array<() => void> = [];
  private inboundScan: ((text: string) => void) | null = null;
  /** Conversations created here while this machine held the lease: no other machine can own one yet. */
  private readonly createdHere = new Set<string>();
  /** Stop or pause reached this owner while a drain ran for the conversation (§2.4). The drain aborts. */
  private readonly emergencyMarks = new Set<string>();
  /** Closes in flight, so a slow close isn't started twice. */
  private readonly closing = new Set<string>();
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
      ...(deps.mediaDiskSpace ? { diskSpace: deps.mediaDiskSpace } : {}),
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
      const copy = await this.media.sessionCopy(messageId, a).then((p) => (p ? this.intoConfinedInbox(conversationKey, p) : p)).catch((err: unknown) => { // @silent-fallback-ok — reported through deps.reportDegradation; the line says the file is unavailable
        this.report('session copy', err);
        return null;
      });
      if (copy) { lines.push(a.kind === 'voice' && !a.transcript ? this.voiceLine(conversationKey, messageId, a, copy, caption) : sessionLine(a, copy)); continue; }
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
   * A confined session can read only its scope folder, so a server-recorded file is copied there. The
   * caller found this file through the conversation's own events: never a path from a message.
   */
  intoConfinedInbox(conversationKey: string, filePath: string): string {
    const inbox = this.deps.confinedInbox?.(conversationKey);
    if (!inbox) return filePath;
    const target = safeInboxTarget(inbox, filePath);
    fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
    return target;
  }

  /** Wired where the pairing service is: declines a pending pairing whose code a transcript dictates. */
  setInboundScan(fn: ((text: string) => void) | null): void { this.inboundScan = fn; }

  /** The session line for a voice note the phone did not transcribe (§4.5.1). Never rejects. */
  private async voiceLine(conversationKey: string, messageId: string, a: AppAttachment, copy: string, caption: string): Promise<string> {
    const r = await this.voiceResult(conversationKey, messageId, a, copy, caption);
    if (r === 'pending') return voiceLinePending(copy, isAppConversationKey(conversationKey));
    return r.ok ? voiceLineWithTranscript(copy, r.text) : voiceLineUnavailable(copy, r.reason);
  }

  /**
   * The server transcript of one voice attachment, waiting at most the 60 s dispatch deadline.
   * `pending` means it is still running: when it settles, a late transcript event is stored and
   * one follow-up line is delivered (app conversations). Never rejects.
   */
  private async voiceResult(conversationKey: string, messageId: string, a: AppAttachment, copy: string, caption: string): Promise<VoiceOutcome | 'pending'> {
    const t = this.transcription(conversationKey, messageId, a, copy);
    if (!('entry' in t)) return t.now;
    const entry = t.entry;
    const deadlineMs = this.deps.transcribeDeadlineMs ?? VOICE_TRANSCRIBE_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), deadlineMs); });
    try {
      const out = await Promise.race([entry.done, deadline]);
      if (out !== 'deadline') return out;
      entry.late = true;
      this.report('voice transcription', new Error(`no transcript within ${Math.round(deadlineMs / 1000)} s; it is kept as a late transcript when it finishes`));
      if (!entry.lateArmed) {
        entry.lateArmed = true;
        void entry.done.then((o) => this.deliverLate(conversationKey, a, copy, captionSnippet(caption), o));
      }
      return 'pending';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * One server transcription per attachment on this machine, ever (§4.5.1, bounded): a stored
   * transcript (made here or replicated from a peer) is reused; one already running is joined; a
   * recorded failure is reported with its reason and never retried; a run a restart interrupted
   * reads as a failure. Only an attachment with no row starts the provider.
   */
  private transcription(conversationKey: string, messageId: string, a: AppAttachment, copy: string): { now: VoiceOutcome } | { entry: TranscriptionEntry } {
    const stored = this.store.transcriptFor(a.attachmentId);
    if (stored) return { now: { ok: true, text: transcriptForDelivery(stored.text) } };
    const live = this.transcriptions.get(a.attachmentId);
    if (live) return { entry: live };
    const transcribe = this.deps.transcribeVoice;
    if (!transcribe) return { now: { ok: false, reason: 'no voice transcription on this machine' } };
    const db = this.media.indexDb;
    const prior = db.prepare('SELECT state, reason FROM voice_transcriptions WHERE attachmentId = ?').get(a.attachmentId) as { state: string; reason: string | null } | undefined;
    if (prior) {
      if (prior.state === 'running') {
        const reason = 'the server restarted before the transcript finished';
        db.prepare(`UPDATE voice_transcriptions SET state = 'failed', reason = ?, finishedAt = ? WHERE attachmentId = ?`).run(reason, this.now(), a.attachmentId);
        return { now: { ok: false, reason } };
      }
      return { now: { ok: false, reason: prior.reason ?? 'the transcription service failed' } };
    }
    const claimed = db.prepare(`INSERT OR IGNORE INTO voice_transcriptions (attachmentId, state, reason, startedAt, finishedAt) VALUES (?, 'running', NULL, ?, NULL)`).run(a.attachmentId, this.now());
    if (claimed.changes !== 1) return { now: { ok: false, reason: 'the transcription service failed' } };
    const entry: TranscriptionEntry = { late: false, lateArmed: false, done: Promise.resolve({ ok: false, reason: 'not started' }) };
    entry.done = this.limitedTranscribe(transcribe, copy, a.mediaType)
      .then(
        (raw): VoiceOutcome => this.storeTranscript(conversationKey, messageId, a, raw, entry.late),
        (err: unknown): VoiceOutcome => {
          if (err instanceof TranscriptionUnavailableError) return { ok: false, reason: 'no transcription provider is configured' };
          this.report('voice transcription', err);
          if (err instanceof TranscriptionQueueTimeout) return { ok: false, reason: 'timed out waiting' };
          if (err instanceof TranscriptionCeilingTimeout) return { ok: false, reason: 'the transcription service timed out' };
          return { ok: false, reason: 'the transcription service failed' };
        },
      )
      .then((o) => {
        try {
          db.prepare('UPDATE voice_transcriptions SET state = ?, reason = ?, finishedAt = ? WHERE attachmentId = ?')
            .run(o.ok ? 'done' : 'failed', o.ok ? null : o.reason, this.now(), a.attachmentId);
        } catch (err) { this.report('voice transcription record', err); } // @silent-fallback-ok — reported; a restart reads the row as interrupted, never retries
        this.transcriptions.delete(a.attachmentId);
        return o;
      });
    this.transcriptions.set(a.attachmentId, entry);
    return { entry };
  }

  /**
   * One provider call under the per-process limit (§4.5.1, second-pass finding 1). Queue time counts
   * toward the ceiling: still queued at the ceiling ⇒ `TranscriptionQueueTimeout`; a running call
   * gets the remaining time (passed to the provider as its own timeout) and is abandoned at the
   * ceiling. The slot is held until the provider call itself settles, so at most N ever run.
   */
  private async limitedTranscribe(transcribe: NonNullable<AppConversationServiceDeps['transcribeVoice']>, copy: string, mediaType: string): Promise<string> {
    const ceilingMs = this.deps.transcribeCeilingMs ?? VOICE_TRANSCRIBE_PROVIDER_TIMEOUT_MS;
    const startedAt = Date.now();
    if (!(await this.acquireTranscribeSlot(ceilingMs))) throw new TranscriptionQueueTimeout();
    const remaining = Math.max(1, ceilingMs - (Date.now() - startedAt));
    const run = Promise.resolve().then(() => transcribe(copy, mediaType, remaining));
    void run.then(() => this.releaseTranscribeSlot(), () => this.releaseTranscribeSlot());
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ceiling = new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new TranscriptionCeilingTimeout()), remaining); });
    try { return await Promise.race([run, ceiling]); } finally { if (timer) clearTimeout(timer); }
  }

  /** A provider slot, waiting at most `waitMs`; false when the wait ran out. */
  private acquireTranscribeSlot(waitMs: number): Promise<boolean> {
    const limit = Math.max(1, this.deps.transcribeConcurrency ?? VOICE_TRANSCRIBE_CONCURRENCY);
    if (this.transcribeActive < limit) { this.transcribeActive++; return Promise.resolve(true); }
    return new Promise<boolean>((resolve) => {
      const waiter = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => {
        const i = this.transcribeWaiters.indexOf(waiter);
        if (i >= 0) this.transcribeWaiters.splice(i, 1);
        resolve(false);
      }, waitMs);
      timer.unref?.();
      this.transcribeWaiters.push(waiter);
    });
  }

  /** Hand the slot to the next queued call, or free it. */
  private releaseTranscribeSlot(): void {
    const next = this.transcribeWaiters.shift();
    if (next) { next(); return; } // the slot passes on; the active count is unchanged
    this.transcribeActive = Math.max(0, this.transcribeActive - 1);
  }

  /** Scrub, then store the transcript as its own unsigned event (§4.5.1). The session gets it either way. */
  private storeTranscript(conversationKey: string, messageId: string, a: AppAttachment, raw: string, late: boolean): VoiceOutcome {
    const scrubbed = scrubServerTranscript(raw, this.inboundScan);
    const machineId = this.deps.machineId();
    const provider = (this.deps.voiceProviderName?.() ?? 'server').toLowerCase();
    try {
      this.store.append({
        eventId: transcriptEventId(a.attachmentId, machineId), kind: 'transcript', conversationKey, messageId,
        attachmentId: a.attachmentId, text: scrubbed.text, provider: /^[a-z0-9][a-z0-9._-]{0,31}$/.test(provider) ? provider : 'server',
        at: new Date(this.now()).toISOString(), machineId, ...(late ? { late: true as const } : {}),
      });
    } catch (err) { this.report('voice transcript store', err); } // @silent-fallback-ok — reported; the session still receives the transcript
    return { ok: true, text: scrubbed.text };
  }

  /** A late transcript (or its failure): one follow-up line, or a note for the next delivery. */
  private deliverLate(conversationKey: string, a: AppAttachment, copy: string, caption: string, outcome: VoiceOutcome): void {
    try {
      if (!isAppConversationKey(conversationKey)) return; // kept with the message; no follow-up path reaches platform sessions
      const line = lateTranscriptLine(copy, outcome, caption);
      const alias = this.deps.registry.appAliasFor(conversationKey);
      const title = this.store.getConversation(conversationKey)?.title ?? 'Untitled';
      const sent = alias !== null && this.ownsAlias(alias)
        && this.followUp?.(alias, `${appInjectionTag(alias, title, this.ownerName(), 'none')} ${line}`) === true;
      // A "now available" row still waiting for a delivery will carry the stored transcript itself
      // (pendingContext), so a separate note would say it twice (second-pass finding 3).
      const carried = !!this.media.indexDb.prepare(`SELECT 1 FROM pending_deliveries WHERE attachmentId = ? AND state = 'ready'`).get(a.attachmentId);
      if (sent && outcome.ok) this.markTranscriptDelivered(a.attachmentId);
      if (!sent && !(outcome.ok && carried)) {
        this.media.indexDb.prepare('INSERT OR IGNORE INTO transcript_notes (attachmentId, conversationKey, line, createdAt) VALUES (?, ?, ?, ?)')
          .run(a.attachmentId, conversationKey, line, this.now());
      }
    } catch (err) { this.report('late transcript', err); }
  }

  /** The transcript reached the session already: no later line may repeat it (second-pass finding 3). */
  private markTranscriptDelivered(attachmentId: string): void {
    try {
      this.media.indexDb.prepare(`INSERT INTO voice_transcriptions (attachmentId, state, reason, startedAt, finishedAt, delivered) VALUES (?, 'done', NULL, ?, ?, 1) ON CONFLICT(attachmentId) DO UPDATE SET delivered = 1`)
        .run(attachmentId, this.now(), this.now());
    } catch (err) { this.report('transcript delivered mark', err); } // @silent-fallback-ok — reported; at worst the transcript is repeated once
  }

  private transcriptDelivered(attachmentId: string): boolean {
    const r = this.media.indexDb.prepare('SELECT delivered FROM voice_transcriptions WHERE attachmentId = ?').get(attachmentId) as { delivered: number } | undefined;
    return r?.delivered === 1;
  }

  /** A blob landed: each waiting row gets its session copy and one follow-up line. */
  async resolvePending(sha: string): Promise<void> {
    const rows = this.media.indexDb.prepare(`SELECT * FROM pending_deliveries WHERE sha256 = ? AND state = 'waiting'`).all(sha) as PendingRow[];
    for (const r of rows) {
      try {
        const a = this.store.getMediaAttachments(r.conversationKey, r.messageId)?.find((x) => x.attachmentId === r.attachmentId);
        const held = a ? await this.media.sessionCopy(r.messageId, a) : null;
        if (!held) continue;
        const copy = this.intoConfinedInbox(r.conversationKey, held);
        // Claim the row first, so two landings never produce two lines (§4.12: de-duplicated by attachment).
        const claimed = this.media.indexDb.prepare(`UPDATE pending_deliveries SET state = 'ready', path = ? WHERE attachmentId = ? AND state = 'waiting'`).run(copy, r.attachmentId);
        if (claimed.changes !== 1) continue;
        // A voice note the phone did not transcribe is transcribed now that it is here (§4.5.1):
        // the transcript (or an honest reason) rides on the same line; past 60 s it follows later.
        let tail = '';
        let carriesTranscript = false;
        if (a && a.kind === 'voice' && !a.transcript) {
          const v = await this.voiceResult(r.conversationKey, r.messageId, a, copy, r.caption);
          carriesTranscript = v !== 'pending' && v.ok;
          tail = v === 'pending' ? ' (transcript not ready after 60 s; it follows in a separate line)'
            : v.ok ? ` ${transcriptOneLine(transcriptForDelivery(v.text))}` : ` (transcription unavailable: ${v.reason})`;
        }
        const alias = this.deps.registry.appAliasFor(r.conversationKey);
        const title = this.store.getConversation(r.conversationKey)?.title ?? 'Untitled';
        const sent = alias !== null && this.ownsAlias(alias)
          && this.followUp?.(alias, `${appInjectionTag(alias, title, this.ownerName(), 'none')} ${availableLine(copy, r.caption)}${tail}`) === true;
        if (sent) {
          this.media.indexDb.prepare('DELETE FROM pending_deliveries WHERE attachmentId = ?').run(r.attachmentId);
          // The transcript rode on this line: a note for it would repeat it (second-pass finding 3).
          if (carriesTranscript) this.markTranscriptDelivered(r.attachmentId);
          if (carriesTranscript) this.media.indexDb.prepare('DELETE FROM transcript_notes WHERE attachmentId = ?').run(r.attachmentId);
        }
      } catch (err) { this.report('pending resolve', err); }
    }
  }

  /**
   * Lines for the next delivery's context: files that became available with no live session to
   * tell, and files that could not be copied within 7 days. `ack` removes them once delivered.
   */
  pendingContext(conversationKey: string): { lines: string[]; ack: () => void } {
    const rows = this.media.indexDb.prepare(`SELECT * FROM pending_deliveries WHERE conversationKey = ? AND state IN ('ready','expired') ORDER BY createdAt`).all(conversationKey) as PendingRow[];
    const carried = new Set<string>();
    const lines = rows.map((r) => {
      if (!(r.state === 'ready' && r.path)) return `(a file from ${new Date(r.createdAt).toISOString().slice(0, 10)}, ${r.displayName}, could not be copied to this machine)`;
      // A voice note's stored server transcript rides on its line (§4.5.1), scrubbed on read.
      const stored = this.store.transcriptFor(r.attachmentId);
      const t = stored && !this.transcriptDelivered(r.attachmentId) ? stored : null;
      if (stored) carried.add(r.attachmentId);
      return `${availableLine(r.path, r.caption)}${t ? ` ${transcriptOneLine(transcriptForDelivery(t.text))}` : ''}`;
    });
    // Late transcripts that found no live session (§4.5.1), oldest first — except one whose
    // transcript the "now available" line above already carries (said once, never twice).
    const notes = this.media.indexDb.prepare('SELECT attachmentId, line FROM transcript_notes WHERE conversationKey = ? ORDER BY createdAt').all(conversationKey) as Array<{ attachmentId: string; line: string }>;
    for (const n of notes) if (!carried.has(n.attachmentId)) lines.push(transcriptForDelivery(n.line));
    return {
      lines,
      ack: () => {
        for (const r of rows) this.media.indexDb.prepare('DELETE FROM pending_deliveries WHERE attachmentId = ? AND state = ?').run(r.attachmentId, r.state);
        for (const n of notes) this.media.indexDb.prepare('DELETE FROM transcript_notes WHERE attachmentId = ?').run(n.attachmentId);
      },
    };
  }

  /** Waiting rows older than 7 days become a line in the session's next context (§4.12). */
  private expirePending(): void {
    try { this.media.indexDb.prepare(`UPDATE pending_deliveries SET state = 'expired' WHERE state = 'waiting' AND createdAt <= ?`).run(this.now() - PENDING_DELIVERY_TTL_MS); } catch (err) { this.report('pending expiry', err); }
    // Bounded bookkeeping (§4.5.1): late-transcript notes no delivery picked up within 7 days (the
    // transcript itself stays in the store and in history), and finished attempt rows after 30
    // days (by then no dispatch re-reads them; a stored transcript is found in the store first).
    try {
      this.media.indexDb.prepare('DELETE FROM transcript_notes WHERE createdAt <= ?').run(this.now() - PENDING_DELIVERY_TTL_MS);
      this.media.indexDb.prepare(`DELETE FROM voice_transcriptions WHERE state IN ('done','failed') AND COALESCE(finishedAt, startedAt) <= ?`).run(this.now() - 30 * 24 * 60 * 60_000);
    } catch (err) { this.report('transcript bookkeeping', err); }
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
        if (r?.appended && (ev.kind === 'media-message' || ev.kind === 'platform-media' || ev.kind === 'purge')) {
          this.replicator.markWantedDirty(ev.kind === 'purge' ? undefined : ev.attachments.map((a) => a.sha256));
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
    if (r.ok && this.mayReply(ev.conversationKey)) this.deps.registry.bindApp(r.id);
  }

  /** Each lease tick: the binding reconcile (§2.1), and aliases when the lease is gained. */
  leaseTick(): void {
    const holds = this.deps.holdsLease();
    const changed = holds !== this.lastLease;
    this.lastLease = holds;
    if (!holds) this.createdHere.clear();
    try {
      if (changed && holds) this.reconcileAliases();
      this.reconcileBindings();
    } catch (err) { this.report('lease binding', err); } // @silent-fallback-ok — reported through the injected DegradationReporter (deps.reportDegradation); the next tick repeats it
  }

  /** The pool, when it is on. Null means the lease holder serves everything, as before this part. */
  private activePool(): AppPoolHandle | null {
    try { const p = this.deps.pool?.() ?? null; return p && p.active() ? p : null; } catch { return null; } // @silent-fallback-ok — an unreadable pool reads as dark: today's lease-holder rule
  }

  private recordOf(p: AppPoolHandle, conversationKey: string) {
    const r = p.read(`app:${conversationKey}`);
    return r && r.status !== 'released' ? r : null;
  }

  /**
   * This machine serves the conversation (§2.1): it starts sessions for it and takes its messages.
   * An `active` record naming it; or no record, the lease here, and the lease gate open.
   */
  serves(conversationKey: string): boolean {
    const p = this.activePool();
    if (!p) return this.deps.holdsLease();
    const r = this.recordOf(p, conversationKey);
    if (r) return r.status === 'active' && r.ownerMachineId === this.deps.machineId();
    if (!this.deps.holdsLease()) return false;
    return this.createdHere.has(conversationKey) || p.gateOpenFor(conversationKey);
  }

  /** May a reply land from here (§2.1): it serves, or it is the drain's last turn. The runner bounds that window. */
  mayReply(conversationKey: string): boolean {
    if (this.serves(conversationKey)) return true;
    const p = this.activePool();
    if (!p) return false;
    const r = this.recordOf(p, conversationKey);
    return r?.status === 'transferring' && r.ownerMachineId === this.deps.machineId() && p.drainRunning(`app:${conversationKey}`);
  }

  /** Where a stop or pause goes (§2.4): the owner named by the record, draining or not; else whoever serves it. */
  currentOwner(conversationKey: string): boolean {
    const p = this.activePool();
    if (!p) return this.serves(conversationKey);
    const r = this.recordOf(p, conversationKey);
    if (!r) return this.serves(conversationKey);
    return (r.status === 'active' || r.status === 'transferring') && r.ownerMachineId === this.deps.machineId();
  }

  /** New conversations start on the lease holder: nothing can own one yet, so the gate doesn't apply. */
  servesNewConversations(): boolean { return this.deps.holdsLease(); }

  /** The pool is on, so a send goes through the router. */
  poolRouter(): AppPoolHandle | null { return this.activePool(); }

  /**
   * A desired-set reconcile, not a reaction to lease changes (§2.1): every conversation for which
   * `mayReply` holds here is bound, the rest are not. A machine that learns it lost a conversation
   * closes its copy, and a refused close is retried on the next reconcile.
   */
  reconcileBindings(): void {
    const p = this.activePool();
    const self = this.deps.machineId();
    const live = this.store.liveConversationKeys().filter(isAppConversationKey);
    const want = new Set(live.filter((k) => this.mayReply(k)));
    for (const key of want) {
      const id = this.deps.registry.appAliasFor(key) ?? (() => { const m = this.deps.registry.mintAppAlias(key); return m.ok ? m.id : null; })();
      if (id !== null && !this.deps.registry.isAppBound(id)) this.deps.registry.bindApp(id);
    }
    for (const id of this.deps.registry.appBoundIds()) {
      const key = this.deps.registry.appConversationFor(id);
      if (!key || !want.has(key)) this.deps.registry.unbindApp(id);
    }
    if (!p) return;
    for (const key of live) {
      if (want.has(key) || this.closing.has(key)) continue;
      const r = this.recordOf(p, key);
      // With no record, only another machine being named holder is the lease moving: a suspended lease or a missed renewal closes nothing.
      const lost = r ? r.ownerMachineId !== self : !this.deps.holdsLease() && p.leaseHeldElsewhere();
      if (!lost) continue;
      const session = this.sessionFor(key);
      if (!session || !p.sessionRunning(session)) continue;
      this.closing.add(key);
      void p.closeLostSession(key, session)
        .then((out) => { if (!out.closed) this.report('close after losing a conversation', new Error(`${key}: ${out.detail ?? 'refused'}; retried on the next reconcile`)); })
        .catch((err: unknown) => this.report('close after losing a conversation', err))
        .finally(() => this.closing.delete(key));
    }
  }

  /** A stop or pause reached this owner: a drain running for the conversation aborts on its next check. */
  noteEmergency(conversationKey: string): void {
    const p = this.activePool();
    const rk = `app:${conversationKey}`;
    if (p?.drainRunning(rk)) this.emergencyMarks.add(rk);
  }

  emergencyMarked(recordKey: string): boolean { return this.emergencyMarks.has(recordKey); }

  /** The drain ended, whichever way: a later move isn't aborted by an old stop. */
  clearEmergency(recordKey: string): void { this.emergencyMarks.delete(recordKey); }

  /** This machine owns the conversation behind `alias` right now: replies may land (§2.1). */
  ownsAlias(alias: number): boolean {
    const key = this.deps.registry.appConversationFor(alias);
    return !!key && this.mayReply(key) && this.deps.registry.isAppBound(alias);
  }

  /** What stays behind on this machine when its conversation moves (§2.5): named in the move's answer. */
  leftBehind(conversationKey: string): { files: number; notes: number } {
    try {
      const files = this.media.indexDb.prepare(`SELECT COUNT(*) AS n FROM pending_deliveries WHERE conversationKey = ?`).get(conversationKey) as { n: number };
      const notes = this.media.indexDb.prepare('SELECT COUNT(*) AS n FROM transcript_notes WHERE conversationKey = ?').get(conversationKey) as { n: number };
      return { files: files.n, notes: notes.n };
    } catch (err) { this.report('left-behind count', err); return { files: 0, notes: 0 }; } // @silent-fallback-ok — reported; the move still answers, without the count
  }

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

  emergencyStop(conversationKey: string, scope?: 'conversation'): { stopped: boolean; session: string | null } {
    const session = this.sessionFor(conversationKey);
    let stopped = false;
    if (session) { try { stopped = this.deps.killSession?.(session) === true; } catch { stopped = false; } } // @silent-fallback-ok — the outcome is reported, never claimed
    const alias = this.deps.registry.appAliasFor(conversationKey);
    if (alias !== null) { try { this.deps.onEmergencyStop?.(alias, scope); } catch { /* @silent-fallback-ok — the stop itself already ran */ } }
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
   * The queue gave up on a held send (app-conversations-in-the-pool §2.2): the phone's request record is
   * finished in words, as `refused` or `unknown` (appLossState). Nothing re-places the conversation.
   */
  finishExpiredForward(conversationKey: string, messageId: string, words: string, state: 'refused' | 'unknown' = 'refused'): void {
    const rec = this.deps.requests.findSendByMessage(messageId);
    // Separate steps: the row is already gone, so nothing retries this. A failed event must not leave the request reading `waiting`.
    try {
      this.appendDelivery(conversationKey, messageId, state, rec ? `${rec.deviceId}\u0000${rec.requestId}` : `expired\u0000${messageId}`);
    } catch (err) { this.report('expired forward', err); } // @silent-fallback-ok — reported; the request below still gets its words
    try {
      if (rec) this.deps.requests.finish(rec.deviceId, rec.requestId, { status: 409, body: { error: state === 'unknown' ? 'outcome-unknown' : 'not-delivered', outcome: state, expiredForward: true, conversationKey, messageId, deliveryState: state, detail: words } });
    } catch (err) { this.report('expired forward', err); } // @silent-fallback-ok — reported; the message stays stored
  }

  /**
   * A send still reading `waiting` past the queue's limits has lost its row some way the queue never
   * reported: a quarantined store, an engine that never started (app-conversations-in-the-pool §2.2). It
   * can't be known whether the owner took it, so it reads `unknown`, which yields to the owner's outcome.
   */
  private settleOverdueWaiting(): void {
    if (!this.activePool()) return;
    for (const w of this.deps.requests.waitingOlderThan(WAITING_OVERDUE_MS)) {
      if (this.store.deliveryState(w.messageId) === 'pending') {
        this.finishExpiredForward(w.conversationKey, w.messageId, MAY_NOT_BE_DELIVERED, 'unknown');
      } else {
        // It settled by replication: nothing to say beyond what the retry answers from the current state.
        this.deps.requests.finish(w.deviceId, w.requestId, { status: 200, body: { ok: true, outcome: 'settled', expiredForward: true, conversationKey: w.conversationKey, messageId: w.messageId } });
      }
    }
  }

  /**
   * Boot recovery (§4.2 step 8 and §4.1): `entered` requests older than 5 minutes that no live
   * handler owns. A send whose message row is missing was never dispatched → `not-delivered`; a
   * send whose message exists with no delivery event → an `unknown` delivery and
   * `outcome-unknown` (never re-dispatched). An interrupted create/rename/delete re-applies its
   * event from the reservation (same event id, so it merges away) and records `done`.
   */
  recoverStranded(): void {
    try { this.settleOverdueWaiting(); } catch (err) { this.report('overdue waiting', err); } // @silent-fallback-ok — reported; the next tick repeats it
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
        const owner = x.ownerMachine && x.ownerUser ? { machineId: x.ownerMachine, userId: x.ownerUser } : null;
        if (x.ownerUser) this.deps.confineStranded?.(key, x.ownerUser, rec.deviceId);
        const r = this.applyCreate(rec.deviceId, rec.requestId, key, x.title ?? 'Untitled', owner);
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
  /** `ownerPerson`: the MSP phone's person that creates it (people and roles §3.4); null ⇒ the owner's. */
  applyCreate(deviceId: string, requestId: string, conversationKey: string, title: string, ownerPerson: ConversationOwner | null = null): { status: number; body: Record<string, unknown> } {
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
      ...(ownerPerson ? { ownerPerson } : {}),
    });
    if (this.deps.holdsLease()) {
      this.createdHere.add(conversationKey);
      this.deps.registry.bindApp(mint.id);
    }
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
