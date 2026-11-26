import { performance } from 'node:perf_hooks';

type Attempt = Readonly<{ challengeKey: string; challengeDigest: string }>;
type TerminalOutcome = 'canceled' | 'accepted';
type CancellationOutcome = TerminalOutcome | 'pending';

interface AttemptTimeoutOptions {
  attempt: Attempt;
  timeoutMs: number;
  /** Return a terminal outcome only with an exact witnessed result. */
  cancel: (attempt: Attempt) => Promise<CancellationOutcome>;
  monotonicNow?: () => number;
}

/** Local admission closes before requesting cancellation. The authority still decides the winning operation. */
export function startFirstPhoneAttemptTimeout(options: AttemptTimeoutOptions) {
  const attempt = Object.freeze({ ...options.attempt });
  const cancel = options.cancel;
  const now = options.monotonicNow ?? (() => performance.now());
  const duration = options.timeoutMs;
  const started = now();
  const deadline = started + duration;
  if (![attempt.challengeKey, attempt.challengeDigest].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
    || !Number.isSafeInteger(duration) || duration <= 0 || duration > 0x7fffffff
    || !Number.isFinite(started) || !Number.isFinite(deadline) || deadline <= started) {
    throw new Error('Invalid first-phone local timeout');
  }

  let closed = false;
  let terminal: TerminalOutcome | null = null;
  let pending: Promise<CancellationOutcome> | null = null;
  const timer = setTimeout(() => { void close(); }, duration);
  timer.unref();

  function close(): Promise<CancellationOutcome> {
    closed = true;
    clearTimeout(timer);
    if (terminal) return Promise.resolve(terminal);
    if (!pending) {
      pending = Promise.resolve().then(() => cancel(attempt)).then(outcome => {
        if (outcome === 'accepted' || outcome === 'canceled') terminal = outcome;
        return terminal ?? 'pending';
      }, () => 'pending' as const).finally(() => { pending = null; });
    }
    return pending;
  }

  function admitsSubmission(): boolean {
    if (closed) return false;
    const sample = now();
    if (!Number.isFinite(sample) || sample < started || sample >= deadline) {
      void close();
      return false;
    }
    return true;
  }

  return { admitsSubmission, close };
}
