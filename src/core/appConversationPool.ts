/**
 * App conversations in the pool (docs/specs/app-conversations-in-the-pool.md).
 *
 * The rule behind everything here: an app conversation changes machine only through a completed
 * drain, or through the operator's explicit "bring it back here". Nothing in the pool places it.
 *
 * This module holds the parts with no HTTP and no boot wiring, all injected so they are testable:
 *  - the forward payload (§2.4): the stored, signed event plus what the owner needs to deliver it;
 *  - the lease gate (§2.3): a new lease holder serves no-record conversations only after a
 *    `session-status` round;
 *  - the flag tracker (§2.6): flagged, positively unflagged, or still unknown;
 *  - the enforcer (§2.5, §2.6): resolves stuck transfers, releases the holder's own records and keeps
 *    older machines out;
 *  - the owner's receive side (§2.4) and the one delivery path both sides share.
 */
import type { AppEvent, MediaMessageEvent, MessageEvent } from './AppConversationStore.js';
import type { AppConversationService } from './AppConversationService.js';
import type { OwnershipAction, SessionOwnershipRecord } from './SessionOwnership.js';
import type { RouteOutcome, InboundMessage } from './SessionRouter.js';
import { isExactStopMessage } from './MessageSentinel.js';
import { isAppConversationKey } from './appConversationText.js';
import type { AppAttachment } from './appMediaTypes.js';
import type { MachineCapacity } from './types.js';
import type { DrainDispatchResult } from './QueueDrainLoop.js';

// ── Words the person reads ──────────────────────────────────────────────────────────────────────

export const STOP_NOT_CONFIRMED = "Couldn't reach the machine running this conversation; the stop hasn't taken effect yet.";
export const OWNER_DID_NOT_ANSWER = "The machine running this conversation didn't answer. Bring it back here, or try again when it's back.";
export const APP_STOPPED_BEFORE_DELIVERY = 'You sent a stop, so this message was not delivered. Send it again if you still want it.';
/** A held message a stop dropped: an earlier attempt may have reached the owner with only its answer lost. */
export const APP_STOPPED_WHILE_HELD = 'You sent a stop, so this message may not have been delivered. Check the conversation, and send it again if you still want it.';
export const STOPPED_MAYBE_DELIVERED = 'You sent a stop while this message was on its way, so it may or may not have reached the agent. Check the conversation.';
export const OWNER_REFUSED_SENDER = 'The machine running this conversation refused this message.';
export const MAY_NOT_BE_DELIVERED = 'This message may not have been delivered. Check the conversation, and send it again if you still want it.';

/** The words for a held message the queue gave up on, by its reason. */
export function appLossWords(reason: string): string {
  if (reason === 'operator-stop') return APP_STOPPED_WHILE_HELD;
  if (reason === 'sender-deauthorized') return OWNER_REFUSED_SENDER;
  if (reason === 'ttl-expired' || reason === 'attempts-exhausted') return OWNER_DID_NOT_ANSWER;
  return MAY_NOT_BE_DELIVERED;
}

/**
 * What a queue loss records. `refused` only where that is known (the owner answered and refused) or the
 * spec asks for it (the queue's own limits, §2.2). Anything else may follow an attempt that reached the
 * owner with only its answer lost, so it reads `unknown`, which yields to the owner's own outcome.
 */
export function appLossState(reason: string): 'refused' | 'unknown' {
  return reason === 'sender-deauthorized' || reason === 'ttl-expired' || reason === 'attempts-exhausted' ? 'refused' : 'unknown';
}

export const NEEDS_UPDATE = 'Your machines need the latest Instar update before app conversations can move.';
export const NO_PRIVATE_MEMORY = "That machine doesn't keep private memory, so this person's conversation can't move there.";
export const MEMORY_STARTS_EMPTY = "What the agent has learned in this conversation stays on this machine; its memory for this conversation starts empty on the new one.";

/** "Bring it back here" writes this far above the observed epoch (§2.2); well inside the applier's 1e9 fence. */
export const BRING_BACK_EPOCH_MARGIN = 1_000_000;
/** The lease gate's `session-status` round is bounded at this (§2.3). */
export const LEASE_GATE_BOUND_MS = 30_000;

export function appRecordKey(conversationKey: string): string { return `app:${conversationKey}`; }
export function appConversationOfRecord(recordKey: string): string | null {
  if (!recordKey.startsWith('app:')) return null;
  const key = recordKey.slice('app:'.length);
  return isAppConversationKey(key) ? key : null;
}

// ── The forward (§2.4) ──────────────────────────────────────────────────────────────────────────

export type AppUrgent = 'stop' | 'pause';

