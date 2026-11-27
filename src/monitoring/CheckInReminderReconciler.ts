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
import {
  isLateNoticeDue,
  isUnresolvedExhaustion,
  isDueSoonNudgeDue,
  buildLateNoticeText,
  buildPromiseHandoffText,
  DEFAULT_LATE_TOPIC_COOLDOWN_MS,
  DEFAULT_MAX_LATE_TOPICS_PER_PASS,
  DEFAULT_MAX_LATE_TOPICS_PER_HOUR,
  LATE_NOTICE_MAX_ATTEMPTS,
  type LateNotDueReason,
} from './lateNoticeCore.js';

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
   * Overdue-promise follow-through: hand a promise to the topic's RUNNING
   * session as a system notice (never a user message, never a spawn). Resolves
   * true only when the session took the text. Absent → no handoff, no due-soon
   * nudge; the person-facing late notice is unaffected.
   */
  handOffPromise?: (topicId: number, text: string) => Promise<boolean>;
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
  /** Rows whose promised time passed and are owed a notice this pass or later. */
  due: number;
  /** Conversations sent a late message this pass. */
  topicsSent: number;
  /** Rows stamped as noticed this pass. */
  rowsNoticed: number;
  /** Conversations held by the per-topic cooldown or the agent-wide budget. */
  topicsHeld: number;
  /** Would-send conversations under dry-run. */
  wouldSendTopics: number;
  failed: number;
  /** Rows whose attempts ran out — undelivered late notices (also counted in gaveUp). */
  gaveUp: number;
  handoffsAccepted: number;
  handoffsNotAccepted: number;
  nudged: number;
  dueIds: string[];
  skippedByReason: Partial<Record<LateNotDueReason, number>>;
}

