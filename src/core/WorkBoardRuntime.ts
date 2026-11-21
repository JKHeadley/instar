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
  WorkBoardService, resolveWorkBoardSettings, lineIdFor, transcriptLineFor, noteRefusalFor, JOURNAL_BUCKET_CAPACITY,
  type WorkBoardSettings, type CardView, type WorkPrincipal, type Refusal, type TeamMembership,
} from './WorkBoardService.js';

/** agent-work-cards-default §8: the team record as the board reads it (the service's `teamMember` and the pass floor's `personMayRead`). */
export interface WorkBoardTeamSeams {
  /** Standing of a NON-owner key in the replicated team record (the owner's key is answered by the runtime itself). */
  teamMember: (personKey: string) => TeamMembership;
  /** May this person read this conversation under the owner's grant? `null` = cannot tell here. */
  personMayRead: (personKey: string, conversationKey: string) => boolean | null;
}
import { WorkBoardPickupController, type DeliverOutcome } from './WorkBoardPickupController.js';
import { WorkBoardRequestGate, type RequestGateDeps } from './WorkBoardRequestGate.js';
import { WORK_CARD_RECORD_KIND, type UnionEntry, type WorkRecordType, type Build } from './WorkCardStore.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import { createHash } from 'node:crypto';

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
  // ── agent-work-cards-default §2/§3 (optional: absent ⇒ notes and holds are inert on this build of the wiring) ──
  /** The agent's progress note as an agent-role `work-board-note` event, emit reserved FIRST (appendWithEmit). */
  appendNoteEvent?: (conversationKey: string, eventId: string, text: string, writerBinding: string) => 'appended' | 'duplicate' | 'rate-limited' | 'not-accepted';
  /** One note event's words and time, or null when it has not replicated here yet. */
  noteEvent?: (conversationKey: string, eventId: string) => { text: string; at: string } | null;
  /** Every `work-board-note` event id on the conversation, oldest first (the drain's boot seed; bounded by the conversation's event count). */
  noteEventIds?: (conversationKey: string) => Array<{ eventId: string; at: string }>;
  /** Is the RECORDING conversation's session live (app, Telegram topic or Slack thread)? null = this wiring cannot tell (treated as live: no second worker is ever started on a guess). */
  recordingSessionLive?: (conversationKey: string) => boolean | null;
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
  /** §8: the team record (or attached later with `attachTeam`). Absent ⇒ a team of one: the owner is the only person. */
  team?: WorkBoardTeamSeams;
}

interface Exchange { at: number; advertSeq: number | null; advertIncarnation: string | null; heldSeq: number | null; heldIncarnation: string | null }

const JOURNAL_SIGNAL_BYTES = 64 * 1024 * 1024;
const SYNC_INTERVAL_MS = 60_000;

export class WorkBoardRuntime {
  readonly svc: WorkBoardService;
  readonly controller: WorkBoardPickupController;
  /** agent-work-cards-default §3: the request-to-card gate; null until the server attaches the commitments seams. */
  gate: WorkBoardRequestGate | null = null;
  private readonly exchanges = new Map<string, Exchange>();
  private lastOtherHolder: string | null = null;
  private selfWasHolder = false;
  private journalSignalled = false;
  private started = false;
  private readonly now: () => number;
  /** §2 "Note rate and the drain set": pending note event ids per card conversation, reconciled by event id against the pointers. */
  private readonly pendingNotes = new Map<string, Map<string, string>>();
  private notesSeeded = false;
  private readonly bootMs: number;
  readonly holderStats = { sweeps: 0, cardsSwept: 0, notesDrained: 0, notesCoalesced: 0, holdsLifted: 0, quietRepickups: 0, unblocked: 0, blockerReopened: 0, carriersDeparted: 0, lastPassAt: null as number | null, lastSweep: null as Record<string, unknown> | null };
  private team: WorkBoardTeamSeams | null;