export interface AppForwardPayload {
  kind: 'app-forward';
  /** The stored, signed event, not just its id. */
  event: MessageEvent | MediaMessageEvent;
  /** The phone's request (`deviceId\0requestId`): delivery events derive from it, so both sides merge. */
  seed: string;
  ownerName: string | null;
  memoryPersonId: string | null;
  urgent?: AppUrgent;
  /**
   * A team member's stop ends their own conversation, not the agent's resume queue, on whichever machine
   * acts on it (team-roles-and-access §4.1). It travels on every forward, because the owner can turn a
   * plain send into a stop: an exact stop text, or the classifier. A forward whose event names a team
   * sender reads as scoped whatever it says, so an older holder or a queued row can't widen a stop.
   */
  stopScope?: 'conversation';
}

export function buildAppForward(p: Omit<AppForwardPayload, 'kind'>): AppForwardPayload {
  return { kind: 'app-forward', ...p };
}

/** A forward as a queue row or a mesh command carries it. Null for anything that isn't one. */
export function parseAppForward(payload: unknown): AppForwardPayload | null {
  let v: unknown = payload;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; } // @silent-fallback-ok — not a forward; the caller answers for it
  }
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (p.kind !== 'app-forward' || !p.event || typeof p.event !== 'object' || typeof p.seed !== 'string') return null;
  const ev = p.event as { kind?: unknown; conversationKey?: unknown; messageId?: unknown; senderRole?: unknown };
  if ((ev.kind !== 'message' && ev.kind !== 'media-message') || typeof ev.conversationKey !== 'string' || typeof ev.messageId !== 'string') return null;
  return {
    kind: 'app-forward', event: p.event as MessageEvent | MediaMessageEvent, seed: p.seed,
    ownerName: typeof p.ownerName === 'string' ? p.ownerName : null,
    memoryPersonId: typeof p.memoryPersonId === 'string' ? p.memoryPersonId : null,
    ...(p.urgent === 'stop' || p.urgent === 'pause' ? { urgent: p.urgent } : {}),
    ...(p.stopScope === 'conversation' || ev.senderRole === 'team' ? { stopScope: 'conversation' as const } : {}),
  };
}

/**
 * The sender check's app arm (§2.4): the envelope names the event it came with and that event's paired
 * device. The signature on the event is checked on delivery, with today's verdict policy.
 */
export function appForwardSenderValid(envelope: { via?: string; deviceId?: string; eventId?: string }, session: string, payload: unknown): boolean {
  const f = parseAppForward(payload);
  if (!f || envelope.via !== 'mobile-device' || typeof envelope.deviceId !== 'string' || !envelope.deviceId) return false;
  if (appRecordKey(f.event.conversationKey) !== session || envelope.eventId !== f.event.eventId) return false;
  const origin = (f.event as { origin?: { deviceId?: unknown } }).origin;
  return !origin || origin.deviceId === envelope.deviceId;
}

// ── The pool handle ─────────────────────────────────────────────────────────────────────────────

/** What the service and the routes ask of the pool. Absent or inactive means today's single-owner behaviour. */
export interface AppPoolHandle {
  /** Pool on, durable ownership and replication live. Dark ⇒ no app records, forwards or moves (§2.7). */
  active(): boolean;
  read(recordKey: string): SessionOwnershipRecord | null;
  gateOpenFor(conversationKey: string): boolean;
  drainRunning(recordKey: string): boolean;
  sessionRunning(tmuxSession: string): boolean;
  closeLostSession(conversationKey: string, tmuxSession: string): Promise<{ closed: boolean; detail?: string }>;
  route(msg: InboundMessage): Promise<RouteOutcome>;
  /** Another machine is named as lease holder. A suspended or missed renewal alone is not the lease moving (§2.1). */
  leaseHeldElsewhere(): boolean;
  /** A stop settles this conversation's messages held in the queue, so they don't run after it (§2.4). */
  dropHeld(recordKey: string): void;
  /** Messages for this conversation still wait in the queue: a new one goes behind them. */
  hasHeld(recordKey: string): boolean;
}

// ── The lease gate (§2.3) ───────────────────────────────────────────────────────────────────────

export interface AppOwnedRow { key: string; epoch: number; status: string }
export interface StatusAnswer { appOwned?: unknown; seamlessnessFlags?: MachineCapacity['seamlessnessFlags'] }

export interface AppLeaseGateDeps {
  holdsLease(): boolean;
  /** Every other machine in the pool that could answer. */
  peers(): string[];
  /** One `session-status` to one machine; null or a throw reads as no answer. */
  status(machineId: string): Promise<StatusAnswer | null>;
  /** Each answer carries its machine's flag, so the flag is read from the answer itself (§2.3). */
  onAnswer?(machineId: string, flagged: boolean): void;
  /** This machine's stored epoch for a record, 0 when it has none. */
  storedEpoch(recordKey: string): number;
  boundMs?: number;
  log?(line: string): void;
}

