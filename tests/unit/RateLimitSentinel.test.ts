// Unit tests for RateLimitSentinel — verifies backoff-before-resume, verify
// (jsonl growth) recovery, escalation envelope, dedupe, bidirectional deferral,
// check-in spacing, the zombie-veto predicate, and the kill switch. Both sides
// of every decision boundary.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RateLimitSentinel } from '../../src/monitoring/RateLimitSentinel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeTempJsonlRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rls-test-'));
  return {
    root,
    write: (name: string, bytes: number) => fs.writeFileSync(path.join(root, name), 'x'.repeat(bytes)),
    cleanup: () => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/RateLimitSentinel.test.ts' }),
  };
}

const FIRST_BACKOFF = 30_000;
const VERIFY = 25_000;

describe('RateLimitSentinel', () => {
  let jsonl: ReturnType<typeof makeTempJsonlRoot>;
  let resumeFn: ReturnType<typeof vi.fn>;
  let notifyFn: ReturnType<typeof vi.fn>;
  let sentinel: RateLimitSentinel;
  let events: Array<{ type: string; payload: any }>;

  function build(cfg = {}, deps = {}) {
    sentinel = new RateLimitSentinel(
      { resumeFn: resumeFn as any, notifyFn: notifyFn as any, projectDir: '/fake/project', jsonlRoot: jsonl.root, ...deps },
      { dedupeWindowMs: 60_000, verifyWindowMs: VERIFY, maxAttempts: 6, maxWindowMs: 30 * 60_000, checkInEveryMs: 120_000, ...cfg },
    );
    events = [];
    for (const e of ['rate-limit:detected', 'rate-limit:resuming', 'rate-limit:recovered', 'rate-limit:escalated']) {
      sentinel.on(e as any, (p: any) => events.push({ type: e, payload: p }));
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    jsonl = makeTempJsonlRoot();
    resumeFn = vi.fn().mockResolvedValue(true);
    notifyFn = vi.fn().mockResolvedValue(undefined);
    build();
  });

  afterEach(() => {
    sentinel.stop();
    jsonl.cleanup();
    vi.useRealTimers();
  });

  // ─── Detection / immediate notice ───

  it('emits detected + sends the immediate "backing off" notice, but does NOT resume yet', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some(e => e.type === 'rate-limit:detected')).toBe(true);
    expect(notifyFn).toHaveBeenCalledTimes(1);
    expect(notifyFn.mock.calls[0][1]).toMatch(/backing off/i);
    // Backoff-before-nudge: no resume until the first backoff elapses.
    expect(resumeFn).not.toHaveBeenCalled();
  });

  it('re-engages only AFTER the first backoff interval (quota-burn guard)', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF - 1000);
    expect(resumeFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(resumeFn).toHaveBeenCalledTimes(1);
    expect(resumeFn).toHaveBeenCalledWith('s1');
  });

  // ─── Recovery ───

  it('recovers when jsonl grows within the verify window after the nudge', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF + 100); // resume fires
    jsonl.write('foo.jsonl', 800);                          // claude wrote output
    await vi.advanceTimersByTimeAsync(VERIFY + 500);
    const rec = events.find(e => e.type === 'rate-limit:recovered');
    expect(rec).toBeDefined();
    expect(rec!.payload.jsonlDelta).toBeGreaterThan(0);
    expect(notifyFn.mock.calls.some(c => /back online/i.test(c[1]))).toBe(true);
    expect(sentinel.isRecoveryActive('s1')).toBe(false);
  });

  // ─── Escalation ───

  it('escalates after maxAttempts with no jsonl growth', async () => {
    jsonl.write('foo.jsonl', 100);
    build({ maxAttempts: 3, backoffScheduleMs: [1000, 1000, 1000, 1000] });
    sentinel.report('s1', 'watchdog-poll');
    // 3 cycles of backoff(1s) + verify(25s), no growth.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000 + VERIFY + 100);
    }
    const esc = events.find(e => e.type === 'rate-limit:escalated');
    expect(esc).toBeDefined();
    expect(resumeFn).toHaveBeenCalledTimes(3);
    expect(notifyFn.mock.calls.some(c => /status\.claude\.com/i.test(c[1]))).toBe(true);
    expect(sentinel.isRecoveryActive('s1')).toBe(false);
  });

  it('escalates immediately if resumeFn declines (no pending work / session gone)', async () => {
    jsonl.write('foo.jsonl', 100);
    resumeFn.mockResolvedValue(false);
    sentinel.report('s1', 'idle-error');
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF + 100);
    expect(events.some(e => e.type === 'rate-limit:escalated')).toBe(true);
    expect(resumeFn).toHaveBeenCalledTimes(1);
  });

  // ─── Dedupe / defer / kill switch ───

  it('dedupes reports while a recovery is active', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    sentinel.report('s1', 'idle-error');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter(e => e.type === 'rate-limit:detected')).toHaveLength(1);
  });

  it('defers when deferIf returns true (compaction recovery owns the session)', async () => {
    jsonl.write('foo.jsonl', 100);
    build({}, { deferIf: () => true });
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(0);
    expect(notifyFn).not.toHaveBeenCalled();
    expect(sentinel.isRecoveryActive('s1')).toBe(false);
  });

  it('respects setDeferIf late-binding', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.setDeferIf(() => true);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(0);
  });

  it('is a no-op when disabled (kill switch)', async () => {
    jsonl.write('foo.jsonl', 100);
    build({ enabled: false });
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF + 100);
    expect(events).toHaveLength(0);
    expect(resumeFn).not.toHaveBeenCalled();
    expect(notifyFn).not.toHaveBeenCalled();
  });

  // ─── isRecoveryActive predicate (zombie veto) ───

  it('isRecoveryActive is true during recovery, false before and after', async () => {
    jsonl.write('foo.jsonl', 100);
    expect(sentinel.isRecoveryActive('s1')).toBe(false);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentinel.isRecoveryActive('s1')).toBe(true); // backing off
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF + 100);
    expect(sentinel.isRecoveryActive('s1')).toBe(true); // resuming/verifying
  });

  // ─── Check-in spacing ───

  it('does not spam check-ins: spaced by checkInEveryMs', async () => {
    jsonl.write('foo.jsonl', 100);
    build({ maxAttempts: 10, checkInEveryMs: 999_999, backoffScheduleMs: [1000] });
    sentinel.report('s1', 'watchdog-poll');
    // run several backoff+verify cycles with no growth
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1000 + VERIFY + 50);
    // Only the initial "backing off" notice; check-ins suppressed by huge spacing.
    const checkIns = notifyFn.mock.calls.filter(c => /still throttled/i.test(c[1]));
    expect(checkIns).toHaveLength(0);
  });

  it('sends a check-in once spacing has elapsed', async () => {
    jsonl.write('foo.jsonl', 100);
    build({ maxAttempts: 10, checkInEveryMs: 1, backoffScheduleMs: [1000] });
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(1000 + VERIFY + 50); // first verify fail → check-in
    const checkIns = notifyFn.mock.calls.filter(c => /still throttled/i.test(c[1]));
    expect(checkIns.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Observability ───

  it('listActive surfaces state + nextBackoffMs for the status endpoint', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    const active = sentinel.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].sessionName).toBe('s1');
    expect(active[0].nextBackoffMs).toBe(FIRST_BACKOFF);
  });

  it('separate sessions recover independently', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('a', 'watchdog-poll');
    sentinel.report('b', 'idle-error');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentinel.isRecoveryActive('a')).toBe(true);
    expect(sentinel.isRecoveryActive('b')).toBe(true);
    expect(events.filter(e => e.type === 'rate-limit:detected')).toHaveLength(2);
  });

  // ─── Generic transient-API-error class (the 2026-05-29 generalization) ───
  describe("errorClass: 'transient-api'", () => {
    const TRANSIENT_FIRST_BACKOFF = 5_000;

    it('uses the FAST first backoff (5s, not the 30s throttle schedule)', async () => {
      jsonl.write('foo.jsonl', 100);
      sentinel.report('s1', 'idle-error', { errorClass: 'transient-api' });
      await vi.advanceTimersByTimeAsync(TRANSIENT_FIRST_BACKOFF - 500);
      expect(resumeFn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000); // crosses 5s → re-engages (throttle would wait 30s)
      expect(resumeFn).toHaveBeenCalledTimes(1);
    });

    it('sends a transient-API-worded notice (not the throttle wording)', async () => {
      jsonl.write('foo.jsonl', 100);
      sentinel.report('s1', 'idle-error', { errorClass: 'transient-api' });
      await vi.advanceTimersByTimeAsync(0);
      expect(notifyFn.mock.calls[0][1]).toMatch(/transient API error/i);
      expect(notifyFn.mock.calls[0][1]).not.toMatch(/throttle/i);
    });

    it('rides the full lifecycle: backoff → resume → verify(jsonl growth) → recovered', async () => {
      jsonl.write('foo.jsonl', 100);
      sentinel.report('s1', 'idle-error', { errorClass: 'transient-api' });
      await vi.advanceTimersByTimeAsync(TRANSIENT_FIRST_BACKOFF + 100); // resume fires
      jsonl.write('foo.jsonl', 5000);                                  // session produced output
      await vi.advanceTimersByTimeAsync(VERIFY + 100);                 // verify window
      expect(events.some(e => e.type === 'rate-limit:recovered')).toBe(true);
      const recoveredNotice = notifyFn.mock.calls.map(c => c[1]).find((t: string) => /back online/i.test(t));
      expect(recoveredNotice).toMatch(/API error cleared/i);
    });

    it('records its errorClass + listActive reflects the short schedule', async () => {
      jsonl.write('foo.jsonl', 100);
      sentinel.report('s1', 'idle-error', { errorClass: 'transient-api' });
      await vi.advanceTimersByTimeAsync(0);
      const active = sentinel.listActive();
      expect(active[0].errorClass).toBe('transient-api');
      expect(active[0].nextBackoffMs).toBe(TRANSIENT_FIRST_BACKOFF);
    });
  });
});
