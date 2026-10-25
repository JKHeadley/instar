/**
 * The injection-verification ladder must be scoped to ONE incarnation.
 *
 * Observed on the Studio, 2026-10-22 (02:25, 02:35, 02:50 and 03:25 UTC): the
 * `health-check` job logged `Injection stuck … Auto-recovering (attempt 1/5)`,
 * then `claudeSessionId rotated … (respawn/resume)`, and then this ladder's
 * verify-only pass reported `The message is NOT delivered` and filed a
 * DegradationReporter entry — while the respawned session went on to run the
 * job, print its completion sentinel and be reaped as a success.
 *
 * The cause is that the ladder keys on a TEXT marker at a tmux NAME, and both
 * survive a respawn: the re-injected prompt renders the same marker at the same
 * prompt in a brand-new pane, so the remaining rungs judge a one-second-old
 * injection against a nine-second deadline. The fix anchors the ladder on the
 * session's native conversation id — a rotation means this pane is a different
 * attempt, which runs its own ladder.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let sendKeysCalls: Array<string[]> = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: string[]) => {
      if (cmd === '/bin/sleep') return Buffer.from('');
      if (args && args[0] === 'send-keys') sendKeysCalls.push([...args]);
      return Buffer.from('');
    }),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';

const MARKER = '[NOTIFICATION PROTOCOL: This job runs in quiet mode.';
const STUCK_PANE = `❯ ${MARKER}\n  ⏵⏵ bypass permissions on\n`;

/** A manager whose session record reports whatever `idFn` returns right now. */
function buildManager(idFn: () => string | null | undefined) {
  const mgr: any = Object.create(SessionManager.prototype);
  mgr.config = { tmuxPath: '/usr/local/bin/tmux' };
  mgr.state = {
    listSessions: () => {
      const claudeSessionId = idFn();
      return [{ tmuxSession: 'echo-job-health-check-xyz', claudeSessionId }];
    },
    saveSession: () => {},
  };
  mgr.idlePromptSince = new Map();
  mgr.captureOutput = vi.fn(() => STUCK_PANE);
  mgr.tmuxSessionExists = vi.fn(() => true);
  mgr.stageBActivation = { active: false };
  mgr.strandedDraftMarkers = new Map();
  return mgr;
}

function recoveryKeypresses(): number {
  return sendKeysCalls.filter((c) => c.includes('Enter') || c.includes('C-m')).length;
}

describe('verifyInjection — incarnation scoping', () => {
  beforeEach(() => {
    sendKeysCalls = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('abandons the ladder when the native session id rotates mid-ladder', async () => {
    let id = 'conv-before-respawn';
    const mgr = buildManager(() => id);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    mgr.verifyInjection('echo-job-health-check-xyz', MARKER);

    // Attempt 0 fires at 500ms against the original incarnation.
    await vi.advanceTimersByTimeAsync(600);
    expect(recoveryKeypresses()).toBe(1);

    // The recovery rung respawned the session: a NEW conversation id, and the
    // re-injected prompt is sitting at the prompt again (pane unchanged).
    id = 'conv-after-respawn';
    await vi.advanceTimersByTimeAsync(20_000);

    // No further rung fires, so no false "NOT delivered" verdict can be reached.
    expect(recoveryKeypresses()).toBe(1);
    expect(log.mock.calls.some(([line]) => typeof line === 'string'
      && line.includes('abandoned at attempt')
      && line.includes('respawned'))).toBe(true);
  });

  it('runs the full ladder when the incarnation is stable', async () => {
    const mgr = buildManager(() => 'conv-stable');
    mgr.verifyInjection('echo-job-health-check-xyz', MARKER);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(recoveryKeypresses()).toBeGreaterThanOrEqual(4);
  });

  it('runs the full ladder when no native id is known on either side', async () => {
    // The pre-fix behaviour for any session whose id is unbound: unchanged.
    const mgr = buildManager(() => null);
    mgr.verifyInjection('echo-job-health-check-xyz', MARKER);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(recoveryKeypresses()).toBeGreaterThanOrEqual(4);
  });

  it('treats a first binding (null → id) as the same attempt, not a respawn', async () => {
    // A session can be injected into before its native id is bound; that
    // transition is NOT a respawn and must not abandon the ladder.
    let id: string | null = null;
    const mgr = buildManager(() => id);
    mgr.verifyInjection('echo-job-health-check-xyz', MARKER);
    await vi.advanceTimersByTimeAsync(600);
    id = 'conv-bound-late';
    await vi.advanceTimersByTimeAsync(20_000);
    expect(recoveryKeypresses()).toBeGreaterThanOrEqual(4);
  });

  it('a state read failure never produces an abandon verdict', async () => {
    // The incarnation lookup must fail toward "same attempt" — an unreadable
    // state file is not evidence of a respawn. (A throwing state manager also
    // stops the recovery rungs for reasons unrelated to this guard, so this
    // test asserts only that no abandon verdict is reached.)
    const mgr = buildManager(() => 'conv-stable');
    mgr.state.listSessions = () => { throw new Error('state unreadable'); };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    mgr.verifyInjection('echo-job-health-check-xyz', MARKER);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(log.mock.calls.some(([line]) => typeof line === 'string'
      && line.includes('abandoned at attempt'))).toBe(false);
  });
});
