/**
 * ConversationUnreadService — unread counts, read reports and the app badge for one machine
 * (docs/specs/mobile-unread-messages.md §3.4–§3.6).
 *
 * It owns the replicated marker store and reads the three message sources the conversation list
 * already loads: the app conversation store, the Telegram in-memory tail and the Slack log tail.
 * For one reader and one conversation held here it computes the **effective position** (the
 * marker, else the baseline, moved forward by the reader's own newest message — "your own reply
 * marks everything before it as read"), walks the newest messages backwards and counts the ones
 * after it that are not the reader's own. Counts are exact to 100, then a floor (`unreadMore`).
 *
 * A read report names a message; the holder stores its own position for a message it has, limits
 * a position for one it does not hold to its newest message, and forwards a mark for a
 * conversation held elsewhere exactly once. The badge is the reader's unread over app
 * conversations only, computed identically on every machine.
 *
 * @self-action-controller: read-marker-catch-up-retry — a peer whose catch-up fails is retried every
 * CATCH_UP_RETRY_MS, at most CATCH_UP_MAX_FAILURES times in a row; then it waits for the peer to come
 * back (onPeerOnline) or the next boot. Proven in tests/unit/self-action-convergence.test.ts.
 */
import type { OwnerIdentity, ResolvedPerson, ConversationOwner } from './MobilePeople.js';
import type { BrowsedMessage, ConversationSummary } from './AppConversationStore.js';
import type { PoolPeerTarget, RopeResultRecorder } from '../server/poolPeerFetch.js';
import { poolPeerFetch } from '../server/poolPeerFetch.js';
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from '../server/peerUrlGuard.js';
import {
  ConversationReadMarkerStore, accessRefOf, type CatchUpState, atMsOf, canonicalConversationRef, comparePositions, countUnread, isMessagePosition,
  parseReaderKey, readerKeyFor, telegramRowId, isReaderKey, CATCH_UP_PAGE,
  type CountRow, type CountResult, type MessagePosition,
} from './ConversationReadMarkers.js';

// ── Sources ────────────────────────────────────────────────────────────────────────────────────

/** The fields of a Telegram log row the count reads (TelegramAdapter's LogEntry, structurally). */
export interface TelegramRowLike {
  messageId: number; timestamp: string; fromUser: boolean; eventId?: string; telegramUserId?: number;
  via?: string; senderRole?: string; senderPerson?: { machineId: string; userId: string }; teamPhone?: boolean;
}
export interface UnreadTelegramSource {
  /** The newest `limit` rows of a topic, oldest first (the in-memory tail; never a disk scan). */
  history: (topicId: number, limit: number) => ReadonlyArray<TelegramRowLike>;
  /** The tail's append counter: the local revision a count is cached on. */
  version: (topicId: number) => number;
  /** Is this topic one this machine lists? */
  exists: (topicId: number) => boolean;
}

/** One Slack row the count reads (the bridge's history row plus the sender's Slack user id). */
export interface SlackRowLike { ts: string; at: string; fromUser: boolean; eventId?: string; platformUserId?: string | null }
export interface UnreadSlackSource {
  /** The rows of a LOCAL Slack conversation (oldest first) and its store key; null when not held here. */
  rows: (id: number) => { key: string; rows: ReadonlyArray<SlackRowLike>; complete: boolean } | null;
  /** The log tail's size and modification time, the local revision a count is cached on. */
  version: (id: number) => string;
}

export type UnreadAppStore = {
  browseMessages(conversationKey: string, before: string | null | undefined, limit?: number): { messages: BrowsedMessage[]; nextBefore: string | null };
  getConversation(conversationKey: string): ConversationSummary | null;
  listConversations(opts?: { limit?: number; cursor?: string | null }): { conversations: ConversationSummary[]; nextCursor: string | null };
  eventAt(conversationKey: string, eventId: string): string | null;
  newestIngestSeq(conversationKey: string): number;
};

