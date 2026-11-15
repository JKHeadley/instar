/**
 * A platform file is readable on the machine that runs the session (docs/specs/native-conversation-base.md
 * §3c items 4 to 7).
 *
 * Each `media[]` entry of an inbound message is resolved on the serving machine, with no network wait:
 *
 *  - the `platform-media` event and its blob are here → a private session copy, in the forms the
 *    session already reads (`[image:<path>]`, `[document:<path>] (…)`, `[video:<path>]`, `[voice:<path>]`);
 *  - the event is here, the blob is not → `[file still copying: <name>]`, a `pending_deliveries` row
 *    and a pull, exactly as an app message does;
 *  - the event is not here yet → the same line and a durable waiter row in `pending_media_events`;
 *  - native media is off here (or on the poller) → the in-process path when this machine downloaded
 *    the file, else a plain "stored on another machine" line.
 *
 * Waiters are reconciled three ways: the store's append listener (fast path), a sweep at start, and
 * a periodic sweep. Conversion is idempotent, and only the call whose transaction marked a waiter
 * converted goes on to deliver it, so a listener and a sweep racing produce one line. A waiter older
 * than 300 s gets one uncertain line ("has not arrived yet") and keeps waiting; a late event still
 * produces "now available". Nothing here ever says a copy failed: the serving machine cannot tell a
 * refused capture from a slow one.
 *
 * File lines are built here, by server code, from the structured field only. Text a person typed is
 * escaped (`escapeTypedPathTags`) and is never read as a path.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppConversationService } from './AppConversationService.js';
import { availableLine } from './AppConversationService.js';
import { PENDING_DELIVERY_TTL_MS } from './AppMediaReplicator.js';
import { platformMediaMessageId, type AppEvent } from './AppConversationStore.js';
import { canonicalConversationKey } from './appConversationText.js';
import { displayName, type AppAttachment } from './appMediaTypes.js';
import {
  escapeTypedPathTags, mediaIdOf, STORED_ELSEWHERE_LINE, stripFallbackSentences, takeLeadingLegacyTag,
  type InboundMediaLocal, type InboundMediaRef,
} from './inboundMedia.js';

/** When the session is told a file has not arrived (§3c item 5). The existing recoverable ceiling, not a measured value. */
export const MEDIA_EVENT_TELL_AFTER_MS = 300_000;
/** How often the reconciliation sweep runs. */
export const MEDIA_EVENT_SWEEP_MS = 30_000;
/**
 * A `ready` row is retried by the sweep only once it has stayed `ready` this long: longer than
 * `resolvePending`'s own voice-transcript wait (60 s) between claiming a row and typing its line,
 * so the sweep and `resolvePending` never both type a line for one file.
 */
export const READY_RETRY_SETTLE_MS = 90_000;
/** Event lags kept for the review's p99 (§3c item 5, last-but-one bullet). */
const LAG_SAMPLES = 500;

const TELEGRAM_KEY_RE = /^telegram:(-?\d+)$/;

export const PENDING_MEDIA_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS pending_media_events (
  eventId TEXT PRIMARY KEY,
  conversationKey TEXT NOT NULL,
  platformMessageId TEXT NOT NULL,
  displayName TEXT NOT NULL,
  kind TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  toldAt INTEGER,
  convertedAt INTEGER
)`;

export interface PendingMediaEventRow {
  eventId: string; conversationKey: string; platformMessageId: string; displayName: string; kind: string;
  createdAt: number; toldAt: number | null; convertedAt: number | null;
}

export interface PlatformMediaForSessionDeps {
  /** The app conversation service when native media is on here; null otherwise. */
  service: () => AppConversationService | null;
  /** The directories this machine's own Telegram downloads land in (realpath-checked). */
  downloadDirs: () => string[];
  /** Type one line into the session serving this Telegram topic on this machine; true only when typed. */
  injectToTopic: (topicId: number, line: string) => boolean;
  now?: () => number;
  report?: (what: string, err: unknown) => void;
}

/** The tell line, fixed by the spec (FD-15). */
export function notArrivedLine(name: string, conversationKey: string, id: string, idKind: 'platformMessageId' | 'attachmentId' = 'platformMessageId'): string {
  return `The file \`${displayName(name)}\` has not arrived on this machine yet. It may still come, and you will get a line here if it does. To check now: \`GET /conversation-media/path?conversationKey=${conversationKey}&${idKind}=${id}\`.`;
}

