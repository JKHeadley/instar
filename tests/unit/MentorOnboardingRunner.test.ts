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
});
