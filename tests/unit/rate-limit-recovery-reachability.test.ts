/**
 * Reachability tests for RateLimitSentinel recovery deps.
 *
 * THE BUG THIS GUARDS: rate-limit recovery (resumeFn + notifyFn) used to call
 * `getTopicForSession(name)` and silently `return` when it was null. A
 * developer's interactive Claude Code window is NOT bound to any Telegram topic,
 * so both recovery paths no-opped — detection + backoff ran, then every output
 * dropped on the floor. From the user's seat it looked exactly as if no sentinel
 * existed. v1.2.33 shipped past green tests because the only fixtures were
 * topic-bound; the non-topic-bound path was never asserted.
 *
 * These tests assert the recovery actually REACHES a destination under every
 * session condition: topic-bound, non-topic-bound (→ lifeline / internal inject),
 * and fully unreachable (→ a loud recovery-unreachable audit event, never silent).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildRateLimitRecoveryDeps,
  RATE_LIMIT_RESUME_NUDGE,
  type RateLimitRecoverySurface,
  type RecoveryReachKind,
} from '../../src/monitoring/sentinelWiring.js';

interface Recorded {
  kind: RecoveryReachKind;
  sessionName: string;
  detail: string;
  fallbackTried: string[];
}

/** A configurable fake surface that records every interaction. */
function makeSurface(overrides: Partial<RateLimitRecoverySurface> = {}) {
  const calls = {
    internalNudges: [] as Array<{ name: string; text: string }>,
    delivered: [] as Array<{ topicId: number; text: string }>,
    recorded: [] as Recorded[],
  };
  const surface: RateLimitRecoverySurface = {
    isSessionAlive: () => true,
    injectInternalNudge: (name, text) => {
      calls.internalNudges.push({ name, text });
      return true;
    },
    getTopicForSession: () => null,
    getLifelineTopicId: () => null,
    deliverNotice: async (topicId, text) => {
      calls.delivered.push({ topicId, text });
      return true;
    },
    recordRecovery: (kind, sessionName, detail, fallbackTried) => {
      calls.recorded.push({ kind, sessionName, detail, fallbackTried });
    },
    ...overrides,
  };
  return { surface, calls };
}

describe('buildRateLimitRecoveryDeps — notifyFn reachability', () => {
  it('topic-bound session → delivers the notice to the session topic', async () => {
    const { surface, calls } = makeSurface({ getTopicForSession: () => 42 });
    const { notifyFn } = buildRateLimitRecoveryDeps(surface);

    await notifyFn('sess-a', 'throttled, backing off');

    expect(calls.delivered).toEqual([{ topicId: 42, text: 'throttled, backing off' }]);
    expect(calls.recorded[0].kind).toBe('recovery-reached');
    expect(calls.recorded[0].fallbackTried).toEqual(['topic']);
  });

  it('NON-topic-bound session → falls back to the lifeline topic (the core bug)', async () => {
    const { surface, calls } = makeSurface({
      getTopicForSession: () => null, // interactive dev window — no topic
      getLifelineTopicId: () => 7,
    });
    const { notifyFn } = buildRateLimitRecoveryDeps(surface);

    await notifyFn('echo-dev', 'throttled, backing off, you are not dropped');

    // Regression: before the fix this delivered NOTHING. Now it reaches lifeline.
    expect(calls.delivered).toEqual([{ topicId: 7, text: 'throttled, backing off, you are not dropped' }]);
    expect(calls.recorded[0].kind).toBe('recovery-reached');
    expect(calls.recorded[0].fallbackTried).toEqual(['topic', 'lifeline']);
  });

  it('no topic AND no lifeline → records recovery-unreachable, never silent', async () => {
    const { surface, calls } = makeSurface({
      getTopicForSession: () => null,
      getLifelineTopicId: () => null,
    });
    const { notifyFn } = buildRateLimitRecoveryDeps(surface);

    await notifyFn('orphan-sess', 'the throttle notice');

    expect(calls.delivered).toHaveLength(0);
    expect(calls.recorded).toHaveLength(1);
    expect(calls.recorded[0].kind).toBe('recovery-unreachable');
    expect(calls.recorded[0].fallbackTried).toContain('audit');
    expect(calls.recorded[0].detail).toContain('the throttle notice');
  });

  it('lifeline delivery failure → recovery-unreachable (no throw, no silent success)', async () => {
    const { surface, calls } = makeSurface({
      getTopicForSession: () => null,
      getLifelineTopicId: () => 7,
      deliverNotice: async () => false, // Telegram down
    });
    const { notifyFn } = buildRateLimitRecoveryDeps(surface);

    await expect(notifyFn('sess', 'notice')).resolves.toBeUndefined();
    expect(calls.recorded[0].kind).toBe('recovery-unreachable');
  });

  it('deliverNotice that throws is swallowed and recorded as unreachable', async () => {
    const { surface, calls } = makeSurface({
      getTopicForSession: () => 9,
      deliverNotice: async () => {
        throw new Error('network down');
      },
    });
    const { notifyFn } = buildRateLimitRecoveryDeps(surface);

    await expect(notifyFn('sess', 'notice')).resolves.toBeUndefined();
    expect(calls.recorded[0].kind).toBe('recovery-unreachable');
  });
});

