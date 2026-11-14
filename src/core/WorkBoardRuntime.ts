/**
 * WorkBoardRuntime — the one place the Work Board's parts are joined
 * (docs/specs/work-board-asks.md): the store's index and write rules (WorkBoardService), the
 * pickup controller, the card's conversation (create, server-written lines, removal), the
 * shared-ledger note per hand-over, the journal-growth signal, and the two multi-machine reads
 * (`behind`, "previous owner caught up").
 *
 * server.ts supplies a flat set of seams (no manager is imported here), so this module is
 * exercised whole in tests with fakes and wired once in production.
 */

import {
  WorkBoardService, resolveWorkBoardSettings, lineIdFor, transcriptLineFor,
  type WorkBoardSettings, type CardView,
} from './WorkBoardService.js';
import { WorkBoardPickupController, type DeliverOutcome } from './WorkBoardPickupController.js';
import { WORK_CARD_RECORD_KIND, type UnionEntry, type WorkRecordType, type Build } from './WorkCardStore.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';

export interface WorkBoardConversationSeam {
  /** Create the card's conversation with a derived key (idempotent). */
  create: (cardId: string, conversationKey: string, title: string) => void;
  exists: (conversationKey: string) => boolean;
  /** Append one agent-role message carrying `systemSource: 'work-board'`; a repeat of the same id is a no-op. Throws on a credential hit. */
  appendSystemLine: (conversationKey: string, lineId: string, text: string) => void;
  /** Tombstone the conversation and purge its files. */
  remove: (conversationKey: string) => void;
  /** This machine serves the conversation (routing owner; the lease holder when there is no routing record). */
  serves: (conversationKey: string) => boolean;
  aliasFor: (conversationKey: string) => number | null;
  hasLiveSession: (conversationKey: string) => boolean;
  /** System-origin delivery through appInboundDispatch.detailed. */
  dispatchSystem: (input: { conversationKey: string; alias: number; title: string; text: string; messageId: string }) => Promise<DeliverOutcome>;
  /** Live-only injection of one line (never spawns). */
  injectLive: (alias: number, line: string) => boolean;
  attachment: (attachmentId: string) => { sha256: string; conversationKey: string; purged: boolean } | null;
  /** ISO time of the newest message by a person in the conversation, or null. */
  lastPersonMessageAt: (conversationKey: string) => string | null;
}

export interface WorkBoardRuntimeSeams {
  machineId: string;
  enabled: () => boolean;
  rawSettings: () => unknown;
  saveSettings: (patch: Record<string, unknown>) => boolean;
  emit: (recordKey: string, build: Build) => { outcome: string; seq?: number; hlc?: HlcTimestamp };
  awaitDurable: (seq: number) => Promise<void>;
  loadUnion: () => UnionEntry[];
  /** Total bytes of the work-card kind on disk (live + archives), for the 64 MB signal. */
  journalBytes: () => number;
  conversation: WorkBoardConversationSeam;
  relayReady: () => boolean;
  capacityProbe: () => { ok: true } | { ok: false; reason: string; retryAt?: number };
  ownerPersonKey: () => string | null;
  displayName: (personKey: string) => string;
  timezone: () => string | undefined;
  detectCredential: (text: string) => string | null;
  /** Best-effort shared-ledger note (id only, never the title). */
  ledgerNote: (cardId: string, causeId: string) => void;
  degradation: (event: string, detail: Record<string, unknown>) => void;
  leaseHolder: () => string | null;
  now?: () => number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

interface Exchange { at: number; advertSeq: number | null; advertIncarnation: string | null; heldSeq: number | null; heldIncarnation: string | null }

const JOURNAL_SIGNAL_BYTES = 64 * 1024 * 1024;
const SYNC_INTERVAL_MS = 60_000;

export class WorkBoardRuntime {
  readonly svc: WorkBoardService;
  readonly controller: WorkBoardPickupController;
  private readonly exchanges = new Map<string, Exchange>();
  private lastOtherHolder: string | null = null;
  private selfWasHolder = false;
  private journalSignalled = false;
  private started = false;
  private readonly now: () => number;

