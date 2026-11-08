/**
 * The two ways an app conversation changes machine (docs/specs/app-conversations-in-the-pool.md §2.2):
 * a move through a completed drain (§2.5), and the operator's "bring it back here". Both run on the
 * lease holder. No pin is ever written, and nothing here retries or re-places by itself.
 */
import { createHash } from 'node:crypto';
import { planTransferByNickname } from './TransferByNickname.js';
import type { OwnershipAction, SessionOwnershipRecord } from './SessionOwnership.js';
import { BRING_BACK_EPOCH_MARGIN, MEMORY_STARTS_EMPTY, NEEDS_UPDATE, NO_PRIVATE_MEMORY, appRecordKey } from './appConversationPool.js';
import type { MachineCapacity } from './types.js';
import { READINESS_CONTACT_MAX_AGE_MS } from './poolReadiness.js';

export interface AppMoveAnswer { status: number; body: Record<string, unknown> }

export interface AppDrainAnswer { ok: boolean; status?: string; reason?: string; claimLanded?: boolean; runSuspended?: boolean; noHandler?: boolean; leftBehind?: { files?: number; notes?: number } }

export interface AppMoveDeps {
  selfId: string;
  capacity(machineId: string): MachineCapacity | undefined;
  /** Nickname or machine id → machine id. */
  resolveMachine(nameOrId: string): string | null;
  validNames(): string[];
  /** The whole-pool gate (§2.6). */
  everyMachineFlagged(): boolean;
  /** This machine advertises the flag. */
  selfFlagged(): boolean;
  selfDrainable(): boolean;
  conversation(conversationKey: string): { ownerPerson?: unknown } | null;
  read(recordKey: string): SessionOwnershipRecord | null;
  cas(recordKey: string, action: OwnershipAction, why: 'user-move' | 'failover' | 'released'): { ok: boolean; record?: SessionOwnershipRecord };
  sendDrain(owner: string, recordKey: string, target: string, epoch: number): Promise<AppDrainAnswer>;
  /**
   * Before a drain with the delivery-ledger hand-off active, the target must already hold this record:
   * it takes custody only from the owner its own copy names. Nudges and waits, bounded. False: not yet.
   * Absent ⇒ no wait.
   */
  awaitTargetRecord?(target: string, recordKey: string, epoch: number): Promise<boolean>;
  /** The source owner's view of the record, its copy being ahead of this machine's by up to 15 s. Null: it can't be asked. */
  askOwner(owner: string, recordKey: string): Promise<{ owner: string; status: string; epoch: number } | null>;
  /** A live autonomous run on the machine the conversation is leaving. */
  autonomousRun(owner: string, conversationKey: string): Promise<{ goal: string | null; remainingMinutes: number | null; runKey?: string | null } | null>;
  setMoveInFlight(recordKey: string, inFlight: boolean): void;
  /** Files and notes that stay behind on the old owner when this machine is it. */
  leftBehindHere(conversationKey: string): { files: number; notes: number };
  /** The session pulled its state over (working set, profile). Fire and forget. */
  afterMove(target: string, recordKey: string, prevOwner: string): void;
  lastMoveAt(recordKey: string): number | null;
  noteMoved(recordKey: string): void;
  now(): number;
}

const refused = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): AppMoveAnswer => ({ status, body: { ok: false, code, error, ...extra } });

