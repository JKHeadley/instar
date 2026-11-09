/**
 * ChiefOfStaffActionProtocol — the §2.4 action protocol of docs/specs/chief-of-staff-topic.md.
 *
 * One small durable state machine for every side-effecting Chief of Staff action (restart
 * by inject, restart by bounded run, redirect): `claimed → executing → started | superseded |
 * rejected | lost | aborted`. Every transition is an immutable record in the `chiefOfStaff`
 * replicated store (ChiefOfStaffStore), and the ONLY place two things are serialised is the
 * ownership machine's per-conversation lock.
 *
 *   1. Claim (lease holder): write a signed `intent`, re-read the stand-down list after one
 *      local flush (a cheap early exit, never the arbiter), route the command to the
 *      conversation's ownership machine (local when self).
 *   2. Verify (ownership machine): the inner signature belongs to `currentHolder()` and that
 *      holder's renewal is fresh (`freshRenewalWithin(holder, ttlMs)`); ownership still names
 *      self; `nextActionAllowedAt` passed and the fold is not lagging; no OTHER open intent
 *      (lowest-HLC claimed-vs-claimed exemption); the operator lease is live; the transfer
 *      barrier is clear. An epoch number alone is never authority.
 *   3. Execute under the lock: repeat stand-down, consult the dedupe index (in-memory over the
 *      durable unified records + the run registry's idempotency keys; fail closed if unreadable),
 *      write `executing` and WAIT for it to be fsynced, perform, write `started`.
 *   4. Recovery: the holder never writes `lost` alone; `settle()` on the owner either finds a
 *      receipt (⇒ `started`) or writes `rejected`; a bare `executing` with no receipt settles
 *      `rejected`, never `started`.
 *   5. Compensation: duplicates return the recorded outcome; a run is stopped only by exact id.
 *
 * Signal vs. Authority: every refusal here is hard-invariant validation on an enumerable domain
 * (identity, freshness, ownership, idempotency) — the principle's own carve-outs — not a
 * judgment about what a message means. The LLM judge (PR 3) is a signal INTO `claim()`.
 *
 * Every dependency failure resolves to the SAFE side: reject / stand down / do nothing.
 */

import type { HlcTimestamp } from './HybridLogicalClock.js';
import {
  CHIEF_OF_STAFF_STORE_KEY,
  buildIntent, buildOutcome, deriveIntentKey, foldIntentState, latestPerKey, compareHlc,
  type CosAction, type CosTransition, type IntentState, type UnionEntry,
} from './ChiefOfStaffStore.js';

// ── commands (carried over the mesh; also used locally) ──────────────────────

export interface CosActionCommand {
  type: 'cos-action';
  conversationKey: string;
  action: CosAction;
  leaseEpoch: number;
  sequence: number;
  /** The machine that claimed (must equal the current lease holder at execution). */
  holderMachineId: string;
  /** Ed25519 signature by the holder over `canonicalCommand(...)`. */
  holderSignature: string;
  /** When the holder claimed (ISO). The command arrives before the holder's `intent` record has
   *  replicated more often than not, so the owner materialises an identical intent record from
   *  the VERIFIED command (same key, same holder, same signature) rather than rejecting. */
  claimedAt: string;
  /** Action payload (continuation / redirect text, run duration). Bounded by the caller. */
  payload: { text?: string; durationHours?: number };
}

export interface CosSettleCommand {
  type: 'cos-settle';
  conversationKey: string;
  intentKey: string;
  holderMachineId: string;
  holderSignature: string;
}

export type CosProtocolOutcome =
  | { outcome: 'started'; runId?: string; injectId?: string; duplicate?: boolean }
  | { outcome: 'rejected'; reason: CosRejectReason; duplicate?: boolean }
  | { outcome: 'superseded'; reason: string }
  | { outcome: 'routed'; target: string; result: unknown }
  | { outcome: 'disabled' };

export type CosRejectReason =
  | 'cos-disabled'
  | 'invalid-command'
  | 'holder-signature-invalid'
  | 'not-current-holder'
  | 'holder-lease-stale'
  | 'not-owner'
  | 'transfer-barrier'
  | 'operator-lease-expired'
  | 'next-action-not-allowed'
  | 'lagging-fold'
  | 'other-intent-open'
  | 'stand-down'
  | 'dedupe-index-unreadable'
  | 'durability-failed'
  | 'executor-failed'
  | 'intent-not-found';

