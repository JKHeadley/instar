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
  CHECK_IN_MAX_ATTEMPTS,
  type NotDueReason,
} from './checkInReminderCore.js';
import type { Commitment, CommitmentTracker } from './CommitmentTracker.js';

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
  send: (topicId: number, text: string) => Promise<unknown>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface CheckInReminderConfig {
  enabled: boolean;
  /** When true, decide and log but send nothing and stamp nothing. */
  dryRun: boolean;
  /** Hard ceiling on reminders per pass — a bounded blast radius. */
  maxPerPass?: number;
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
  /** Retries exhausted this pass — genuinely undelivered reminders. */
  gaveUp: number;
  skippedByReason: Partial<Record<NotDueReason, number>>;
  errors: Array<{ id: string; error: string }>;
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
    gaveUp: 0,
    skippedByReason: {},
    errors: [],
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
    const { due, skipped } = selectDueCommitments(all as Array<Commitment & { id: string }>, now);

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

    return report;
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

    const text = buildCheckInReminderText({
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
      await this.deps.send(topicId, text);
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
      report.errors.push({ id: commitment.id, error: `sent-but-unstamped: ${err}` });
    }
    return true;
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }
}