export function parseAppOwned(raw: unknown): AppOwnedRow[] {
  if (!Array.isArray(raw)) return [];
  const out: AppOwnedRow[] = [];
  for (const r of raw.slice(0, 2000)) {
    const row = r as { key?: unknown; epoch?: unknown; status?: unknown };
    if (typeof row?.key !== 'string' || !appConversationOfRecord(row.key)) continue;
    if (typeof row.epoch !== 'number' || !Number.isFinite(row.epoch)) continue;
    out.push({ key: row.key, epoch: row.epoch, status: typeof row.status === 'string' ? row.status : 'active' });
  }
  return out;
}

export class AppLeaseGate {
  private open = false;
  private wasHolder = false;
  private round: Promise<void> | null = null;
  private generation = 0;
  /** Records a peer reported at a higher epoch than this machine has: held, not served. */
  private readonly held = new Map<string, number>();

  constructor(private readonly d: AppLeaseGateDeps) {}

  /** Called every lease tick. Returns the round in flight, so a test can await it. */
  tick(): Promise<void> | null {
    const holds = this.d.holdsLease();
    if (!holds) {
      this.open = false;
      this.wasHolder = false;
      this.held.clear();
      this.generation++;
      this.round = null;
      return null;
    }
    if (!this.wasHolder) {
      this.wasHolder = true;
      this.open = false;
      this.round = this.runRound(++this.generation);
    }
    return this.round;
  }

  isOpen(): boolean { return this.open; }

  /** Open for this conversation: the round finished and no peer reported a record this machine still lacks. */
  openFor(conversationKey: string): boolean {
    if (!this.open) return false;
    const rk = appRecordKey(conversationKey);
    const want = this.held.get(rk);
    if (want === undefined) return true;
    if (this.d.storedEpoch(rk) >= want) { this.held.delete(rk); return true; }
    return false;
  }

  private async runRound(generation: number): Promise<void> {
    const peers = this.d.peers();
    if (peers.length > 0) {
      const bound = this.d.boundMs ?? LEASE_GATE_BOUND_MS;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, bound); (timer as { unref?: () => void }).unref?.(); });
      const asks = peers.map(async (m) => {
        let a: StatusAnswer | null = null;
        try { a = await this.d.status(m); } catch (err) { this.d.log?.(`lease gate: ${m} did not answer: ${err instanceof Error ? err.message : String(err)}`); } // @silent-fallback-ok — logged; §2.3 treats a machine that doesn't answer as owning nothing, and the close rule bounds the split
        if (!a || generation !== this.generation) return; // A machine that doesn't answer is treated as owning nothing.
        this.d.onAnswer?.(m, a.seamlessnessFlags?.appConversationsPool === true);
        for (const row of parseAppOwned(a.appOwned)) {
          if (this.d.storedEpoch(row.key) < row.epoch) this.held.set(row.key, Math.max(row.epoch, this.held.get(row.key) ?? 0));
        }
      });
      await Promise.race([Promise.all(asks), deadline]);
      if (timer) clearTimeout(timer);
    }
    if (generation === this.generation) this.open = true;
  }
}

// ── The flag (§2.6) ─────────────────────────────────────────────────────────────────────────────

export type FlagState = 'flagged' | 'unflagged' | 'unknown';

/** How often machines report in. An unflagged reading must hold for two of these before anything acts on it (§2.6). */
export const FLAG_HEARTBEAT_MS = 30_000;

/**
 * A machine's flag is unknown until its first full heartbeat after it came online or the lease moved.
 * Coarse beats carry no flags, and a machine that just restarted advertises false until its pool is
 * wired, so `unflagged` needs a full report that has stayed unflagged for two heartbeat intervals. That
 * is what keeps a routine restart from reading as a downgrade. Unknown never opens the write gate, and
 * enforcement acts only on a machine positively unflagged, so a flagged holder coming back never sets it off.
 */
export class AppFlagTracker {
  private readonly onlineSince = new Map<string, number>();
  private markAt = 0;
  private wasHolder: boolean | null = null;
  private readonly answers = new Map<string, { at: number; flagged: boolean }>();
  /** When each machine's reading first turned unflagged, cleared the moment it reads flagged. */
  private readonly unflaggedSince = new Map<string, number>();

  constructor(private readonly d: { now(): number; holdsLease(): boolean; selfId(): string; intervalMs?: number }) {}

