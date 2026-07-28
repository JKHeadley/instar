/**
 * featureRollout — pure rollout-stage logic. The load-bearing safety property:
 * the stage is derived from OBSERVATION only, and `default-on` never produces
 * an all-phases-done state (which would seal the record against regression).
 */

import { describe, it, expect } from 'vitest';
import {
  deriveRolloutStage,
  rolloutPhaseStatuses,
  shouldArchiveAtStage,
  isRegression,
} from '../../src/core/featureRollout.js';

describe('deriveRolloutStage', () => {
  it('dark when the flag is absent / disabled', () => {
    expect(deriveRolloutStage({})).toBe('dark');
    expect(deriveRolloutStage({ flagEnabled: false })).toBe('dark');
    expect(deriveRolloutStage({ flagEnabled: false, flagDryRun: true })).toBe('dark');
  });
  it('dry-run when enabled + dryRun', () => {
    expect(deriveRolloutStage({ flagEnabled: true, flagDryRun: true })).toBe('dry-run');
  });
  it('live when enabled + not dryRun', () => {
    expect(deriveRolloutStage({ flagEnabled: true, flagDryRun: false })).toBe('live');
    expect(deriveRolloutStage({ flagEnabled: true })).toBe('live');
  });
  it('default-on ONLY when the shipped default is enabled (a code change) — overrides flag state', () => {
    expect(deriveRolloutStage({ defaultEnabled: true })).toBe('default-on');
    // Even if the agent's live flag is off, a shipped default-on means default-on.
    expect(deriveRolloutStage({ defaultEnabled: true, flagEnabled: false })).toBe('default-on');
  });
});

describe('rolloutPhaseStatuses', () => {
  it('default-on does NOT mark all phases done (avoids immutable terminal)', () => {
    const s = rolloutPhaseStatuses('default-on');
    expect(s['default-on']).not.toBe('done'); // the safety invariant
    expect(s['dry-run']).toBe('done');
    expect(s.live).toBe('done');
    // not every phase is 'done' → the tracker won't auto-complete the initiative
    expect(Object.values(s).every(v => v === 'done')).toBe(false);
  });
  it('progresses dry-run → live', () => {
    expect(rolloutPhaseStatuses('dry-run')['dry-run']).toBe('in-progress');
    expect(rolloutPhaseStatuses('live')['dry-run']).toBe('done');
    expect(rolloutPhaseStatuses('live').live).toBe('in-progress');
  });
  it('dark leaves all phases pending', () => {
    expect(Object.values(rolloutPhaseStatuses('dark')).every(v => v === 'pending')).toBe(true);
  });
});

describe('shouldArchiveAtStage', () => {
  it('archives at default-on, not before', () => {
    expect(shouldArchiveAtStage('default-on')).toBe(true);
    expect(shouldArchiveAtStage('live')).toBe(false);
    expect(shouldArchiveAtStage('dry-run')).toBe(false);
  });
});

describe('isRegression', () => {
  it('detects a backward stage move (revert after default-on)', () => {
    expect(isRegression('default-on', 'live')).toBe(true);
    expect(isRegression('live', 'dry-run')).toBe(true);
    expect(isRegression('dry-run', 'dark')).toBe(true);
  });
  it('forward / same is not a regression', () => {
    expect(isRegression('dry-run', 'live')).toBe(false);
    expect(isRegression('live', 'live')).toBe(false);
    expect(isRegression('dark', 'default-on')).toBe(false);
  });
});
