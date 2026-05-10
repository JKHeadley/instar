/**
 * TaskFlowDueWaker — minute-tick poll that resumes `scheduled-tick` waits
 * whose `dueAt` has passed.
 *
 * Acts under the system-waker scope: it does not own the controller of the
 * woken flow. Per spec § Architecture, it transitions waiting → running and
 * leaves step advancement to the owning controller (which subscribes to
 * `taskflow:wait-fired`).
 */

import { TaskFlowRegistry } from './TaskFlowRegistry.js';
import { DUE_WAKER_INTERVAL_MS, TaskFlowError } from './task-flow-types.js';

export interface DueWakerOptions {
  registry: TaskFlowRegistry;
  intervalMs?: number;
  now?: () => number;
  wakerId?: string;
}

export class TaskFlowDueWaker {
  private timer: NodeJS.Timeout | null = null;
  private readonly registry: TaskFlowRegistry;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly wakerId: string;

  constructor(opts: DueWakerOptions) {
    this.registry = opts.registry;
    this.intervalMs = opts.intervalMs ?? DUE_WAKER_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.wakerId = opts.wakerId ?? 'TaskFlowDueWaker';
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        /* swallow — best-effort */
      });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Wake every scheduled-tick wait with `dueAt <= now`. Returns rows woken. */
  async tick(): Promise<number> {
    const matches = this.registry.findWaitingByDueAt(this.now());
    let resumed = 0;
    for (const m of matches) {
      try {
        await this.registry.resumeFlow({
          flowId: m.flowId,
          expectedRevision: m.revision,
          waitInstanceId: m.waitInstanceId,
          principal: { scope: 'system-waker', wakerId: this.wakerId },
        });
        this.registry.emit('taskflow:wait-fired', {
          flowId: m.flowId,
          controllerId: m.controllerId,
        });
        resumed++;
      } catch (err) {
        if (err instanceof TaskFlowError) {
          if (err.code === 'revision_conflict') continue;
          if (err.code === 'already_terminal') continue;
          if (err.code === 'already_consumed') continue;
        }
        // Other errors: swallow and continue with the rest.
      }
    }
    return resumed;
  }
}
