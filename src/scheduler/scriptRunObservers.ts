/**
 * scriptRunObservers — the observer seam for completed script-job runs
 * (docs/specs/job-cost-reduction.md §5.4, §5.6).
 *
 * The anomaly pusher, the per-run triage and the canary runner subscribe here
 * via `JobScheduler.addScriptRunObserver`. Observers are called AFTER the run
 * is recorded and its claim released, never awaited by the run path, and a
 * throwing observer is logged and swallowed — an observer can never change a
 * run's recorded result or delay the next one.
 */

import type { JobDefinition } from '../core/types.js';
import type { ParsedScriptRun } from './jobScriptProtocol.js';

export interface ScriptRunContext {
  job: JobDefinition;
  runId: string;
  machineId: string | null;
  parsed: ParsedScriptRun;
  /** Secret-scrubbed, capped. */
  scrubbedOutput: string;
  startedAt: string;
  finishedAt: string;
  /** True for canary runs (observers other than the canary runner must ignore). */
  canary: boolean;
  lockTrust: string;
}

export interface ScriptRunObserver {
  onScriptRunCompleted(ctx: ScriptRunContext): void | Promise<void>;
}

/** Fan a context out to observers: fire-and-forget, errors logged. */
export function notifyScriptRunObservers(
  observers: readonly ScriptRunObserver[],
  ctx: ScriptRunContext,
  log: (msg: string) => void = (m) => console.error(m),
): void {
  for (const o of observers) {
    try {
      const r = o.onScriptRunCompleted(ctx);
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).catch((err) => {
          log(`[script-run-observer] observer rejected for ${ctx.job.slug}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    } catch (err) {
      // @silent-fallback-ok — an observer must never affect the run path.
      log(`[script-run-observer] observer threw for ${ctx.job.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
