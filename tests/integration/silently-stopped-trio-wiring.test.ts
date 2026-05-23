// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — no fs mutations.

/**
 * Integration test for the silently-stopped trio wiring.
 *
 * Unit tests prove each dep delegates correctly. This test proves the whole
 * chain fires end-to-end: a REAL sentinel, driven by REAL wiring deps
 * (buildSocketDisconnectDeps / buildActiveWorkSilenceDeps), against a fake
 * SessionManager surface and a fake `/attention` endpoint that mimics the
 * tone gate (suppresses the no-CTA first notice, passes the CTA escalation).
 *
 * This is the test that would have failed loudly when PR #334 shipped the
 * sentinels unwired: with no wiring, no escalation ever reaches /attention.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SocketDisconnectSentinel } from '../../src/monitoring/SocketDisconnectSentinel.js';
import { ActiveWorkSilenceSentinel } from '../../src/monitoring/ActiveWorkSilenceSentinel.js';
import {
  makeAttentionPoster,
  buildSocketDisconnectDeps,
  buildActiveWorkSilenceDeps,
  OutputActivityTracker,
  type SentinelSessionSurface,
} from '../../src/monitoring/sentinelWiring.js';

interface Posted { url: string; body: any; }

/** A fake /attention that mimics the tone gate: a message with a yes/no CTA
 *  ("dig in") is delivered (201); a no-CTA self-healing notice is blocked (422). */
function makeToneGatedFetch(posted: Posted[]): typeof fetch {
  return (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    posted.push({ url, body });
    const hasCta = /dig in/i.test(body.summary || '');
    return { status: hasCta ? 201 : 422 };
  }) as unknown as typeof fetch;
}

describe('silently-stopped trio wiring — end to end', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('SocketDisconnectSentinel escalates through the tone-gated /attention path', async () => {
    const posted: Posted[] = [];
    const surface: SentinelSessionSurface = {
      // Output stays stuck on the disconnect string — recovery never clears it.
      captureOutput: () => 'socket connection closed unexpectedly',
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [{ tmuxSession: 'agent-1' }],
    };
    const notify = makeAttentionPoster({ port: 4040, authToken: 'tok', fetchImpl: makeToneGatedFetch(posted) });
    const sentinel = new SocketDisconnectSentinel(
      buildSocketDisconnectDeps({ sessions: surface, notify }),
      { maxAttempts: 1, backoffScheduleMs: [5], verifyWindowMs: 5 },
    );

    sentinel.report('agent-1');
    // Drive the backoff → attempt → verify → escalate cycle.
    await vi.advanceTimersByTimeAsync(50);

    const escalation = posted.find(p => p.body.id === 'socket-disconnect:agent-1' && /dig in/i.test(p.body.summary));
    expect(escalation).toBeDefined();
    expect(escalation!.url).toBe('http://localhost:4040/attention');
    expect(escalation!.body.category).toBe('degradation');
  });

  it('ActiveWorkSilenceSentinel escalates a frozen mid-task session via /attention', async () => {
    const posted: Posted[] = [];
    const surface: SentinelSessionSurface = {
      // A frozen mid-task frame: shows "esc to interrupt" (active) but never changes.
      captureOutput: () => 'Running Bash(npm test) (esc to interrupt)',
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [{ tmuxSession: 'agent-1' }],
    };
    // Tracker stamps lastOutputAt 20 min in the past so the 15-min threshold trips.
    const tracker = new OutputActivityTracker(surface, () => Date.now() - 20 * 60_000);
    const notify = makeAttentionPoster({ port: 4040, authToken: 'tok', fetchImpl: makeToneGatedFetch(posted) });
    const sentinel = new ActiveWorkSilenceSentinel(
      buildActiveWorkSilenceDeps({ tracker, sessions: surface, notify }),
      { verifyWindowMs: 5 },
    );

    sentinel.tick();
    // runNudge fires (microtask), then verify window → escalate.
    await vi.advanceTimersByTimeAsync(50);

    const escalation = posted.find(p => p.body.id === 'active-silence:agent-1' && /dig in/i.test(p.body.summary));
    expect(escalation).toBeDefined();
    expect(escalation!.body.category).toBe('degradation');
  });

  it('does NOT flag an idle-at-prompt session as silent (no false escalation)', async () => {
    const posted: Posted[] = [];
    const surface: SentinelSessionSurface = {
      // Idle prompt — not "actively working then stopped".
      captureOutput: () => '> \n  ? for shortcuts',
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [{ tmuxSession: 'agent-1' }],
    };
    const tracker = new OutputActivityTracker(surface, () => Date.now() - 20 * 60_000);
    const notify = makeAttentionPoster({ port: 4040, authToken: 'tok', fetchImpl: makeToneGatedFetch(posted) });
    const sentinel = new ActiveWorkSilenceSentinel(
      buildActiveWorkSilenceDeps({ tracker, sessions: surface, notify }),
      { verifyWindowMs: 5 },
    );

    sentinel.tick();
    await vi.advanceTimersByTimeAsync(50);

    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
    expect(posted.length).toBe(0);
  });
});