export function canonicalCommand(c: { conversationKey: string; leaseEpoch: number; sequence: number; action: string; claimedAt?: string; payload?: { text?: string; durationHours?: number } }): string {
  // The payload (injected text, duration) and the claim time are INSIDE the signature, so a
  // forwarder cannot alter what gets injected and a replay cannot carry a fresher claimedAt.
  const payload = JSON.stringify({ text: c.payload?.text ?? null, durationHours: c.payload?.durationHours ?? null });
  return `cos:${c.conversationKey}:${c.leaseEpoch}:${c.sequence}:${c.action}:${c.claimedAt ?? ''}:${payload}`;
}

export function canonicalSettle(c: { conversationKey: string; intentKey: string }): string {
  return `cos-settle:${c.conversationKey}:${c.intentKey}`;
}

// ── stand-down (shared evaluator; §2.4) ──────────────────────────────────────

export type StandDownReason =
  | 'run-active'
  | 'run-queued'
  | 'reconciler-non-idle'
  | 'resume-queue-holds'
  | 'move-in-progress'
  | 'operator-stopped'
  | 'cos-intent-open'
  | 'registry-unreadable';

export interface StandDownInputs {
  /** Run registry view for the conversation: 'none' | 'history' (terminal) | 'open' | 'queued' | 'unknown'. */
  runState: 'none' | 'history' | 'open' | 'queued' | 'unknown';
  /** The Liveness Reconciler's condition for the topic, or null when idle/unknown-topic. */
  reconcilerCondition: string | null;
  resumeQueueHolds: boolean | null;
  moveInProgress: boolean | null;
  operatorStopped: boolean | null;
  /** Open CoS intents for the conversation, EXCLUDING the command's own key. */
  otherOpenIntents: IntentState[];
}

const IDLE_RECONCILER: ReadonlySet<string> = new Set(['healthy', 'terminal-turn', 'turn-revived']);

/** Pure. Returns the first stand-down reason, or null when the CoS may act. */
export function decideStandDown(i: StandDownInputs): StandDownReason | null {
  if (i.runState === 'unknown') return 'registry-unreadable';
  if (i.runState === 'open') return 'run-active';
  if (i.runState === 'queued') return 'run-queued';
  if (i.reconcilerCondition && !IDLE_RECONCILER.has(i.reconcilerCondition)) return 'reconciler-non-idle';
  if (i.resumeQueueHolds !== false) return 'resume-queue-holds';
  if (i.moveInProgress !== false) return 'move-in-progress';
  if (i.operatorStopped !== false) return 'operator-stopped';
  if (i.otherOpenIntents.length > 0) return 'cos-intent-open';
  return null;
}

/**
 * Pure. §2.4 step 2(d): among the open intents for one conversation, may `mine` proceed?
 * - Any OTHER intent that reached `executing`, or belongs to a different machine than the
 *   current owner's view of the holder, blocks (→ 'other-intent-open').
 * - When every open intent is still `claimed`, the lowest intent HLC proceeds and the rest
 *   are to be marked `superseded` (returned in `supersede`).
 */
export function arbitrateClaims(mine: IntentState, others: IntentState[]): { proceed: boolean; supersede: IntentState[]; reason?: CosRejectReason; lostToLowerHlc?: boolean } {
  const open = others.filter((o) => o.open);
  if (open.length === 0) return { proceed: true, supersede: [] };
  if (open.some((o) => o.state === 'executing')) return { proceed: false, supersede: [], reason: 'other-intent-open' };
  const lowest = [mine, ...open].reduce((a, b) => (compareHlc(a.intentHlc, b.intentHlc) <= 0 ? a : b));
  if (lowest.intentKey !== mine.intentKey) return { proceed: false, supersede: [], reason: 'other-intent-open', lostToLowerHlc: true };
  return { proceed: true, supersede: open };
}

// ── deps ─────────────────────────────────────────────────────────────────────