  constructor(private readonly seams: WorkBoardRuntimeSeams) {
    this.now = seams.now ?? Date.now;
    const settings = (): WorkBoardSettings => resolveWorkBoardSettings(seams.rawSettings());
    this.svc = new WorkBoardService({
      machineId: seams.machineId,
      emit: seams.emit,
      loadUnion: seams.loadUnion,
      now: this.now,
      settings,
      ownerPersonKey: seams.ownerPersonKey,
      detectCredential: seams.detectCredential,
      dayOf: (ms) => this.dayOf(ms),
      displayName: seams.displayName,
      onLocalWrite: (cardId, type, data) => this.afterWrite(cardId, type, data, true),
      log: seams.log,
    });
    this.svc.attachmentResolver = (conversationKey, attachmentId) => {
      const a = seams.conversation.attachment(attachmentId);
      return a && !a.purged && a.conversationKey === conversationKey ? { sha256: a.sha256 } : null;
    };
    this.controller = new WorkBoardPickupController({
      svc: this.svc, machineId: seams.machineId, settings: () => settings().pickup, now: this.now, enabled: seams.enabled,
      ownsConversation: (ck) => seams.conversation.serves(ck),
      relayReady: seams.relayReady,
      admits: (ck) => seams.conversation.serves(ck),
      hasLiveSession: (ck) => seams.conversation.hasLiveSession(ck),
      capacityProbe: seams.capacityProbe,
      awaitDurable: seams.awaitDurable,
      appendLine: async (ck, id, text) => { this.appendLine(ck, id, text); },
      deliver: async (ck, brief, title) => {
        // The conversation may not be bound here yet (created on a standby): create is idempotent.
        const alias = seams.conversation.aliasFor(ck);
        if (alias === null) return { outcome: 'refused', reason: 'the card\'s chat is not open on this machine yet' };
        return seams.conversation.dispatchSystem({ conversationKey: ck, alias, title, text: brief, messageId: `wb-brief-${this.now()}` });
      },
      injectStop: async (ck, brief, tagTitle) => {
        const alias = seams.conversation.aliasFor(ck);
        if (alias === null) return false;
        return seams.conversation.injectLive(alias, `[app:${alias} "${tagTitle.replace(/["\n\r]/g, ' ').slice(0, 80)}" system:work-board] ${brief}`);
      },
      ledgerNote: seams.ledgerNote,
      degradation: seams.degradation,
      previousOwnerCaughtUp: (ck, since) => this.previousOwnerCaughtUp(ck, since),
      name: seams.displayName, when: (iso) => this.when(iso),
      log: seams.log,
    });
  }

  settings(): WorkBoardSettings { return resolveWorkBoardSettings(this.seams.rawSettings()); }
  saveSettingsPatch(patch: Record<string, unknown>): boolean { return this.seams.saveSettings(patch); }
  /** True when this machine holds the lease (or no other holder is known). */
  holdsLease(): boolean { const h = this.seams.leaseHolder(); return h === null || h === this.seams.machineId; }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.svc.rebuild();
    // Boot is not an ownership change: start from the holder as it is now, so a plain restart never
    // spends a failure park's one automatic re-try.
    const holder = this.seams.leaseHolder();
    this.selfWasHolder = holder === this.seams.machineId;
    if (holder && !this.selfWasHolder) this.lastOtherHolder = holder;
    this.ensureConversations();
    this.checkJournalGrowth();
    this.controller.start(this.settings().pickup.tickSeconds);
  }

  stop(): void { this.controller.stop(); this.started = false; }

  /** Committed entries from the journal (own) or the sync applier (a peer's). */
  onCommitted(entries: Array<{ data: unknown; machine?: string }>, fromPeer: string | null): void {
    if (!this.started) return;
    // Switched off live: the records still land in the index (they are data, and re-enabling must
    // show them), but nothing is created, noted or handed over.
    if (!this.seams.enabled()) { this.svc.apply(entries.map((e) => { const d = e.data as Record<string, unknown>; return { data: d, origin: String(d.origin ?? fromPeer ?? this.seams.machineId) }; })); return; }
    const union: UnionEntry[] = entries.map((e) => {
      const d = e.data as Record<string, unknown>;
      return { data: d, origin: String(d.origin ?? fromPeer ?? this.seams.machineId) };
    });
    const before = new Set(this.svc.cardIds());
    const changed = this.svc.apply(union);
    if (!changed.length) return;
    for (const u of union) {
      const d = u.data;
      if (fromPeer && typeof d.cardId === 'string' && typeof d.recordType === 'string') this.afterWrite(d.cardId, d.recordType as WorkRecordType, d, false);
    }
    // A card created on another machine gets its conversation here too (the key is derived, so this is a no-op when present).
    for (const id of changed) if (!before.has(id)) this.ensureConversation(id);
    this.checkJournalGrowth();
    this.controller.poke();
  }