/** POST /pool/transfer for `app:<key>`, on the lease holder (§2.5). */
export async function runAppMove(d: AppMoveDeps, input: { conversationKey: string; to: string; confirm: boolean; confirmationChallenge?: string }): Promise<AppMoveAnswer> {
  const recordKey = appRecordKey(input.conversationKey);
  const conv = d.conversation(input.conversationKey);
  if (!conv) return refused(404, 'unknown-conversation', 'This conversation isn\'t on this agent any more.');

  const target = d.resolveMachine(input.to);
  const before = d.read(recordKey);
  const hasOwner = before !== null && before.status !== 'released';
  if (hasOwner && before.status !== 'active') {
    return { status: 409, body: { retryRequired: true, error: 'This conversation is moving right now. Try again in a moment.' } };
  }
  // With no record the lease holder is the current owner (§2.5 virtual baseline).
  const currentOwner = hasOwner ? before.ownerMachineId : d.selfId;
  const baselineEpoch = before?.ownershipEpoch ?? 0;

  // A move to where it already is is a no-op, before any gate: nothing is written.
  if (target !== null && target === currentOwner) {
    return { status: 200, body: { ok: true, seatMoved: true, action: 'noop', topicId: recordKey, targetMachine: target, targetNickname: d.capacity(target)?.nickname ?? null, pinned: false } };
  }

  // §2.6 the whole-pool gate, the target's flag, the current owner's drain and flag.
  if (!d.everyMachineFlagged() || !d.selfFlagged()) return refused(409, 'needs-update', NEEDS_UPDATE);
  if (target !== null && target !== d.selfId && d.capacity(target)?.seamlessnessFlags?.appConversationsPool !== true) return refused(409, 'needs-update', NEEDS_UPDATE);
  if (currentOwner === d.selfId ? !d.selfDrainable() : d.capacity(currentOwner)?.seamlessnessFlags?.ws12DrainReceive !== true) return refused(409, 'needs-update', NEEDS_UPDATE);
  // §2.5 memory privacy: a support person's conversation goes only to a machine that keeps private memory.
  if (target !== null && conv.ownerPerson && d.capacity(target)?.seamlessnessFlags?.memoryPrivacyEnforced !== true) return refused(409, 'memory-privacy', NO_PRIVATE_MEMORY);

  let run: Awaited<ReturnType<AppMoveDeps['autonomousRun']>> = null;
  try { run = await d.autonomousRun(currentOwner, input.conversationKey); }
  catch { run = { goal: 'owner run state could not be verified', remainingMinutes: null, runKey: 'unverified' }; } // Fail closed: an owner that can't answer can't prove there is no run. // @silent-fallback-ok — fail closed: asks for consent
  const after = d.read(recordKey);
  if (after?.ownerMachineId !== before?.ownerMachineId || after?.ownershipEpoch !== before?.ownershipEpoch) {
    return { status: 409, body: { retryRequired: true, error: 'This conversation moved while checking. Try again.' } };
  }

  const plan = planTransferByNickname({ intent: 'transfer', nickname: input.to, matchedVerb: 'transfer' }, {
    resolveNickname: () => target,
    validNicknames: d.validNames,
    isOnline: (m) => m === d.selfId || d.capacity(m)?.online === true,
    currentOwnerOf: () => currentOwner,
    isMidReply: () => false,
    lastPlacementUpdateAt: () => d.lastMoveAt(recordKey),
    now: d.now,
    autonomousRunActive: () => run,
  }, recordKey);
  if (plan.action === 'reject') {
    if (plan.rejectReason === 'unknown-machine-nickname') return { status: 404, body: { error: `unknown machine "${input.to}". Known: ${(plan.validNicknames ?? []).join(', ') || '(none)'}`, rejectReason: plan.rejectReason } };
    return { status: 409, body: { error: `cannot transfer right now (${plan.rejectReason})`, rejectReason: plan.rejectReason } };
  }
  // A move to a machine that isn't here is refused, not confirmed (§2.5): only a completed drain moves it.
  if ((plan.detail ?? '').includes('target-offline')) return refused(409, 'target-offline', 'That machine isn\'t answering right now, so this conversation stays where it is.');
  if (plan.action === 'noop' || !target) return { status: 200, body: { ok: true, seatMoved: true, action: 'noop', topicId: recordKey, targetMachine: plan.targetMachine ?? null, pinned: false } };

  if (plan.action === 'confirm-required') {
    const confirmationChallenge = createHash('sha256').update(JSON.stringify({
      topicId: recordKey, targetMachine: target, detail: plan.detail, owner: currentOwner, ownershipEpoch: baselineEpoch,
      runKey: run?.runKey ?? null, runGoal: run?.goal ?? null,
    })).digest('hex');
    if (!input.confirm || input.confirmationChallenge !== confirmationChallenge) {
      return { status: 409, body: { needsConfirmation: true, prompt: `${plan.confirmationPrompt} ${MEMORY_STARTS_EMPTY}`, targetMachine: target, detail: plan.detail, confirmationChallenge } };
    }
  }

  d.setMoveInFlight(recordKey, true);
  try {
    // The baseline (§2.5): an unmoved conversation gets a record naming the holder, two CAS steps,
    // and the drain sees the new epoch, not the baseline.
    let drainEpoch = before?.ownershipEpoch ?? 0;
    if (!hasOwner) {
      const placed = d.cas(recordKey, { type: 'place', machineId: d.selfId }, 'user-move');
      const claimed = placed.ok ? d.cas(recordKey, { type: 'claim', machineId: d.selfId }, 'user-move') : { ok: false as const };
      const now = d.read(recordKey);
      if (!placed.ok || !claimed.ok || now?.status !== 'active' || now.ownerMachineId !== d.selfId || now.ownershipEpoch <= baselineEpoch) {
        return { status: 409, body: { retryRequired: true, failedNeedsRetry: true, error: 'This conversation changed while it was being set up to move. Try again.' } };
      }
      drainEpoch = now.ownershipEpoch;
    }

    if (d.awaitTargetRecord && !(await d.awaitTargetRecord(target, recordKey, drainEpoch))) {
      return { status: 409, body: { failedNeedsRetry: true, drain: { attempted: false }, error: 'That machine hasn\'t caught up with this conversation yet. It stays where it is; try again in a moment.' } };
    }

    let drain: AppDrainAnswer;
    try { drain = await d.sendDrain(currentOwner, recordKey, target, drainEpoch); }
    catch (err) { drain = { ok: false, reason: err instanceof Error ? err.message : String(err) }; } // @silent-fallback-ok — answered as a failed drain, in words, after asking the source
    const leg = { attempted: true, ok: drain.ok, status: drain.status, reason: drain.reason, claimLanded: drain.claimLanded };

    const completed = (drain.status === 'drained' || drain.status === 'drained-interrupted') && drain.claimLanded === true;
    if (!completed) {
      // The holder's copy lags: a slow runner may have outlived a timed-out route. Ask the source.
      let view: Awaited<ReturnType<AppMoveDeps['askOwner']>> = null;
      let asked = true;
      if (currentOwner === d.selfId) {
        const r = d.read(recordKey);
        view = r ? { owner: r.ownerMachineId, status: r.status, epoch: r.ownershipEpoch } : null;
      } else {
        try { view = await d.askOwner(currentOwner, recordKey); asked = view !== null; } catch { asked = false; } // @silent-fallback-ok — answered in words below
      }
      if (asked && view && view.owner === target && view.status === 'active') {
        return moved(d, input.conversationKey, recordKey, target, currentOwner, leg, drain);
      }
      // No answer from the runner, and the source still shows it moving: the runner can still land the claim.
      const unsettled = !asked || (drain.status === undefined && view?.status === 'transferring');
      if (unsettled) {
        return { status: 409, body: { failedNeedsRetry: true, stillMayComplete: true, drain: leg, error: 'The move may still complete; check in a moment.' } };
      }
      return { status: 409, body: { failedNeedsRetry: true, drain: leg, error: failureWords(drain) } };
    }
    return moved(d, input.conversationKey, recordKey, target, currentOwner, leg, drain);
  } finally {
    d.setMoveInFlight(recordKey, false);
  }
}

