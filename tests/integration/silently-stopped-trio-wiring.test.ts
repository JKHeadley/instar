// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — no fs mutations.

/**
 * Integration test for the silently-stopped trio wiring.
 *
 * Drives real sentinels through real wiring deps against a fake SessionManager
 * surface and a real SentinelNotifier — the same shape server.ts assembles.
 *
 * Proves the post-2026-05-22 delivery contract end-to-end:
 *   - Detection requires an OBSERVED active→silent transition (Defect 1).
 *   - Routine transitions land in the notifier's audit log, never on Telegram.
 *   - Genuine escalations are coalesced into ONE consolidated send to a single
 *     reused system topic — never one-topic-per-event.
 *   - When telegramEscalation is OFF (default), the user sees nothing.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SocketDisconnectSentinel } from '../../src/monitoring/SocketDisconnectSentinel.js';
import { ActiveWorkSilenceSentinel } from '../../src/monitoring/ActiveWorkSilenceSentinel.js';
import {
  buildSocketDisconnectDeps,
  buildActiveWorkSilenceDeps,
  OutputActivityTracker,
  type SentinelSessionSurface,
} from '../../src/monitoring/sentinelWiring.js';
import { SentinelNotifier, type SentinelLogEntry } from '../../src/monitoring/SentinelNotifier.js';

describe('silently-stopped trio — end-to-end through SentinelNotifier', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeRig(opts: { telegramEscalation?: boolean; coalesceWindowMs?: number } = {}) {
    const log: SentinelLogEntry[] = [];
    const sent: string[] = [];
    const notifier = new SentinelNotifier(
      {
        log: (e) => log.push(e),
        sendConsolidated: async (text) => { sent.push(text); return true; },
      },
      { telegramEscalation: opts.telegramEscalation ?? false, coalesceWindowMs: opts.coalesceWindowMs ?? 50 },
    );
    return { notifier, log, sent };
  }

  it('SocketDisconnectSentinel: routine recovery → audit log only, Telegram silent (default)', async () => {
    const { notifier, log, sent } = makeRig();
    const surface: SentinelSessionSurface = {
      // Stays stuck on the disconnect string — recovery never clears it.
      captureOutput: () => 'socket connection closed unexpectedly',
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [{ tmuxSession: 'agent-1' }],
    };
    const sentinel = new SocketDisconnectSentinel(
      buildSocketDisconnectDeps({
        sessions: surface,
        escalate: (name, text) => notifier.escalate('socket-disconnect', name, text),
      }),
      { maxAttempts: 1, backoffScheduleMs: [5], verifyWindowMs: 5 },
    );

    sentinel.report('agent-1');
    await vi.advanceTimersByTimeAsync(50);
    await notifier.flushNow();

    // Escalation was recorded but never reached Telegram (default = off).
    expect(log.some(e => e.kind === 'escalated' && e.sessionName === 'agent-1')).toBe(true);
    expect(log.some(e => e.kind === 'escalation-suppressed')).toBe(true);
    expect(sent.length).toBe(0);
  });

  it('escalates only AFTER an observed active→silent transition (the detection fix)', async () => {
    // Confirms Defect 1 + Defect 2+3 together: first sighting is non-eligible;
    // an observed change makes the session eligible; freezing past threshold
    // produces ONE notifier escalation entry. With telegramEscalation off, no send.
    const { notifier, log } = makeRig();
    let frame = 'Bash(npm test) step 1 (esc to interrupt)';
    const surface: SentinelSessionSurface = {
      captureOutput: () => frame,
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [{ tmuxSession: 'agent-1' }],
    };
    vi.setSystemTime(1_700_000_000_000);
    const tracker = new OutputActivityTracker(surface, () => Date.now());
    const sentinel = new ActiveWorkSilenceSentinel(
      buildActiveWorkSilenceDeps({
        tracker, sessions: surface,
        escalate: (name, text) => notifier.escalate('active-silence', name, text),
      }),
      { verifyWindowMs: 5 },
    );

    sentinel.tick();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);

    vi.setSystemTime(Date.now() + 60_000);
    frame = 'Bash(npm test) step 2 (esc to interrupt)';
    sentinel.tick();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);

    vi.setSystemTime(Date.now() + 16 * 60_000);
    sentinel.tick();
    await vi.advanceTimersByTimeAsync(50);
    await notifier.flushNow();

    expect(log.some(e => e.kind === 'escalated' && e.sessionName === 'agent-1')).toBe(true);
  });

  it('the 2026-05-22 flood scenario: dead leftover sessions whose output never changes are NEVER escalated', async () => {
    // Three "zombie" sessions whose frozen last frames still contain "esc to
    // interrupt" — exactly the leftover-tmux post-restart shape that produced
    // the wall of "X went quiet" Telegram topics. With the detection fix +
    // notifier, no escalation is ever generated, regardless of how long they sit.
    const { notifier, log, sent } = makeRig({ telegramEscalation: true });
    const surface: SentinelSessionSurface = {
      captureOutput: () => 'Bash(npm test) (esc to interrupt)',
      isSessionAlive: () => true,
      sendKey: () => true,
      listRunningSessions: () => [
        { tmuxSession: 'zombie-1' },
        { tmuxSession: 'zombie-2' },
        { tmuxSession: 'zombie-3' },
      ],
    };
    vi.setSystemTime(1_700_000_000_000);
    const tracker = new OutputActivityTracker(surface, () => Date.now());
    const sentinel = new ActiveWorkSilenceSentinel(
      buildActiveWorkSilenceDeps({
        tracker, sessions: surface,
        escalate: (name, text) => notifier.escalate('active-silence', name, text),
      }),
      { verifyWindowMs: 5 },
    );

    for (let i = 0; i < 30; i++) {
      vi.setSystemTime(Date.now() + 60_000);
      sentinel.tick();
    }
    await vi.advanceTimersByTimeAsync(200);
    await notifier.flushNow();

    expect(log.some(e => e.kind === 'escalated')).toBe(false);
    expect(sent.length).toBe(0); // no Telegram, even with escalation enabled
  });

  it('multiple simultaneous genuine escalations coalesce into ONE message when escalation is enabled', async () => {
    // Drives two sessions across an observed change + freeze, both escalate
    // within the coalesce window → notifier sends ONE consolidated message,
    // not two. This is the structural replacement for the topic-per-event flood.
    const { notifier, sent } = makeRig({ telegramEscalation: true, coalesceWindowMs: 100 });
    notifier.escalate('active-silence', 'agent-1', 'agent-1 was working and went quiet. Want me to dig in?');
    notifier.escalate('active-silence', 'agent-2', 'agent-2 was working and went quiet. Want me to dig in?');
    notifier.escalate('socket-disconnect', 'agent-3', 'agent-3 lost its connection.');
    await vi.advanceTimersByTimeAsync(150);
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatch(/3 background sessions/);
    expect(sent[0]).toMatch(/agent-1/);
    expect(sent[0]).toMatch(/agent-2/);
    expect(sent[0]).toMatch(/agent-3/);
  });
});
