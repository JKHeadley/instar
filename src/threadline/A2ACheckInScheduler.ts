/**
 * A2ACheckInScheduler — Layer 4 cadence (THREADLINE-A2A-COHERENCE-SPEC).
 *
 * Drives the silence-breaker heartbeat: on a periodic tick it walks the active a2a threads and,
 * for each, runs the check-in flow (decide → summarize → guard → surface). The operator's
 * refinement is "every 5-10 min while a conversation is active and I've heard nothing" — so the
 * scheduler tracks the last surface time per thread (in memory) and lets A2ACheckInPolicy decide.
 *
 * First-sight semantics: when a thread is first seen the silence clock STARTS (set to now) and
 * nothing fires — so a heartbeat never fires the instant a conversation becomes active, only
 * after the full interval of subsequent silence. Salience check-ins fire from the inbound path
 * (not here) and call recordSurface() so the heartbeat clock resets.
 *
 * Deps are injected → the scheduler is testable without the server/timer. Ships gated on the
 * default-off config (start() is a no-op when disabled).
 */

import { runCheckIn, type CheckInRequest, type CheckInOutcome } from './A2ACheckInProxy.js';
import type { SummaryKind } from './A2ACheckInSummarizer.js';

export interface ActiveThreadRef {
  threadId: string;
  peerName: string;
  topicId?: number;
}

export interface A2ACheckInSchedulerConfig {
  enabled: boolean;
  heartbeatEnabled: boolean;
  heartbeatIntervalMs: number;
}

export interface A2ACheckInSchedulerDeps {
  /** Active a2a threads to consider this tick (server: from ConversationStore.listActive()). */
  listActiveThreads: () => ActiveThreadRef[];
  /** Run the full check-in flow (server: runCheckIn bound with real summarize/surface/getHistory). */
  checkIn: (req: CheckInRequest) => Promise<CheckInOutcome>;
  /** Clock, injected for testability. */
  now: () => number;
  config: A2ACheckInSchedulerConfig;
  log?: (msg: string) => void;
}

export class A2ACheckInScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private readonly lastSurfaceAt = new Map<string, number>();

  constructor(private readonly deps: A2ACheckInSchedulerDeps) {}

  /** Start the cadence timer. No-op when the feature is disabled. */
  start(tickIntervalMs = 60_000): void {
    if (!this.deps.config.enabled) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, tickIntervalMs);
    // Never keep the process alive just for the heartbeat.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Record that a surface happened for a thread (e.g. a salience check-in) so the heartbeat resets. */
  recordSurface(threadId: string, at: number): void {
    this.lastSurfaceAt.set(threadId, at);
  }

  /** One pass over active threads. Exposed for tests + the timer. Never throws to the caller. */
  async tick(): Promise<void> {
    if (!this.deps.config.enabled) return;
    const now = this.deps.now();
    for (const t of this.deps.listActiveThreads()) {
      const last = this.lastSurfaceAt.get(t.threadId);
      if (last === undefined) {
        // First sight — start the silence clock; never fire on the first tick.
        this.lastSurfaceAt.set(t.threadId, now);
        continue;
      }
      try {
        const outcome = await this.deps.checkIn({
          threadId: t.threadId,
          peerName: t.peerName,
          topicId: t.topicId,
          conversationActive: true,
          hasSalientEvent: false, // the heartbeat path; salience is driven from the inbound path
          lastSurfaceAt: last,
          now,
          heartbeatIntervalMs: this.deps.config.heartbeatIntervalMs,
          heartbeatEnabled: this.deps.config.heartbeatEnabled,
        });
        if (outcome.surfaced) this.lastSurfaceAt.set(t.threadId, now);
      } catch (err) {
        this.deps.log?.(`[a2a-checkin] tick error for ${t.threadId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

/**
 * Factory — compose the concrete I/O deps into a wired scheduler. The server provides:
 *   listActiveThreads — from ThreadResumeMap.listActive() (filtered to topic-bound threads)
 *   summarize         — sharedLlmQueue.enqueue('background', () => intelligence.evaluate(prompt,{model:'fast'}))
 *   surface           — telegram.sendToTopic(topicId, body) (or the hub for parentless)
 *   getHistory        — formatted thread messages from MessageStore
 * Keeping this here (vs inline in server.ts) makes the full Layer 4 logic exercisable
 * end-to-end with mock deps — the wiring-integrity test the convergence round asked for.
 */
export interface A2ACheckInWiring {
  listActiveThreads: () => ActiveThreadRef[];
  summarize: (prompt: string) => Promise<string>;
  surface: (args: { threadId: string; topicId?: number; peerName: string; body: string; kind: SummaryKind }) => Promise<void>;
  getHistory: (threadId: string) => Promise<string> | string;
  config: A2ACheckInSchedulerConfig;
  now?: () => number;
  log?: (msg: string) => void;
}

export function createA2ACheckInScheduler(w: A2ACheckInWiring): A2ACheckInScheduler {
  const checkIn = (req: CheckInRequest): Promise<CheckInOutcome> =>
    runCheckIn(req, { summarize: w.summarize, surface: w.surface, getHistory: w.getHistory });
  return new A2ACheckInScheduler({
    listActiveThreads: w.listActiveThreads,
    checkIn,
    now: w.now ?? (() => Date.now()),
    config: w.config,
    log: w.log,
  });
}