function moved(d: AppMoveDeps, conversationKey: string, recordKey: string, target: string, prevOwner: string, leg: Record<string, unknown>, drain: AppDrainAnswer): AppMoveAnswer {
  d.noteMoved(recordKey);
  try { d.afterMove(target, recordKey, prevOwner); } catch { /* @silent-fallback-ok — bounded retries live inside; the move itself is complete */ }
  const here = prevOwner === d.selfId ? d.leftBehindHere(conversationKey) : (drain.leftBehind ?? { files: 0, notes: 0 });
  const files = here.files ?? 0;
  const notes = here.notes ?? 0;
  const left: string[] = [];
  if (files > 0) left.push(`${files} file${files === 1 ? '' : 's'} still copying`);
  if (notes > 0) left.push(`${notes} late transcript${notes === 1 ? '' : 's'}`);
  return {
    status: 200,
    body: {
      ok: true, seatMoved: true, topicId: recordKey, targetMachine: target,
      targetNickname: d.capacity(target)?.nickname ?? null, action: 'transfer', pinned: false,
      autonomousRunSuspended: drain.runSuspended === true, drain: leg, memoryNote: MEMORY_STARTS_EMPTY,
      ...(left.length > 0 ? { leftBehind: { files, notes }, leftBehindWords: `${left.join(' and ')} stayed on the old machine.` } : {}),
    },
  };
}

function failureWords(drain: AppDrainAnswer): string {
  if (drain.status === 'aborted-emergency-stop') return 'The move stopped because of an emergency stop. The conversation stays where it is.';
  if (drain.status === 'refused-close-failed') return `The machine running this conversation could not close its session (${drain.reason ?? 'close refused'}). The conversation stays where it is.`;
  return 'The conversation stays where it is. Try the move again in a moment.';
}

export interface AppBringBackDeps {
  selfId: string;
  holdsLease(): boolean;
  read(recordKey: string): SessionOwnershipRecord | null;
  conversation(conversationKey: string): unknown | null;
  ownerOnline(machineId: string): boolean;
  cas(recordKey: string, action: OwnershipAction, why: 'failover'): { ok: boolean; record?: SessionOwnershipRecord };
  nicknameOf(machineId: string): string | null;
}

/**
 * Whether a moved conversation's machine is answering, for its placement and for Bring it back here.
 * Only fresh DIRECT contact counts, by the same 2-minute rule as pool readiness. Reading
 * `liveness.state` alone is not enough: a peer stays "live" until its last direct success is older
 * than the failover threshold (15 minutes by default), which kept Bring it back here hidden that
 * long after the machine stopped. Bringing back is still the operator's confirmed tap, and a
 * machine that returns is fenced by its lower epoch.
 */