  /** A `session-status` answer in the lease gate's round: as good as a heartbeat, until a newer heartbeat. */
  noteAnswer(machineId: string, flagged: boolean): void {
    this.answers.set(machineId, { at: this.d.now(), flagged });
  }

  /** Remember when each machine came online and when the lease last changed. Call before reading. */
  observe(caps: ReadonlyArray<MachineCapacity>): void {
    const now = this.d.now();
    const holds = this.d.holdsLease();
    if (this.wasHolder !== holds) { this.markAt = now; this.wasHolder = holds; }
    const online = new Set<string>();
    for (const c of caps) {
      if (!c.online) continue;
      online.add(c.machineId);
      if (!this.onlineSince.has(c.machineId)) this.onlineSince.set(c.machineId, now);
    }
    for (const m of [...this.onlineSince.keys()]) {
      if (!online.has(m)) { this.onlineSince.delete(m); this.unflaggedSince.delete(m); this.answers.delete(m); }
    }
  }

  /** The newest full report since the mark, with when it came. Null: none yet. Coarse beats aren't reports. */
  private reading(cap: MachineCapacity): { flagged: boolean; at: number } | null {
    const mark = Math.max(this.onlineSince.get(cap.machineId) ?? 0, this.markAt);
    const isSelf = cap.machineId === this.d.selfId();
    const parsed = cap.seamlessnessFlagsReceivedAt ? Date.parse(cap.seamlessnessFlagsReceivedAt) : NaN;
    const beatAt = isSelf ? this.d.now() : parsed;
    const beatFresh = !!cap.seamlessnessFlags && Number.isFinite(beatAt) && beatAt >= mark;
    const answer = this.answers.get(cap.machineId);
    if (answer && answer.at >= mark && !(beatFresh && beatAt > answer.at)) return { flagged: answer.flagged, at: answer.at };
    return beatFresh ? { flagged: cap.seamlessnessFlags?.appConversationsPool === true, at: beatAt } : null;
  }

  stateOf(cap: MachineCapacity): FlagState {
    const r = this.reading(cap);
    if (r === null) return 'unknown';
    if (r.flagged) { this.unflaggedSince.delete(cap.machineId); return 'flagged'; }
    // Two distinct reports, two heartbeats apart. A machine that went quiet after one false report stays unknown.
    const since = this.unflaggedSince.get(cap.machineId) ?? r.at;
    this.unflaggedSince.set(cap.machineId, since);
    return r.at - since >= 2 * (this.d.intervalMs ?? FLAG_HEARTBEAT_MS) ? 'unflagged' : 'unknown';
  }

  /** The whole-pool gate: every online machine advertises the flag. Unknown keeps it shut, whatever its age. */
  everyOnlineMachineFlagged(caps: ReadonlyArray<MachineCapacity>): boolean {
    this.observe(caps);
    return caps.filter((c) => c.online).every((c) => this.stateOf(c) === 'flagged');
  }

  /** Online machines positively seen as unflagged. Unknown never counts here. */
  positivelyUnflagged(caps: ReadonlyArray<MachineCapacity>): MachineCapacity[] {
    this.observe(caps);
    return caps.filter((c) => c.online && this.stateOf(c) === 'unflagged');
  }
}

// ── The enforcer (§2.5, §2.6) ───────────────────────────────────────────────────────────────────

export interface AppPoolEnforcerDeps {
  selfId(): string;
  active(): boolean;
  selfFlagged(): boolean;
  holdsLease(): boolean;
  leaseHolderId(): string | null;
  capacities(): MachineCapacity[];
  /** Every `app:` ownership record this machine knows. */
  records(): SessionOwnershipRecord[];
  /** The registry CAS, paired with its journal row. */
  cas(recordKey: string, action: OwnershipAction, why: string): { ok: boolean; record?: SessionOwnershipRecord };
  drainRunning(recordKey: string): boolean;
  /** A move the holder is carrying out right now for this record (its record is mid-baseline). */
  moveInFlight(recordKey: string): boolean;
  /** Put the delivery ledger back after this machine aborted a transfer, as the runner's own abort does. */
  restoreDeliveryLedger(recordKey: string, transferEpoch: number, activeEpoch: number): void;
  sendDrain(owner: string, recordKey: string, target: string, epoch: number): Promise<{ ok: boolean; status?: string; claimLanded?: boolean; reason?: string }>;
  raiseAttention(item: { conditionKey: string; title: string; body: string }): void;
  clearAttention(conditionKey: string): void;
  nicknameOf(machineId: string): string | null;
  now(): number;
  /** How long a `transferring` record may sit with no drain running. */
  transferDeadlineMs: number;
  flags: AppFlagTracker;
  log?(line: string): void;
}

