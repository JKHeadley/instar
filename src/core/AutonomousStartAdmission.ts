/**
 * AutonomousStartAdmission — does a newly registered autonomous run start
 * 'active' or 'preparing', and who tells the operator when one never starts.
 *
 * THE INCIDENT (2026-11-01, topic 10000001225): POST /autonomous/register put
 * EVERY Echo run in 'preparing' whenever window-run liveness was enforcing. Only
 * that authority may promote a preparing run, but nothing bound ordinary runs
 * to it, and it holds one window at a time. The W32 window it was built for
 * closed on 2026-09-08, so from then on almost every run sat in 'preparing' for
 * its whole life: invisible to the liveness reconciler (which revives ACTIVE
 * runs) and to the operator, who heard "the autonomous session never started".
 *
 * THE FIX:
 *  1. `decideAutonomousStartStatus` — 'preparing' only while a W32 window
 *     lifecycle is genuinely open AND its single liveness slot can take this
 *     run. Every other run starts 'active', so the reconciler revives it if its
 *     session dies.
 *  2. `PreparingRunWatchdog` — any open run still 'preparing' past a few
 *     minutes gets ONE plain notice in its own topic. A run that cannot start
 *     is never silent. At most PREPARING_NOTICE_MAX_ATTEMPTS sends per run,
 *     counted on the durable run record, so a dead delivery path cannot loop.
 *
 * @self-action-controller: preparing-run-watchdog
 */

import type { AutonomousRunRecord, AutonomousRunStore } from './AutonomousRunStore.js';

/** Lifecycle states in which a W32 window is admitting / running work. */
export const OPEN_WINDOW_LIFECYCLE_STATES: readonly string[] = [
  'pre_start_gate', 'start_blocked', 'active_start', 'active_mid_due', 'active_mid_blocked', 'active_mid_satisfied',
];
const TERMINAL_LIVENESS_STATES = ['stalled', 'failed', 'closed'];

export interface StartAdmissionInput {
  projectName: string;
  topicId: string;
  /** WindowRunLivenessAuthority.status(), or null/undefined when the authority is dark. */
  liveness: { enabled: boolean; dryRun: boolean; state: { topicId: number; windowId: string; status: string } | null } | null | undefined;
  /** The Echo W32 window lifecycle ledger, or null when none exists. */
  windowLedger: { windowId: string; state: string; windowCeilingAt?: string; recurrenceFrozenAt?: string } | null | undefined;
  nowMs: number;
}

export interface StartAdmissionDecision {
  initialStatus: 'preparing' | 'active';
  reason: string;
}

export function decideAutonomousStartStatus(input: StartAdmissionInput): StartAdmissionDecision {
  const { liveness, windowLedger } = input;
  if (input.projectName !== 'echo' || liveness?.enabled !== true || liveness.dryRun !== false) {
    return { initialStatus: 'active', reason: 'liveness-not-enforcing' };
  }
  const ceilingMs = Date.parse(windowLedger?.windowCeilingAt ?? '');
  const windowOpen = !!windowLedger
    && OPEN_WINDOW_LIFECYCLE_STATES.includes(windowLedger.state)
    && !windowLedger.recurrenceFrozenAt
    && (!Number.isFinite(ceilingMs) || input.nowMs < ceilingMs);
  if (!windowOpen) return { initialStatus: 'active', reason: 'no-open-window' };
  // The authority holds ONE binding, and only a NEW run can bind it: a live
  // binding (even this topic's, which belongs to an earlier run) refuses it, and
  // a finished binding for this same window closes the window to rebinding. A
  // run that cannot take the slot could never be promoted, so it must not wait.
  const bound = liveness.state;
  if (bound && !TERMINAL_LIVENESS_STATES.includes(bound.status)) {
    return { initialStatus: 'active', reason: 'liveness-slot-held' };
  }
  if (bound && bound.windowId === windowLedger!.windowId) {
    return { initialStatus: 'active', reason: 'liveness-window-already-finished' };
  }
  return { initialStatus: 'preparing', reason: 'open-window-awaits-liveness' };
}

export const PREPARING_NOTICE_AFTER_MS = 5 * 60_000;
/** A run the liveness authority is actively evaluating needs time for its first work receipt. */
export const PREPARING_NOTICE_AFTER_BOUND_MS = 45 * 60_000;
/** Send attempts per run before the watchdog gives up on that run (survives restart). */
export const PREPARING_NOTICE_MAX_ATTEMPTS = 3;

export interface BoundRun { topicId: string; runId: string; boundAt: string }