  constructor(private readonly seams: WorkBoardRuntimeSeams) {
    this.now = seams.now ?? Date.now;
    this.bootMs = this.now();
    this.team = seams.team ?? null;
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
      // §8: the owner's key is always `owner`; every other key is the team record's answer, or `not-a-member` with no record (a team of one).
      teamMember: (k) => (k === seams.ownerPersonKey() ? 'owner' : this.team ? this.team.teamMember(k) : 'not-a-member'),
      personMayRead: (k, ck) => this.team?.personMayRead(k, ck) ?? null,
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
      beforeTick: () => this.holderPass(),
      log: seams.log,
    });
  }

  // ── agent-work-cards-default: the gate, notes and the holder's pass ────────

  /** §8: the server attaches the team record once the pairing service exists (the runtime is built before it). */
  attachTeam(team: WorkBoardTeamSeams): void { this.team = team; }
  /** True once team seams are attached (a test rig's, or the server's); the server never overwrites attached seams. */
  teamAttached(): boolean { return this.team !== null; }

  /**
   * §9: reconcile blocker links now (a link or a finish just landed), on the holder only, paced to the journal bucket.
   * The route calls it after a local write; `afterWrite` calls it for a peer's record; the holder's pass runs it every tick.
   */
  reconcileBlockersNow(): void {
    if (!this.started || !this.seams.enabled() || !this.holdsLease()) return;
    if (this.reconcileBlockers(JOURNAL_BUCKET_CAPACITY) > 0) this.controller.poke();
  }

  /** §8: the team record changed on any machine (`afterTeamRows`); the holder writes `carrier-departed` for carriers no longer on it. */
  onTeamRecordChanged(): void {
    if (!this.started || !this.seams.enabled() || !this.holdsLease()) return;
    if (this.reconcileDeparted(JOURNAL_BUCKET_CAPACITY) > 0) this.controller.poke();
  }

  private reconcileBlockers(max: number): number {
    if (max <= 0) return 0;
    let r: ReturnType<WorkBoardService['reconcileBlockers']>;
    try { r = this.svc.reconcileBlockers(max); }
    catch (err) { /* @silent-fallback-ok: logged; the next tick reconciles again and the cards stay as their records say */ this.seams.log?.('work-board-blocker-reconcile-failed', { error: (err as Error)?.message }); return 0; }
    this.holderStats.unblocked += r.unblocked.length; this.holderStats.blockerReopened += r.reopened.length;
    for (const u of r.unblocked) this.seams.log?.('work-board-unblocked', { cardId: u.cardId, blockerCardId: u.blockerCardId, reason: u.reason });
    for (const o of r.reopened) this.seams.log?.('work-board-blocker-reopened', { cardId: o.cardId, blockerCardId: o.blockerCardId });
    return r.unblocked.length + r.reopened.length;
  }

  private reconcileDeparted(max: number): number {
    if (max <= 0) return 0;
    let r: ReturnType<WorkBoardService['reconcileDepartedCarriers']>;
    try { r = this.svc.reconcileDepartedCarriers(max); }
    catch (err) { /* @silent-fallback-ok: logged; the next team pull or tick reconciles again */ this.seams.log?.('work-board-departed-reconcile-failed', { error: (err as Error)?.message }); return 0; }
    this.holderStats.carriersDeparted += r.length;
    for (const d of r) {
      const v = this.svc.view(d.cardId); if (!v) continue;
      const rec = this.svc.recordsOf(d.cardId).find((x) => x.id === d.recordId);
      const line = rec ? transcriptLineFor('carrier-departed', rec.d, { name: this.seams.displayName, when: (iso) => this.when(iso), carrierName: this.seams.displayName(d.personKey) }) : null;
      if (line) this.appendLine(v.card.conversationKey, lineIdFor(d.recordId), line);
      this.seams.log?.('work-board-carrier-departed', { cardId: d.cardId });
    }
    return r.length;
  }

  /** The server attaches the commitments and adapter seams once they exist; the gate then runs on every recorded request. */
  attachRequestGate(deps: Omit<RequestGateDeps, 'svc' | 'machineId' | 'now' | 'settings' | 'ownerPersonKey' | 'detectCredential' | 'writeNote' | 'caughtUpWithAllPeers'>): WorkBoardRequestGate {
    this.gate = new WorkBoardRequestGate({
      ...deps,
      svc: this.svc, machineId: this.seams.machineId, now: this.now, settings: () => this.settings(),
      ownerPersonKey: this.seams.ownerPersonKey, detectCredential: this.seams.detectCredential,
      writeNote: (cardId, text, writerBinding) => this.writeNote({ kind: 'agent', server: true }, cardId, text, writerBinding),
      caughtUpWithAllPeers: () => this.caughtUpWithAllPeers(this.bootMs),
      log: deps.log ?? this.seams.log,
    });
    return this.gate;
  }

  /**
   * §2: the agent's progress note. The conversation event lands FIRST (emit reserved, then the durable append), on the
   * card's conversation, agent role, `systemSource: 'work-board-note'`, the writer's binding recorded. The holder writes
   * the `note` pointer record from the pending set on its tick. A refused emit writes nothing and says so.
   */
  writeNote(p: WorkPrincipal, cardId: string, text: unknown, writerBinding: string): { ok: true; eventId: string; conversationKey: string } | Refusal {
    const r = noteRefusalFor(this.svc, p, cardId); if (r) return r;
    const t = this.svc.checkNoteText(text); if (!t.ok) return t;
    const v = this.svc.view(cardId)!;
    if (!this.seams.conversation.appendNoteEvent) return { ok: false, status: 503, error: 'notes-unavailable', detail: { message: 'Progress notes are not wired on this machine yet.' } };
    this.ensureConversation(cardId);
    const eventId = `wbn-${createHash('sha256').update(`${cardId}:${this.seams.machineId}:${this.now()}:${t.text}`).digest('hex').slice(0, 24)}`;
    const out = this.seams.conversation.appendNoteEvent(v.card.conversationKey, eventId, t.text, writerBinding.slice(0, 200));
    if (out === 'rate-limited') return { ok: false, status: 503, error: 'rate-limited', detail: { retryable: true, message: 'The replicated journal refused the note just now (rate cap). Nothing was written; write it again in a moment.' } };
    if (out === 'not-accepted') return { ok: false, status: 503, error: 'store-unavailable', detail: { retryable: true, message: 'The note could not be reserved for replication, so nothing was written. Try again.' } };
    this.notePending(v.card.conversationKey, eventId, new Date(this.now()).toISOString());
    return { ok: true, eventId, conversationKey: v.card.conversationKey };
  }

  /** The store's append listener feeds this live (local and replicated events alike), filtered on `systemSource`. */
  onNoteEvent(conversationKey: string, eventId: string, at: string): void { this.notePending(conversationKey, eventId, at); }

  private notePending(conversationKey: string, eventId: string, at: string): void {
    const cardId = this.svc.cardIdForConversation(conversationKey); if (!cardId) return;
    if (this.svc.notedEventIds(cardId).has(eventId)) return;
    const m = this.pendingNotes.get(conversationKey) ?? new Map<string, string>();
    m.set(eventId, at);
    this.pendingNotes.set(conversationKey, m);
  }

  /** The card's last note: its words when the event is here, `pending` when the pointer names an event not yet replicated. */
  lastNote(cardId: string): { text: string; at: string; eventId: string } | { pending: true; eventId: string } | null {
    const v = this.svc.view(cardId); if (!v) return null;
    const last = v.card.notes.length ? v.card.notes[v.card.notes.length - 1] : null;
    let eventId = last ? last.eventIds[last.eventIds.length - 1] : null;
    // A note written but not yet pointed at is still the newest note.
    const pend = this.pendingNotes.get(v.card.conversationKey);
    if (pend && pend.size) { let newest: [string, string] | null = null; for (const e of pend) if (!newest || e[1] > newest[1]) newest = e; if (newest && (!last || newest[1] >= last.at)) eventId = newest[0]; }
    if (!eventId) return null;
    const ev = this.seams.conversation.noteEvent?.(v.card.conversationKey, eventId) ?? null;
    if (!ev) return { pending: true, eventId };
    const text = ev.text.startsWith('Work board: the agent noted: ') ? ev.text.slice('Work board: the agent noted: '.length) : ev.text;
    return { text, at: ev.at, eventId };
  }

  pendingNoteCount(): number { let n = 0; for (const m of this.pendingNotes.values()) n += m.size; return n; }

  /** Boot or takeover: one bounded scan per card conversation seeds the pending set by event id (never by time). */
  private seedPendingNotes(): void {
    if (this.notesSeeded || !this.seams.conversation.noteEventIds) return;
    this.notesSeeded = true;
    for (const id of this.svc.cardIds()) {
      const v = this.svc.view(id); if (!v || !v.card.created || v.card.redacted) continue;
      let ids: Array<{ eventId: string; at: string }> = [];
      try { ids = this.seams.conversation.noteEventIds(v.card.conversationKey); } catch { continue; /* @silent-fallback-ok: an unreadable conversation is seeded on the next takeover; live events still arrive through the listener */ }
      const noted = this.svc.notedEventIds(id);
      for (const e of ids) if (!noted.has(e.eventId)) this.notePending(v.card.conversationKey, e.eventId, e.at);
    }
  }

  /**
   * The lease holder's pass (§3 "Where and when it runs"; §2 "Note rate and the drain set"; §3 "Pickup hold" and
   * "Quiet"): runs at the start of every pickup tick, only on the holder, each step paced to the shared journal bucket.
   */
  holderPass(): void {
    if (!this.seams.enabled() || !this.holdsLease()) return;
    this.holderStats.lastPassAt = this.now();
    const s = this.settings();
    let budget = JOURNAL_BUCKET_CAPACITY;
    // 1. the request-card sweep
    if (this.gate) {
      try {
        const r = this.gate.sweep();
        this.holderStats.sweeps++; this.holderStats.cardsSwept += r.written + r.linked; this.holderStats.lastSweep = r;
        budget -= r.written + r.linked;
      } catch (err) { /* @silent-fallback-ok: logged; the sweep runs again on the next tick and the commitments stay cardPending until it lands */ this.seams.log?.('work-board-sweep-failed', { error: (err as Error)?.message }); }
    }
    // 2. the note drain
    this.seedPendingNotes();
    budget -= this.drainNotes(Math.min(s.noteDrainPerTick, Math.max(0, budget)));
    // 3. one hold lift, then one quiet re-pickup, each only while no work pickup is pending or in a capacity wait
    if (budget > 0 && !this.workPickupPending()) { if (this.liftOneHold()) budget--; }
    if (budget > 0 && !this.workPickupPending()) { if (this.repickupOneQuiet()) budget--; }
    // 4. blocker reconciliation (§9: arrival, transition and boot all meet here) and departed carriers (§8), to the remaining budget
    budget -= this.reconcileBlockers(budget);
    budget -= this.reconcileDeparted(budget);
  }

  private workPickupPending(): boolean {
    for (const id of this.svc.cardIds()) {
      const v = this.svc.view(id); if (!v) continue;
      if (v.pickups.some((p) => p.status === 'pending' && p.cause.kind === 'work')) return true;
    }
    return false;
  }

  /** At most `max` pointer records, oldest events first; above the daily ceiling, one coalesced pointer per interval. */
  private drainNotes(max: number): number {
    let written = 0;
    const s = this.settings();
    const todayDay = this.dayOf(this.now()).day;
    for (const [conversationKey, pend] of this.pendingNotes) {
      if (written >= max) break;
      if (!pend.size) { this.pendingNotes.delete(conversationKey); continue; }
      const cardId = this.svc.cardIdForConversation(conversationKey); if (!cardId) { this.pendingNotes.delete(conversationKey); continue; }
      const noted = this.svc.notedEventIds(cardId);
      for (const e of [...pend.keys()]) if (noted.has(e)) pend.delete(e);
      const events = [...pend.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
      if (!events.length) continue;
      const today = this.svc.notePointersOn(cardId, todayDay);
      if (today >= s.maxNotesPerCardPerDay) {
        // Coalesce: one pointer per `noteCoalesceMinutes` carrying that interval's events, the newest interval only when it has settled.
        const v = this.svc.view(cardId)!;
        const lastAt = v.card.notes.length ? Date.parse(v.card.notes[v.card.notes.length - 1].at) : 0;
        if (this.now() - lastAt < s.noteCoalesceMinutes * 60_000) continue;
        const r = this.svc.notePointer(cardId, events.map((x) => x[0]));
        if (r.ok) { for (const [e] of events) pend.delete(e); written++; this.holderStats.notesCoalesced++; }
        else if (r.error === 'store-unavailable') return written; // rate-capped: the events stay pending for the next tick
        continue;
      }
      for (const [eventId] of events) {
        if (written >= max) break;
        const r = this.svc.notePointer(cardId, [eventId]);
        if (!r.ok) { if (r.error === 'store-unavailable') return written; pend.delete(eventId); continue; }
        pend.delete(eventId); written++; this.holderStats.notesDrained++;
        if (this.svc.notePointersOn(cardId, todayDay) >= s.maxNotesPerCardPerDay) break;
      }
    }
    return written;
  }

  /**
   * §3 "Pickup hold": the oldest held card whose hold should lift — a person's or the system's cause with no live
   * recording session, or no agent record for `quietAfterHours` (the quiet lift) — gets ONE `hold-lifted` record.
   */
  private liftOneHold(): boolean {
    const s = this.settings();
    const quietMs = s.quietAfterHours * 3_600_000;
    const held: Array<{ id: string; at: string; reason: 'quiet' | 'person-cause' }> = [];
    for (const id of this.svc.cardIds()) {
      const v = this.svc.view(id); if (!v) continue;
      const c = v.card;
      if (!c.created || !c.pickupHeld || c.redacted || c.archives.length || c.done) continue;
      if (!this.seams.conversation.serves(c.conversationKey)) continue;
      const recording = c.pickupHold?.kind === 'recording-session' ? c.pickupHold.conversationKey : null;
      const live = recording ? (this.seams.conversation.recordingSessionLive?.(recording) ?? null) : false;
      const quiet = this.now() - c.newestAgentRecordAt > quietMs;
      // A person's cause (an approve or an answer after creation) lifts the hold only when no live session can take it.
      const personCause = c.taps.some((t) => t.by.kind === 'person' && (t.action === 'approve' || t.action === 'answer' || t.action === 'retry') && Date.parse(t.at) >= Date.parse(c.createdAt ?? ''));
      if (personCause && live === false) { held.push({ id, at: c.createdAt ?? '', reason: 'person-cause' }); continue; }
      // No cause: the hold lifts only when the recording conversation has gone quiet (a long silent tool run is not a dead session, so `live === true` waits).
      if (quiet && live !== true) held.push({ id, at: c.createdAt ?? '', reason: 'quiet' });
    }
    if (!held.length) return false;
    held.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
    const pick = held[0];
    const r = this.svc.liftHold(pick.id, pick.reason);
    if (r.ok) { this.holderStats.holdsLifted++; this.seams.log?.('work-board-hold-lifted', { cardId: pick.id, reason: pick.reason }); }
    return r.ok;
  }

  /**
   * §3 "Quiet, with one self-heal first": the oldest workable, unheld, agent-carried card with no agent record for
   * `quietAfterHours` and no pending pickup gets ONE `quiet-repickup` record (idempotent on the newest agent record).
   */
  private repickupOneQuiet(): boolean {
    const s = this.settings();
    const quietMs = s.quietAfterHours * 3_600_000;
    const due: Array<{ id: string; at: number }> = [];
    for (const id of this.svc.cardIds()) {
      const v = this.svc.view(id); if (!v) continue;
      const c = v.card;
      if (!c.workable || c.pickupHeld || c.carrier !== 'agent' || !c.newestAgentRecordId) continue;
      if (!this.seams.conversation.serves(c.conversationKey)) continue;
      if (v.pickups.some((p) => p.status === 'pending' || p.status === 'parked')) continue; // a park (the quiet row) or a wait stands
      if (c.quietRepickups.some((q) => q.newestAgentRecordId === c.newestAgentRecordId)) continue; // one per quiet period
      if (this.now() - c.newestAgentRecordAt <= quietMs) continue;
      due.push({ id, at: c.newestAgentRecordAt });
    }
    if (!due.length) return false;
    due.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    const r = this.svc.quietRepickup(due[0].id);
    if (r.ok && !r.duplicate) { this.holderStats.quietRepickups++; this.seams.log?.('work-board-quiet-repickup', { cardId: due[0].id }); }
    return r.ok && !r.duplicate;
  }

  /** The holder has completed an exchange with every peer it knows since `sinceMs` (§3 "The first run", §5 "one offer"). */
  caughtUpWithAllPeers(sinceMs: number): boolean {
    if (!this.exchanges.size) return this.holdsLease();
    for (const [peer] of this.exchanges) if (!this.caughtUpWith(peer, sinceMs)) return false;
    return true;
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
    // A peer's link, close, confirm, reopen, restore or pass may free or re-block a card here: reconcile ONCE per batch on the holder.
    if (fromPeer && this.holdsLease() && union.some((u) => WorkBoardRuntime.RECONCILE_AFTER.has(String(u.data.recordType)))) this.reconcileBlockers(JOURNAL_BUCKET_CAPACITY);
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

  /** The record kinds after which a peer's batch is reconciled once (§9 "in either arrival order"): a link, a close, a confirm, a reopen, a restore, a finish, a pass. */
  private static readonly RECONCILE_AFTER: ReadonlySet<string> = new Set(['blocked-by', 'tap', 'claimed-done', 'edited']);

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
