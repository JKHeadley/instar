/**
 * Tier-1 unit tests for MentorOnboardingRunner — the thin glue around the pure
 * tick core (FRAMEWORK-ONBOARDING-MENTOR-SPEC §19.4). Verifies the off-by-default
 * short-circuit and correct service wiring with fakes (no tmux/LLM/server).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MentorOnboardingRunner,
  DEFAULT_MENTOR_CONFIG,
  resolveMentorDeliveryTopic,
  type MentorConfig,
  type MentorRunnerServices,
} from '../../src/scheduler/MentorOnboardingRunner.js';

describe('resolveMentorDeliveryTopic — mentor a2a topic routing (Codey-dogfooding P3)', () => {
  it('prefers the dedicated mentorTopicId when set (keeps mentor a2a off the human topic)', () => {
    expect(resolveMentorDeliveryTopic({ mentorTopicId: 77, menteeTopicId: 458 })).toBe(77);
  });
  it('falls back to menteeTopicId when mentorTopicId is unset (backward-compatible)', () => {
    expect(resolveMentorDeliveryTopic({ menteeTopicId: 458 })).toBe(458);
    expect(resolveMentorDeliveryTopic({ mentorTopicId: undefined, menteeTopicId: 458 })).toBe(458);
  });
  it('returns undefined when neither is configured (mentor wiring stays dark)', () => {
    expect(resolveMentorDeliveryTopic({})).toBeUndefined();
  });
  it('treats mentorTopicId 0 as a real topic (nullish, not falsy)', () => {
    // Topic 0 ("General") is a valid forum topic — must not fall through to menteeTopicId.
    expect(resolveMentorDeliveryTopic({ mentorTopicId: 0, menteeTopicId: 458 })).toBe(0);
  });
});

function fakeServices(over: Partial<MentorRunnerServices> = {}): MentorRunnerServices {
  return {
    capture: vi.fn(() => ({ runId: 'r', framework: 'codex-cli', findingsCount: 0, observationsWritten: 0, newIssues: 0, regressionCandidates: [] })),
    spawnStageA: vi.fn(async () => 'clean conversational reply'),
    runStageBForensics: vi.fn(async () => []),
    isMenteeBusy: vi.fn(() => false),
    minIntervalElapsed: vi.fn(() => true),
    budgetOk: vi.fn(() => true),
    getSurface: vi.fn((framework: string) => ({ framework, threadlineHistory: 'hi' })),
    ...over,
  };
}

describe('MentorOnboardingRunner', () => {
  it('ships dormant: disabled config short-circuits to reason=disabled (no work)', async () => {
    const svc = fakeServices();
    const runner = new MentorOnboardingRunner(svc, () => ({ ...DEFAULT_MENTOR_CONFIG }));
    const r = await runner.tick();
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('disabled');
    expect(svc.spawnStageA).not.toHaveBeenCalled();
    expect(svc.budgetOk).not.toHaveBeenCalled();
  });

  it('mode "off" also short-circuits even if enabled flag flips', async () => {
    const svc = fakeServices();
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'off' };
    const runner = new MentorOnboardingRunner(svc, () => cfg);
    expect((await runner.tick()).reason).toBe('disabled');
  });

  it('when enabled + safe + in budget, runs a full tick and captures', async () => {
    const svc = fakeServices();
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'dry-run' };
    const runner = new MentorOnboardingRunner(svc, () => cfg);
    const r = await runner.tick();
    expect(r.ran).toBe(true);
    expect(r.mode).toBe('dry-run');
    expect(svc.spawnStageA).toHaveBeenCalled();
    expect(svc.capture).toHaveBeenCalled();
  });

  it('treats a busy mentee as an unsafe window (skips)', async () => {
    const svc = fakeServices({ isMenteeBusy: () => true });
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'live' };
    const r = await new MentorOnboardingRunner(svc, () => cfg).tick();
    expect(r.reason).toBe('unsafe-window');
    expect(svc.spawnStageA).not.toHaveBeenCalled();
  });

  it('treats not-yet-elapsed min-interval as unsafe (anti-forced-cadence)', async () => {
    const svc = fakeServices({ minIntervalElapsed: () => false });
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'live' };
    const r = await new MentorOnboardingRunner(svc, () => cfg).tick();
    expect(r.reason).toBe('unsafe-window');
  });

  it('status() reflects config + async state', () => {
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'live', menteeFramework: 'cursor' };
    const runner = new MentorOnboardingRunner(fakeServices(), () => cfg);
    expect(runner.status()).toMatchObject({ enabled: true, mode: 'live', menteeFramework: 'cursor', inFlight: false, lastResult: null });
  });

  it('startTick is fire-and-forget: 202-accepted when enabled, result lands in status().lastResult', async () => {
    const svc = fakeServices();
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'dry-run' };
    const runner = new MentorOnboardingRunner(svc, () => cfg);
    const r = runner.startTick();
    expect(r.accepted).toBe(true);
    // Let the async tick settle.
    await new Promise((res) => setTimeout(res, 10));
    expect(svc.spawnStageA).toHaveBeenCalled();
    expect(runner.status().lastResult?.ran).toBe(true);
    expect(runner.status().inFlight).toBe(false);
  });

  it('startTick short-circuits to disabled synchronously when off (no work)', () => {
    const svc = fakeServices();
    const runner = new MentorOnboardingRunner(svc, () => ({ ...DEFAULT_MENTOR_CONFIG }));
    const r = runner.startTick();
    expect(r).toEqual({ accepted: false, reason: 'disabled' });
    expect(svc.spawnStageA).not.toHaveBeenCalled();
    expect(runner.status().lastResult?.reason).toBe('disabled');
  });

  it('surfaces the real Stage-A error into lastResult.error (not just an opaque stage-a-failed)', async () => {
    const svc = fakeServices({
      spawnStageA: vi.fn(async () => {
        throw new Error('spawn refused: session cap reached');
      }),
    });
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'dry-run' };
    const runner = new MentorOnboardingRunner(svc, () => cfg);
    runner.startTick();
    await new Promise((res) => setTimeout(res, 10));
    const lr = runner.status().lastResult;
    expect(lr?.ran).toBe(false);
    expect(lr?.reason).toBe('stage-a-failed');
    // The real cause is now visible via GET /mentor/status.lastResult.error,
    // instead of being swallowed by the bare catch in runMentorTick.
    expect(lr?.error).toContain('spawn refused: session cap reached');
  });
});

describe('MentorOnboardingRunner — autonomous-fix guardian branch ("just be Echo")', () => {
  function autoCfg(over: Partial<MentorConfig> = {}): MentorConfig {
    return {
      ...DEFAULT_MENTOR_CONFIG,
      enabled: true,
      mode: 'off', // the guardian must run REGARDLESS of mode
      autonomousFix: { enabled: true, model: 'opus', sessionNamePrefix: 'mentor-autoloop' },
      ...over,
    };
  }

  it('routes to the guardian (NOT the observe-pipeline) when autonomousFix.enabled, even with mode:off', async () => {
    const spawnStageA = vi.fn(async () => 'should-not-be-called');
    const spawnLoopSession = vi.fn(async () => ({ sessionName: 'mentor-autoloop-1' }));
    const svc = fakeServices({
      spawnStageA,
      loopSessionAlive: () => false,
      spawnLoopSession,
      buildAutoloopGoal: () => 'GOAL',
    });
    const runner = new MentorOnboardingRunner(svc, () => autoCfg());
    const r = await runner.tick();
    expect(r.reason).toBe('spawned');
    expect(r.ran).toBe(true);
    expect(r.sessionName).toBe('mentor-autoloop-1');
    // The observe-pipeline's Stage-A compose must NEVER run on the guardian path.
    expect(spawnStageA).not.toHaveBeenCalled();
    expect(spawnLoopSession).toHaveBeenCalledOnce();
  });

  it('single-instance: a live loop session short-circuits to loop-active (no second spawn)', async () => {
    const spawnLoopSession = vi.fn(async () => ({ sessionName: 'x' }));
    const svc = fakeServices({
      loopSessionAlive: () => true,
      spawnLoopSession,
      buildAutoloopGoal: () => 'GOAL',
    });
    const runner = new MentorOnboardingRunner(svc, () => autoCfg());
    const r = await runner.tick();
    expect(r.reason).toBe('loop-active');
    expect(spawnLoopSession).not.toHaveBeenCalled();
  });

  it('a spawned cycle advances the run counters (onTickRan) once', async () => {
    const onTickRan = vi.fn();
    const svc = fakeServices({
      loopSessionAlive: () => false,
      spawnLoopSession: async () => ({ sessionName: 'mentor-autoloop-2' }),
      buildAutoloopGoal: () => 'GOAL',
      onTickRan,
    });
    const runner = new MentorOnboardingRunner(svc, () => autoCfg());
    await runner.tick();
    expect(onTickRan).toHaveBeenCalledOnce();
  });

  it('a skipped cycle (loop-active) does NOT advance the run counters', async () => {
    const onTickRan = vi.fn();
    const svc = fakeServices({
      loopSessionAlive: () => true,
      spawnLoopSession: async () => ({ sessionName: 'x' }),
      buildAutoloopGoal: () => 'GOAL',
      onTickRan,
    });
    const runner = new MentorOnboardingRunner(svc, () => autoCfg());
    await runner.tick();
    expect(onTickRan).not.toHaveBeenCalled();
  });

  it('autonomousFix.enabled but spawnLoopSession not wired → clear spawn-failed (not a silent no-op)', async () => {
    // Host enabled the feature but forgot to inject the spawner: must surface.
    const svc = fakeServices({ loopSessionAlive: () => false, buildAutoloopGoal: () => 'GOAL' });
    const runner = new MentorOnboardingRunner(svc, () => autoCfg());
    const r = await runner.tick();
    expect(r.reason).toBe('spawn-failed');
    expect(r.error).toMatch(/spawnLoopSession not wired/);
  });

  it('still ships dark: autonomousFix present but enabled:false runs the observe-pipeline, not the guardian', async () => {
    const spawnLoopSession = vi.fn(async () => ({ sessionName: 'x' }));
    const svc = fakeServices({ spawnLoopSession, loopSessionAlive: () => false });
    const cfg = autoCfg({ mode: 'dry-run', autonomousFix: { enabled: false, model: 'opus' } });
    const runner = new MentorOnboardingRunner(svc, () => cfg);
    const r = await runner.tick();
    expect(r.reason).not.toBe('spawned');
    expect(spawnLoopSession).not.toHaveBeenCalled();
    expect(svc.spawnStageA).toHaveBeenCalled(); // observe-pipeline ran instead
  });

  it('mentor.enabled:false keeps the guardian dark even with autonomousFix.enabled', async () => {
    const spawnLoopSession = vi.fn(async () => ({ sessionName: 'x' }));
    const svc = fakeServices({ spawnLoopSession, loopSessionAlive: () => false });
    const cfg = autoCfg({ enabled: false });
    const runner = new MentorOnboardingRunner(svc, () => cfg);
    const r = await runner.tick();
    expect(r.reason).toBe('disabled');
    expect(spawnLoopSession).not.toHaveBeenCalled();
  });
});