export interface CosJournalSeam {
  /** Emit through the replicated-record emitter; `seq` present only when accepted. */
  emit(recordKey: string, build: (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null): { outcome: string; seq?: number };
  /** Resolve once `seq` is fsynced (CoherenceJournal.awaitDurableSeq); reject on timeout/error. */
  awaitDurable(seq: number): Promise<void>;
  /** One local flush (the early-exit re-read in step 1). */
  flush(): void;
  /** The union of every machine's chiefOfStaff records (own + peers). Throws ⇒ unreadable. */
  loadUnion(): UnionEntry[];
}

export interface CosProtocolDeps {
  enabled: () => boolean;
  now: () => number;
  machineId: string;
  journal: CosJournalSeam;
  lease: {
    currentHolder(): string | null;
    freshRenewalWithin(machineId: string, ms: number): boolean;
    ttlMs: number;
    currentEpoch(): number;
    holdsLease(): boolean;
  };
  /** The machine named in the conversation's ownership record, or null when unowned. */
  ownerOf(conversationKey: string): string | null;
  sign(canonical: string): string;
  verify(canonical: string, signature: string, machineId: string): boolean;
  runRegistry: {
    stateFor(conversationKey: string): StandDownInputs['runState'];
    findByIdempotencyKey(key: string): { runId: string } | null;
    stopRun?(runId: string, reason: string): void;
  };
  reconcilerCondition(conversationKey: string): string | null;
  resumeQueueHolds(conversationKey: string): boolean;
  moveInProgress(conversationKey: string): boolean;
  operatorStoppedSince(conversationKey: string, sinceIso: string): boolean;
  /** The operator check-in lease (§4), derived by PR 3; PR 2 takes it as a dep. */
  operatorLeaseLive(): boolean;
  /** Derived `nextActionAllowedAt` ISO for the conversation (null = none) and the newest check age in ms. */
  actionGate(conversationKey: string): { nextActionAllowedAt: string | null; newestCheckAgeMs: number | null };
  /** Freshness ceiling for the fold at execution (§2.4 step 2c): 2 ticks. */
  laggingFoldMs: number;
  withConversationLock<T>(conversationKey: string, fn: () => Promise<T>): Promise<T>;
  executors: {
    startRun(input: { conversationKey: string; idempotencyKey: string; durationHours?: number; text?: string }): Promise<{ runId: string }>;
    inject(input: { conversationKey: string; idempotencyKey: string; text: string }): Promise<{ injectId: string }>;
    liveSession(conversationKey: string): boolean;
  };
  /** Send a command to another machine; the protocol calls it only when owner ≠ self. */
  route(targetMachineId: string, command: CosActionCommand | CosSettleCommand): Promise<unknown>;
  /** Max duration for a CoS-started run (config `chiefOfStaff.maxRunHours`). */
  maxRunHours: number;
  log?: (line: string) => void;
}

// ── the protocol ─────────────────────────────────────────────────────────────

interface IndexEntry { state: CosTransition; runId?: string; injectId?: string }

export class ChiefOfStaffActionProtocol {
  private index = new Map<string, IndexEntry>();
  private indexReady = false;
  private adoptedConversations = new Set<string>();
  private sequence = 0;

  constructor(private readonly d: CosProtocolDeps) {}

  // ── index (step 3) ──

  /** Rebuild the dedupe index from durable sources only. Throws ⇒ callers fail closed. */
  rebuildIndex(): void {
    const union = this.d.journal.loadUnion();
    const next = new Map<string, IndexEntry>();
    for (const st of foldIntentState(union).values()) {
      next.set(st.intentKey, { state: st.state, runId: st.runId, injectId: st.injectId });
    }
    this.index = next;
    this.indexReady = true;
  }

  /** §2.4 step 3 transfer barrier: a conversation may be acted on by THIS machine only once
   *  every open intent from a previous owner has an outcome. */
  adopt(conversationKey: string): { ok: boolean; openFromOthers: string[] } {
    this.rebuildIndex();
    const open = this.openIntentsFor(conversationKey).filter((s) => s.open && !this.ownedBy(s, this.d.machineId));
    if (open.length > 0) return { ok: false, openFromOthers: open.map((s) => s.intentKey) };
    this.adoptedConversations.add(conversationKey);
    return { ok: true, openFromOthers: [] };
  }

  private ownedBy(st: IntentState, machineId: string): boolean {
    // The claim record carries the holder machine; the executing/started records carry the owner.
    const claim = latestPerKey(this.safeUnion()).get(st.intentKey);
    return claim?.data.machine === machineId;
  }

  private safeUnion(): UnionEntry[] {
    try { return this.d.journal.loadUnion(); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ return []; }
  }