export interface ConversationUnreadDeps {
  store: ConversationReadMarkerStore;
  /** `mobilePairing.native.unread.enabled` with native chat on, read live. */
  enabled: () => boolean;
  machineId: () => string;
  app: UnreadAppStore | null;
  telegram?: UnreadTelegramSource | null;
  slack?: UnreadSlackSource | null;
  ownerIdentity: () => OwnerIdentity;
  /** §3.5 `personOfReaderKey`: a key to a person through THIS machine's records, or null. */
  personOfReaderKey: (key: string) => ResolvedPerson | null;
  /**
   * §3.2 positive evidence that a reader is GONE on this machine (a revoked person in a healthy
   * record): never "not known here yet" (a team log that is absent or unreadable, a registry that
   * cannot be read). Absent ⇒ no reader is ever treated as removed.
   */
  readerRemoved?: (key: string) => boolean;
  /** The one shared conversation access check (`MobilePairingService.mayUse`). */
  mayUse: (person: ResolvedPerson, ref: string, op?: 'read') => boolean;
  /**
   * Team access 2b: whether this reader may see one stored app message (a row held from them is
   * not counted, so a count never announces it). Absent ⇒ every row of a readable conversation counts.
   */
  mayReadMessage?: (person: ResolvedPerson, conversationKey: string, m: BrowsedMessage) => boolean;
  /** The pool's peers, for forwarding a mark and for the boot catch-up. Absent ⇒ one machine. */
  peers?: () => PoolPeerTarget[];
  peerAllowlist?: () => string[] | undefined;
  authToken: () => string;
  recordRope?: RopeResultRecorder;
  fetchImpl?: typeof fetch;
  /** The machine's hybrid logical clock, in ms (never behind a time learned from a peer). */
  hlcNowMs?: () => number;
  now?: () => number;
  report?: (what: string, detail: string) => void;
}

export interface Reader {
  key: string;
  /** Null when the key does not resolve on this machine (`reader-unknown-here`). */
  person: ResolvedPerson | null;
  /** A phone's own request (creates a baseline); false for the agent's forwarded `reader=` read. */
  viaDevice: boolean;
}

export interface UnreadFields {
  hasUnread: boolean;
  unreadCount?: number;
  unreadMore?: true;
  readUpTo: MessagePosition | null;
}

export interface ReadMark { ref: string; id: string; atMs: number; machine?: string }
export type ReadMarkError = 'bad-mark' | 'unknown-conversation' | 'pending' | 'reader-unknown-here';
export interface ReadMarkResult { ref: string; ok: boolean; readUpTo?: MessagePosition; unreadCount?: number; unreadMore?: true; error?: ReadMarkError }

export const MAX_MARKS = 50;
export const CATCH_UP_RETRY_MS = 5 * 60_000;
/** Consecutive failures after which a peer's catch-up waits for the peer to come back (§3.3 brake). */
export const CATCH_UP_MAX_FAILURES = 12;

/**
 * The catch-up's one pacing decision: a peer is asked again when its catch-up is incomplete, its last
 * attempt is at least CATCH_UP_RETRY_MS ago, and it has not failed CATCH_UP_MAX_FAILURES times in a row.
 * A returning peer (onPeerOnline) resets the failure count, so the brake never strands a live peer.
 */
export function catchUpAttemptDue(state: Pick<CatchUpState, 'done' | 'lastAttemptAt' | 'failures'>, nowMs: number, opts: { force?: boolean } = {}): boolean {
  if (state.done) return false;
  if (opts.force) return true;
  if (state.failures >= CATCH_UP_MAX_FAILURES) return false;
  return state.lastAttemptAt === null || nowMs - state.lastAttemptAt >= CATCH_UP_RETRY_MS;
}
export const CATCH_UP_PAGE_TIMEOUT_MS = 5000;
export const CATCH_UP_MAX_PEERS = 16;
export const GC_INTERVAL_MS = 60 * 60_000;
const COUNT_CACHE_MAX = 5000;
/** A row whose activity is more than this before the position has nothing new (§3.4 pre-filter). */
const PRE_FILTER_MARGIN_MS = 1000;

type Sender =
  | { kind: 'agent' }
  | { kind: 'operator'; viaApp: boolean; role?: string; person?: ConversationOwner | null; telegramUserId?: number | null; slackUserId?: string | null };
interface RawRow extends MessagePosition { sender: Sender }
interface SourceRows { rows: RawRow[]; complete: boolean; rev: string }

export class ConversationUnreadService {
  readonly store: ConversationReadMarkerStore;
  private readonly now: () => number;
  private readonly cache = new Map<string, { posKey: string; rev: string; result: CountResult }>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private catchingUp = false;

