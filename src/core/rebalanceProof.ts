/**
 * RebalanceProofRunner — the repeatable proof a machine runs to earn pool stage
 * `rebalance` (docs/specs/session-pool-rebalancing-finish.md, change 7).
 *
 * The move itself is the production path (OverloadShedPlanner.proofMove → reconciler →
 * drain). This module only sets the run up and judges it from OUTSIDE the drain:
 *
 *   1. The record reads active, owned by the target, at a higher epoch. `ownerOf` alone
 *      reports `transferTo` mid-transfer, so the record's status is what counts.
 *   2. No session for the topic is left here: the defect this feature exists to close.
 *   3. A probe sent through routing is answered exactly once, by the target machine.
 *
 * Honesty contract: refused before anything moved ⇒ no row. Started ⇒ always a row, red
 * unless all three hold, so old authorization never outlives a run that could not
 * establish what happened. A red is cheap: this machine steps down until a rerun passes.
 *
 * This is the repeatable gate, not the user-channel proof: the probe skips Telegram's own
 * ingress. It is fixed, server-authored text with no caller input, labelled automated, so
 * a session never takes it for the operator's words. All I/O is injected.
 */

import type { MoveOutcome } from './OverloadShedPlanner.js';
import type { SessionPoolE2EResultStore, StageE2EOutcome } from './SessionPoolE2EResultStore.js';

export const PROOF_REPLY_TIMEOUT_MS = 180_000;
export const PROOF_OWNERSHIP_TIMEOUT_MS = 60_000;
export const PROOF_SPAWN_TIMEOUT_MS = 120_000;
export const PROOF_DUPLICATE_SETTLE_MS = 30_000;
/** Longest wait on any one step that could otherwise never settle. */
export const PROOF_MOVE_TIMEOUT_MS = 120_000;
export const PROOF_IO_TIMEOUT_MS = 30_000;
/** A session is settled after this many idle reads in a row, this far apart. */
export const PROOF_SETTLED_READS = 6;
export const PROOF_SETTLED_INTERVAL_MS = 5_000;

/**
 * A session still starting reads as idle: no working footer, no child process, and its
 * opening brief not yet delivered. One idle read then lets the move start on a session
 * about to go active, and the drain aborts it. Found live on 2026-11-04, Mama PC. So idle
 * has to hold across several reads; any other read starts the count again.
 */
