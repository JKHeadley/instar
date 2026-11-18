/**
 * CheckInReminderReconciler — the stateful half of the dated-commitment
 * check-in reminder (ACT-724; docs/specs/dated-commitment-reminder.md).
 *
 * One recurring pass scans the commitment store for open commitments whose
 * `checkInAt` has arrived and posts exactly one reminder each.
 *
 * WHY A SCAN AND NOT A JOB PER COMMITMENT (spec §2.1). The action's sketch said
 * "materialize one one-shot scheduler entry per dated commitment". Taken
 * literally that reproduces two of the three defects it lists: a per-commitment
 * entry needs a job file plus a manifest entry (defect (b), the two-file dance)
 * and retiring it after delivery means editing or deleting that file (defect
 * (c)). A scan has neither: coverage is a property of the scan, so there is no
 * registration step that can be skipped or race, and teardown is just the
 * commitment reaching a terminal status.
 *
 * The decision itself is pure and lives in checkInReminderCore.ts.
 */
import {
  selectDueCommitments,
  buildCheckInReminderText,
  buildPromisedUpdateOverdueText,
  CHECK_IN_MAX_ATTEMPTS,
  type NotDueReason,
} from './checkInReminderCore.js';
import type { Commitment, CommitmentTracker } from './CommitmentTracker.js';
import { isQuietReceipt } from '../messaging/NotificationSelectivityGate.js';
import { isPromisedUpdateCommitment } from './PromisedUpdateCapture.js';
import { PromiseKeepingPass, emptyPromiseKeepingReport, type PromiseKeepingReport, type PromiseKeepingDeps } from './promiseKeepingPass.js';
import { preDeadlineCheck, overdueStep, buildPromiseBootstrap, buildLastResortText, promiseWorkMaxLive } from './promiseKeepingCore.js';

/** The send identity: per check-in row, or per late group (docs/specs/overdue-promise-follow-through.md §3.2). */
export type CheckInSendIdentity =
  | { commitmentId: string; checkInAt: string }
  | { kind: 'late'; topicId: number; rows: Array<{ origin: string | null; id: string; time: string }> };

export interface CheckInReminderDeps {
  tracker: Pick<CommitmentTracker, 'getAll' | 'mutate'>;
  /**
   * DETERMINISTIC delivery — deliberately not the LLM tone-gated path.
   *
   * A reminder must not be capable of being held by a gate that fails closed:
   * an undelivered reminder is the entire defect this feature exists to fix.
   * The text is a fixed template carrying no agent prose, so there is nothing
   * for a tone gate to judge — the safety the gate provides is not being
   * bypassed, it is not applicable.
   */
  send: (topicId: number, text: string, identity: CheckInSendIdentity) => Promise<unknown>;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * After a PROMISED-UPDATE reminder is delivered and stamped, hand the promise
   * back to the topic's session so the update actually gets written
   * (docs/specs/promised-update-capture.md). Absent → the reminder says only
   * that the update is late, never that a pickup is happening.
   */
  resumePromisedUpdate?: (commitment: Commitment) => void | Promise<void>;
  /**
   * Promise keeping (docs/specs/promise-keeping-before-the-deadline.md §3.1):
   * hand the work to the topic's session — notify a running one, or launch a
   * start (never awaited by the pass). Absent → nothing can be picked up, and
   * a missed time reaches the last resort after its deadline.
   */
  pickUp?: PromiseKeepingDeps['pickUp'];
  /** Reconcile a timed-out attempt against the session registry (exited sessions included). */
  findAttemptSession?: PromiseKeepingDeps['findAttemptSession'];
  /** Working promise-work sessions on this machine (for the live limit). */
  workingPromiseSessions?: () => number;
  /** sessions.maxSessions on this machine. */
  maxSessions?: number;
  /** §3.7 no-time lane: a session is live in this conversation. */
  hasLiveSession?: PromiseKeepingDeps['hasLiveSession'];
  /** §3.6 release step: promise-work sessions on this machine, and the guarded release. */
  listPromiseWorkSessions?: PromiseKeepingDeps['listPromiseWorkSessions'];
  releaseIfAllowed?: PromiseKeepingDeps['releaseIfAllowed'];
  /** Resolve a reschedule intent left open (crash residue, §3.4). */
  resolveRescheduleIntent?: PromiseKeepingDeps['resolveRescheduleIntent'];
  /**
   * This machine's late-notice epoch (first live pass). `read` returns null
   * before the first live pass; `writeOnce` persists it. Absent → the late
   * batch does not run (it cannot bound its backlog without an epoch).
   */
  lateEpoch?: { read: () => number | null; writeOnce: (ms: number) => number };
  /** IANA zone for the times in late text; absent → machine zone. */
  timeZone?: string | null;
}