export const BROUGHT_HOME_CONDITION = 'app-conversations:brought-home';
/** A bring-home drain the owner refused waits this long before the next try, per conversation. */
export const BRING_HOME_RETRY_MS = 5 * 60_000;

/* @self-action-controller: app-pool-enforcer */
export class AppPoolEnforcer {
  private readonly homeDrains = new Set<string>();
  private readonly homeRetryAt = new Map<string, number>();
  private noticeRaised = false;

  constructor(private readonly d: AppPoolEnforcerDeps) {}

  tick(): void {
    if (!this.d.active()) return;
    const self = this.d.selfId();
    const caps = this.d.capacities();
    const records = this.d.records();
    this.resolveStuckTransfers(records, self);
    if (this.d.selfFlagged()) {
      const unflagged = this.d.flags.positivelyUnflagged(caps);
      const holderId = this.d.leaseHolderId();
      if (holderId && holderId !== self && unflagged.some((c) => c.machineId === holderId)) {
        this.standDownForOlderHolder(records, self);
        return;
      }
      if (this.d.holdsLease()) this.bringHome(records, unflagged, self);
    }
    if (this.d.holdsLease()) this.releaseOwnRecords(this.d.records(), self);
  }

  /** §2.5: a record left `transferring` (runner died, route timed out) goes back to its owner. The target never claimed. */
  private resolveStuckTransfers(records: SessionOwnershipRecord[], self: string): void {
    for (const r of records) {
      // A baseline whose claim failed rests at `placing`, which would queue every message. Finish it; the holder then releases it.
      if (r.status === 'placing' && r.ownerMachineId === self && !this.d.moveInFlight(r.sessionKey)) {
        this.d.cas(r.sessionKey, { type: 'claim', machineId: self }, 'stuck-placing');
        continue;
      }
      if (r.status !== 'transferring' || r.ownerMachineId !== self) continue;
      if (this.d.drainRunning(r.sessionKey) || this.d.now() - r.timestamp < this.d.transferDeadlineMs) continue;
      this.abort(r, self, 'stuck-transfer');
    }
  }

  private abort(r: SessionOwnershipRecord, self: string, why: string): boolean {
    const out = this.d.cas(r.sessionKey, { type: 'abort-transfer', machineId: self }, why);
    if (!out.ok) return false;
    const activeEpoch = out.record?.ownershipEpoch;
    if (typeof activeEpoch === 'number') {
      try { this.d.restoreDeliveryLedger(r.sessionKey, activeEpoch - 1, activeEpoch); }
      catch (err) { this.d.log?.(`ledger restore for ${r.sessionKey}: ${err instanceof Error ? err.message : String(err)}`); } // @silent-fallback-ok — logged, as the runner's own abort fails closed: effects stay fenced
    }
    return true;
  }

  /**
   * §2.6: an older machine took the lease and serves every app conversation, as older code does. An
   * owner stops serving: abort then release. The close rule (§2.1) then closes its session and unbinds.
   */
  private standDownForOlderHolder(records: SessionOwnershipRecord[], self: string): void {
    for (const r of records) {
      if (r.ownerMachineId !== self) continue;
      if (r.status === 'transferring' && !this.abort(r, self, 'older-lease-holder')) continue;
      if (r.status === 'transferring' || r.status === 'active') this.d.cas(r.sessionKey, { type: 'release', machineId: self }, 'older-lease-holder');
    }
  }

  /** §2.6: an unflagged machine is online while records exist, so the holder brings every moved conversation home. */
  private bringHome(records: SessionOwnershipRecord[], unflagged: MachineCapacity[], self: string): void {
    const moved = records.filter((r) => r.status === 'active' && r.ownerMachineId !== self);
    if (unflagged.length === 0) {
      this.homeRetryAt.clear();
      if (this.noticeRaised) { this.noticeRaised = false; this.d.clearAttention(BROUGHT_HOME_CONDITION); }
      return;
    }
    if (moved.length === 0) return;
    if (!this.noticeRaised) {
      this.noticeRaised = true;
      const name = this.d.nicknameOf(unflagged[0].machineId) ?? 'another machine';
      this.d.raiseAttention({
        conditionKey: BROUGHT_HOME_CONDITION,
        title: 'App conversations were brought home',
        body: `App conversations were brought home because ${name} needs the update.`,
      });
    }
    const unflaggedIds = new Set(unflagged.map((c) => c.machineId));
    for (const r of moved) {
      if (unflaggedIds.has(r.ownerMachineId)) {
        // The downgrade case. Older code can't reply off the lease, so the takeover splits nothing.
        this.d.cas(r.sessionKey, { type: 'force-claim', machineId: self }, 'owner-needs-update');
        continue;
      }
      if (this.homeDrains.has(r.sessionKey) || this.d.now() < (this.homeRetryAt.get(r.sessionKey) ?? 0)) continue;
      this.homeDrains.add(r.sessionKey);
      this.homeRetryAt.set(r.sessionKey, this.d.now() + BRING_HOME_RETRY_MS);
      void this.d.sendDrain(r.ownerMachineId, r.sessionKey, self, r.ownershipEpoch)
        .catch((err: unknown) => { this.d.log?.(`bring home ${r.sessionKey}: ${err instanceof Error ? err.message : String(err)}`); })
        .finally(() => { this.homeDrains.delete(r.sessionKey); });
    }
  }