export async function waitForSettledIdle(
  /** The idle session's identity, or null when it is not idle. A replacement starts the count again. */
  idleSession: () => Promise<string | null>,
  timeoutMs: number,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<boolean> {
  const deadline = clock.now() + timeoutMs;
  let inARow = 0;
  let counted: string | null = null;
  while (clock.now() < deadline) {
    const session = await idleSession();
    if (clock.now() >= deadline) return false;
    inARow = session === null ? 0 : session === counted ? inARow + 1 : 1;
    counted = session;
    if (inARow >= PROOF_SETTLED_READS) return true;
    await clock.sleep(PROOF_SETTLED_INTERVAL_MS);
  }
  return false;
}
const POLL_MS = 3_000;
const MAX_KEPT_RUNS = 20;

export interface ProofRecord {
  ownerMachineId?: string;
  status?: string;
  ownershipEpoch: number;
}

export interface ProofHistoryRow {
  text?: string;
  fromUser?: boolean;
  machine?: string;
}

export type ProofRefusal = 'not-a-proof-topic' | 'not-owner' | 'stage-too-low' | 'proof-running' | 'no-session' | string;

export interface RebalanceProofDeps {
  selfMachineId: () => string | null | undefined;
  isProofTopic: (topic: number) => boolean;
  /** True at `live-transfer` or above. */
  stageAllowsProof: () => boolean;
  stage: () => string;
  readRecord: (topic: number) => ProofRecord | null;
  hasLocalSession: (topic: number) => boolean;
  /** Start a session for the topic if none runs, and resolve once it is idle. False ⇒ it never got there. */
  ensureIdleSession: (topic: number, timeoutMs: number) => Promise<boolean>;
  move: (topic: number, to: string) => { refused: string } | { outcome: Promise<{ moved: boolean; outcome: MoveOutcome }> };
  /**
   * Hand the probe to the lease holder, the only machine that can forward: real inbound
   * enters there, and a peer's forward is refused as not-router. Null means this machine
   * is the holder, so `sendProbe` applies. `holder` lets a target that IS the holder count.
   */
  probeViaHolder?: (topic: number, nonce: string) => Promise<{ action: string; holder: string | null } | null>;
  /** Send the probe through routing. Resolves with the route's action. */
  sendProbe: (topic: number, text: string, messageId: string) => Promise<string>;
  /** Pool-wide topic history; `failed` lists machines that could not be read. */
  readHistory: (topic: number) => Promise<{ rows: ProofHistoryRow[]; failed: string[] }>;
  record: (result: StageE2EOutcome, evidenceRef: string) => void;
  writeEvidence: (evidence: Record<string, unknown>) => string;
  newNonce: () => string;
  /** A durable note that a move has started, read back at boot. */
  markInFlight?: (runId: string) => void;
  readInFlight?: () => string | null;
  clearInFlight?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface ProofRun {
  runId: string;
  topic: number;
  to: string;
  state: 'running' | 'green' | 'red' | 'not-recorded';
  reason?: string;
  startedAt: string;
  finishedAt?: string;
  evidenceRef?: string;
}

/**
 * Stop waiting, without stopping the work. A move that never settles keeps its planner slot
 * by design, which is the safe direction; this only lets the run record what it knows.
 */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    timer.unref?.();
  });
  return Promise.race([work, expired]).finally(() => { if (timer) clearTimeout(timer); });
}

export function proofProbeText(nonce: string): string {
  return `Automated machine-move check from the agent, not a message from the user. Nothing here to remember or act on. Reply with only this code: ${nonce}`;
}

/** The brief for a session started only so the proof has something to move. */
export function proofSpawnBrief(): string {
  return 'This topic is an automated machine-move check, not a conversation with the user. Do nothing and wait.';
}

export class RebalanceProofRunner {
  private running = false;
  private readonly runs = new Map<string, ProofRun>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: RebalanceProofDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** At boot, once the store is ready: a run that never finished is a run that failed. */
  recoverInterrupted(): void {
    const runId = this.d.readInFlight?.() ?? null;
    if (!runId) return;
    const evidenceRef = this.d.writeEvidence({ runId, result: 'red', reason: 'restarted-during-run' });
    this.d.record('red', evidenceRef);
    this.d.clearInFlight?.();
    this.d.log?.(`rebalance-proof: ${runId} red (restarted-during-run)`);
  }

  get(runId: string): ProofRun | null {
    return this.runs.get(runId) ?? null;
  }

  /**
   * The holder's half of a peer's proof. Fixed text built here from a nonce only, so no caller
   * words reach a session, and only for a listed proof topic. Records nothing: the run does.
   */
  async routeProbe(topic: number, nonce: string): Promise<{ action: string; holder: string | null } | { refused: string }> {
    if (!this.d.isProofTopic(topic)) return { refused: 'not-a-proof-topic' };
    if (!/^[a-f0-9]{8,64}$/.test(nonce)) return { refused: 'bad-nonce' };
    const action = await this.d.sendProbe(topic, proofProbeText(nonce), `proof-probe-${nonce}`);
    return { action, holder: this.d.selfMachineId() ?? null };
  }