  /** null ⇒ the union could not be read (callers stand down). */
  private openIntentsForOrNull(conversationKey: string): IntentState[] | null {
    let union: UnionEntry[];
    try { union = this.d.journal.loadUnion(); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ return null; }
    const out: IntentState[] = [];
    for (const st of foldIntentState(union).values()) if (st.conversationKey === conversationKey) out.push(st);
    return out;
  }

  private openIntentsFor(conversationKey: string): IntentState[] {
    return this.openIntentsForOrNull(conversationKey) ?? [];
  }

  // ── stand-down (shared with the Reconciler / resume queue / heartbeat) ──

  /** The reason the CoS (or another producer) must stand down for this conversation, or null. */
  standDown(conversationKey: string, excludeIntentKey?: string): StandDownReason | null {
    const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ return fallback; } };
    const sinceIso = new Date(this.d.now() - 7 * 24 * 3_600_000).toISOString();
    const intents = this.openIntentsForOrNull(conversationKey);
    if (intents === null) return 'registry-unreadable';
    return decideStandDown({
      runState: safe(() => this.d.runRegistry.stateFor(conversationKey), 'unknown'),
      reconcilerCondition: safe(() => this.d.reconcilerCondition(conversationKey), 'unknown'),
      resumeQueueHolds: safe(() => this.d.resumeQueueHolds(conversationKey), null),
      moveInProgress: safe(() => this.d.moveInProgress(conversationKey), null),
      operatorStopped: safe(() => this.d.operatorStoppedSince(conversationKey, sinceIso), null),
      otherOpenIntents: intents.filter((s) => s.open && s.intentKey !== excludeIntentKey),
    });
  }

  /** For other producers: is ANY CoS intent open for this conversation? An unreadable union
   *  answers TRUE (stand down), never false. */
  hasOpenIntent(conversationKey: string): boolean {
    const intents = this.openIntentsForOrNull(conversationKey);
    return intents === null ? true : intents.some((s) => s.open);
  }

  // ── step 1: claim (lease holder) ──

  async claim(input: { conversationKey: string; action: CosAction; payload: CosActionCommand['payload'] }): Promise<CosProtocolOutcome> {
    if (!this.d.enabled()) return { outcome: 'disabled' };
    if (!this.d.lease.holdsLease()) return { outcome: 'rejected', reason: 'not-current-holder' };
    if (!this.d.operatorLeaseLive()) return { outcome: 'rejected', reason: 'operator-lease-expired' };
    const pre = this.standDown(input.conversationKey);
    if (pre) return { outcome: 'rejected', reason: 'stand-down' };
    const leaseEpoch = this.d.lease.currentEpoch();
    const sequence = ++this.sequence + Math.floor(this.d.now() % 1_000_000) * 1000; // unique per holder process + time
    const intentKey = deriveIntentKey(input.conversationKey, leaseEpoch, sequence);
    if (!intentKey) return { outcome: 'rejected', reason: 'invalid-command' };
    const claimedAt = new Date(this.d.now()).toISOString();
    const cmd: CosActionCommand = {
      type: 'cos-action', conversationKey: input.conversationKey, action: input.action, leaseEpoch, sequence,
      holderMachineId: this.d.machineId, holderSignature: this.d.sign(canonicalCommand({ conversationKey: input.conversationKey, leaseEpoch, sequence, action: input.action, claimedAt, payload: input.payload })),
      claimedAt, payload: input.payload,
    };
    const r = this.d.journal.emit(intentKey, buildIntent({
      conversationKey: input.conversationKey, action: input.action, leaseEpoch, sequence,
      claimedAt, machine: this.d.machineId, holderSignature: cmd.holderSignature,
    }));
    if (r.outcome !== 'emitted' && r.outcome !== 'accepted') return { outcome: 'rejected', reason: 'durability-failed' };
    // Early exit after one local flush (never the arbiter — the owner's lock is).
    try { this.d.journal.flush(); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ /* flush failure surfaces at step 3 */ }
    const post = this.standDown(input.conversationKey, intentKey);
    if (post && post !== 'cos-intent-open') { await this.writeOutcome(intentKey, 'superseded', 'holder', post); return { outcome: 'superseded', reason: post }; }
    const owner = this.safeOwner(input.conversationKey);
    if (owner && owner !== this.d.machineId) {
      let result: unknown;
      try { result = await this.d.route(owner, cmd); } catch (e) { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ result = { outcome: 'rejected', reason: 'executor-failed', error: (e as Error)?.message }; }
      return { outcome: 'routed', target: owner, result };
    }
    return this.execute(cmd);
  }

  private safeOwner(conversationKey: string): string | null {
    try { return this.d.ownerOf(conversationKey); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ return null; }
  }

  // ── step 2 + 3: verify + execute (ownership machine) ──

  /** Refusals that mean "this command never proved who sent it": nothing durable is written for
   *  them, so an unauthenticated peer cannot populate the replicated store or pre-reject a key. */
  static readonly PRE_AUTH_REASONS: ReadonlySet<CosRejectReason> = new Set<CosRejectReason>(['invalid-command', 'holder-signature-invalid', 'not-current-holder', 'holder-lease-stale']);

  verifyCommand(cmd: CosActionCommand): CosRejectReason | null {
    if (!cmd || cmd.type !== 'cos-action' || !deriveIntentKey(cmd.conversationKey, cmd.leaseEpoch, cmd.sequence)) return 'invalid-command';
    if (typeof cmd.claimedAt !== 'string' || !Number.isFinite(Date.parse(cmd.claimedAt))) return 'invalid-command';
    let ok = false;
    try { ok = this.d.verify(canonicalCommand(cmd), cmd.holderSignature, cmd.holderMachineId); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ ok = false; }
    if (!ok) return 'holder-signature-invalid';
    let holder: string | null = null;
    try { holder = this.d.lease.currentHolder(); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ holder = null; }
    if (!holder || holder !== cmd.holderMachineId) return 'not-current-holder';
    let fresh = false;
    try { fresh = this.d.lease.freshRenewalWithin(holder, this.d.lease.ttlMs); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ fresh = false; }
    if (!fresh) return 'holder-lease-stale';
    // Replay window: the command must belong to the CURRENT lease epoch (§2.6) and its signed
    // claim time must be younger than one run ceiling; the dedupe index covers the rest.
    let epoch = -1;
    try { epoch = this.d.lease.currentEpoch(); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ epoch = -1; }
    if (cmd.leaseEpoch !== epoch) return 'not-current-holder';
    const ageMs = this.d.now() - Date.parse(cmd.claimedAt);
    if (ageMs < -this.d.laggingFoldMs || ageMs > this.d.maxRunHours * 3_600_000) return 'invalid-command';
    const owner = this.safeOwner(cmd.conversationKey);
    if (owner !== this.d.machineId) return 'not-owner';
    if (!this.safeBool(() => this.d.operatorLeaseLive(), false)) return 'operator-lease-expired';
    let gate: { nextActionAllowedAt: string | null; newestCheckAgeMs: number | null };
    try { gate = this.d.actionGate(cmd.conversationKey); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ return 'lagging-fold'; }
    if (gate.newestCheckAgeMs !== null && gate.newestCheckAgeMs > this.d.laggingFoldMs) return 'lagging-fold';
    if (gate.nextActionAllowedAt && Date.parse(gate.nextActionAllowedAt) > this.d.now()) return 'next-action-not-allowed';
    return null;
  }

  async execute(cmd: CosActionCommand): Promise<CosProtocolOutcome> {
    if (!this.safeBool(() => this.d.enabled(), false)) return { outcome: 'disabled' };
    const intentKey = deriveIntentKey(cmd.conversationKey, cmd.leaseEpoch, cmd.sequence);
    const reject = this.verifyCommand(cmd);
    if (reject) {
      if (intentKey && !ChiefOfStaffActionProtocol.PRE_AUTH_REASONS.has(reject)) await this.writeOutcome(intentKey, 'rejected', 'ownership-machine', reject);
      return { outcome: 'rejected', reason: reject };
    }
    const key = intentKey!;
    return this.d.withConversationLock(cmd.conversationKey, async () => {
      // Dedupe index: fail closed if it cannot be (re)built.
      try { if (!this.indexReady) this.rebuildIndex(); else this.rebuildIndex(); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ return { outcome: 'rejected', reason: 'dedupe-index-unreadable' } as CosProtocolOutcome; }
      const seen = this.index.get(key);
      if (seen && seen.state !== 'claimed') return this.recordedOutcome(seen);
      // Transfer barrier (§2.4 step 3) + other-open-intent rule (step 2d) + stand-down (step 3).
      let mine = foldIntentState(this.safeUnion()).get(key);
      if (!mine) {
        // The holder's intent has not replicated yet (the normal case for a routed command).
        // The command IS the claim — verified against the current holder's key — so write an
        // identical intent record here (same key; the substrate keeps one per key) and proceed.
        const claimedAt = typeof cmd.claimedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(cmd.claimedAt) ? cmd.claimedAt : new Date(this.d.now()).toISOString();
        const w = this.d.journal.emit(key, buildIntent({ conversationKey: cmd.conversationKey, action: cmd.action, leaseEpoch: cmd.leaseEpoch, sequence: cmd.sequence, claimedAt, machine: cmd.holderMachineId, holderSignature: cmd.holderSignature }));
        if (w.seq !== undefined) { try { await this.d.journal.awaitDurable(w.seq); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ /* the executing wait below fails closed */ } }
        try { this.rebuildIndex(); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ return { outcome: 'rejected', reason: 'dedupe-index-unreadable' } as CosProtocolOutcome; }
        mine = foldIntentState(this.safeUnion()).get(key);
        if (!mine) { await this.writeOutcome(key, 'rejected', 'ownership-machine', 'intent-not-found'); return { outcome: 'rejected', reason: 'intent-not-found' }; }
      }
      const others = this.openIntentsFor(cmd.conversationKey).filter((s) => s.intentKey !== key);
      if (others.some((s) => s.open && !this.ownedBy(s, cmd.holderMachineId))) { await this.writeOutcome(key, 'rejected', 'ownership-machine', 'transfer-barrier'); return { outcome: 'rejected', reason: 'transfer-barrier' }; }
      const arb = arbitrateClaims(mine, others);
      if (!arb.proceed) {
        // A claim that lost to a lower-HLC claim is SUPERSEDED (the race resolved against it);
        // a claim blocked by an intent already executing is rejected and may be re-presented
        // once that intent settles.
        if (arb.lostToLowerHlc) { await this.writeOutcome(key, 'superseded', 'ownership-machine', 'lower-hlc-won'); this.index.set(key, { state: 'superseded' }); return { outcome: 'superseded', reason: 'lower-hlc-won' }; }
        await this.writeOutcome(key, 'rejected', 'ownership-machine', arb.reason ?? 'other-intent-open'); return { outcome: 'rejected', reason: arb.reason ?? 'other-intent-open' };
      }
      for (const s of arb.supersede) await this.writeOutcome(s.intentKey, 'superseded', 'ownership-machine', 'lower-hlc-won');
      const sd = this.standDown(cmd.conversationKey, key);
      if (sd && sd !== 'cos-intent-open') { await this.writeOutcome(key, 'rejected', 'ownership-machine', sd); return { outcome: 'rejected', reason: 'stand-down' }; }
      // `executing` durable BEFORE the side effect.
      const ex = this.d.journal.emit(`${key}:outcome:executing`, buildOutcome({ intentKey: key, transition: 'executing', writer: 'ownership-machine', machine: this.d.machineId, at: new Date(this.d.now()).toISOString() }));
      if ((ex.outcome !== 'emitted' && ex.outcome !== 'accepted') || ex.seq === undefined) { await this.writeOutcome(key, 'rejected', 'ownership-machine', 'durability-failed'); return { outcome: 'rejected', reason: 'durability-failed' }; }
      try { await this.d.journal.awaitDurable(ex.seq); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ await this.writeOutcome(key, 'rejected', 'ownership-machine', 'durability-failed'); return { outcome: 'rejected', reason: 'durability-failed' }; }
      this.index.set(key, { state: 'executing' });
      // Perform.
      try {
        if (cmd.action === 'restart-run') {
          const hours = Math.min(this.d.maxRunHours, Math.max(0.25, cmd.payload?.durationHours ?? this.d.maxRunHours));
          const { runId } = await this.d.executors.startRun({ conversationKey: cmd.conversationKey, idempotencyKey: key, durationHours: hours, text: cmd.payload?.text });
          await this.writeOutcome(key, 'started', 'ownership-machine', undefined, { runId });
          this.index.set(key, { state: 'started', runId });
          return { outcome: 'started', runId };
        }
        const text = cmd.payload?.text ?? '';
        const { injectId } = await this.d.executors.inject({ conversationKey: cmd.conversationKey, idempotencyKey: key, text });
        await this.writeOutcome(key, 'started', 'ownership-machine', undefined, { injectId });
        this.index.set(key, { state: 'started', injectId });
        return { outcome: 'started', injectId };
      } catch (e) { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */
        await this.writeOutcome(key, 'aborted', 'ownership-machine', `executor-failed:${(e as Error)?.message ?? 'unknown'}`.slice(0, 200));
        this.index.set(key, { state: 'aborted' });
        return { outcome: 'rejected', reason: 'executor-failed' };
      }
    });
  }

  private recordedOutcome(e: IndexEntry): CosProtocolOutcome {
    if (e.state === 'started') return { outcome: 'started', runId: e.runId, injectId: e.injectId, duplicate: true };
    if (e.state === 'superseded') return { outcome: 'superseded', reason: 'recorded' };
    return { outcome: 'rejected', reason: 'intent-not-found', duplicate: true };
  }

  // ── step 4: settle (ownership machine), then the holder writes `lost` ──

  async settle(cmd: CosSettleCommand): Promise<{ settled: 'started' | 'rejected' | 'unknown'; runId?: string }> {
    if (!this.safeBool(() => this.d.enabled(), false)) return { settled: 'unknown' };
    // Same authentication floor as execute(): the signature must be the CURRENT lease holder's,
    // with a fresh renewal, and the intent must exist and have been claimed by that holder.
    // Anything less answers `unknown` and writes NOTHING — a peer must not be able to tombstone
    // (pre-reject) a predictable key before the real command arrives.
    if (!this.safeBool(() => this.d.verify(canonicalSettle(cmd), cmd.holderSignature, cmd.holderMachineId), false)) return { settled: 'unknown' };
    let holder: string | null = null;
    try { holder = this.d.lease.currentHolder(); } catch { /* @silent-fallback-ok: an unreadable lease view answers unknown (no write) */ holder = null; }
    if (!holder || holder !== cmd.holderMachineId) return { settled: 'unknown' };
    if (!this.safeBool(() => this.d.lease.freshRenewalWithin(holder!, this.d.lease.ttlMs), false)) return { settled: 'unknown' };
    const claim = latestPerKey(this.safeUnion()).get(cmd.intentKey);
    if (!claim || claim.data.recordType !== 'intent' || claim.data.conversationKey !== cmd.conversationKey) return { settled: 'unknown' };
    // CMT-1417: after a lease failover the CURRENT holder (verified above, fresh renewal) may settle an intent a
    // PREVIOUS holder claimed — but only once that claim is older than a lease TTL, so the previous holder cannot
    // still be acting on it. A peer that is not the current holder never reaches this line.
    // Step 2(b)/4: only the conversation's OWNER settles, and only the machine that wrote `executing` may
    // judge whether a receipt exists (another machine's registry cannot see this run).
    if ((this.safeOwner(cmd.conversationKey) ?? this.d.machineId) !== this.d.machineId) return { settled: 'unknown' };
    const executing = latestPerKey(this.safeUnion()).get(`${cmd.intentKey}:outcome:executing`);
    if (executing && executing.data.machine !== this.d.machineId) return { settled: 'unknown' };
    const priorHolder = claim.data.machine !== cmd.holderMachineId ? String(claim.data.machine) : null;
    if (priorHolder) {
      // Minimum age: the larger of a lease TTL and the lagging-fold window (wall clocks differ between machines; the
      // conversation lock, not this guard, is what protects a run still executing on THIS machine).
      const claimedAt = typeof claim.data.claimedAt === 'string' ? Date.parse(claim.data.claimedAt) : NaN;
      if (!Number.isFinite(claimedAt) || this.d.now() - claimedAt <= Math.max(this.d.lease.ttlMs, this.d.laggingFoldMs)) return { settled: 'unknown' };
    }
    const why = (base: string) => (priorHolder ? `${base};prior-holder=${priorHolder}`.slice(0, 200) : base);
    return this.d.withConversationLock(cmd.conversationKey, async () => {
      try { this.rebuildIndex(); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ return { settled: 'unknown' as const }; }
      const seen = this.index.get(cmd.intentKey);
      if (seen?.state === 'started') return { settled: 'started' as const, runId: seen.runId };
      let receipt: { runId: string } | null = null;
      try { receipt = this.d.runRegistry.findByIdempotencyKey(cmd.intentKey); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ return { settled: 'unknown' as const }; }
      if (receipt) {
        await this.writeOutcome(cmd.intentKey, 'started', 'ownership-machine', why('settled-from-registry'), { runId: receipt.runId });
        this.index.set(cmd.intentKey, { state: 'started', runId: receipt.runId });
        return { settled: 'started' as const, runId: receipt.runId };
      }
      // No receipt: a bare `executing` (or a claim that never arrived) is tombstoned, never re-run.
      await this.writeOutcome(cmd.intentKey, 'rejected', 'ownership-machine', why('settled-no-receipt'));
      this.index.set(cmd.intentKey, { state: 'rejected' });
      return { settled: 'rejected' as const };
    });
  }

  /** Holder side of recovery: ask the owner to settle an open intent, then (and only then) write `lost`. */
  async settleOpenIntent(st: IntentState): Promise<'started' | 'lost' | 'blocked'> {
    const owner = this.safeOwner(st.conversationKey) ?? this.d.machineId;
    const cmd: CosSettleCommand = { type: 'cos-settle', conversationKey: st.conversationKey, intentKey: st.intentKey, holderMachineId: this.d.machineId, holderSignature: this.d.sign(canonicalSettle({ conversationKey: st.conversationKey, intentKey: st.intentKey })) };
    let res: { settled?: string } | null = null;
    try { res = (owner === this.d.machineId ? await this.settle(cmd) : (await this.d.route(owner, cmd)) as { settled?: string }); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ res = null; }
    if (res?.settled === 'started') return 'started';
    if (res?.settled === 'rejected') { await this.writeOutcome(st.intentKey, 'lost', 'holder', 'settled-by-owner'); return 'lost'; }
    return 'blocked'; // owner unreachable / unknown: keep blocking, escalate in the note (PR 3)
  }

  // ── step 5: compensation by exact run id only ──

  async abortOwnRun(intentKey: string, runId: string, reason: string): Promise<void> {
    const seen = this.index.get(intentKey);
    if (!seen || seen.runId !== runId) return; // never stop a run we did not start under this key
    try { this.d.runRegistry.stopRun?.(runId, reason); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ /* best-effort; the aborted record is the truth */ }
    await this.writeOutcome(intentKey, 'aborted', 'ownership-machine', reason, { runId });
    this.index.set(intentKey, { state: 'aborted', runId });
  }

  // ── helpers ──

  private async writeOutcome(intentKey: string, transition: Exclude<CosTransition, 'claimed'>, writer: 'ownership-machine' | 'holder', reason?: string, ids?: { runId?: string; injectId?: string }): Promise<void> {
    try {
      const r = this.d.journal.emit(`${intentKey}:outcome:${transition}`, buildOutcome({ intentKey, transition, writer, machine: this.d.machineId, at: new Date(this.d.now()).toISOString(), ...(reason ? { reason: reason.slice(0, 200) } : {}), ...(ids?.runId ? { runId: ids.runId } : {}), ...(ids?.injectId ? { injectId: ids.injectId } : {}) }));
      if (r.seq !== undefined) { try { await this.d.journal.awaitDurable(r.seq); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ this.d.log?.(`[cos-protocol] ${transition} for ${intentKey} not confirmed durable`); } }
    } catch (e) { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */
      this.d.log?.(`[cos-protocol] failed to write ${transition} for ${intentKey}: ${(e as Error)?.message}`);
    }
  }

  private safeBool(fn: () => boolean, fallback: boolean): boolean {
    try { return fn(); } catch { /* @silent-fallback-ok: resolves to the SAFE side by design (refuse / stand down / no side effect) — the Chief of Staff action protocol must never act on an unreadable seam; every refusal is recorded or returned, never swallowed into action (docs/specs/chief-of-staff-topic.md §2.4) */ return fallback; }
  }

  /** The derived operator check-in lease as the deps report it (safe side: false). */
  operatorLeaseLive(): boolean {
    return this.safeBool(() => this.d.operatorLeaseLive(), false);
  }

  /** Read-only status for `GET /chief-of-staff` (PR 3). */
  status(): { indexReady: boolean; indexed: number; adopted: string[] } {
    return { indexReady: this.indexReady, indexed: this.index.size, adopted: [...this.adoptedConversations] };
  }
}

export const COS_STORE_KEY_FOR_PROTOCOL = CHIEF_OF_STAFF_STORE_KEY;