  /**
   * §2.5: the lease holder serves an unmoved conversation with no record, so an `active` record naming
   * itself is released once nothing is using it: a move back that landed, an aborted baseline, a takeover.
   */
  private releaseOwnRecords(records: SessionOwnershipRecord[], self: string): void {
    for (const r of records) {
      if (r.status !== 'active' || r.ownerMachineId !== self) continue;
      if (this.d.moveInFlight(r.sessionKey) || this.d.drainRunning(r.sessionKey)) continue;
      this.d.cas(r.sessionKey, { type: 'release', machineId: self }, 'holder-serves-unmoved');
    }
  }
}

// ── Delivery, shared by the local path and the owner's receive side (§2.4) ──────────────────────

export interface DeliverStoredInput {
  key: string;
  alias: number;
  title: string;
  event: MessageEvent | MediaMessageEvent;
  ownerName: string;
  memoryPersonId: string | null;
}

/**
 * The inline steps of a send, on whichever machine delivers: session lines, what the session missed,
 * the origin verdict (deliver on any verdict, tag only on `verified`), the dispatch.
 */
export async function dispatchStoredAppMessage(s: AppConversationService, input: DeliverStoredInput): Promise<{ outcome: 'delivered' | 'refused'; originVerdict: ReturnType<AppConversationService['verify']> }> {
  const dispatch = s.deps.dispatch();
  if (!dispatch) return { outcome: 'refused', originVerdict: 'unknown' };
  const { event, key } = input;
  const attachments: ReadonlyArray<AppAttachment> = event.kind === 'media-message' ? event.attachments : [];
  let sessionText = event.text;
  if (attachments.length > 0) {
    const lines = await s.sessionLinesFor(key, event.messageId, attachments, event.text);
    sessionText = [...lines, ...(event.text ? [event.text] : [])].join('\n');
  }
  const pending = s.pendingContext(key);
  const originVerdict = s.verify(event);
  const outcome = await dispatch({
    conversationKey: key, alias: input.alias, title: input.title, text: sessionText, messageId: event.messageId,
    ownerName: input.ownerName, memoryPersonId: input.memoryPersonId, originVerdict,
    ...(pending.lines.length > 0 ? { notes: pending.lines } : {}),
  });
  if (outcome === 'delivered') pending.ack();
  return { outcome, originVerdict };
}

export interface AppOwnerReceiverDeps {
  service: () => AppConversationService | null;
  /** The owner's stored epoch for a record, or null. */
  storedEpoch(recordKey: string): number | null;
  /** Sentinel, as the send route uses it. Absent or throwing fails open. */
  classify?(text: string, alias: number): Promise<'kill' | 'pause' | 'deliver'>;
  /** The durable receipt's `injected` marker. */
  markInjected(session: string, messageId: string): void;
  report?(what: string, detail: string): void;
}