function emptyLateReport(): LatePassReport {
  return {
    ran: false, due: 0, topicsSent: 0, rowsNoticed: 0, topicsHeld: 0, wouldSendTopics: 0,
    failed: 0, gaveUp: 0, handoffsAccepted: 0, handoffsNotAccepted: 0, nudged: 0, dueIds: [], skippedByReason: {},
  };
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

  // ── Late notices (docs/specs/overdue-promise-follow-through.md) ──────────

  private async runLatePass(now: number, report: CheckInReminderPassReport): Promise<void> {
    const late = report.late;
    const epochStore = this.deps.lateEpoch;
    if (!epochStore) return;
    let epochMs = epochStore.read();
    if (epochMs === null) {
      // The epoch marks the first LIVE pass. A dry-run pass never sets it, so a
      // long dry-run soak cannot move the backlog window.
      if (this.config.dryRun) epochMs = now;
      else epochMs = epochStore.writeOnce(now);
    }
    late.ran = true;
    const self = this.config.selfMachineId;
    const all = this.deps.tracker.getAll() as Commitment[];

    // 1. Unresolved exhaustion → stamp failed, count it (never a silent give-up).
    for (const c of all) {
      if (!isUnresolvedExhaustion(c)) continue;
      if (self && (c.ownerMachineId ?? c.originMachineId) !== self) continue;
      if (this.config.dryRun) continue;
      try {
        await this.deps.tracker.mutate(c.id, (r) => ({ ...r, lateNoticeFailedAt: new Date(now).toISOString() }));
        late.gaveUp++;
        report.gaveUp++;
      } catch (err) {
        report.errors.push({ id: c.id, error: `late-exhaustion-stamp: ${err}` });
      }
    }

    // 2. Due-soon nudges (session only, running sessions only).
    if (this.deps.handOffPromise && !this.config.dryRun) {
      for (const c of all) {
        const v = isDueSoonNudgeDue({ commitment: c, nowMs: now, selfMachineId: self });
        if (!v.due) continue;
        try {
          // Stamp FIRST: a repeated nudge is noise; a missed one is backed up by the late notice.
          await this.deps.tracker.mutate(c.id, (r) => ({ ...r, dueSoonNudgeFor: v.promisedTime }));
          const ok = await this.deps.handOffPromise(c.topicId as number, buildPromiseHandoffText({
            kind: 'due-soon', id: c.id, origin: c.originMachineId ?? null, promisedTime: v.promisedTime,
            agentResponse: c.agentResponse, timeZone: this.deps.timeZone,
          }));
          if (ok) late.nudged++;
        } catch (err) {
          report.errors.push({ id: c.id, error: `due-soon-nudge: ${err}` });
        }
      }
    }

    // 3. Late notices: select, group by topic, order by oldest promised time.
    const groups = new Map<number, Array<{ c: Commitment; time: string; ms: number }>>();
    for (const c of all) {
      const v = isLateNoticeDue({ commitment: c, nowMs: now, selfMachineId: self, epochMs });
      if (!v.due) {
        if (v.reason !== 'no-promised-time') late.skippedByReason[v.reason] = (late.skippedByReason[v.reason] ?? 0) + 1;
        continue;
      }
      late.due++;
      const g = groups.get(c.topicId as number) ?? [];
      g.push({ c, time: v.promisedTime, ms: v.promisedMs });
      groups.set(c.topicId as number, g);
    }
    if (groups.size === 0) return;

    const cooldown = this.config.lateTopicCooldownMs ?? DEFAULT_LATE_TOPIC_COOLDOWN_MS;
    const perPass = this.config.maxLateTopicsPerPass ?? DEFAULT_MAX_LATE_TOPICS_PER_PASS;
    const perHour = this.config.maxLateTopicsPerHour ?? DEFAULT_MAX_LATE_TOPICS_PER_HOUR;
    // Recent sends per topic, from the durable stamps (survives restarts; no in-memory state).
    const lastSentByTopic = new Map<number, number>();
    for (const c of all) {
      const t = Date.parse(c.lateNoticeSentAt ?? '');
      if (!Number.isFinite(t) || typeof c.topicId !== 'number') continue;
      if (self && (c.ownerMachineId ?? c.originMachineId) !== self) continue;
      if (t > (lastSentByTopic.get(c.topicId) ?? 0)) lastSentByTopic.set(c.topicId, t);
    }
    let topicsThisHour = [...lastSentByTopic.values()].filter((t) => now - t < 60 * 60_000).length;

    const ordered = [...groups.entries()]
      .map(([topicId, rows]) => ({ topicId, rows: rows.sort((a, b) => a.ms - b.ms) }))
      .sort((a, b) => a.rows[0].ms - b.rows[0].ms);

    let topicsThisPass = 0;
    for (const group of ordered) {
      const last = lastSentByTopic.get(group.topicId);
      if (last !== undefined && now - last < cooldown) { late.topicsHeld++; continue; }
      if (topicsThisPass >= perPass || topicsThisHour >= perHour) { late.topicsHeld++; continue; }
      if (this.config.dryRun) {
        late.wouldSendTopics++;
        late.dueIds.push(...group.rows.map((r) => r.c.id));
        topicsThisPass++;
        this.log(`[late-notice] would tell topic ${group.topicId} about ${group.rows.length} late promise(s)`);
        continue;
      }
      const sent = await this.noticeGroup(group.topicId, group.rows, now, report);
      if (sent) { topicsThisPass++; topicsThisHour++; }
    }
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
   * One conversation's late rows → one message. Order: count an attempt (with
   * the predicate re-checked inside the CAS) → send once → stamp every row →
   * hand off to a running session. The handoff runs only after the stamp, so
   * its "the user has been told" is true.
   */
  private async noticeGroup(
    topicId: number,
    rows: Array<{ c: Commitment; time: string; ms: number }>,
    now: number,
    report: CheckInReminderPassReport,
  ): Promise<boolean> {
    const late = report.late;
    const self = this.config.selfMachineId;
    const kept: Array<{ c: Commitment; time: string }> = [];
    for (const r of rows) {
      let still = false;
      try {
        await this.deps.tracker.mutate(r.c.id, (cur) => {
          const v = isLateNoticeDue({ commitment: cur, nowMs: now, selfMachineId: self, epochMs: -Infinity });
          if (!v.due || v.promisedTime !== r.time) return cur;
          still = true;
          const sameTime = cur.lateAttemptsFor === r.time;
          // A new promised time gets a fresh budget: attempts AND any old failure stamp reset together.
          return { ...cur, lateAttemptsFor: r.time, lateAttempts: (sameTime ? (cur.lateAttempts ?? 0) : 0) + 1, ...(sameTime ? {} : { lateNoticeFailedAt: undefined }) };
        });
      } catch (err) {
        // @silent-fallback-ok — not silent: the error is in the pass report, and the row stays
        // eligible (no attempt was counted) so the next pass retries it.
        report.errors.push({ id: r.c.id, error: `late-attempt: ${err}` });
        continue;
      }
      if (still) kept.push({ c: this.deps.tracker.getAll().find((x) => x.id === r.c.id && x.originMachineId === r.c.originMachineId) as Commitment ?? r.c, time: r.time });
    }
    if (kept.length === 0) return false;

    const text = buildLateNoticeText(
      kept.map((k) => ({ promisedTime: k.time, agentResponse: k.c.agentResponse, userRequest: k.c.userRequest })),
      this.deps.timeZone,
    );
    const identity: CheckInSendIdentity = {
      kind: 'late',
      topicId,
      rows: kept
        .map((k) => ({ origin: k.c.originMachineId ?? null, id: k.c.id, time: k.time }))
        .sort((a, b) => (a.id + a.time).localeCompare(b.id + b.time)),
    };
    try {
      await this.sendDelivered(topicId, text, identity);
    } catch (err) {
      late.failed++;
      report.failed++;
      report.errors.push({ id: kept.map((k) => k.c.id).join(','), error: String(err) });
      for (const k of kept) {
        const attempts = k.c.lateAttemptsFor === k.time ? (k.c.lateAttempts ?? 0) : 0;
        if (attempts >= LATE_NOTICE_MAX_ATTEMPTS) {
          try {
            await this.deps.tracker.mutate(k.c.id, (cur) => ({ ...cur, lateNoticeFailedAt: new Date(now).toISOString() }));
          } catch { /* @silent-fallback-ok — the failure is in the pass report; the next pass's exhaustion sweep retries the stamp */ }
          late.gaveUp++;
          report.gaveUp++;
          this.log(`[late-notice] GIVING UP on ${k.c.id} after ${attempts} attempts — late notice UNDELIVERED`);
        }
      }
      return false;
    }

    const sentAt = new Date(now).toISOString();
    for (const k of kept) {
      try {
        await this.deps.tracker.mutate(k.c.id, (cur) => ({
          ...cur,
          lateNoticeFor: k.time,
          lateNoticeSentAt: sentAt,
          lateNoticeCount: (cur.lateNoticeCount ?? 0) + 1,
        }));
        late.rowsNoticed++;
        late.dueIds.push(k.c.id);
      } catch (err) {
        // The person HAS the notice; the next pass re-sends with the same identity (replayed).
        report.errors.push({ id: k.c.id, error: `late-sent-but-unstamped: ${err}` });
      }
    }
    late.topicsSent++;

    if (this.deps.handOffPromise) {
      for (const k of kept) {
        try {
          const ok = await this.deps.handOffPromise(topicId, buildPromiseHandoffText({
            kind: 'late', id: k.c.id, origin: k.c.originMachineId ?? null, promisedTime: k.time,
            agentResponse: k.c.agentResponse, timeZone: this.deps.timeZone,
          }));
          if (ok) {
            late.handoffsAccepted++;
            await this.deps.tracker.mutate(k.c.id, (cur) => ({ ...cur, lateHandoffFor: k.time })).catch(() => { /* @silent-fallback-ok — bookkeeping only; the session already has the text */ });
          } else {
            late.handoffsNotAccepted++;
          }
        } catch (err) {
          late.handoffsNotAccepted++;
          report.errors.push({ id: k.c.id, error: `late-handoff: ${err}` });
        }
      }
    }
    return true;
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
