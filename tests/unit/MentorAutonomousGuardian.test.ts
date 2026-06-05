/**
 * Tier-1 unit tests for MentorAutonomousGuardian — the pure "just be Echo"
 * autonomous-fix loop core (MENTOR-AUTONOMOUS-FIX-LOOP-SPEC).
 *
 * The guardian's job is the gate sequence (enabled → budget → single-instance →
 * min-interval → spawn); every side-effect is injected, so this exercises BOTH
 * sides of every decision boundary with no SessionManager/tmux/LLM. Plus
 * buildAutoloopGoal's deterministic prompt assembly.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runAutonomousGuardian,
  buildAutoloopGoal,
  type AutonomousGuardianDeps,
} from '../../src/scheduler/MentorAutonomousGuardian.js';

function deps(over: Partial<AutonomousGuardianDeps> = {}): AutonomousGuardianDeps {
  return {
    framework: 'codex-cli',
    enabled: true,
    budgetOk: true,
    loopSessionAlive: false,
    minIntervalElapsed: true,
    model: 'opus',
    buildGoal: () => 'GOAL',
    spawnLoopSession: vi.fn(async () => ({ sessionName: 'mentor-autoloop-123' })),
    ...over,
  };
}

describe('runAutonomousGuardian — gate sequence', () => {
  it('spawns one Opus loop session when all gates pass (happy path)', async () => {
    const spawn = vi.fn(async () => ({ sessionName: 'mentor-autoloop-999' }));
    const d = deps({ spawnLoopSession: spawn });
    const r = await runAutonomousGuardian(d);
    expect(r).toEqual({ ran: true, reason: 'spawned', sessionName: 'mentor-autoloop-999' });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith('GOAL', 'opus');
  });

  it('disabled → no spawn, reason=disabled (ships dark)', async () => {
    const spawn = vi.fn(async () => ({ sessionName: 'x' }));
    const r = await runAutonomousGuardian(deps({ enabled: false, spawnLoopSession: spawn }));
    expect(r).toEqual({ ran: false, reason: 'disabled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('budget depleted → no spawn, reason=budget (fail-closed BEFORE spend)', async () => {
    const spawn = vi.fn(async () => ({ sessionName: 'x' }));
    const r = await runAutonomousGuardian(deps({ budgetOk: false, spawnLoopSession: spawn }));
    expect(r).toEqual({ ran: false, reason: 'budget' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a loop session already alive → no spawn, reason=loop-active (single-instance)', async () => {
    const spawn = vi.fn(async () => ({ sessionName: 'x' }));
    const r = await runAutonomousGuardian(deps({ loopSessionAlive: true, spawnLoopSession: spawn }));
    expect(r).toEqual({ ran: false, reason: 'loop-active' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('min-interval not elapsed → no spawn, reason=unsafe-interval (anti spawn-storm)', async () => {
    const spawn = vi.fn(async () => ({ sessionName: 'x' }));
    const r = await runAutonomousGuardian(deps({ minIntervalElapsed: false, spawnLoopSession: spawn }));
    expect(r).toEqual({ ran: false, reason: 'unsafe-interval' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawn throws → reason=spawn-failed with the surfaced error (not a silent no-op)', async () => {
    const spawn = vi.fn(async () => {
      throw new Error('session cap reached');
    });
    const r = await runAutonomousGuardian(deps({ spawnLoopSession: spawn }));
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('spawn-failed');
    expect(r.error).toContain('session cap reached');
  });

  it('gate order is load-bearing: budget is checked before single-instance', async () => {
    // Both budget-depleted AND a loop alive: budget must win (it is earlier).
    const r = await runAutonomousGuardian(deps({ budgetOk: false, loopSessionAlive: true }));
    expect(r.reason).toBe('budget');
  });

  it('single-instance is checked before min-interval', async () => {
    // Both a loop alive AND interval not elapsed: loop-active must win (earlier).
    const r = await runAutonomousGuardian(deps({ loopSessionAlive: true, minIntervalElapsed: false }));
    expect(r.reason).toBe('loop-active');
  });

  it('disabled wins over every other failing gate', async () => {
    const r = await runAutonomousGuardian(
      deps({ enabled: false, budgetOk: false, loopSessionAlive: true, minIntervalElapsed: false }),
    );
    expect(r.reason).toBe('disabled');
  });

  it('passes the configured model through to the spawn (not hard-coded)', async () => {
    const spawn = vi.fn(async () => ({ sessionName: 'm' }));
    await runAutonomousGuardian(deps({ model: 'sonnet', spawnLoopSession: spawn }));
    expect(spawn).toHaveBeenCalledWith('GOAL', 'sonnet');
  });
});

describe('buildAutoloopGoal — deterministic prompt assembly', () => {
  it('encodes the full cycle: health → assign → observe → fix-as-PR → report', () => {
    const goal = buildAutoloopGoal({
      menteeAgentName: 'instar-codey',
      menteeFramework: 'codex-cli',
      reportTopicId: 13435,
      menteeTopicId: 458,
    });
    expect(goal).toContain('instar-codey');
    expect(goal).toContain('codex-cli');
    expect(goal).toMatch(/HEALTH FIRST/);
    expect(goal).toMatch(/ASSIGN/);
    expect(goal).toMatch(/OBSERVE BOTH SIDES/);
    expect(goal).toMatch(/FIX/);
    expect(goal).toContain('topic 13435'); // report topic
    expect(goal).toContain('topic 458'); // drive topic
    // The ship discipline + anti-confabulation must be in the prompt.
    expect(goal).toMatch(/JKHeadley\/main/);
    expect(goal).toMatch(/verify before you claim/i);
    expect(goal).toMatch(/one cycle, then exit/i);
    // Gate compliance (earned: #792's no-silent-fallbacks ratchet failure — the
    // spec's "best-effort, never throws" guidance invited a swallowed catch).
    expect(goal).toMatch(/@silent-fallback-ok/);
    expect(goal).toMatch(/never bump a ratchet baseline/i);
    expect(goal).toMatch(/DegradationReporter/);
    // Parallel-claim discipline (earned 2026-06-05: two sessions built the same
    // incident fix twice — #802 vs the keychain spec, #810 vs #808) + the
    // ELI16-in-PR-body required gate (also 2026-06-05, hit live on #813).
    expect(goal).toMatch(/dev:claim-check/);
    expect(goal).toMatch(/## ELI16/);
  });

  it('degrades gracefully when topics are unset (no "topic undefined" text)', () => {
    const goal = buildAutoloopGoal({ menteeAgentName: 'instar-codey', menteeFramework: 'codex-cli' });
    expect(goal).not.toContain('undefined');
    expect(goal).toMatch(/over Telegram/);
  });
});