/** The owner's half of a forward (§2.4). Stop and pause act synchronously, before the acknowledgement. */
export function createAppOwnerReceiver(d: AppOwnerReceiverDeps) {
  const keyOfSession = (session: string): string | null => appConversationOfRecord(session);
  return {
    isApp: (session: string): boolean => keyOfSession(session) !== null,
    /** Serving: takes ordinary messages. */
    canTake(session: string): boolean {
      const s = d.service();
      const key = keyOfSession(session);
      if (!s || !key || !s.liveConversation(key)) return false;
      if (!s.serves(key)) return false;
      const alias = s.deps.registry.appAliasFor(key);
      return alias !== null || s.deps.registry.mintAppAlias(key).ok;
    },
    /** A stop or pause to the current owner, even one draining it, at an epoch at least the forwarded one. */
    urgentAccepted(session: string, payload: unknown, forwardedEpoch: number): boolean {
      const s = d.service();
      const key = keyOfSession(session);
      const f = parseAppForward(payload);
      if (!s || !key || !f?.urgent || !s.currentOwner(key)) return false;
      return (d.storedEpoch(session) ?? 0) >= forwardedEpoch;
    },
    /** Durable, idempotent by event id. Runs before the receipt. */
    ingest(session: string, payload: unknown): boolean {
      const s = d.service();
      const key = keyOfSession(session);
      const f = parseAppForward(payload);
      if (!s || !key || !f || f.event.conversationKey !== key) return false;
      s.ingestReplicated([f.event as AppEvent]);
      return s.store.hasEvent(key, f.event.eventId);
    },
    /** After the receipt. A stop or pause has taken effect when this returns. */
    accepted(session: string, messageId: string, payload: unknown): void {
      const s = d.service();
      const key = keyOfSession(session);
      const f = parseAppForward(payload);
      if (!s || !key || !f) return;
      if (f.urgent) {
        actOnUrgent(s, key, f, messageId);
        d.markInjected(session, messageId);
        return;
      }
      if (isExactStopMessage(f.event.text)) {
        actOnUrgent(s, key, { ...f, urgent: 'stop' }, messageId);
        d.markInjected(session, messageId);
        return;
      }
      void deliverForwarded(s, key, f, d)
        .catch((err: unknown) => {
          try { s.appendDelivery(key, messageId, 'unknown', f.seed); } catch { /* @silent-fallback-ok — the receipt's unset marker is the durable record */ }
          d.report?.('AppConversations.forward', err instanceof Error ? err.message : String(err));
        })
        .finally(() => d.markInjected(session, messageId));
    },
  };
}

/** A forwarded stop or pause, acted on here: the one place the owner and a drain's last resort do this. */
export function actOnUrgent(s: AppConversationService, key: string, f: AppForwardPayload, messageId: string): void {
  if (teamSignatureFailed(s, f)) { refuseForward(s, key, f, messageId, 'a team event whose signature failed'); return; }
  s.noteEmergency(key);
  if (f.urgent === 'pause') s.pause(key);
  else s.emergencyStop(key, f.stopScope);
  s.appendDelivery(key, messageId, 'intercepted', f.seed);
}

/** A team event this machine can show was not signed by the phone it names. `unknown` is not failed: a key may not have reached here yet. */
function teamSignatureFailed(s: AppConversationService, f: AppForwardPayload): boolean {
  return (f.event as { senderRole?: unknown }).senderRole === 'team' && s.verify(f.event) === 'failed';
}

/** A team send with no person would be remembered as the owner's words, so it does not run. */
function teamPersonMissing(f: AppForwardPayload): boolean {
  return (f.event as { senderRole?: unknown }).senderRole === 'team' && !f.memoryPersonId;
}

function refuseForward(s: AppConversationService, key: string, f: AppForwardPayload, messageId: string, why: string): void {
  s.appendDelivery(key, messageId, 'refused', f.seed);
  s.deps.reportDegradation?.('AppConversations.forward', `refused ${why}: ${messageId}`);
}

/** Who a forward's words came from. Only the owner's own message may fall back to the owner's name. */
export function forwardSpeakerName(s: AppConversationService, f: AppForwardPayload): string {
  const ev = f.event as { senderRole?: unknown; senderName?: unknown };
  if (f.ownerName) return f.ownerName;
  if (ev.senderRole !== 'team' && ev.senderRole !== 'msp') return s.ownerName();
  return typeof ev.senderName === 'string' && ev.senderName ? ev.senderName : 'Another person';
}

async function deliverForwarded(s: AppConversationService, key: string, f: AppForwardPayload, d: AppOwnerReceiverDeps): Promise<void> {
  const conv = s.liveConversation(key);
  const alias = s.deps.registry.appAliasFor(key);
  if (!conv || alias === null) { s.appendDelivery(key, f.event.messageId, 'refused', f.seed); return; }
  if (teamSignatureFailed(s, f)) { refuseForward(s, key, f, f.event.messageId, 'a team event whose signature failed'); return; }
  if (!s.deps.registry.isAppBound(alias)) s.deps.registry.bindApp(alias);
  if (d.classify && f.event.text) {
    let verdict: 'kill' | 'pause' | 'deliver' = 'deliver';
    try { verdict = await d.classify(f.event.text, alias); } catch { /* @silent-fallback-ok — FAIL-OPEN: a classifier error routes the message normally, as on the Telegram path */ }
    if (verdict !== 'deliver') { actOnUrgent(s, key, { ...f, urgent: verdict === 'kill' ? 'stop' : 'pause' }, f.event.messageId); return; }
  }
  if (teamPersonMissing(f)) { refuseForward(s, key, f, f.event.messageId, 'a team send with no person'); return; }
  const r = await dispatchStoredAppMessage(s, {
    key, alias, title: conv.title ?? 'Untitled', event: f.event,
    ownerName: forwardSpeakerName(s, f), memoryPersonId: f.memoryPersonId,
  });
  s.appendDelivery(key, f.event.messageId, r.outcome, f.seed);
}

