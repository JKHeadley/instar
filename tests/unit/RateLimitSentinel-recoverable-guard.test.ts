// Live incident 2026-06-24: a FINISHED session is "idle at a prompt" with a stale
// throttle string still in its scrollback, so the idle-error detector mistakes it for
// a live-but-throttled session and reports it. Without a session-status guard the
// recovery runs its full backoff→resume→verify lifecycle against a session that will
// never grow its jsonl — burning all attempts and spamming the user with the
// RATE_LIMIT_RESUME_NUDGE. These tests lock the `isSessionRecoverable` guard:
//   - report() no-ops (no notice, no recovery) when the session is not recoverable;
//   - a recovery aborts SILENTLY (no "still throttled" ping) when the session finishes
//     mid-backoff;
//   - dep ABSENT preserves the prior behavior (regression lock).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimitSentinel } from '../../src/monitoring/RateLimitSentinel.js';

const FIRST_BACKOFF = 30_000;

describe('RateLimitSentinel — isSessionRecoverable guard (false-positive on finished sessions)', () => {
  let resumeFn: ReturnType<typeof vi.fn>;
  let notifyFn: ReturnType<typeof vi.fn>;
  let sentinel: RateLimitSentinel;

  beforeEach(() => {
    vi.useFakeTimers();
    resumeFn = vi.fn().mockResolvedValue(true);
    notifyFn = vi.fn().mockResolvedValue(undefined);
  });
  afterEach(() => {
    sentinel?.stop();
    vi.useRealTimers();
  });

  function build(recoverable: ((s: string) => boolean) | undefined) {
    sentinel = new RateLimitSentinel(
      {
        resumeFn: resumeFn as any,
        notifyFn: notifyFn as any,
        projectDir: '/fake/project',
        // No jsonl on disk → readJsonlBaseline returns null; irrelevant for these tests.
        ...(recoverable ? { isSessionRecoverable: recoverable } : {}),
      },
      { dedupeWindowMs: 60_000, verifyWindowMs: 25_000, maxAttempts: 6, maxWindowMs: 30 * 60_000, checkInEveryMs: 120_000 },
    );
  }

  it('NO-OPS when the session is not recoverable (finished/killed/unknown) — no notice, no recovery', () => {
    build(() => false);
    sentinel.report('echo-topic-28130', 'idle-error');
    // The whole point: a finished session must not get the "throttled, backing off" notice…
    expect(notifyFn).not.toHaveBeenCalled();
    // …and no recovery state is created.
    expect(sentinel.getState('echo-topic-28130')).toBeUndefined();
    expect(sentinel.isRecoveryActive('echo-topic-28130')).toBe(false);
  });

  it('PROCEEDS normally when the session IS recoverable (genuine throttle still recovers)', () => {
    build(() => true);
    sentinel.report('echo-topic-28130', 'idle-error');
    // The immediate user notice is sent and a recovery is now active.
    expect(notifyFn).toHaveBeenCalledTimes(1);
    expect(sentinel.isRecoveryActive('echo-topic-28130')).toBe(true);
  });

  it('dep ABSENT preserves prior behavior (recovers anything reported) — regression lock', () => {
    build(undefined);
    sentinel.report('echo-topic-28130', 'idle-error');
    expect(notifyFn).toHaveBeenCalledTimes(1);
    expect(sentinel.isRecoveryActive('echo-topic-28130')).toBe(true);
  });

  it('ABORTS SILENTLY when the session finishes mid-backoff — no escalation ping, emits aborted', async () => {
    let alive = true;
    build(() => alive);
    const aborted: any[] = [];
    const escalated: any[] = [];
    sentinel.on('rate-limit:aborted', p => aborted.push(p));
    sentinel.on('rate-limit:escalated', p => escalated.push(p));

    sentinel.report('echo-topic-28130', 'idle-error'); // starts; one notice sent
    expect(notifyFn).toHaveBeenCalledTimes(1);

    // Session finishes while we're backing off.
    alive = false;
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF + 100); // backoff fires → attemptResume

    // It must NOT have injected a resume, must NOT have sent any further user message,
    // and must NOT have escalated. It aborts silently.
    expect(resumeFn).not.toHaveBeenCalled();
    expect(notifyFn).toHaveBeenCalledTimes(1); // still just the first notice
    expect(escalated).toHaveLength(0);
    expect(aborted).toHaveLength(1);
    expect(sentinel.isRecoveryActive('echo-topic-28130')).toBe(false);
  });

  it('ABORTS when the session finishes during the VERIFY window — no escalation ping (the finished-mid-verify hole)', async () => {
    let alive = true;
    build(() => alive);
    const aborted: any[] = [];
    const escalated: any[] = [];
    sentinel.on('rate-limit:aborted', p => aborted.push(p));
    sentinel.on('rate-limit:escalated', p => escalated.push(p));

    sentinel.report('echo-topic-28130', 'idle-error'); // notice #1; backoff scheduled
    expect(notifyFn).toHaveBeenCalledTimes(1);

    // Backoff fires while the session is still alive → resume injected, verify scheduled.
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF + 100);
    expect(resumeFn).toHaveBeenCalledTimes(1);

    // The session FINISHES during the verify window.
    alive = false;
    await vi.advanceTimersByTimeAsync(25_000 + 100); // verify fires

    // verify() must abort silently — NOT escalate with a "still can't get through" ping.
    expect(escalated).toHaveLength(0);
    expect(aborted).toHaveLength(1);
    expect(notifyFn).toHaveBeenCalledTimes(1); // still only the first notice
    expect(sentinel.isRecoveryActive('echo-topic-28130')).toBe(false);
  });
});