  /** Check the preconditions and start. A refusal records nothing. */
  start(topic: number, to: string): { refused: ProofRefusal } | { run: ProofRun; finished: Promise<ProofRun> } {
    const self = this.d.selfMachineId();
    if (!self) return { refused: 'no-machine-identity' };
    if (this.running) return { refused: 'proof-running' };
    if (!this.d.isProofTopic(topic)) return { refused: 'not-a-proof-topic' };
    if (!this.d.stageAllowsProof()) return { refused: 'stage-too-low' };
    const rec = this.d.readRecord(topic);
    if (!rec || rec.status !== 'active' || rec.ownerMachineId !== self) return { refused: 'not-owner' };

    const run: ProofRun = { runId: `proof-${this.now()}-${topic}`, topic, to, state: 'running', startedAt: new Date(this.now()).toISOString() };
    this.runs.set(run.runId, run);
    if (this.runs.size > MAX_KEPT_RUNS) this.runs.delete(this.runs.keys().next().value as string);
    this.running = true;
    const finished = this.execute(run, self, rec.ownershipEpoch).finally(() => { this.running = false; });
    return { run, finished };
  }

  private async execute(run: ProofRun, self: string, startEpoch: number): Promise<ProofRun> {
    const steps: Record<string, unknown> = {};
    const stageAtStart = this.d.stage();
    const t0 = this.now();
    let reason: string | null = null;
    let moveStarted = false;

    try {
      steps.sessionReady = await within(this.d.ensureIdleSession(run.topic, PROOF_SPAWN_TIMEOUT_MS), PROOF_SPAWN_TIMEOUT_MS + PROOF_IO_TIMEOUT_MS, 'idle wait');
      if (steps.sessionReady !== true) return this.finish(run, null, 'no-idle-session', steps, self);

      const started = this.d.move(run.topic, run.to);
      if ('refused' in started) return this.finish(run, null, started.refused, steps, self);

      // From here a real move has been asked for, so the run always leaves a row, even if
      // this process dies: the marker makes the next boot record the run as red.
      moveStarted = true;
      this.d.markInFlight?.(run.runId);
      const { moved, outcome } = await within(started.outcome, PROOF_MOVE_TIMEOUT_MS, 'move');
      steps.move = { moved, ...outcome, atMs: this.now() - t0 };
      if (!moved) reason = `move-${outcome.status}`;

      if (!reason && !(await this.ownershipLanded(run, startEpoch))) reason = 'ownership-not-landed';
      // Always a real read: a move that failed leaves the session running, and the evidence says so.
      let sessionLeft: boolean | null = null;
      try { sessionLeft = this.d.hasLocalSession(run.topic); } catch (err) { if (!reason) throw err; /* @silent-fallback-ok: not silent. The evidence says unknown and the move's failure stays the reason. */ }
      if (!reason && sessionLeft) reason = 'source-session-left-running';
      steps.sourceSessionGone = sessionLeft === null ? 'unknown' : !sessionLeft;

      if (!reason) {
        const nonce = this.d.newNonce();
        const viaHolder = this.d.probeViaHolder
          ? await within(this.d.probeViaHolder(run.topic, nonce), PROOF_IO_TIMEOUT_MS, 'probe')
          : null;
        const action = viaHolder ? viaHolder.action : await within(this.d.sendProbe(run.topic, proofProbeText(nonce), run.runId), PROOF_IO_TIMEOUT_MS, 'probe');
        steps.probeAction = action;
        if (viaHolder) steps.probeVia = viaHolder.holder ?? 'holder';
        // The move's target can be the holder itself, which handles the probe rather than forwarding.
        const reached = action === 'forwarded' || (action === 'handled-locally' && viaHolder?.holder === run.to);
        if (!reached) reason = `probe-${action}`;
        else {
          const reply = await this.awaitReply(run, nonce);
          steps.reply = { ...reply, atMs: this.now() - t0 };
          if (reply.targetUnreadable) reason = 'target-history-unreadable';
          else if (reply.fromTarget !== 1 || reply.total !== 1) {
            reason = reply.total === 0 ? 'no-reply' : reply.total > 1 ? 'duplicate-reply' : 'reply-from-wrong-machine';
          }
        }
      }
      if (!reason && this.d.stage() !== stageAtStart) reason = 'stage-changed-during-run';
    } catch (err) {
      // @silent-fallback-ok: not silent. The error becomes this run's recorded reason and evidence.
      reason = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      // Keyed on the move having started, not on evidence of its result: a started run that
      // ended in an error must leave a row, or an older green would stay in force.
      if (!moveStarted) return this.finish(run, null, reason, steps, self);
    }
    return this.finish(run, reason === null ? 'green' : 'red', reason, steps, self);
  }