describe('buildRateLimitRecoveryDeps — resumeFn reachability', () => {
  // THE COHERENCE BUG THIS GUARDS (2026-06-05): the resume nudge used to take a
  // `[telegram:N]`-prefixed path for topic-bound sessions. That prefix is the
  // exact format of a real user message, so the agent answered the nudge ("no
  // throttle on my end") and relayed that denial back to the topic — appearing
  // to contradict the sentinel's own throttle notices. The fix: the resume
  // nudge ALWAYS uses the internal (un-prefixed) recovery channel, so it can
  // never be mistaken for a user message. There is no longer a topic-tagged
  // injection path at all.
  it('topic-bound session → internal nudge ONLY (never the user-message path)', async () => {
    const { surface, calls } = makeSurface({ getTopicForSession: () => 42 });
    const { resumeFn } = buildRateLimitRecoveryDeps(surface);

    const ok = await resumeFn('sess-a');

    expect(ok).toBe(true);
    // Even though the session IS topic-bound, the nudge goes internal — the
    // topic only shows up in the audit detail, never as a `[telegram:N]` prefix.
    expect(calls.internalNudges).toEqual([{ name: 'sess-a', text: RATE_LIMIT_RESUME_NUDGE }]);
    expect(calls.recorded[0].kind).toBe('recovery-reached');
    expect(calls.recorded[0].fallbackTried).toEqual(['internal-injection']);
    expect(calls.recorded[0].detail).toContain('topic 42');
  });

  it('resume nudge text never contains a `[telegram:` prefix (anti-impersonation)', async () => {
    const { surface, calls } = makeSurface({ getTopicForSession: () => 99 });
    const { resumeFn } = buildRateLimitRecoveryDeps(surface);

    await resumeFn('sess-x');

    // The injected text must be the bare nudge — anything wearing a user-message
    // prefix would be answered+relayed by the agent (the incoherence incident).
    expect(calls.internalNudges).toHaveLength(1);
    expect(calls.internalNudges[0].text).toBe(RATE_LIMIT_RESUME_NUDGE);
    expect(calls.internalNudges[0].text).not.toContain('[telegram:');
  });

  it('NON-topic-bound session → internal injection nudge, returns true', async () => {
    const { surface, calls } = makeSurface({ getTopicForSession: () => null });
    const { resumeFn } = buildRateLimitRecoveryDeps(surface);

    const ok = await resumeFn('echo-dev');

    // Regression: an earlier bug returned false WITHOUT injecting anything for
    // non-topic-bound sessions, so the sentinel escalated as "resumeFn declined"
    // and the session never woke. Now every session reaches the internal channel.
    expect(ok).toBe(true);
    expect(calls.internalNudges).toEqual([{ name: 'echo-dev', text: RATE_LIMIT_RESUME_NUDGE }]);
    expect(calls.recorded[0].kind).toBe('recovery-reached');
    expect(calls.recorded[0].fallbackTried).toEqual(['internal-injection']);
  });

  it('dead session → returns false (no nudge, no record)', async () => {
    const { surface, calls } = makeSurface({ isSessionAlive: () => false });
    const { resumeFn } = buildRateLimitRecoveryDeps(surface);

    expect(await resumeFn('dead')).toBe(false);
    expect(calls.internalNudges).toHaveLength(0);
  });

  it('internal injection that fails → recovery-unreachable', async () => {
    const { surface, calls } = makeSurface({
      getTopicForSession: () => null,
      injectInternalNudge: () => false,
    });
    const { resumeFn } = buildRateLimitRecoveryDeps(surface);

    expect(await resumeFn('sess')).toBe(false);
    expect(calls.recorded[0].kind).toBe('recovery-unreachable');
  });
});