export interface CheckInReminderConfig {
  enabled: boolean;
  /** When true, decide and log but send nothing and stamp nothing. */
  dryRun: boolean;
  /** Hard ceiling on reminders per pass — a bounded blast radius. */
  maxPerPass?: number;
  /** This machine's id; see DuePredicateInput.selfMachineId. */
  selfMachineId?: string | null;
  /** Late notice: conversations per pass / per rolling hour (agent-wide), and the per-topic cooldown. */
  maxLateTopicsPerPass?: number;
  maxLateTopicsPerHour?: number;
  lateTopicCooldownMs?: number;
}

export interface CheckInReminderPassReport {
  ran: boolean;
  dryRun: boolean;
  scanned: number;
  due: number;
  sent: number;
  failed: number;
  wouldSend: number;
  capped: number;
  /** Ids in this pass's batch (ids only — the soak ledger reads them). */
  dueIds: string[];
  /** Retries exhausted this pass — genuinely undelivered reminders. */
  gaveUp: number;
  skippedByReason: Partial<Record<NotDueReason, number>>;
  errors: Array<{ id: string; error: string }>;
  /** Late notices (docs/specs/overdue-promise-follow-through.md). */
  late: LatePassReport;
}

export interface LatePassReport {
  ran: boolean;
  /** Dry-run: promises a live pass would act on (check, pickup or last resort). */
  wouldAct: number;
  dueIds: string[];
  /** The live pass (docs/specs/promise-keeping-before-the-deadline.md). */
  keeping: PromiseKeepingReport;
}

function emptyLateReport(): LatePassReport {
  return { ran: false, wouldAct: 0, dueIds: [], keeping: emptyPromiseKeepingReport() };
}

const DEFAULT_MAX_PER_PASS = 25;

function emptyReport(over: Partial<CheckInReminderPassReport> = {}): CheckInReminderPassReport {
  return {
    ran: false,
    dryRun: false,
    scanned: 0,
    due: 0,
    sent: 0,
    failed: 0,
    wouldSend: 0,
    capped: 0,
    dueIds: [],
    gaveUp: 0,
    skippedByReason: {},
    errors: [],
    late: emptyLateReport(),
    ...over,
  };
}

export class CheckInReminderReconciler {
  constructor(
    private readonly deps: CheckInReminderDeps,
    private readonly config: CheckInReminderConfig,
  ) {}

