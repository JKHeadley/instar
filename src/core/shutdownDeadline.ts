/**
 * Hard bound on graceful shutdown (instar#2122).
 *
 * The server's SIGTERM handler awaits a long sequence of subsystem stops. Any one
 * of them can hang (an origin worker, a tunnel, a Threadline relay, an HTTP server
 * holding a long-poll), and without a bound the process never exits — only SIGKILL
 * stops it, which is what Luna's standby showed. This arms an unref'd timer that
 * forces the exit after `deadlineMs`, naming the step that was in flight.
 */

/** Default upper bound on graceful teardown before the process exits anyway. */
export const SHUTDOWN_HARD_DEADLINE_MS = 20_000;

/** Resolve the deadline: env override (ms) wins when it is a positive number; floor 2s. */
export function resolveShutdownDeadlineMs(envValue: string | undefined, fallback = SHUTDOWN_HARD_DEADLINE_MS): number {
  const parsed = Number(envValue);
  const chosen = envValue !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(2_000, chosen);
}

export interface ShutdownDeadlineOptions {
  deadlineMs: number;
  /** Names the teardown step currently in flight, for the exit log line. */
  currentStep: () => string;
  /** Best-effort cleanup + exit; receives the step name and the bound. */
  onExpire: (step: string, deadlineMs: number) => void;
  setTimeoutFn?: typeof setTimeout;
}

/** Arm the deadline. The timer is unref'd so a fast teardown is never held open by it. */
export function armShutdownDeadline(opts: ShutdownDeadlineOptions): { cancel: () => void } {
  const st = opts.setTimeoutFn ?? setTimeout;
  const timer = st(() => opts.onExpire(opts.currentStep(), opts.deadlineMs), opts.deadlineMs);
  (timer as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(timer) };
}