  private async ownershipLanded(run: ProofRun, startEpoch: number): Promise<boolean> {
    const deadline = this.now() + PROOF_OWNERSHIP_TIMEOUT_MS;
    for (;;) {
      const r = this.d.readRecord(run.topic);
      if (r?.status === 'active' && r.ownerMachineId === run.to && r.ownershipEpoch > startEpoch) return true;
      if (this.now() >= deadline) return false;
      await this.sleep(POLL_MS);
    }
  }

  /** Wait the full settle window once a reply shows, so a duplicate has time to appear. */
  private async awaitReply(run: ProofRun, nonce: string): Promise<{ total: number; fromTarget: number; targetUnreadable: boolean }> {
    const deadline = this.now() + PROOF_REPLY_TIMEOUT_MS;
    let settleUntil: number | null = null;
    let last = { total: 0, fromTarget: 0, targetUnreadable: false };
    for (;;) {
      try {
        const h = await within(this.d.readHistory(run.topic), PROOF_IO_TIMEOUT_MS, 'history read');
        const agentRows = h.rows.filter((m) => m.fromUser !== true && (m.text ?? '').includes(nonce) && !(m.text ?? '').includes('Automated machine-move check'));
        // A read that could not reach the target says nothing about its reply, so it never
        // replaces what an earlier read saw.
        if (h.failed.includes(run.to)) last = { ...last, targetUnreadable: true };
        else last = { total: agentRows.length, fromTarget: agentRows.filter((m) => m.machine === run.to).length, targetUnreadable: false };
      } catch (err) {
        this.d.log?.(`rebalance-proof: history read failed: ${err instanceof Error ? err.message : String(err)}`);
        last = { ...last, targetUnreadable: true };
      }
      const now = this.now();
      if (last.total > 0 && settleUntil === null) settleUntil = now + PROOF_DUPLICATE_SETTLE_MS;
      // A settle window the target could not be read through has not ruled out a duplicate.
      if (settleUntil !== null && now >= settleUntil && !last.targetUnreadable) return last;
      if (now >= deadline) return last;
      await this.sleep(POLL_MS);
    }
  }

  private finish(run: ProofRun, result: StageE2EOutcome | null, reason: string | null, steps: Record<string, unknown>, self: string): ProofRun {
    const evidenceRef = this.d.writeEvidence({ runId: run.runId, source: self, target: run.to, topic: run.topic, result: result ?? 'not-recorded', reason, steps, startedAt: run.startedAt });
    if (result) this.d.record(result, evidenceRef);
    this.d.clearInFlight?.();
    run.state = result ?? 'not-recorded';
    run.reason = reason ?? undefined;
    run.evidenceRef = evidenceRef;
    run.finishedAt = new Date(this.now()).toISOString();
    this.d.log?.(`rebalance-proof: ${run.runId} ${result ?? 'nothing recorded'}${reason ? ` (${reason})` : ''}`);
    return run;
  }
}

let active: RebalanceProofRunner | null = null;
export function setActiveRebalanceProof(r: RebalanceProofRunner | null): void { active = r; }
export function getActiveRebalanceProof(): RebalanceProofRunner | null { return active; }

let activeStore: SessionPoolE2EResultStore | null = null;
export function setActiveRebalanceProofStore(s: SessionPoolE2EResultStore | null): void { activeStore = s; }
export function getActiveRebalanceProofStore(): SessionPoolE2EResultStore | null { return activeStore; }