/**
 * A waiter for a file sent from the app into a topic (by attachment id) whose message event has not
 * replicated here yet. Its key is `att:<attachmentId>`; the id sits in the `platformMessageId` column.
 */
const ATT_PREFIX = 'att:';

function topicOf(conversationKey: string): number | null {
  const m = TELEGRAM_KEY_RE.exec(conversationKey);
  return m ? Number(m[1]) : null;
}

function localTag(kind: InboundMediaRef['kind'], p: string): string {
  return kind === 'photo' ? `[image:${p}]` : kind === 'video' ? `[video:${p}]` : kind === 'voice' ? `[voice:${p}]` : `[document:${p}]`;
}

export class PlatformMediaForSession {
  private readonly now: () => number;
  private readonly schemaReady = new WeakSet<object>();
  private readonly listening = new WeakSet<object>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly lags: number[] = [];
  private sweeping = false;
  /** When the sweep first saw each `ready` Telegram row (in process; a restart only delays a retry). */
  private readonly readySeenAt = new Map<string, number>();

  constructor(private readonly deps: PlatformMediaForSessionDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private report(what: string, err: unknown): void {
    try { this.deps.report?.(what, err); } catch { /* @silent-fallback-ok — reporting never fails delivery */ }
  }

  /** The service, with the waiter table and the append listener attached once. */
  private svc(): AppConversationService | null {
    let s: AppConversationService | null = null;
    try { s = this.deps.service(); } catch { s = null; } // @silent-fallback-ok — no service reads as native media off here
    if (!s) return null;
    if (!this.schemaReady.has(s)) {
      s.media.indexDb.exec(PENDING_MEDIA_EVENTS_DDL);
      s.media.indexDb.exec('CREATE INDEX IF NOT EXISTS idx_pme_open ON pending_media_events(convertedAt, createdAt)');
      this.schemaReady.add(s);
    }
    if (!this.listening.has(s)) {
      this.listening.add(s);
      // The fast path only: replicated commits fire it too. The sweep is what makes a miss cost
      // one interval instead of a file.
      s.store.addAppendListener((ev: AppEvent) => {
        if (ev.kind === 'platform-media') {
          void this.convertPendingMediaEvent(ev.eventId).catch((err) => this.report('media event listener', err)); // reported: deps.report routes to DegradationReporter (AgentServer wiring)
        } else if (ev.kind === 'media-message') {
          for (const a of ev.attachments) void this.convertPendingMediaEvent(`${ATT_PREFIX}${a.attachmentId}`).catch((err) => this.report('media event listener', err)); // reported: deps.report routes to DegradationReporter (AgentServer wiring)
        }
      });
      s.setPlatformFollowUp((conversationKey, line) => this.followUp(conversationKey, line));
    }
    return s;
  }

  private followUp(conversationKey: string, line: string): boolean {
    const topicId = topicOf(conversationKey);
    if (topicId === null) return false;
    try { return this.deps.injectToTopic(topicId, line) === true; } catch (err) { this.report('follow-up inject', err); return false; }
  }

  /** A path this machine downloaded itself, inside its download directories, or null. */
  private confinedLocal(p: string | undefined): string | null {
    if (!p || !path.isAbsolute(p)) return null;
    try {
      const real = fs.realpathSync(p);
      if (!fs.statSync(real).isFile()) return null;
      const roots = this.deps.downloadDirs().map((d) => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } }); // @silent-fallback-ok — a missing root simply matches nothing
      return roots.some((r) => real.startsWith(`${r}${path.sep}`)) ? real : null;
    } catch { return null; } // @silent-fallback-ok — a missing file is not a local file
  }

  /**
   * The session text for one inbound message: the file lines, then the person's text (escaped).
   * `media === null | undefined` means an older sender: a leading tag is read only for its kind and
   * name, the file is resolved by the message's own platform id, and the path is discarded.
   */
  async buildInboundSessionText(input: {
    conversationKey: string;
    text: string;
    media: ReadonlyArray<InboundMediaLocal> | null | undefined;
    /** The platform message id, for an older sender's message. */
    platformMessageId?: string | null;
  }): Promise<string> {
    let personText = input.text ?? '';
    let entries: InboundMediaLocal[] = [];
    const lines: string[] = [];
    if (input.media) {
      entries = [...input.media];
      personText = stripFallbackSentences(personText, entries);
    } else {
      const lead = takeLeadingLegacyTag(personText);
      if (lead) {
        personText = lead.rest;
        if (lead.path === 'download-failed') {
          lines.push(lead.kind === 'photo' ? '[User sent a photo but the download failed]' : '[User sent a file but the download failed]');
        } else if (input.platformMessageId && /^[0-9A-Za-z._:-]{1,64}$/.test(input.platformMessageId)) {
          entries = [{ kind: lead.kind, platformMessageId: input.platformMessageId, filename: displayName(path.basename(lead.path).replace(/^\d{10,}-/, '')) }];
        } else {
          lines.push(STORED_ELSEWHERE_LINE);
        }
      }
    }
    for (const m of entries) lines.push(await this.lineFor(input.conversationKey, m));
    const escaped = escapeTypedPathTags(personText).replace(/^\n+/, '');
    return [...lines, ...(escaped ? [escaped] : [])].join('\n');
  }

  /**
   * What each file line was, for the maturation row's kill criteria and graduation read (spec
   * "Maturation plan", 3c rows): a cross-machine photo observed means `copied` or `nowAvailable`
   * on a machine that did not download it.
   */
  readonly counts = { copied: 0, local: 0, copying: 0, storedElsewhere: 0, unavailable: 0, converted: 0, toldNotArrived: 0, nowAvailableRetried: 0 };

  private tally(line: string): string {
    if (line.startsWith('[file still copying:')) this.counts.copying++;
    else if (line.startsWith('[file unavailable:')) this.counts.unavailable++;
    else if (line === STORED_ELSEWHERE_LINE) this.counts.storedElsewhere++;
    else this.counts.copied++;
    return line;
  }

  /** One file's line on this machine. Never throws, never waits on the network. */
  async lineFor(conversationKey: string, m: InboundMediaLocal): Promise<string> {
    const line = await this.lineForInner(conversationKey, m);
    if (line.startsWith('[image:') || line.startsWith('[document:') || line.startsWith('[video:') || line.startsWith('[voice:')) {
      if (m.localPath && line.includes(m.localPath)) { this.counts.local++; return line; }
    }
    return this.tally(line);
  }

  private async lineForInner(conversationKey: string, m: InboundMediaLocal): Promise<string> {
    const name = displayName(m.filename);
    try {
      const s = this.svc();
      const found = s && m.capture !== 'off' ? this.findAttachment(s, conversationKey, m) : null;
      if (s && found && 'attachment' in found) {
        // The download itself beats "still copying" on the machine that made it.
        if (!s.media.locateBlob(found.attachment.sha256)) {
          const local = this.confinedLocal(m.localPath);
          if (local) return localTag(m.kind, local);
        }
        // The app's own resolver, with no network wait (FD-8): a private copy (and a voice note's
        // transcript) when the blob is here; otherwise `[file still copying]`, a pending row and a pull.
        const lines = await s.sessionLinesFor(conversationKey, found.messageId, [found.attachment], '', 0);
        return lines[0] ?? `[file unavailable: ${name}]`;
      }
      // Not in the store here (yet): the download itself, when this machine made it.
      const local = this.confinedLocal(m.localPath);
      if (local) return localTag(m.kind, local);
      if (s && found && 'gone' in found) return `[file unavailable: ${name}]`;
      if (s && m.capture !== 'off' && (m.platformMessageId || m.attachmentId)) {
        const late = this.awaitEvent(s, conversationKey, m, name);
        if (late) return this.lineForInner(conversationKey, { ...m, localPath: undefined });
        return `[file still copying: ${name}]`;
      }
      return STORED_ELSEWHERE_LINE;
    } catch (err) {
      // reported: this.report routes to DegradationReporter (AgentServer wiring)
      this.report('media line', err);
      return STORED_ELSEWHERE_LINE;
    }
  }

  private findAttachment(s: AppConversationService, conversationKey: string, m: InboundMediaRef):
    { messageId: string; attachment: AppAttachment } | { gone: true } | null {
    if (m.attachmentId) {
      const ref = s.store.mediaRef(m.attachmentId);
      // No reference yet is the normal case while the app message is still replicating: pending.
      if (!ref) return null;
      if (ref.canonicalKey !== canonicalConversationKey(conversationKey)) return { gone: true };
      if (ref.purged || ref.tombstoned) return { gone: true };
      const a = s.store.getMediaAttachments(conversationKey, ref.messageId)?.[ref.idx];
      return a ? { messageId: ref.messageId, attachment: a } : { gone: true };
    }
    if (!m.platformMessageId) return null;
    const ev = s.store.getPlatformMedia(conversationKey, m.platformMessageId);
    const a = ev?.attachments[0];
    if (!ev || !a) return null;
    if (s.store.isAttachmentPurged(a.attachmentId)) return { gone: true };
    return { messageId: ev.messageId, attachment: a };
  }

  /**
   * Insert the waiter, then look again (§3c item 5, first bullet): an event that landed between the
   * first look and the insert is found by the second look. Returns true when the event is here now;
   * the waiter is then marked converted by this call, so no listener or sweep repeats the line.
   */
  private awaitEvent(s: AppConversationService, conversationKey: string, m: InboundMediaRef, name: string): boolean {
    const byAttachment = !m.platformMessageId;
    const id = (m.platformMessageId ?? m.attachmentId)!;
    const eventId = byAttachment ? `${ATT_PREFIX}${id}` : platformMediaMessageId(conversationKey, id);
    const db = s.media.indexDb;
    db.prepare(`INSERT OR IGNORE INTO pending_media_events (eventId, conversationKey, platformMessageId, displayName, kind, createdAt, toldAt, convertedAt) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run(eventId, conversationKey, id, name, m.kind, this.now());
    if (!this.lookup(s, { eventId, conversationKey, platformMessageId: id })) return false;
    const claimed = db.prepare('UPDATE pending_media_events SET convertedAt = ? WHERE eventId = ? AND convertedAt IS NULL').run(this.now(), eventId);
    return claimed.changes === 1;
  }

  /** The event a waiter waits for, once it is here: its message id and the attachments it brings. */
  private lookup(s: AppConversationService, w: Pick<PendingMediaEventRow, 'eventId' | 'conversationKey' | 'platformMessageId'>): { messageId: string; attachments: AppAttachment[] } | null {
    if (w.eventId.startsWith(ATT_PREFIX)) {
      const ref = s.store.mediaRef(w.platformMessageId);
      if (!ref || ref.canonicalKey !== canonicalConversationKey(w.conversationKey) || ref.purged) return null;
      const a = s.store.getMediaAttachments(w.conversationKey, ref.messageId)?.[ref.idx];
      return a ? { messageId: ref.messageId, attachments: [a] } : null;
    }
    const ev = s.store.getPlatformMedia(w.conversationKey, w.platformMessageId);
    return ev ? { messageId: ev.messageId, attachments: ev.attachments } : null;
  }

  /**
   * Turn a waiter into `pending_deliveries` rows once its event is here (§3c item 5, second bullet).
   * Idempotent: only the call whose transaction set `convertedAt` goes on, and a blob already held
   * here is delivered at once (`resolvePending` fires only when a blob lands). Returns true when this
   * call converted the waiter.
   */
  async convertPendingMediaEvent(eventId: string): Promise<boolean> {
    const s = this.svc();
    if (!s) return false;
    const db = s.media.indexDb;
    const w = db.prepare('SELECT * FROM pending_media_events WHERE eventId = ?').get(eventId) as PendingMediaEventRow | undefined;
    if (!w || w.convertedAt !== null) return false;
    const ev = this.lookup(s, w);
    if (!ev) return false;
    const now = this.now();
    const converted = db.transaction((): boolean => {
      const r = db.prepare('UPDATE pending_media_events SET convertedAt = ? WHERE eventId = ? AND convertedAt IS NULL').run(now, eventId);
      if (r.changes !== 1) return false;
      for (const a of ev.attachments) {
        db.prepare(`INSERT OR IGNORE INTO pending_deliveries (attachmentId, messageId, conversationKey, sha256, displayName, caption, createdAt, state, path) VALUES (?, ?, ?, ?, ?, '', ?, 'waiting', NULL)`)
          .run(a.attachmentId, ev.messageId, w.conversationKey, a.sha256, displayName(a.filename), now);
      }
      return true;
    })();
    if (!converted) return false;
    this.counts.converted++;
    this.recordLag(now - w.createdAt);
    for (const a of ev.attachments) {
      if (s.media.locateBlob(a.sha256)) await s.resolvePending(a.sha256);
      else s.replicator.want(a.sha256);
    }
    return true;
  }

  private recordLag(ms: number): void {
    this.lags.push(Math.max(0, ms));
    if (this.lags.length > LAG_SAMPLES) this.lags.splice(0, this.lags.length - LAG_SAMPLES);
  }

  /** The event lags this machine observed, for the tell-time review. */
  stats(): { waiting: number | 'unknown'; told: number | 'unknown'; readyUndelivered: number | 'unknown'; lagSamples: number; lagP99Ms: number | null; lagMaxMs: number | null; counts: PlatformMediaForSession['counts'] } {
    const sorted = [...this.lags].sort((a, b) => a - b);
    const p99 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)]! : null;
    const base = { lagSamples: sorted.length, lagP99Ms: p99, lagMaxMs: sorted.length ? sorted[sorted.length - 1]! : null, counts: { ...this.counts } };
    const s = this.svc();
    if (!s) return { waiting: 'unknown', told: 'unknown', readyUndelivered: 'unknown', ...base };
    try {
      const db = s.media.indexDb;
      const waiting = (db.prepare('SELECT COUNT(*) AS n FROM pending_media_events WHERE convertedAt IS NULL').get() as { n: number }).n;
      const told = (db.prepare('SELECT COUNT(*) AS n FROM pending_media_events WHERE convertedAt IS NULL AND toldAt IS NOT NULL').get() as { n: number }).n;
      const ready = (db.prepare(`SELECT COUNT(*) AS n FROM pending_deliveries WHERE state = 'ready' AND conversationKey LIKE 'telegram:%'`).get() as { n: number }).n;
      return { waiting, told, readyUndelivered: ready, ...base };
    } catch (err) {
      this.report('stats', err);
      return { waiting: 'unknown', told: 'unknown', readyUndelivered: 'unknown', ...base };
    }
  }

  /**
   * The reconciliation sweep (§3c item 5): convert every waiter whose event is here; retry a
   * "now available" line that found no session; tell a session once, at 300 s, that its file has not
   * arrived (and keep waiting); end a waiter, with no line, at the 7-day pending TTL.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const s = this.svc();
      if (!s) return;
      const db = s.media.indexDb;
      const now = this.now();
      db.prepare('DELETE FROM pending_media_events WHERE convertedAt IS NULL AND createdAt <= ?').run(now - PENDING_DELIVERY_TTL_MS);
      db.prepare('DELETE FROM pending_media_events WHERE convertedAt IS NOT NULL AND convertedAt <= ?').run(now - PENDING_DELIVERY_TTL_MS);
      const open = db.prepare('SELECT * FROM pending_media_events WHERE convertedAt IS NULL ORDER BY createdAt').all() as PendingMediaEventRow[];
      for (const w of open) {
        if (this.lookup(s, w)) {
          await this.convertPendingMediaEvent(w.eventId).catch((err) => this.report('sweep convert', err));
          continue;
        }
        if (w.toldAt === null && now - w.createdAt >= MEDIA_EVENT_TELL_AFTER_MS) {
          // toldAt is written only after the line was typed; with no session the next pass retries.
          if (this.followUp(w.conversationKey, notArrivedLine(w.displayName, w.conversationKey, w.platformMessageId, w.eventId.startsWith(ATT_PREFIX) ? 'attachmentId' : 'platformMessageId'))) {
            db.prepare('UPDATE pending_media_events SET toldAt = ? WHERE eventId = ? AND toldAt IS NULL').run(now, w.eventId);
            this.counts.toldNotArrived++;
          }
        }
      }
      // A Telegram file that landed while no session ran for its topic: nothing else reads a `ready`
      // row for a Telegram key, so the sweep re-tries the line and deletes the row only once typed.
      const ready = db.prepare(`SELECT attachmentId, conversationKey, path, caption, createdAt FROM pending_deliveries WHERE state = 'ready' AND path IS NOT NULL AND conversationKey LIKE 'telegram:%' ORDER BY createdAt`).all() as Array<{ attachmentId: string; conversationKey: string; path: string; caption: string; createdAt: number }>;
      const stillReady = new Set(ready.map((r) => r.attachmentId));
      for (const id of [...this.readySeenAt.keys()]) if (!stillReady.has(id)) this.readySeenAt.delete(id);
      for (const r of ready) {
        const seen = this.readySeenAt.get(r.attachmentId);
        if (seen === undefined) { this.readySeenAt.set(r.attachmentId, now); continue; }
        if (now - seen < READY_RETRY_SETTLE_MS) continue;
        if (this.followUp(r.conversationKey, availableLine(r.path, r.caption))) {
          db.prepare(`DELETE FROM pending_deliveries WHERE attachmentId = ? AND state = 'ready'`).run(r.attachmentId);
          this.counts.nowAvailableRetried++;
        } else if (now - r.createdAt > PENDING_DELIVERY_TTL_MS) {
          db.prepare(`DELETE FROM pending_deliveries WHERE attachmentId = ? AND state = 'ready'`).run(r.attachmentId);
        }
      }
      // Telegram rows the app's expiry marked `expired` are read by nothing; they end here.
      db.prepare(`DELETE FROM pending_deliveries WHERE state = 'expired' AND conversationKey LIKE 'telegram:%'`).run();
    } catch (err) {
      // reported: this.report routes to DegradationReporter (AgentServer wiring)
      this.report('media event sweep', err);
    } finally {
      this.sweeping = false;
    }
  }

  /** Runs the sweep now (the start-up reconciliation) and then periodically. */
  start(intervalMs = MEDIA_EVENT_SWEEP_MS): void {
    if (this.timer) return;
    void this.sweep();
    this.timer = setInterval(() => { void this.sweep(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** The machine-wide instance, set where the server wires the Telegram adapter. */
let active: PlatformMediaForSession | null = null;
export function setPlatformMediaForSession(p: PlatformMediaForSession | null): void { active = p; }
export function getPlatformMediaForSession(): PlatformMediaForSession | null { return active; }

/** The id helper the fetch route and the tell line share. */
export { mediaIdOf };

let fallback: PlatformMediaForSession | null = null;
const chains = new Map<number, Promise<void>>();

/**
 * The text a Telegram topic's session is given for one inbound message (§3c): file lines built by
 * server code from `media[]`, then the person's text with every typed path tag inert. Used at every
 * place a message reaches a session: the live inject, a respawn or spawn bootstrap, the owner side
 * of a forward, the inbound queue's drain and the forward route's own fallback.
 *
 * One topic's messages are built in arrival order, so a photo (whose copy is async) and the text after
 * it reach the session in that order: each caller injects synchronously once its build resolves, and
 * the next build starts only after that.
 */
export function buildTelegramSessionText(
  topicId: number,
  text: string,
  media: ReadonlyArray<InboundMediaLocal> | null | undefined,
  platformMessageId: number | string | null | undefined,
): Promise<string> {
  const p = active ?? (fallback ??= new PlatformMediaForSession({ service: () => null, downloadDirs: () => [], injectToTopic: () => false }));
  const prev = chains.get(topicId) ?? Promise.resolve();
  const run = prev.then(() => p.buildInboundSessionText({
    conversationKey: `telegram:${topicId}`, text, media,
    platformMessageId: platformMessageId == null ? null : String(platformMessageId).replace(/^\D*/, '') || null,
  }));
  const tail = run.then(() => undefined, () => undefined);
  chains.set(topicId, tail);
  void tail.then(() => { if (chains.get(topicId) === tail) chains.delete(topicId); });
  return run;
}