export function ownerAnswering(cap: Pick<MachineCapacity, 'liveness'> | null | undefined): boolean {
  const l = cap?.liveness;
  return !!l && l.source === 'direct' && l.state === 'live'
    && typeof l.evidenceAgeMs === 'number' && l.evidenceAgeMs <= READINESS_CONTACT_MAX_AGE_MS;
}

export function bringBackWarning(machineName: string): string {
  return `If ${machineName} is actually still running this conversation, its session will be stopped as soon as it reconnects.`;
}

/**
 * "Bring it back here" (§2.2): the operator's explicit, confirmed decision on the lease holder, for a
 * moved conversation whose machine isn't answering. Never a liveness guess: only this call does it.
 */
export function runBringBack(d: AppBringBackDeps, input: { conversationKey: string; confirmed: boolean }): AppMoveAnswer {
  const recordKey = appRecordKey(input.conversationKey);
  if (!d.conversation(input.conversationKey)) return refused(404, 'unknown-conversation', 'This conversation isn\'t on this agent any more.');
  if (!d.holdsLease()) return refused(409, 'not-lease-holder', 'Only the machine that serves your app can bring a conversation back. Try again in a moment.');
  const rec = d.read(recordKey);
  if (!rec || rec.status === 'released' || rec.ownerMachineId === d.selfId) {
    return { status: 200, body: { ok: true, noop: true, message: 'This conversation is already on this machine.' } };
  }
  const name = d.nicknameOf(rec.ownerMachineId) ?? 'the other machine';
  if (d.ownerOnline(rec.ownerMachineId)) {
    return refused(409, 'owner-answering', `${name} is answering, so move this conversation instead of bringing it back.`);
  }
  if (!input.confirmed) return { status: 409, body: { needsConfirmation: true, prompt: bringBackWarning(name) } };
  const r = d.cas(recordKey, { type: 'force-claim', machineId: d.selfId, epochMargin: BRING_BACK_EPOCH_MARGIN, takeover: true }, 'failover');
  if (!r.ok) return refused(409, 'not-moved', 'It stayed where it is. Try again in a moment.');
  return { status: 200, body: { ok: true, broughtBack: true, topicId: recordKey, epoch: r.record?.ownershipEpoch ?? null, message: 'It\'s back on this machine. The conversation carries on with your next message.' } };
}

/** What the routes call on the lease holder. One per process, wired at boot (the shed planner's pattern). */
export interface AppPoolMoves {
  active(): boolean;
  move(input: { conversationKey: string; to: string; confirm: boolean; confirmationChallenge?: string }): Promise<AppMoveAnswer>;
  bringBack(input: { conversationKey: string; confirmed: boolean }): AppMoveAnswer;
  /** Where it runs, and whether "Bring it back here" is on offer. */
  placement(conversationKey: string): Record<string, unknown>;
}
let appPoolMoves: AppPoolMoves | null = null;
export function setAppPoolMoves(m: AppPoolMoves | null): void { appPoolMoves = m; }
export function getAppPoolMoves(): AppPoolMoves | null { return appPoolMoves; }

/** The remote half of the autonomous-run consent check: asks the owner, wired where the transfer route gets it. */
type AutonomousProbe = (machineId: string, topic: string) => Promise<{ goal: string | null; remainingMinutes: number | null; runKey?: string | null } | null>;
let autonomousRunProbe: AutonomousProbe | null = null;
export function setAutonomousRunProbe(p: AutonomousProbe | null): void { autonomousRunProbe = p; }
export function getAutonomousRunProbe(): AutonomousProbe | null { return autonomousRunProbe; }

/** The phone's read of a conversation's placement: "Bring it back here" is offered only when it would be taken. */
export function appPlacement(d: Pick<AppBringBackDeps, 'selfId' | 'holdsLease' | 'read' | 'ownerOnline' | 'nicknameOf'>, conversationKey: string): Record<string, unknown> {
  const rec = d.read(appRecordKey(conversationKey));
  const conversationRef = appRecordKey(conversationKey);
  if (!rec || rec.status === 'released') return { conversationRef, moved: false, bringBack: { can: false } };
  const answering = rec.ownerMachineId === d.selfId || d.ownerOnline(rec.ownerMachineId);
  const name = d.nicknameOf(rec.ownerMachineId);
  const can = !answering && d.holdsLease();
  return { conversationRef, moved: true, machineId: rec.ownerMachineId, machine: name, answering, bringBack: can ? { can: true, confirm: bringBackWarning(name ?? 'the other machine') } : { can: false } };
}