  /**
   * One pass. Idempotent by construction: the CAS stamp means a pass that
   * crashes midway, or two passes racing, cannot double-send.
   */
  async runPass(): Promise<CheckInReminderPassReport> {
    if (!this.config.enabled) return emptyReport({ dryRun: this.config.dryRun });

    const now = (this.deps.now ?? Date.now)();
    const all = this.deps.tracker.getAll();
    const { due, skipped } = selectDueCommitments(
      all as Array<Commitment & { id: string }>,
      now,
      this.config.selfMachineId,
    );

    const skippedByReason: Partial<Record<NotDueReason, number>> = {};
    for (const s of skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;

    const cap = this.config.maxPerPass ?? DEFAULT_MAX_PER_PASS;
    const batch = due.slice(0, cap);
    const capped = Math.max(0, due.length - batch.length);
    if (capped > 0) {
      // Never silent: a bounded pass that dropped work says so, and the
      // remainder is picked up next pass (the stamp makes that safe).
      this.log(`[check-in-reminder] capped at ${cap}; ${capped} due commitment(s) deferred to the next pass`);
    }

    const report = emptyReport({
      ran: true,
      dryRun: this.config.dryRun,
      scanned: all.length,
      due: due.length,
      capped,
      dueIds: batch.map((c) => c.id),
      skippedByReason,
    });

    for (const commitment of batch) {
      if (this.config.dryRun) {
        report.wouldSend++;
        this.log(`[check-in-reminder] would remind ${commitment.id} in topic ${commitment.topicId}`);
        continue;
      }
      const ok = await this.remindOne(commitment, now, report);
      if (ok) report.sent++;
    }

    try {
      await this.runLatePass(now, report);
    } catch (err) {
      // The late batch must never take the check-in batch down with it.
      report.errors.push({ id: 'late-pass', error: String(err) });
    }

    return report;
  }

  // ── Promise keeping (docs/specs/promise-keeping-before-the-deadline.md) ──

  private async runLatePass(now: number, report: CheckInReminderPassReport): Promise<void> {
    const late = report.late;
    const epochStore = this.deps.lateEpoch;
    if (!epochStore) return;
    let epochMs = epochStore.read();
    if (epochMs === null) {
      // The epoch marks the first LIVE pass; a dry-run pass never sets it.
      if (this.config.dryRun) epochMs = now;
      else epochMs = epochStore.writeOnce(now);
    }
    late.ran = true;
    if (this.config.dryRun) {
      // Decide and log only: no notice, start, stamp or send.
      const self = this.config.selfMachineId;
      for (const c of this.deps.tracker.getAll() as Commitment[]) {
        const chk = preDeadlineCheck(c, now, self);
        const step = chk.due ? null : overdueStep({ c, nowMs: now, selfMachineId: self, epochMs, movedSincePickup: false });
        if (chk.due || (step && step.act !== 'none')) {
          late.wouldAct++;
          late.dueIds.push(c.id);
        }
      }
      if (late.wouldAct > 0) this.log(`[promise-keeping] dry-run: would act on ${late.wouldAct} promise(s)`);
      return;
    }
    const pass = new PromiseKeepingPass(
      {
        tracker: this.deps.tracker,
        ...(this.deps.pickUp ? { pickUp: this.deps.pickUp } : {}),
        ...(this.deps.findAttemptSession ? { findAttemptSession: this.deps.findAttemptSession } : {}),
        ...(this.deps.workingPromiseSessions ? { workingPromiseSessions: this.deps.workingPromiseSessions } : {}),
        ...(this.deps.maxSessions !== undefined ? { maxSessions: this.deps.maxSessions } : {}),
        ...(this.deps.resolveRescheduleIntent ? { resolveRescheduleIntent: this.deps.resolveRescheduleIntent } : {}),
        ...(this.deps.hasLiveSession ? { hasLiveSession: this.deps.hasLiveSession } : {}),
        ...(this.deps.listPromiseWorkSessions ? { listPromiseWorkSessions: this.deps.listPromiseWorkSessions } : {}),
        ...(this.deps.releaseIfAllowed ? { releaseIfAllowed: this.deps.releaseIfAllowed } : {}),
        sendLastResort: (topicId, text, identity) => this.sendDelivered(topicId, text, identity),
        timeZone: this.deps.timeZone,
        log: (l) => this.log(l),
      },
      {
        selfMachineId: this.config.selfMachineId,
        epochMs,
        ...(this.config.maxLateTopicsPerPass !== undefined ? { maxLateTopicsPerPass: this.config.maxLateTopicsPerPass } : {}),
        ...(this.config.maxLateTopicsPerHour !== undefined ? { maxLateTopicsPerHour: this.config.maxLateTopicsPerHour } : {}),
        ...(this.config.lateTopicCooldownMs !== undefined ? { lateTopicCooldownMs: this.config.lateTopicCooldownMs } : {}),
      },
    );
    await pass.run(now, late.keeping);
  }

  /**
   * Send, and fail when the message was held instead of delivered. A held send
   * (the notification policy filed it in the Notifications feed) resolves
   * normally with a quiet receipt; counting that as sent would stamp
   * "the user has been told" on a message the user never got (CMT-1951,
   * 2026-11-18). Throwing routes it through the same retry / give-up path as a
   * transport failure.
   */
  private async sendDelivered(topicId: number, text: string, identity: CheckInSendIdentity): Promise<void> {
    const receipt = await this.deps.send(topicId, text, identity);
    if (isQuietReceipt(receipt)) throw new Error(`held-not-delivered: the notification policy recorded it quietly (${receipt.quietId})`);
  }

  /**
   * SEND FIRST, then stamp — and the reverse is a trap worth naming.
   *
   * The earlier draft stamped before sending, reasoning that a duplicate cannot
   * be recalled while a miss is recoverable. That reasoning was wrong in a
   * specific and familiar way: it made ZERO deliveries a *designed* outcome. A
   * failed send left the commitment marked `checkInReminderSentAt` — a field
   * asserting a delivery that never happened — and permanently ineligible. The
   * feature whose purpose is that promises are not silently dropped would have
   * silently dropped them. (External review, 2026-07-25.)
   *
   * Sending first restores at-least-once. The duplicate it risks — a crash
   * between send and stamp — is absorbed by the relay's existing content dedup
   * (identical text to the same topic inside its window), so the platform
   * already solves the problem the wrong ordering was invented to solve.
   *
   * Attempts are counted and bounded: a transient failure gets another pass, a
   * permanently broken transport is given up on LOUDLY via
   * `checkInReminderFailedAt` rather than retried forever.
   */
  private async remindOne(
    commitment: Commitment,
    now: number,
    report: CheckInReminderPassReport,
  ): Promise<boolean> {
    const topicId = commitment.topicId;
    if (typeof topicId !== 'number') return false; // excluded by the predicate; belt-and-braces

    const promisedUpdate = isPromisedUpdateCommitment(commitment);

    // promise-keeping §3.8: a promised update is work for a session first. The
    // person gets a line only when no session could take it after the attempts.
    if (promisedUpdate && this.deps.pickUp) {
      const attempts = (commitment.checkInReminderAttempts ?? 0) + 1;
      try {
        await this.deps.tracker.mutate(commitment.id, (c) => ({ ...c, checkInReminderAttempts: (c.checkInReminderAttempts ?? 0) + 1 }));
      } catch (err) {
        report.errors.push({ id: commitment.id, error: String(err) });
        return false;
      }
      const attemptId = `pu-${now.toString(36)}-${commitment.id}`;
      let outcome: Awaited<ReturnType<NonNullable<CheckInReminderDeps['pickUp']>>>;
      try {
        outcome = await this.deps.pickUp({
          topicId,
          bootstrap: buildPromiseBootstrap({
            stage: 'overdue',
            rows: [{ id: commitment.id, origin: commitment.originMachineId ?? null, time: commitment.checkInAt ?? null, noTime: !commitment.checkInAt, agentResponse: commitment.agentResponse }],
            timeZone: this.deps.timeZone,
          }).replace('stage overdue]', 'stage promised-update]') + '\nThis was a promised UPDATE: send the person the update now (what is done, where it stands, what is next), then deliver the record.',
          attemptId,
          triggeredBy: `promise-work:${commitment.id}:${attemptId}`,
          // Same start limits as the promise-keeping pass: a third of maxSessions working.
          mayStart: (this.deps.workingPromiseSessions?.() ?? 0) < promiseWorkMaxLive(this.deps.maxSessions ?? 10),
          onSettled: () => { /* a launched start is confirmed on the next pass, when its session is live and notified */ },
        });
      } catch (err) {
        outcome = { kind: 'failed', error: String(err) };
      }
      if (outcome.kind === 'pending' && attempts < 3) {
        // A start was launched: not handled yet. The next pass finds the session live and
        // notifies it (then stamps), or counts another attempt toward the last resort.
        return false;
      }
      if (outcome.kind === 'notified' || outcome.kind === 'started') {
        await this.deps.tracker.mutate(commitment.id, (c) => ({ ...c, checkInReminderSentAt: new Date(now).toISOString(), pickedUpAt: new Date(now).toISOString() })).catch((err) => {
          report.errors.push({ id: commitment.id, error: `picked-up-but-unstamped: ${err}` });
        });
        return true;
      }
      if (attempts < 3) return false; // retried next pass; nothing to the person yet
      // Third attempt and still nothing took it (held, failed, or a start that never came up): last resort.
      const variant = outcome.kind === 'pending' ? 'could-not-restart' : outcome.kind === 'held'
        ? (outcome.reason === 'capacity' ? 'busy' : outcome.reason === 'not-holder' ? 'not-here' : 'queued')
        : 'could-not-restart';
      const lastResort = buildLastResortText([{ time: commitment.checkInAt ?? '', noTime: !commitment.checkInAt, agentResponse: commitment.agentResponse, userRequest: commitment.userRequest, variant }], this.deps.timeZone);
      try {
        await this.sendDelivered(topicId, lastResort, { commitmentId: commitment.id, checkInAt: commitment.checkInAt! });
      } catch (err) {
        report.failed++;
        report.errors.push({ id: commitment.id, error: String(err) });
        if (attempts >= CHECK_IN_MAX_ATTEMPTS) {
          await this.deps.tracker.mutate(commitment.id, (c) => ({ ...c, checkInReminderFailedAt: new Date(now).toISOString() })).catch(() => { /* @silent-fallback-ok — in the pass report */ });
          report.gaveUp++;
        }
        return false;
      }
      await this.deps.tracker.mutate(commitment.id, (c) => ({ ...c, checkInReminderSentAt: new Date(now).toISOString() })).catch((err) => {
        report.errors.push({ id: commitment.id, error: `sent-but-unstamped: ${err}` });
      });
      return true;
    }

    const text = promisedUpdate
      ? buildPromisedUpdateOverdueText({
        userRequest: commitment.userRequest ?? '',
        agentResponse: commitment.agentResponse ?? '',
        resuming: !!this.deps.resumePromisedUpdate,
      })
      : buildCheckInReminderText({
        userRequest: commitment.userRequest ?? '',
        checkInAt: commitment.checkInAt ?? '',
      });

    // Count the attempt BEFORE trying. If the process dies mid-send, the
    // attempt is still on record, so a crash-loop cannot buy infinite retries.
    try {
      await this.deps.tracker.mutate(commitment.id, (c) => ({
        ...c,
        checkInReminderAttempts: (c.checkInReminderAttempts ?? 0) + 1,
      }));
    } catch (err) {
      report.errors.push({ id: commitment.id, error: String(err) });
      return false;
    }

    try {
      await this.sendDelivered(topicId, text, { commitmentId: commitment.id, checkInAt: commitment.checkInAt! });
    } catch (err) {
      report.failed++;
      report.errors.push({ id: commitment.id, error: String(err) });
      const attempts = (commitment.checkInReminderAttempts ?? 0) + 1;
      if (attempts >= CHECK_IN_MAX_ATTEMPTS) {
        // Give up loudly — record the undelivered fact rather than a "sent".
        try {
          await this.deps.tracker.mutate(commitment.id, (c) => ({
            ...c,
            checkInReminderFailedAt: new Date(now).toISOString(),
          }));
        } catch {
          // @silent-fallback-ok — the failure is already in the pass report;
          // failing to annotate must not strand the remaining due commitments.
        }
        this.log(
          `[check-in-reminder] GIVING UP on ${commitment.id} after ${attempts} attempts — reminder UNDELIVERED`,
        );
        report.gaveUp++;
      }
      return false;
    }

    // Delivered. Only now does the stamp go on, so it never lies.
    try {
      await this.deps.tracker.mutate(commitment.id, (c) => ({
        ...c,
        checkInReminderSentAt: new Date(now).toISOString(),
      }));
    } catch (err) {
      // The user HAS the reminder; only the bookkeeping failed. Report it, and
      // let the next pass re-send — the relay's content dedup absorbs that.
      // The handoff waits for that pass too: it runs only after a stamp, so a
      // re-send can never hand the same promise to the session twice.
      report.errors.push({ id: commitment.id, error: `sent-but-unstamped: ${err}` });
      return true;
    }
    if (promisedUpdate && this.deps.resumePromisedUpdate) {
      try {
        await this.deps.resumePromisedUpdate(commitment);
      } catch (err) {
        // The user already has the honest line; a failed handoff is logged and
        // reported, never retried as a second reminder.
        report.errors.push({ id: commitment.id, error: `resume-handoff-failed: ${err}` });
        this.log(`[check-in-reminder] could not hand ${commitment.id} back to topic ${topicId}: ${err}`);
      }
    }
    return true;
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }
}
