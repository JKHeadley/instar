// Companion to RateLimitSentinel-recoverable-guard: the PreCompact trigger enumerates
// the whole topic→session map (which is not cleaned up on completion), so a FINISHED
// session can be reported to CompactionSentinel. Without the isSessionRecoverable guard
// it would inject a compaction-recovery prompt into a session that is simply done.
// (live incident 2026-06-24)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CompactionSentinel } from '../../src/monitoring/CompactionSentinel.js';

describe('CompactionSentinel — isSessionRecoverable guard', () => {
  let recoverFn: ReturnType<typeof vi.fn>;
  let sentinel: CompactionSentinel;

  beforeEach(() => {
    vi.useFakeTimers();
    recoverFn = vi.fn().mockResolvedValue(true);
  });
  afterEach(() => {
    sentinel?.stop?.();
    vi.useRealTimers();
  });

  function build(recoverable: ((s: string) => boolean) | undefined) {
    sentinel = new CompactionSentinel({
      recoverFn: recoverFn as any,
      projectDir: '/fake/project',
      ...(recoverable ? { isSessionRecoverable: recoverable } : {}),
    });
  }

  it('NO-OPS for a non-recoverable (finished/killed) session — no recovery injected', () => {
    build(() => false);
    sentinel.report('echo-topic-28130', 'PreCompact');
    expect(recoverFn).not.toHaveBeenCalled();
    expect(sentinel.isRecoveryActive('echo-topic-28130')).toBe(false);
  });

  it('PROCEEDS for a recoverable session — recovery starts', () => {
    build(() => true);
    sentinel.report('echo-topic-28130', 'PreCompact');
    expect(sentinel.isRecoveryActive('echo-topic-28130')).toBe(true);
  });

  it('dep ABSENT preserves prior behavior — regression lock', () => {
    build(undefined);
    sentinel.report('echo-topic-28130', 'PreCompact');
    expect(sentinel.isRecoveryActive('echo-topic-28130')).toBe(true);
  });
});