  constructor(private readonly deps: ConversationUnreadDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  enabled(): boolean { return this.deps.enabled(); }
  machineId(): string { return this.deps.machineId(); }

  // ── Readers (§3.1, §3.5) ──

  /**
   * The reader of a request: a phone's person, or the agent's forwarded `reader=` key. A Bearer
   * request without a key has no reader; a device request ignores `reader=`.
   */
  resolveReader(input: { person: ResolvedPerson | null; viaDevice: boolean; readerParam?: unknown }): Reader | null {
    if (input.viaDevice) {
      const key = readerKeyFor(input.person, this.deps.machineId());
      return key && input.person ? { key, person: input.person, viaDevice: true } : null;
    }
    if (!isReaderKey(input.readerParam)) return null;
    return { key: input.readerParam, person: this.deps.personOfReaderKey(input.readerParam), viaDevice: false };
  }

  /** A phone seen here gets its baseline once the first catch-up has settled (§3.2, §3.3). Never for a Bearer read. */
  touchBaseline(reader: Reader): void {
    if (!reader.viaDevice || this.store.hasBaseline(reader.key) || !this.store.catchUpSettled()) return;
    const wall = this.now();
    const hlc = this.deps.hlcNowMs?.() ?? wall;
    this.store.setBaseline(reader.key, Math.min(Number.isFinite(hlc) ? hlc : wall, wall));
  }

  private mayRead(reader: Reader, ref: string): boolean {
    if (!reader.person) return false;
    try { return this.deps.mayUse(reader.person, accessRefOf(ref), 'read'); } catch { return false; } // @silent-fallback-ok — fail closed: an unanswerable check shows no read fields
  }

  // ── Counting (§3.4) ──

  /** The pre-filter: something after the stored position, without a walk. */
  preFilterHasUnread(reader: Reader, ref: string, lastActivity: string | null): boolean {
    const pos = this.store.storedPosition(reader.key, ref);
    if (!pos) return false;
    const act = atMsOf(lastActivity);
    if (act === null) return false;
    return act >= pos.atMs - PRE_FILTER_MARGIN_MS;
  }

  /**
   * The read fields of one list row for a reader (§3.5), or null when the reader may not use the
   * conversation or the key does not resolve here. Absent `unreadCount` means unknown.
   */
  rowFields(reader: Reader, row: { platform: 'app' | 'telegram' | 'slack'; id: string | number; lastActivity: string | null; machine?: string | null }): UnreadFields | null {
    // A count must never take the list down: a source that throws leaves this row without read fields.
    try { return this.rowFieldsUnguarded(reader, row); } catch (err) { this.reportOnce('ConversationUnread.rowFields', err); return null; } // @silent-fallback-ok — reported; the row shows no read fields
  }

  private rowFieldsUnguarded(reader: Reader, row: { platform: 'app' | 'telegram' | 'slack'; id: string | number; lastActivity: string | null; machine?: string | null }): UnreadFields | null {
    const ref = this.refOfRow(row);
    if (!ref || !this.mayRead(reader, ref)) return null;
    const stored = this.store.storedPosition(reader.key, ref);
    if (!stored) return { hasUnread: false, unreadCount: 0, readUpTo: null };
    if (!this.preFilterHasUnread(reader, ref, row.lastActivity)) return { hasUnread: false, unreadCount: 0, readUpTo: stored };
    const c = this.countFor(reader, ref);
    if (!c) return { hasUnread: true, readUpTo: stored };
    return { hasUnread: c.count > 0 || c.more, unreadCount: c.count, ...(c.more ? { unreadMore: true as const } : {}), readUpTo: c.effective ?? stored };
  }

  /** The reader's effective position in a conversation, for the history divider (§3.5). */
  readUpTo(reader: Reader, ref: string): MessagePosition | null {
    try {
      if (!this.mayRead(reader, ref)) return null;
      const stored = this.store.storedPosition(reader.key, ref);
      if (!stored) return null;
      const c = this.countFor(reader, ref);
      return c?.effective ?? stored;
    } catch (err) { this.reportOnce('ConversationUnread.readUpTo', err); return null; } // @silent-fallback-ok — reported; the history read answers without a divider
  }

  private lastReportAt = new Map<string, number>();
  /** One degradation report per minute per site, so a broken source does not flood the reporter. */
  private reportOnce(what: string, err: unknown): void {
    const t = this.now();
    const last = this.lastReportAt.get(what);
    if (last !== undefined && t - last < 60_000) return;
    this.lastReportAt.set(what, t);
    this.deps.report?.(what, err instanceof Error ? err.message : String(err));
  }

  /** Count for one reader and one conversation held here; null when the source is not available. */
  countFor(reader: Reader, ref: string): CountResult | null {
    const stored = this.store.storedPosition(reader.key, ref);
    if (!stored) return { count: 0, more: false, ownNewest: null, effective: null };
    const src = this.sourceRows(ref, reader);
    if (!src) return null;
    const posKey = `${stored.atMs}:${stored.id}`;
    const ck = `${reader.key}\u0000${ref}`;
    const hit = this.cache.get(ck);
    if (hit && hit.posKey === posKey && hit.rev === src.rev) return hit.result;
    const rows: CountRow[] = src.rows.map((r) => ({ atMs: r.atMs, id: r.id, own: this.isOwn(reader, r.sender) }));
    const result = countUnread(rows, stored, src.complete);
    // An own message after the stored marker is stored as an ordinary local advance (§3.4), so the
    // inference survives the message ageing out of the bounded history.
    if (result.ownNewest && comparePositions(result.ownNewest, stored) > 0) this.store.advance(reader.key, ref, result.ownNewest);
    const after = this.store.storedPosition(reader.key, ref) ?? stored;
    if (this.cache.size >= COUNT_CACHE_MAX) this.cache.clear();
    this.cache.set(ck, { posKey: `${after.atMs}:${after.id}`, rev: src.rev, result });
    return result;
  }

  private refOfRow(row: { platform: string; id: string | number; machine?: string | null }): string | null {
    if (row.platform === 'app') return canonicalConversationRef(String(row.id));
    if (row.platform === 'telegram') return canonicalConversationRef(`telegram:${String(row.id)}`);
    if (row.platform === 'slack') return canonicalConversationRef(`slack:${row.machine ?? this.deps.machineId()}:${String(row.id)}`);
    return null;
  }

  /** Is this conversation held on this machine? (the message source is here) */
  holdsRef(ref: string): boolean {
    if (ref.startsWith('app:')) { const c = this.deps.app?.getConversation(ref.slice(4)); return !!c && !c.tombstoned; }
    if (ref.startsWith('telegram:')) { const id = Number(ref.slice(9)); return !!this.deps.telegram && (this.deps.telegram.exists(id) || this.deps.telegram.history(id, 1).length > 0); }
    const m = /^slack:([\w-]+):(-\d+)$/.exec(ref);
    if (!m) return false;
    return m[1] === this.deps.machineId() && !!this.deps.slack && this.deps.slack.rows(Number(m[2])) !== null;
  }

  /** The conversation's rows newest first, from the source the list already loads. */
  private sourceRows(ref: string, reader?: Reader): SourceRows | null {
    if (ref.startsWith('app:')) {
      const key = ref.slice(4);
      const app = this.deps.app;
      if (!app) return null;
      const conv = app.getConversation(key);
      if (!conv || conv.tombstoned) return null;
      const page = app.browseMessages(key, null, 100);
      const rows: RawRow[] = [];
      const mayRead = this.deps.mayReadMessage;
      const person = reader?.person ?? null;
      let held = 0;
      for (const m of page.messages) {
        if (mayRead && person && !mayRead(person, key, m)) { held++; continue; }
        const atMs = atMsOf(m.at);
        if (atMs === null) continue;
        rows.push({ atMs, id: m.eventId, sender: m.role === 'agent' ? { kind: 'agent' } : { kind: 'operator', viaApp: true, role: m.senderRole, person: m.senderPerson ?? null } });
      }
      rows.reverse();
      // A grant that shows a held row changes the count without a new message, so it changes `rev` too.
      return { rows, complete: page.nextBefore === null, rev: `${app.newestIngestSeq(key)}:${held}` };
    }
    if (ref.startsWith('telegram:')) {
      const tg = this.deps.telegram;
      if (!tg) return null;
      const topicId = Number(ref.slice(9));
      let history = tg.history(topicId, 100);
      let complete = history.length < 100;
      if (!complete) {
        // The whole in-memory tail, still no disk read (§3.4): the marker may be past the first page.
        const more = tg.history(topicId, 500);
        complete = more.length < 500;
        history = more;
      }
      const rows: RawRow[] = [];
      for (const r of history) {
        const atMs = atMsOf(r.timestamp);
        const id = telegramRowId(r);
        if (atMs === null || !id) continue;
        rows.push({ atMs, id, sender: r.fromUser
          ? { kind: 'operator', viaApp: r.via === 'mobile-device', role: r.senderRole, person: r.senderPerson ?? null, telegramUserId: r.telegramUserId ?? null }
          : { kind: 'agent' } });
      }
      rows.reverse();
      return { rows, complete, rev: String(tg.version(topicId)) };
    }
    const m = /^slack:([\w-]+):(-\d+)$/.exec(ref);
    if (!m || m[1] !== this.deps.machineId() || !this.deps.slack) return null;
    const id = Number(m[2]);
    const held = this.deps.slack.rows(id);
    if (!held) return null;
    const byId = new Map<string, RawRow>();
    // App-sent messages from the store (their sender fields are recorded there).
    if (this.deps.app) {
      try {
        for (const s of this.deps.app.browseMessages(held.key, null, 100).messages) {
          const atMs = atMsOf(s.at);
          if (atMs === null) continue;
          byId.set(s.eventId, { atMs, id: s.eventId, sender: s.role === 'agent' ? { kind: 'agent' } : { kind: 'operator', viaApp: true, role: s.senderRole, person: s.senderPerson ?? null } });
        }
      } catch { /* @silent-fallback-ok — the Slack rows still count */ }
    }
    for (const r of held.rows) {
      const atMs = atMsOf(r.at);
      if (atMs === null) continue;
      const id = r.eventId && /^[A-Za-z0-9._:-]{1,160}$/.test(r.eventId) ? r.eventId : `slack:${r.ts}`;
      if (byId.has(id)) continue;
      byId.set(id, { atMs, id, sender: r.fromUser ? { kind: 'operator', viaApp: !!r.eventId, slackUserId: r.platformUserId ?? null, person: null } : { kind: 'agent' } });
    }
    const rows = [...byId.values()].sort((a, b) => comparePositions(b, a));
    return { rows, complete: held.complete, rev: this.deps.slack.version(id) };
  }

  /** "Own messages" per platform and reader (§3.4). */
  private isOwn(reader: Reader, s: Sender): boolean {
    if (s.kind !== 'operator') return false;
    const r = parseReaderKey(reader.key);
    if (!r) return false;
    if (r.role === 'owner') {
      if (s.viaApp) return s.role === undefined || s.role === 'owner';
      const owner = this.deps.ownerIdentity();
      if (typeof s.telegramUserId === 'number' && owner.telegramOwnerId !== null) return s.telegramUserId === owner.telegramOwnerId;
      if (typeof s.slackUserId === 'string' && s.slackUserId && owner.slackOwnerUserId) return s.slackUserId === owner.slackOwnerUserId;
      return false;
    }
    if (r.role === 'msp') return !!s.person && s.person.machineId === r.machineId && s.person.userId === r.userId;
    return !!s.person && s.person.userId === r.personKey && (s.role === 'team' || s.role === undefined);
  }

  // ── The badge (§3.6) ──

  /**
   * The reader's unread total over app conversations the person may use. `triggering` names the
   * reply that caused the push; it counts even when its replica has not landed here yet.
   */
  badgeFor(reader: Reader, triggering?: { conversationKey: string; messageId: string }): number | null {
    if (!this.enabled() || !reader.person || !this.deps.app) return null;
    try {
      let total = 0;
      let cursor: string | null = null;
      let pages = 0;
      let sawTrigger = false;
      do {
        const page = this.deps.app.listConversations({ limit: 200, cursor });
        for (const c of page.conversations) {
          if (c.tombstoned) continue;
          const ref = `app:${c.conversationKey.toLowerCase()}`;
          const f = this.rowFields(reader, { platform: 'app', id: c.conversationKey, lastActivity: c.lastActivity ?? c.createdAt });
          if (!f) continue;
          if (triggering && c.conversationKey.toLowerCase() === triggering.conversationKey.toLowerCase()) {
            sawTrigger = true;
            const stored = this.deps.app.eventAt(c.conversationKey, triggering.messageId) ?? this.hasMessageId(c.conversationKey, triggering.messageId);
            if (!stored && this.mayRead(reader, ref)) total += 1;
          }
          total += f.unreadCount ?? (f.hasUnread ? 1 : 0);
        }
        cursor = page.nextCursor;
      } while (cursor && ++pages < 25);
      if (triggering && !sawTrigger && this.mayRead(reader, `app:${triggering.conversationKey.toLowerCase()}`)) total += 1;
      return total;
    } catch (err) {
      this.deps.report?.('ConversationUnread.badge', err instanceof Error ? err.message : String(err)); // @silent-fallback-ok — the push still sends without a badge
      return null;
    }
  }

  private hasMessageId(conversationKey: string, messageId: string): string | null {
    try {
      const page = this.deps.app!.browseMessages(conversationKey, null, 100);
      const m = page.messages.find((x) => x.messageId === messageId || x.eventId === messageId);
      return m ? m.at : null;
    } catch { return null; } // @silent-fallback-ok — unknown ⇒ counted as new
  }

  // ── Read reports (§3.5) ──

  /** Validate the body's marks: 1–50, each a canonical ref, an id and an integer time. */
  static parseMarks(raw: unknown): ReadMark[] | null {
    if (!raw || typeof raw !== 'object') return null;
    const marks = (raw as { marks?: unknown }).marks;
    if (!Array.isArray(marks) || marks.length < 1 || marks.length > MAX_MARKS) return null;
    const out: ReadMark[] = [];
    for (const m of marks) {
      if (!m || typeof m !== 'object') return null;
      const x = m as Record<string, unknown>;
      const ref = canonicalConversationRef(x.ref);
      if (!ref || !isMessagePosition({ atMs: x.atMs, id: x.id })) return null;
      const machine = typeof x.machine === 'string' && /^[\w-]{1,64}$/.test(x.machine) ? x.machine : undefined;
      out.push({ ref, id: x.id as string, atMs: x.atMs as number, ...(machine ? { machine } : {}) });
    }
    return out;
  }

  /**
   * Apply a report. `forwarded` is the `reader=` path: a mark is never forwarded again from here.
   * Each mark is answered on its own; a refused mark never affects the others.
   */
  async report(reader: Reader, marks: ReadMark[], opts: { forwarded: boolean }): Promise<ReadMarkResult[]> {
    const out: ReadMarkResult[] = [];
    for (const mark of marks) out.push(await this.applyMark(reader, mark, opts.forwarded));
    return out;
  }

  private async applyMark(reader: Reader, mark: ReadMark, forwarded: boolean): Promise<ReadMarkResult> {
    const ref = mark.ref;
    if (!reader.person) return { ref, ok: false, error: 'reader-unknown-here' };
    if (!this.holdsRef(ref)) {
      if (ref.startsWith('app:') && this.deps.app?.getConversation(ref.slice(4))?.tombstoned) return { ref, ok: false, error: 'unknown-conversation' };
      // A conversation held elsewhere: forward once to the machine the phone names (§3.5).
      if (forwarded) return { ref, ok: false, error: 'unknown-conversation' };
      const target = this.forwardTarget(ref, mark.machine);
      if (!target) return { ref, ok: false, error: 'pending' };
      return this.forwardMark(target, reader.key, mark);
    }
    // The access check on the holder: the one shared check for a phone; on the forwarded path the
    // same check through the person the key resolved to (never the Bearer pass-through).
    if (!this.mayRead(reader, ref)) return { ref, ok: false, error: 'unknown-conversation' };
    const held = this.positionOfMessage(ref, mark.id);
    let pos: MessagePosition;
    if (held) pos = held;
    else {
      // Not held (older than the tail, or not replicated yet): the phone's position, limited to no later
      // than the newest message here, so a report can never mark a future message read.
      // With no message held at all, the ceiling is now: a report can never mark a future message read.
      const newest = this.newestPosition(ref) ?? { atMs: Math.min(this.now(), this.deps.hlcNowMs?.() ?? this.now()), id: mark.id };
      pos = comparePositions({ atMs: mark.atMs, id: mark.id }, newest) > 0 ? newest : { atMs: mark.atMs, id: mark.id };
    }
    this.store.advance(reader.key, ref, pos);
    this.touchBaseline(reader);
    this.cache.delete(`${reader.key}\u0000${ref}`);
    const c = this.countFor(reader, ref);
    const readUpTo = c?.effective ?? this.store.storedPosition(reader.key, ref) ?? pos;
    return { ref, ok: true, readUpTo, ...(c ? { unreadCount: c.count, ...(c.more ? { unreadMore: true as const } : {}) } : {}) };
  }

  /** The stored position of a message this machine holds, by its id (§3.5). */
  private positionOfMessage(ref: string, id: string): MessagePosition | null {
    if (ref.startsWith('app:')) {
      const at = this.deps.app?.eventAt(ref.slice(4), id);
      const atMs = atMsOf(at);
      return atMs === null ? null : { atMs, id };
    }
    const src = this.sourceRows(ref);
    const row = src?.rows.find((r) => r.id === id);
    return row ? { atMs: row.atMs, id: row.id } : null;
  }

  private newestPosition(ref: string): MessagePosition | null {
    const src = this.sourceRows(ref);
    const r = src?.rows[0];
    return r ? { atMs: r.atMs, id: r.id } : null;
  }

  private forwardTarget(ref: string, machine: string | undefined): PoolPeerTarget | null {
    const m = /^slack:([\w-]+):/.exec(ref);
    const wanted = m ? m[1] : machine;
    if (!wanted || wanted === this.deps.machineId()) return null;
    return (this.deps.peers?.() ?? []).find((p) => p.machineId === wanted) ?? null;
  }

  private async forwardMark(peer: PoolPeerTarget, readerKey: string, mark: ReadMark): Promise<ReadMarkResult> {
    const allow = this.deps.peerAllowlist?.();
    if (!isPeerUrlAllowedForCredentials({ url: peer.url, kind: (peer.kind ?? null) as PeerEndpointKind }, allow).ok) return { ref: mark.ref, ok: false, error: 'pending' };
    try {
      const r = await poolPeerFetch(this.deps.recordRope, peer, `/mobile/conversations/read?reader=${encodeURIComponent(readerKey)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.deps.authToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ marks: [{ ref: mark.ref, id: mark.id, atMs: mark.atMs }] }), signal: AbortSignal.timeout(CATCH_UP_PAGE_TIMEOUT_MS), redirect: 'manual',
      }, this.deps.fetchImpl ?? fetch);
      if (!r.ok) return { ref: mark.ref, ok: false, error: 'pending' };
      const body = JSON.parse(await r.text()) as { results?: unknown };
      const first = Array.isArray(body.results) ? body.results[0] as Record<string, unknown> | undefined : undefined;
      if (!first || first.ref !== mark.ref) return { ref: mark.ref, ok: false, error: 'pending' };
      if (first.ok === true) {
        const readUpTo = isMessagePosition(first.readUpTo) ? first.readUpTo : { atMs: mark.atMs, id: mark.id };
        // The holder's advance reaches this machine by replication; the answer is passed through.
        return { ref: mark.ref, ok: true, readUpTo, ...(typeof first.unreadCount === 'number' && Number.isSafeInteger(first.unreadCount) && first.unreadCount >= 0 ? { unreadCount: first.unreadCount } : {}), ...(first.unreadMore === true ? { unreadMore: true as const } : {}) };
      }
      const err = first.error;
      return { ref: mark.ref, ok: false, error: err === 'unknown-conversation' || err === 'reader-unknown-here' ? err : 'pending' };
    } catch { return { ref: mark.ref, ok: false, error: 'pending' }; } // @silent-fallback-ok — the phone keeps a pending mark and sends it again
  }

  // ── Catch-up between machines (§3.3) ──

  exportPage(cursor: string | null, limit?: number) { return this.store.exportPage(cursor, limit ?? CATCH_UP_PAGE); }

  /** Boot, and every 5 minutes while a peer's catch-up is incomplete. One run at a time. */
  private catchUpAttempts = 0;

  async catchUp(only?: ReadonlyArray<string>): Promise<{ peers: number; landed: number; failed: string[] }> {
    const result = { peers: 0, landed: 0, failed: [] as string[] };
    if (this.catchingUp) return result;
    this.catchingUp = true;
    try {
      const all = this.deps.peers?.() ?? [];
      const peers = all.slice(0, CATCH_UP_MAX_PEERS).filter((p) => !only || only.includes(p.machineId));
      if (!only) this.catchUpAttempts++;
      const allow = this.deps.peerAllowlist?.();
      await Promise.all(peers.map(async (p) => {
        const st = this.store.catchUpState(p.machineId);
        // The pacing decision: done, or braked after repeated failures, or asked too recently ⇒ not now.
        // A named peer (it came back online) is always asked, with its failure count reset.
        if (!catchUpAttemptDue(st, this.now(), { force: !!only })) return;
        if (only) st.failures = 0;
        result.peers++;
        if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: (p.kind ?? null) as PeerEndpointKind }, allow).ok) { result.failed.push(p.machineId); return; }
        let cursor = st.cursor;
        let landed = 0;
        try {
          for (let pages = 0; pages < 10_000; pages++) {
            const r = await poolPeerFetch(this.deps.recordRope, p, `/mobile/conversations/read-markers?limit=${CATCH_UP_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
              headers: { Authorization: `Bearer ${this.deps.authToken()}` }, signal: AbortSignal.timeout(CATCH_UP_PAGE_TIMEOUT_MS), redirect: 'manual',
            }, this.deps.fetchImpl ?? fetch);
            if (r.status === 404 || r.status === 503) { // an older peer, or unread off there: nothing to merge, and nothing to retry
              this.store.setCatchUpState(p.machineId, { cursor: null, done: true, lastAttemptAt: this.now(), failures: st.failures });
              return;
            }
            if (!r.ok) throw new Error(`http-${r.status}`);
            const text = await r.text();
            if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('too-large');
            const body = JSON.parse(text) as { records?: unknown; nextCursor?: unknown };
            for (const rec of Array.isArray(body.records) ? body.records : []) if (this.store.ingestReplicated(rec) === 'accepted') landed++;
            cursor = typeof body.nextCursor === 'string' && /^[0-9a-f]{64}$/.test(body.nextCursor) ? body.nextCursor : null;
            this.store.setCatchUpState(p.machineId, { cursor, done: cursor === null, lastAttemptAt: this.now(), failures: 0 });
            if (cursor === null) break;
          }
          result.landed += landed;
        } catch (err) {
          // @silent-fallback-ok — the cursor is kept; the 5-minute retry resumes this peer from it
          const failures = st.failures + 1;
          this.store.setCatchUpState(p.machineId, { cursor, done: false, lastAttemptAt: this.now(), failures });
          result.failed.push(p.machineId);
          // Reported on the first failure and when the brake engages, not every five minutes.
          if (failures === 1 || failures === CATCH_UP_MAX_FAILURES) this.deps.report?.('ConversationUnread.catchUp', `${p.machineId}: ${err instanceof Error ? err.message : String(err)}${failures === CATCH_UP_MAX_FAILURES ? ' (giving up until the peer comes back)' : ''}`);
        }
      }));
      // Every reachable peer answered or failed once: phones may now get their baselines (§3.3). A pool
      // whose registry has not named a peer yet at boot waits for the next attempt (5 minutes) before
      // settling with nobody to ask, so a fresh local baseline does not beat an earlier replicated one.
      if (!this.deps.peers || all.length > 0 || this.catchUpAttempts >= 2) this.store.markCatchUpSettled();
      this.cache.clear();
    } finally { this.catchingUp = false; }
    return result;
  }

  /** A peer came back after being dark: resume its catch-up now. */
  onPeerOnline(machineId: string): void {
    void this.catchUp([machineId]).catch(() => { /* @silent-fallback-ok — the retry timer resumes it */ });
  }

  /** Local garbage collection (§3.2): markers of gone conversations and readers that no longer resolve. */
  gc(): number {
    let n = 0;
    const seenReaders = new Set<string>();
    const removedReaders = new Set<string>();
    const records: Array<{ reader: string; ref: string }> = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10_000; pages++) {
      const page = this.store.exportPage(cursor, CATCH_UP_PAGE);
      for (const r of page.records) records.push({ reader: r.reader, ref: r.ref });
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    for (const r of records) {
      if (r.ref === '*') continue;
      if (!seenReaders.has(r.reader)) {
        seenReaders.add(r.reader);
        if (this.readerRemoved(r.reader)) { n += this.store.removeReader(r.reader); removedReaders.add(r.reader); continue; }
      }
      if (removedReaders.has(r.reader)) continue;
      if (this.refRemoved(r.ref)) n += this.store.removeRef(r.ref, r.ref.startsWith('slack:'));
    }
    if (n > 0) this.cache.clear();
    return n;
  }

  /** Positive removal evidence stored on this machine (§3.2). "Not known here yet" is never removal. */
  removalEvidence(reader: string, ref: string): boolean {
    return this.refRemoved(ref) || this.readerRemoved(reader);
  }

  private refRemoved(ref: string): boolean {
    if (ref.startsWith('app:')) return this.deps.app?.getConversation(ref.slice(4))?.tombstoned === true;
    if (ref.startsWith('slack:')) {
      const m = /^slack:([\w-]+):(-\d+)$/.exec(ref);
      // Only a Slack conversation this machine minted can be known gone here.
      return !!m && m[1] === this.deps.machineId() && !!this.deps.slack && this.deps.slack.rows(Number(m[2])) === null;
    }
    return false; // Telegram markers are never removed (§3.2)
  }

  private readerRemoved(reader: string): boolean {
    const r = parseReaderKey(reader);
    if (!r || r.role === 'owner') return false;
    // An MSP user is namespaced by machine: only this machine can say its own user is gone.
    if (r.role === 'msp' && r.machineId !== this.deps.machineId()) return false;
    try { return this.deps.readerRemoved?.(reader) === true; } catch { return false; } // @silent-fallback-ok — an unanswerable check is never removal evidence
  }

  start(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      const peers = this.deps.peers?.() ?? [];
      if (!this.store.catchUpSettled() || peers.some((p) => catchUpAttemptDue(this.store.catchUpState(p.machineId), this.now()))) void this.catchUp().catch(() => { /* @silent-fallback-ok — the next tick retries */ });
    }, CATCH_UP_RETRY_MS);
    this.retryTimer.unref?.();
    this.gcTimer = setInterval(() => { try { this.gc(); } catch (err) { this.deps.report?.('ConversationUnread.gc', err instanceof Error ? err.message : String(err)); } }, GC_INTERVAL_MS); // @silent-fallback-ok — reported; the next hour retries
    this.gcTimer.unref?.();
  }

  stop(): void {
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    if (this.gcTimer) { clearInterval(this.gcTimer); this.gcTimer = null; }
    this.store.stop();
  }

  /** Tests and the list: drop cached counts (a source changed under them). */
  invalidate(): void { this.cache.clear(); }
}