/** Open runs that have sat in 'preparing' too long and have not been reported yet. */
export function findStuckPreparingRuns(
  runs: readonly AutonomousRunRecord[],
  opts: { nowMs: number; boundRun?: BoundRun | null; afterMs?: number; afterBoundMs?: number },
): AutonomousRunRecord[] {
  const afterMs = opts.afterMs ?? PREPARING_NOTICE_AFTER_MS;
  const afterBoundMs = opts.afterBoundMs ?? PREPARING_NOTICE_AFTER_BOUND_MS;
  return runs.filter((run) => {
    if (run.status !== 'preparing' || run.preparingNoticeAt) return false;
    if ((run.preparingNoticeAttempts ?? 0) >= PREPARING_NOTICE_MAX_ATTEMPTS) return false;
    const registeredMs = Date.parse(run.registeredAt);
    if (!Number.isFinite(registeredMs)) return true;
    const bound = opts.boundRun?.topicId === run.topicId && opts.boundRun.runId === run.runId;
    if (!bound) return opts.nowMs - registeredMs >= afterMs;
    // The allowance for a first work receipt runs from when the authority took the run.
    const boundMs = Date.parse(opts.boundRun!.boundAt);
    return opts.nowMs - Math.max(registeredMs, Number.isFinite(boundMs) ? boundMs : registeredMs) >= afterBoundMs;
  });
}

export function renderPreparingNotice(run: AutonomousRunRecord, nowMs: number): string {
  const minutes = Math.max(1, Math.round((nowMs - Date.parse(run.registeredAt)) / 60_000));
  const waited = Number.isFinite(minutes) ? `${minutes} minute${minutes === 1 ? '' : 's'}` : 'a while';
  return [
    `Your autonomous run in this topic did not start. It was registered ${waited} ago but is still waiting for its start check, so it is not running and nothing will restart it if its session stops.`,
    `To start it, ask me to start the autonomous run again (run ${run.runId}).`,
  ].join('\n\n');
}

export interface PreparingRunWatchdogDeps {
  store: Pick<AutonomousRunStore, 'listOpen' | 'update'>;
  /** Deliver the notice to the run's topic; resolve true only when it was sent. */
  notify: (topicId: string, text: string) => Promise<boolean>;
  /** The run the liveness authority currently evaluates (non-terminal), if any. */
  boundRun?: () => BoundRun | null;
  now?: () => number;
}

export class PreparingRunWatchdog {
  private running = false;
  constructor(private readonly deps: PreparingRunWatchdogDeps) {}

  /** One pass. Returns the run ids that were reported. */
  async tick(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const nowMs = this.deps.now?.() ?? Date.now();
      const stuck = findStuckPreparingRuns(this.deps.store.listOpen(nowMs), { nowMs, boundRun: this.deps.boundRun?.() ?? null });
      const reported: string[] = [];
      for (const run of stuck) {
        // Claim under the run lock, re-checking the live record: a run promoted
        // since the scan is not told it never started. The notice is marked
        // BEFORE the send so a lock contention after a delivered send cannot
        // cause a second copy; a failed send releases the mark.
        const at = new Date(nowMs).toISOString();
        let claimed = false;
        try {
          this.deps.store.update(run.topicId, run.runId, (rec) => {
            if (rec.status !== 'preparing' || rec.preparingNoticeAt || (rec.preparingNoticeAttempts ?? 0) >= PREPARING_NOTICE_MAX_ATTEMPTS) return;
            rec.preparingNoticeAttempts = (rec.preparingNoticeAttempts ?? 0) + 1;
            rec.preparingNoticeAt = at;
            claimed = true;
          });
        } catch (error) {
          // @silent-fallback-ok — the run lock was busy; the next tick tries again.
          console.warn(`[preparing-run-watchdog] could not claim run ${run.runId}:`, error);
        }
        if (!claimed) continue;
        let sent = false;
        try {
          sent = await this.deps.notify(run.topicId, renderPreparingNotice(run, nowMs));
        } catch (error) {
          // @silent-fallback-ok — the mark is released below; the next tick retries until the attempt cap.
          console.warn(`[preparing-run-watchdog] notice for topic ${run.topicId} failed:`, error);
        }
        if (sent) {
          reported.push(run.runId);
          continue;
        }
        try {
          this.deps.store.update(run.topicId, run.runId, (rec) => { if (rec.preparingNoticeAt === at) delete rec.preparingNoticeAt; });
        } catch (error) {
          // @silent-fallback-ok — leaving the mark set fails toward one fewer retry, never a duplicate.
          console.warn(`[preparing-run-watchdog] could not release run ${run.runId} for retry:`, error);
        }
        if ((run.preparingNoticeAttempts ?? 0) + 1 >= PREPARING_NOTICE_MAX_ATTEMPTS) {
          console.warn(`[preparing-run-watchdog] gave up telling topic ${run.topicId} that run ${run.runId} never started (${PREPARING_NOTICE_MAX_ATTEMPTS} failed sends)`);
        }
      }
      return reported;
    } finally {
      this.running = false;
    }
  }
}