// ── The inbound queue's app tail (§2.4) ─────────────────────────────────────────────────────────

export interface AppDrainDeps {
  service(): AppConversationService | null;
  route(msg: InboundMessage): Promise<RouteOutcome>;
  routerReady(): boolean;
}
export interface AppDrainRow { sessionKey: string; messageId: string; payload: string; senderEnvelope?: InboundMessage['senderEnvelope'] }
export interface AppDrainHandover { commitReceipt(): boolean; stopRecheck(): boolean }

/** A held message routes again; when it lands here it delivers like the send route. */
export function createAppDrainDeliver(d: AppDrainDeps) {
  const dispatching = new Set<string>();
  return async (dmsg: AppDrainRow, handover: AppDrainHandover): Promise<DrainDispatchResult> => {
    const svc = d.service();
    const f = parseAppForward(dmsg.payload);
    if (!svc || !f || !d.routerReady()) return { kind: 'failed', error: new Error('app forward could not be read') };
    const key = f.event.conversationKey;
    const out = await d.route({
      sessionKey: dmsg.sessionKey, messageId: dmsg.messageId, payload: f,
      // The envelope stored at the send, so the owner's sender check sees what the phone's request carried.
      senderEnvelope: dmsg.senderEnvelope,
      ...(f.urgent ? { appUrgent: f.urgent } : {}),
    });
    if (out.action === 'rejected') { svc.appendDelivery(key, dmsg.messageId, 'refused', f.seed); return { kind: 'sender-rejected' }; }
    if (out.action === 'queued' || out.action === 'placement-blocked') return { kind: 'un-routable', reason: out.detail ?? out.action };
    if (out.action === 'forwarded') {
      // The owner appends a message's outcome itself after dispatching. A stop has taken effect by its acknowledgement.
      if (f.urgent) svc.appendDelivery(key, dmsg.messageId, 'intercepted', f.seed);
      return { kind: 'remote-delivered' };
    }
    if (out.action !== 'handled-locally') return { kind: 'remote-delivered' };
    // An earlier forward may have reached a machine with only its answer lost, and a drain past its
    // deadline is still running. Either way this message has been handled: never a second dispatch.
    const already = svc.store.deliveryState(dmsg.messageId);
    if (dispatching.has(dmsg.messageId) || (already !== null && already !== 'pending' && already !== 'unknown')) return { kind: 'local-delivered' };
    const conv = svc.liveConversation(key);
    const alias = svc.deps.registry.appAliasFor(key);
    if (!conv || alias === null) { svc.appendDelivery(key, dmsg.messageId, 'unknown', f.seed); return { kind: 'local-delivered', injectError: 'conversation-gone' }; }
    if (!handover.commitReceipt()) return { kind: 'handover-refused' };
    if (handover.stopRecheck()) return { kind: 'stopped-before-inject' };
    dispatching.add(dmsg.messageId);
    try {
      if (f.urgent) {
        actOnUrgent(svc, key, f, dmsg.messageId);
        return { kind: 'local-delivered' };
      }
      // These two are decided here, so a plain refusal is the honest answer rather than `unknown`.
      if (teamSignatureFailed(svc, f)) { refuseForward(svc, key, f, dmsg.messageId, 'a team event whose signature failed'); return { kind: 'local-delivered' }; }
      if (teamPersonMissing(f)) { refuseForward(svc, key, f, dmsg.messageId, 'a team send with no person'); return { kind: 'local-delivered' }; }
      if (!svc.deps.registry.isAppBound(alias)) svc.deps.registry.bindApp(alias);
      const r = await dispatchStoredAppMessage(svc, { key, alias, title: conv.title ?? 'Untitled', event: f.event, ownerName: forwardSpeakerName(svc, f), memoryPersonId: f.memoryPersonId });
      // A refusal here says nothing about an earlier attempt that may have reached a machine:
      // `unknown` yields to its outcome, where a refusal could override it.
      svc.appendDelivery(key, dmsg.messageId, r.outcome === 'refused' ? 'unknown' : r.outcome, f.seed);
      return { kind: 'local-delivered' };
    } catch (err) { // @silent-fallback-ok — the message reads `unknown` in the app, and the queue reports it as possibly not injected
      svc.appendDelivery(key, dmsg.messageId, 'unknown', f.seed);
      return { kind: 'local-delivered', injectError: err instanceof Error ? err.message : String(err) };
    } finally {
      dispatching.delete(dmsg.messageId);
    }
  };
}