  /** After any record lands (local write, or a peer's record applied live). */
  private afterWrite(cardId: string, type: WorkRecordType, data: Record<string, unknown>, local: boolean): void {
    if (type === 'dispatched' && (data.outcome === 'injected' || data.outcome === 'spawned')) {
      // Every machine writes its own note from the same replicated record (§6 "Other sessions can see it").
      if (!local) { try { this.seams.ledgerNote(cardId, String(data.for)); } catch { /* @silent-fallback-ok: best-effort note; the pickup is unaffected */ } }
    }
    if (type === 'policy' || !local) this.controller.poke();
  }

  /** A policy change that makes a waiting card workable leaves one line on each such card (§2). */
  async notePolicyChange(recordData: Record<string, unknown>, cardIdsNowWorkable: string[]): Promise<void> {
    const line = transcriptLineFor('policy', recordData, { name: this.seams.displayName, when: (iso) => this.when(iso) });
    if (!line) return;
    for (const id of cardIdsNowWorkable) {
      const v = this.svc.view(id); if (!v) continue;
      this.appendLine(v.card.conversationKey, lineIdFor(`${String(recordData.recordKey)}:${id}`), line);
    }
  }

  appendLine(conversationKey: string, lineId: string, text: string): void {
    // §2: the line passes the same credential guard the session-reply route runs before it is appended.
    if (this.seams.detectCredential(text)) { this.seams.log?.('work-board-line-credential-refused', { lineId }); return; }
    if (!this.seams.conversation.exists(conversationKey)) return;
    this.seams.conversation.appendSystemLine(conversationKey, lineId, text);
  }

  ensureConversation(cardId: string): void {
    const v = this.svc.view(cardId);
    if (!v || !v.card.created || v.card.redacted) return;
    if (this.seams.conversation.exists(v.card.conversationKey)) return;
    try { this.seams.conversation.create(cardId, v.card.conversationKey, v.card.title); }
    catch (err) { /* @silent-fallback-ok: logged; the card shows "waiting for the chat" and the next write or boot creates it (the key is derived) */ this.seams.log?.('work-board-conversation-create-failed', { cardId, error: (err as Error)?.message }); }
  }

  private ensureConversations(): void { for (const id of this.svc.cardIds()) this.ensureConversation(id); }

  removeConversation(conversationKey: string): void { this.seams.conversation.remove(conversationKey); }

  /** The conversations the lists leave out (§2); none while the feature is switched off. */
  hiddenConversationKeys(): Set<string> { return this.seams.enabled() ? this.svc.hiddenConversationKeys() : new Set(); }

  private checkJournalGrowth(): void {
    if (this.journalSignalled) return;
    let bytes = 0;
    try { bytes = this.seams.journalBytes(); } catch { return; /* @silent-fallback-ok: a signal only; an unreadable size is retried on the next write */ }
    if (bytes > JOURNAL_SIGNAL_BYTES) {
      this.journalSignalled = true;
      this.seams.degradation('work-board-journal-large', { bytes, limit: JOURNAL_SIGNAL_BYTES, spec: 'docs/specs/work-board-asks.md', kind: WORK_CARD_RECORD_KIND });
    }
  }

  // ── multi-machine reads ────────────────────────────────────────────────────

  noteJournalExchange(machineId: string, peerAdvert: Record<string, { incarnation: string; lastSeq: number }>, held: Record<string, { incarnation: string; lastSeq: number }>): void {
    const a = peerAdvert[WORK_CARD_RECORD_KIND]; const h = held[WORK_CARD_RECORD_KIND];
    this.exchanges.set(machineId, { at: this.now(), advertSeq: a ? a.lastSeq : null, advertIncarnation: a ? a.incarnation : null, heldSeq: h ? h.lastSeq : null, heldIncarnation: h ? h.incarnation : null });
  }

