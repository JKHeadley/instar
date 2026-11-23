/**
 * restartRequestSignal — one process-wide announcement that a restart of THIS server has been
 * asked for (docs/specs/planned-restart-keeps-lead.md §1 step 1).
 *
 * Every writer of `state/restart-requested.json` that lives in the server process calls
 * `announceRestartRequested` BEFORE it makes the file visible, so the lease holder can extend
 * its lease over the coming boot before either restart consumer (the lifeline's supervisor or the
 * in-process watcher) can act. The three writers behind nearly every holder restart await the
 * returned promise; the others announce and publish at once.
 *
 * The promise resolves:
 *   - at once when no subscriber is attached (multi-machine off, lease not initialised), or the
 *     subscriber signs no renewal (this machine is not the holder, or is still confirming its own
 *     reclaim);
 *   - otherwise when the subscriber's window renewal is confirmed, or this module's own deadline
 *     (the transport's broadcast deadline, 8 s by default) passes — the deadline is run here so a
 *     slow subscriber can never hold a writer.
 * An announce that arrives while one is in flight joins the same promise. Subscriber errors are
 * isolated: an announce never throws into a writer, so a failed continuity write can never stop
 * an update's restart from being requested.
 *
 * Leaf module: no imports from the lease layer, so every writer can import it without a cycle.
 */

export interface RestartAnnounce {
  requestedBy: string;
  reason?: string;
  /** ISO time the writer stamped (or will stamp) on the request. */
  requestedAt?: string;
}

/** What the subscriber did with an announce. `null` means it signed nothing (not the holder). */
export type RestartAnnounceOutcome = 'confirmed' | 'unconfirmed';
export type RestartAnnounceSubscriber = (announce: RestartAnnounce) => Promise<RestartAnnounceOutcome> | null;
export type RestartWithdrawSubscriber = () => void;

export const DEFAULT_RESTART_SIGNAL_DEADLINE_MS = 8_000;

let subscriber: RestartAnnounceSubscriber | null = null;
let withdrawSubscriber: RestartWithdrawSubscriber | null = null;
let deadlineMs = DEFAULT_RESTART_SIGNAL_DEADLINE_MS;
let inFlight: Promise<RestartAnnounceOutcome | null> | null = null;
let errorSink: ((err: unknown) => void) | null = null;

/** Attach the one subscriber (the lease coordinator, through MultiMachineCoordinator). Returns a detach. */
export function onRestartRequested(fn: RestartAnnounceSubscriber, opts?: { onError?: (err: unknown) => void }): () => void {
  subscriber = fn;
  errorSink = opts?.onError ?? null;
  return () => {
    if (subscriber === fn) subscriber = null;
    if (opts?.onError && errorSink === opts.onError) errorSink = null;
  };
}

export function onRestartWithdrawn(fn: RestartWithdrawSubscriber): () => void {
  withdrawSubscriber = fn;
  return () => { if (withdrawSubscriber === fn) withdrawSubscriber = null; };
}

/** The transport's resolved broadcast deadline, set once by the coordinator; 8 s with default settings. */
export function setRestartSignalDeadlineMs(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) deadlineMs = ms;
}

export function restartSignalDeadlineMs(): number {
  return deadlineMs;
}

/**
 * Announce a restart request before it becomes visible. Never throws; resolves with the
 * subscriber's outcome, or `null` when nothing was signed (no subscriber / not the holder /
 * subscriber fault), or `'unconfirmed'` when the deadline passed first.
 */
export function announceRestartRequested(announce: RestartAnnounce): Promise<RestartAnnounceOutcome | null> {
  if (inFlight) return inFlight;
  const fn = subscriber;
  if (!fn) return Promise.resolve(null);
  let signed: Promise<RestartAnnounceOutcome> | null;
  try {
    signed = fn(announce);
  } catch (err) {
    // @silent-fallback-ok: handed to the caller's report() hook; null tells the caller the announce did not go out
    report(err);
    return Promise.resolve(null);
  }
  if (!signed) return Promise.resolve(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<RestartAnnounceOutcome>((resolve) => {
    timer = setTimeout(() => resolve('unconfirmed'), deadlineMs);
    timer.unref?.();
  });
  inFlight = Promise.race([
    signed.catch((err) => { report(err); return 'unconfirmed' as RestartAnnounceOutcome; }),
    deadline,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    inFlight = null;
  });
  return inFlight;
}

/** A writer took its request back (withdrawRoleRestart). */
export function announceRestartWithdrawn(): void {
  const fn = withdrawSubscriber;
  if (!fn) return;
  try { fn(); } catch (err) { report(err); }
}

function report(err: unknown): void {
  try { errorSink?.(err); } catch { /* @silent-fallback-ok: the error sink is observability; a writer must never see it */ }
}

/** Test seam: forget every subscriber and the in-flight announce. */
export function _resetRestartSignalForTests(): void {
  subscriber = null;
  withdrawSubscriber = null;
  errorSink = null;
  inFlight = null;
  deadlineMs = DEFAULT_RESTART_SIGNAL_DEADLINE_MS;
}
