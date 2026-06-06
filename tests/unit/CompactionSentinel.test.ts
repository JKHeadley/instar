// Unit tests for CompactionSentinel — verifies the full detect/inject/verify/
// retry lifecycle, dedupe behavior, and isRecoveryActive predicate used by the
// zombie-killer veto.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionSentinel } from '../../src/monitoring/CompactionSentinel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeTempJsonlRoot(): { root: string; write: (name: string, bytes: number) => void; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
  return {
    root,
    write: (name, bytes) => {
      fs.writeFileSync(path.join(root, name), 'x'.repeat(bytes));
    },
    cleanup: () => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/CompactionSentinel.test.ts:19' }),
  };
}

describe('CompactionSentinel', () => {
  let jsonl: ReturnType<typeof makeTempJsonlRoot>;
  let recoverFn: ReturnType<typeof vi.fn>;
  let sentinel: CompactionSentinel;
  let events: Array<{ type: string; payload: any }>;

  beforeEach(() => {
    vi.useFakeTimers();
    jsonl = makeTempJsonlRoot();
    recoverFn = vi.fn().mockResolvedValue(true);
    sentinel = new CompactionSentinel(
      {
        recoverFn: recoverFn as any,
        projectDir: '/fake/project',
        jsonlRoot: jsonl.root,
      },
      {
        dedupeWindowMs: 60_000,
        verifyWindowMs: 25_000,
        maxInjectAttempts: 3,
        recoveryGuardMs: 10 * 60_000,
      },
    );
    events = [];
    for (const e of ['compaction:detected', 'compaction:inject-attempted', 'compaction:recovered', 'compaction:failed']) {
      sentinel.on(e as any, (p: any) => events.push({ type: e, payload: p }));
    }
  });

  afterEach(() => {
    sentinel.stop();
    jsonl.cleanup();
    vi.useRealTimers();
  });

  // ─── Detection / dedupe ───

  it('emits compaction:detected on first report and calls recoverFn', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    // Allow the async recoverFn to resolve.
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some(e => e.type === 'compaction:detected')).toBe(true);
    expect(recoverFn).toHaveBeenCalledTimes(1);
    expect(recoverFn).toHaveBeenCalledWith('s1', 'watchdog-poll');
  });

  it('dedupes reports within the dedupe window', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'PreCompact');
    await vi.advanceTimersByTimeAsync(0);
    sentinel.report('s1', 'watchdog-poll'); // should be no-op — already active
    sentinel.report('s1', 'recovery-hook'); // also no-op
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('separate sessions recover independently', async () => {
    jsonl.write('a.jsonl', 100);
    sentinel.report('session-a', 'watchdog-poll');
    sentinel.report('session-b', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).toHaveBeenCalledWith('session-a', 'watchdog-poll');
    expect(recoverFn).toHaveBeenCalledWith('session-b', 'watchdog-poll');
  });

  // ─── Verification success path ───

  it('emits compaction:recovered when jsonl grows within the verify window', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    // Let recoverFn resolve
    await vi.advanceTimersByTimeAsync(0);
    // Simulate claude writing to jsonl
    jsonl.write('foo.jsonl', 500);
    // Advance past verify window
    await vi.advanceTimersByTimeAsync(25_500);
    const recovered = events.find(e => e.type === 'compaction:recovered');
    expect(recovered).toBeDefined();
    expect(recovered!.payload.jsonlDelta).toBeGreaterThan(0);
    expect(recovered!.payload.attempts).toBe(1);
  });

  // ─── Retry path ───

  it('retries when jsonl does not grow, up to maxInjectAttempts', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);

    // First verify window passes with no growth → retry
    await vi.advanceTimersByTimeAsync(25_500);
    expect(recoverFn).toHaveBeenCalledTimes(2);
    // Second verify window → retry again
    await vi.advanceTimersByTimeAsync(25_500);
    expect(recoverFn).toHaveBeenCalledTimes(3);
    // Third → exhausted → failed
    await vi.advanceTimersByTimeAsync(25_500);
    const failed = events.find(e => e.type === 'compaction:failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.attempts).toBe(3);
  });

  it('stops retrying as soon as jsonl grows (recovers on attempt 2)', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25_500); // first verify fails → retry
    expect(recoverFn).toHaveBeenCalledTimes(2);

    jsonl.write('foo.jsonl', 400);
    await vi.advanceTimersByTimeAsync(25_500); // second verify succeeds
    const recovered = events.find(e => e.type === 'compaction:recovered');
    expect(recovered).toBeDefined();
    expect(recovered!.payload.attempts).toBe(2);
    expect(recoverFn).toHaveBeenCalledTimes(2);
  });

  // ─── Zombie veto ───

  it('isRecoveryActive returns true during recovery and false after success', async () => {
    jsonl.write('foo.jsonl', 100);
    expect(sentinel.isRecoveryActive('s1')).toBe(false);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentinel.isRecoveryActive('s1')).toBe(true); // verifying

    jsonl.write('foo.jsonl', 500);
    await vi.advanceTimersByTimeAsync(25_500);
    // Recovered — but we still veto briefly before cleanup. Check both paths:
    // during the 5s post-recovery keep-window, state.status = 'recovered'
    // → isRecoveryActive should be FALSE (don't claim active in terminal state).
    expect(sentinel.isRecoveryActive('s1')).toBe(false);

    // After the keep-window, state is gone.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(sentinel.isRecoveryActive('s1')).toBe(false);
    expect(sentinel.getState('s1')).toBeUndefined();
  });

  it('isRecoveryActive returns false for never-seen sessions', () => {
    expect(sentinel.isRecoveryActive('never-reported')).toBe(false);
  });

  // ─── recoverFn failure ───

  it('finalizes as failed when recoverFn returns false', async () => {
    recoverFn.mockResolvedValue(false);
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    const failed = events.find(e => e.type === 'compaction:failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.reason).toMatch(/declined/);
    // Should NOT retry when recoverFn declines — different from verify failure
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('treats recoverFn throwing as acceptance=false and finalizes', async () => {
    recoverFn.mockRejectedValue(new Error('kaboom'));
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    const failed = events.find(e => e.type === 'compaction:failed');
    expect(failed).toBeDefined();
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  // ─── Jsonl baseline edge cases ───

  it('handles the no-jsonl case without crashing', async () => {
    // No jsonl file written at all
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    // Should still dispatch inject
    expect(recoverFn).toHaveBeenCalledTimes(1);
    // verify window: no baseline means grew=false → retry
    await vi.advanceTimersByTimeAsync(25_500);
    expect(recoverFn).toHaveBeenCalledTimes(2);
  });

  it('uses claudeSessionId to target the exact jsonl when available', async () => {
    // Two sibling jsonl files exist. The session under test has uuid "abc-123".
    // Only abc-123.jsonl should be watched — a sibling growing must NOT cause
    // false "recovered" emission.
    jsonl.write('abc-123.jsonl', 100);
    jsonl.write('sibling-session.jsonl', 100);

    // Recreate sentinel with a uuid resolver.
    sentinel.stop();
    sentinel = new CompactionSentinel(
      {
        recoverFn: recoverFn as any,
        projectDir: '/fake/project',
        jsonlRoot: jsonl.root,
        getClaudeSessionId: (name: string) => (name === 's1' ? 'abc-123' : undefined),
      },
      { dedupeWindowMs: 60_000, verifyWindowMs: 25_000, maxInjectAttempts: 3, recoveryGuardMs: 10 * 60_000 },
    );
    events = [];
    for (const e of ['compaction:detected', 'compaction:inject-attempted', 'compaction:recovered', 'compaction:failed']) {
      sentinel.on(e as any, (p: any) => events.push({ type: e, payload: p }));
    }

    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);

    // Sibling grows — must NOT trigger recovered for s1.
    jsonl.write('sibling-session.jsonl', 5000);
    await vi.advanceTimersByTimeAsync(25_500);
    expect(events.find(e => e.type === 'compaction:recovered')).toBeUndefined();

    // s1's own file grows — this time it SHOULD recover.
    jsonl.write('abc-123.jsonl', 400);
    await vi.advanceTimersByTimeAsync(25_500);
    expect(events.find(e => e.type === 'compaction:recovered')).toBeDefined();
  });

  // REGRESSION (2026-06-06 incident, mirrored from RateLimitSentinel): when the
  // stored claudeSessionId has NO transcript on disk (UUID rotated on respawn/
  // --resume; the bridge record went stale), returning null made recovery
  // verification permanently unable to succeed. A stale uuid must degrade to
  // the newest-jsonl heuristic instead of guaranteeing a false failure.
  it('falls back to newest jsonl when the stored claudeSessionId transcript is missing (phantom uuid)', async () => {
    jsonl.write('live-conversation.jsonl', 100); // the REAL transcript (different uuid)

    sentinel.stop();
    sentinel = new CompactionSentinel(
      {
        recoverFn: recoverFn as any,
        projectDir: '/fake/project',
        jsonlRoot: jsonl.root,
        getClaudeSessionId: () => '563a7027-432d-4b46-9706-caf43daa1016', // no such file
      },
      { dedupeWindowMs: 60_000, verifyWindowMs: 25_000, maxInjectAttempts: 3, recoveryGuardMs: 10 * 60_000 },
    );
    events = [];
    for (const e of ['compaction:detected', 'compaction:inject-attempted', 'compaction:recovered', 'compaction:failed']) {
      sentinel.on(e as any, (p: any) => events.push({ type: e, payload: p }));
    }

    sentinel.report('echo-api-errors', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);

    // The live transcript grows — the session genuinely recovered.
    jsonl.write('live-conversation.jsonl', 900);
    await vi.advanceTimersByTimeAsync(25_500);
    expect(events.find(e => e.type === 'compaction:recovered')).toBeDefined();
    expect(events.find(e => e.type === 'compaction:failed')).toBeUndefined();
  });

  it('detects growth via mtime change on a fixed-size jsonl', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    // Simulate mtime change without size change (rare, but possible)
    const p = path.join(jsonl.root, 'foo.jsonl');
    const newTime = new Date(Date.now() + 5000);
    fs.utimesSync(p, newTime, newTime);
    await vi.advanceTimersByTimeAsync(25_500);
    const recovered = events.find(e => e.type === 'compaction:recovered');
    expect(recovered).toBeDefined();
  });

  // ─── clear / stop ───

  it('clear() removes active state', async () => {
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(sentinel.getState('s1')).toBeDefined();
    sentinel.clear('s1');
    expect(sentinel.getState('s1')).toBeUndefined();
  });

  it('allows re-recovery after a previous recovery finalizes', async () => {
    // After a successful recovery, the session should be eligible for a NEW
    // recovery even if the second compaction happens within the dedupe window.
    // Without this, a session that recovers cleanly and then compacts again
    // ~30s later would be silently suppressed and left to the zombie-killer.
    jsonl.write('foo.jsonl', 100);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    jsonl.write('foo.jsonl', 400);
    await vi.advanceTimersByTimeAsync(25_500);
    // Recovered.
    const firstRecovered = events.filter(e => e.type === 'compaction:recovered');
    expect(firstRecovered).toHaveLength(1);
    // Wait out the 5s keep-window so the active state is cleaned up.
    await vi.advanceTimersByTimeAsync(6_000);

    // Second compaction happens immediately — should NOT be suppressed.
    jsonl.write('foo.jsonl', 400);
    sentinel.report('s1', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    // A fresh detected event should fire.
    expect(events.filter(e => e.type === 'compaction:detected')).toHaveLength(2);
  });

  it('stop() cleans up all state and timers', async () => {
    jsonl.write('a.jsonl', 100);
    sentinel.report('a', 'watchdog-poll');
    sentinel.report('b', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    sentinel.stop();
    expect(sentinel.getState('a')).toBeUndefined();
    expect(sentinel.getState('b')).toBeUndefined();
  });

  // ─── Busy-session defer guard (isActivelyWorking) ───
  //
  // Root cause of the false "session is restarting" loop: a long extended-think
  // on a large context writes nothing to the JSONL until the turn lands, so the
  // no-growth check read it as "stuck" and RE-INJECTED a recovery prompt —
  // burying the user's real message under stacked bootstraps. With an
  // isActivelyWorking signal, the sentinel must DEFER (wait without injecting)
  // while the session is mid-turn, bounded by maxWorkingDefers.
  describe('busy-session defer guard', () => {
    let working: boolean;
    let j: ReturnType<typeof makeTempJsonlRoot>;
    let rec: ReturnType<typeof vi.fn>;
    let s: CompactionSentinel;
    let evs: Array<{ type: string; payload: any }>;

    function build(opts: { maxWorkingDefers?: number; withDep?: boolean } = {}): void {
      j = makeTempJsonlRoot();
      rec = vi.fn().mockResolvedValue(true);
      s = new CompactionSentinel(
        {
          recoverFn: rec as any,
          projectDir: '/fake/project',
          jsonlRoot: j.root,
          ...(opts.withDep === false ? {} : { isActivelyWorking: () => working }),
        },
        { dedupeWindowMs: 60_000, verifyWindowMs: 25_000, maxInjectAttempts: 3, maxWorkingDefers: opts.maxWorkingDefers ?? 4 },
      );
      evs = [];
      for (const e of ['compaction:detected', 'compaction:inject-attempted', 'compaction:deferred', 'compaction:recovered', 'compaction:failed']) {
        s.on(e as any, (p: any) => evs.push({ type: e, payload: p }));
      }
    }

    beforeEach(() => { working = false; });
    afterEach(() => { s?.stop(); j?.cleanup(); });

    it('defers the first inject while actively working — never calls recoverFn', async () => {
      build();
      j.write('foo.jsonl', 100);
      working = true;
      s.report('s1', 'watchdog-poll');
      await vi.advanceTimersByTimeAsync(0);
      expect(rec).not.toHaveBeenCalled();
      expect(evs.some(e => e.type === 'compaction:deferred')).toBe(true);
      expect(evs.some(e => e.type === 'compaction:inject-attempted')).toBe(false);
      expect(s.getState('s1')?.status).toBe('deferring');
      expect(s.getState('s1')?.workingDefers).toBe(1);
      // Still counts as active recovery → zombie-killer stays vetoed.
      expect(s.isRecoveryActive('s1')).toBe(true);
    });

    it('injects once the session stops working', async () => {
      build();
      j.write('foo.jsonl', 100);
      working = true;
      s.report('s1', 'watchdog-poll');
      await vi.advanceTimersByTimeAsync(0);
      expect(rec).not.toHaveBeenCalled();
      // Turn finishes — next verify window proceeds to inject.
      working = false;
      await vi.advanceTimersByTimeAsync(25_500);
      expect(rec).toHaveBeenCalledTimes(1);
    });

    it('recovers WITHOUT injecting if the session emits while we defer (jsonl grows)', async () => {
      build();
      j.write('foo.jsonl', 100);
      working = true;
      s.report('s1', 'watchdog-poll');
      await vi.advanceTimersByTimeAsync(0);
      // The deferred turn landed — claude emitted output, jsonl grows.
      j.write('foo.jsonl', 500);
      await vi.advanceTimersByTimeAsync(25_500);
      expect(rec).not.toHaveBeenCalled();
      expect(evs.some(e => e.type === 'compaction:recovered')).toBe(true);
    });

    it('caps consecutive defers at maxWorkingDefers then forces an inject', async () => {
      build({ maxWorkingDefers: 4 });
      j.write('foo.jsonl', 100);
      working = true; // hung "working" footer — never clears
      s.report('s1', 'watchdog-poll');
      await vi.advanceTimersByTimeAsync(0);
      // defer #1 at report; defers #2/#3/#4 at the next three verify windows;
      // the window after that forces an inject.
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(25_500);
      expect(evs.filter(e => e.type === 'compaction:deferred')).toHaveLength(4);
      expect(rec).toHaveBeenCalledTimes(1);
    });

    it('maxWorkingDefers=0 disables deferral (injects immediately even while working)', async () => {
      build({ maxWorkingDefers: 0 });
      j.write('foo.jsonl', 100);
      working = true;
      s.report('s1', 'watchdog-poll');
      await vi.advanceTimersByTimeAsync(0);
      expect(rec).toHaveBeenCalledTimes(1); // old behavior restored
    });

    it('with no isActivelyWorking dep, never defers (backward compatible)', async () => {
      build({ withDep: false });
      j.write('foo.jsonl', 100);
      working = true; // irrelevant — dep absent
      s.report('s1', 'watchdog-poll');
      await vi.advanceTimersByTimeAsync(0);
      expect(rec).toHaveBeenCalledTimes(1);
      expect(evs.some(e => e.type === 'compaction:deferred')).toBe(false);
    });
  });
});