  /** Called on every lease observation: remembers the last OTHER holder, and fires the ownership change. */
  noteLeaseHolder(): void {
    const holder = this.seams.leaseHolder();
    const selfNow = holder === this.seams.machineId;
    if (holder && !selfNow) this.lastOtherHolder = holder;
    if (selfNow !== this.selfWasHolder) { this.selfWasHolder = selfNow; if (this.started) this.controller.onOwnershipChange(); }
  }

  private caughtUpWith(machineId: string, sinceMs: number): boolean {
    const e = this.exchanges.get(machineId);
    if (!e || e.at <= sinceMs) return false; // no exchange completed after the takeover
    if (e.advertSeq === null) return true; // the peer advertised no work-card stream: nothing to hold
    return e.heldIncarnation === e.advertIncarnation && e.heldSeq !== null && e.heldSeq >= e.advertSeq;
  }

  /**
   * §6 "Previous owner caught up": an exchange with that machine COMPLETED after the takeover, and
   * what this machine holds of its work-card stream reaches the head that exchange advertised (same
   * incarnation; a gapped or quarantined stream holds less and so is not caught up). The machines
   * that count: the last other lease holder seen, and every other machine that wrote a record on
   * this card. With none, there is no previous owner to wait for.
   */
  previousOwnerCaughtUp(conversationKey: string, sinceMs: number): boolean {
    const peers = new Set<string>();
    if (this.lastOtherHolder) peers.add(this.lastOtherHolder);
    const cardId = this.svc.cardIdForConversation(conversationKey);
    if (cardId) for (const r of this.svc.recordsOf(cardId)) { if (r.origin && r.origin !== this.seams.machineId) peers.add(r.origin); }
    for (const p of peers) if (!this.caughtUpWith(p, sinceMs)) return false;
    return true;
  }

  /** A peer whose work-card stream this machine is behind by more than one sync interval. */
  behind(): { machineId: string; since: string } | null {
    const now = this.now();
    for (const [machineId, e] of this.exchanges) {
      if (e.advertSeq === null) continue;
      const current = e.heldIncarnation === e.advertIncarnation && e.heldSeq !== null && e.heldSeq >= e.advertSeq;
      if (!current && now - e.at > SYNC_INTERVAL_MS) return { machineId, since: new Date(e.at).toISOString() };
    }
    return null;
  }

  lastWrittenOn(v: CardView): string | null {
    const recs = this.svc.recordsOf(v.card.cardId);
    return recs.length ? recs[recs.length - 1].origin : null;
  }

  repliedAfterQuestion(v: CardView): boolean {
    const q = v.card.openQuestion; if (!q) return false;
    const last = this.seams.conversation.lastPersonMessageAt(v.card.conversationKey);
    return !!last && last > q.at;
  }

  brokenAttachments(v: CardView): string[] {
    const out: string[] = [];
    for (const l of v.card.links) {
      if (!('attachmentId' in l)) continue;
      const a = this.seams.conversation.attachment(l.attachmentId);
      if (!a || a.purged || a.sha256 !== l.sha256) out.push(l.attachmentId);
    }
    return out;
  }

  // ── time ───────────────────────────────────────────────────────────────────

  dayOf(ms: number): { day: string; resetsAt: string } {
    const tz = this.seams.timezone();
    let day: string;
    try { day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
    catch { day = new Date(ms).toISOString().slice(0, 10); /* @silent-fallback-ok: an unknown timezone name falls back to the UTC day */ }
    // The next day boundary: step forward in 15-minute slices until the formatted day changes (≤ 96 steps).
    let t = ms;
    for (let i = 0; i < 100; i++) {
      t += 15 * 60_000;
      let d: string;
      try { d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); } catch { d = new Date(t).toISOString().slice(0, 10); /* @silent-fallback-ok: as above */ }
      if (d !== day) break;
    }
    const slice = 15 * 60_000;
    return { day, resetsAt: new Date(Math.floor(t / slice) * slice).toISOString() };
  }

  when(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    try { return new Intl.DateTimeFormat('en-US', { timeZone: this.seams.timezone(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t)); }
    catch { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); /* @silent-fallback-ok: an unknown timezone name falls back to UTC */ }
  }
}
