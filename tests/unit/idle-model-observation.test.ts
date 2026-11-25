import { describe, expect, it, vi } from 'vitest';
import { classifyIdleModelObservation, observeOwnedIdleModel, type IdleModelObservationEvidence, type OwnerBoundIdleModelSnapshot } from '../../src/core/IdleModelObservation.js';

const revision = {
  ownerEpoch: '1',
  processIncarnation: 'process-1',
  topicPolicyRevision: 'topic-1',
  modelPolicyRevision: 'policy-1',
  runtimeObservationRevision: 'runtime-1',
};

const candidate: IdleModelObservationEvidence = {
  captured: revision,
  current: revision,
  policy: 'moving-default',
  runtime: { kind: 'verified', configuredThreadModel: 'gpt-6.1-sol', selector: 'inherited', idle: true },
  optIn: true,
  target: { kind: 'verified-upgrade', model: 'gpt-6.2-sol' },
};

describe('idle model observation', () => {
  it('describes a verified candidate without returning private proof identifiers', () => {
    expect(classifyIdleModelObservation(candidate)).toEqual({
      policy: 'moving-default',
      configuredThreadModel: 'gpt-6.1-sol',
      eligibility: 'candidate',
      reason: 'verified-observation',
      targetModel: 'gpt-6.2-sol',
    });
  });

  it.each(['ownerEpoch', 'processIncarnation', 'topicPolicyRevision', 'modelPolicyRevision'] as const)(
    'withholds stale evidence if %s changes before the response',
    key => {
      expect(classifyIdleModelObservation({
        ...candidate,
        current: { ...revision, [key]: 'changed' },
      })).toEqual({
        policy: 'unknown',
        configuredThreadModel: null,
        eligibility: 'unknown',
        reason: 'stale-identity-or-policy',
      });
    },
  );

  it('distinguishes a current saved pin from a gap in native evidence', () => {
    const gap = { ...candidate, current: { ...revision, runtimeObservationRevision: null } };
    expect(classifyIdleModelObservation({ ...gap, policy: 'exact-pin' })).toMatchObject({
      eligibility: 'ineligible', reason: 'exact-policy-pin', configuredThreadModel: null,
    });
    expect(classifyIdleModelObservation(gap)).toMatchObject({
      eligibility: 'unknown', reason: 'unverified-runtime', configuredThreadModel: null,
    });
  });

  it('distinguishes verified unsupported runtime from unavailable capability evidence', () => {
    expect(classifyIdleModelObservation({ ...candidate, runtime: { kind: 'unsupported' } }).reason)
      .toBe('unsupported-runtime');
    expect(classifyIdleModelObservation({ ...candidate, runtime: { kind: 'unknown' } }).reason)
      .toBe('unverified-runtime');
  });

  it.each([null, 'new-runtime-revision'])('does not use stale unsupported evidence at %s', runtimeObservationRevision => {
    expect(classifyIdleModelObservation({
      ...candidate,
      current: { ...revision, runtimeObservationRevision },
      runtime: { kind: 'unsupported' },
    }).reason).toBe('unverified-runtime');
  });

  it('rejects unchanged or blank model evidence', () => {
    expect(classifyIdleModelObservation({
      ...candidate, target: { kind: 'verified-upgrade', model: 'gpt-6.1-sol' },
    }).reason).toBe('no-compatible-upgrade');
    expect(classifyIdleModelObservation({
      ...candidate, target: { kind: 'verified-upgrade', model: '' },
    }).reason).toBe('unknown-target');
    expect(classifyIdleModelObservation({
      ...candidate, runtime: { kind: 'verified', configuredThreadModel: '', selector: 'inherited', idle: true },
    }).reason).toBe('unverified-runtime');
  });

  it.each([
    [{ selector: 'explicit', idle: true }, 'explicit-native-selection'],
    [{ selector: 'unknown', idle: true }, 'unverified-inheritance'],
    [{ selector: 'inherited', idle: false }, 'active-work'],
    [{ selector: 'inherited', idle: null }, 'unknown-work-state'],
  ] as const)('reports native intent or work state %j', (state, reason) => {
    expect(classifyIdleModelObservation({
      ...candidate,
      runtime: { kind: 'verified', configuredThreadModel: 'gpt-6.1-sol', ...state },
    }).reason).toBe(reason);
  });

  it('requires opt-in and a verified compatible target', () => {
    expect(classifyIdleModelObservation({ ...candidate, optIn: null }).reason).toBe('unknown-opt-in');
    expect(classifyIdleModelObservation({ ...candidate, optIn: false }).reason).toBe('opt-in-absent');
    expect(classifyIdleModelObservation({ ...candidate, target: { kind: 'unknown' } }).reason).toBe('unknown-target');
    expect(classifyIdleModelObservation({ ...candidate, target: { kind: 'no-compatible-upgrade' } }).reason)
      .toBe('no-compatible-upgrade');
  });
});


describe('owner-bound idle observation reader', () => {
  const base: OwnerBoundIdleModelSnapshot = {
    sessionId: 'session-1', ownerMachineId: 'local', ownershipStatus: 'active', revision,
  };

  it.each([
    null,
    { ...base, sessionId: 'other-session' },
    { ...base, ownerMachineId: 'peer' },
    { ...base, ownershipStatus: 'transferring' as const },
  ])('refuses a session with absent, mismatched or displaced custody', initial => {
    const evidence = vi.fn(() => candidate);
    expect(observeOwnedIdleModel(base.sessionId, 'local', () => initial, evidence)).toBeNull();
    expect(evidence).not.toHaveBeenCalled();
  });

  it('does not release cached details if ownership transfers during read', () => {
    const read = vi.fn().mockReturnValueOnce(base).mockReturnValueOnce({ ...base, ownerMachineId: 'peer' });
    expect(observeOwnedIdleModel(base.sessionId, 'local', read, () => candidate)).toBeNull();
  });

  it('does not release cached details after an exact process is replaced', () => {
    const read = vi.fn().mockReturnValueOnce(base).mockReturnValueOnce({
      ...base, revision: { ...revision, processIncarnation: 'replacement' },
    });
    expect(observeOwnedIdleModel(base.sessionId, 'local', read, () => candidate)).toBeNull();
  });

  it('reports a shifted topic revision as unknown, without disclosing the cached model', () => {
    const read = vi.fn().mockReturnValueOnce(base).mockReturnValueOnce({
      ...base, revision: { ...revision, topicPolicyRevision: 'new-pin' },
    });
    expect(observeOwnedIdleModel(base.sessionId, 'local', read, () => candidate)).toEqual({
      policy: 'unknown', configuredThreadModel: null,
      eligibility: 'unknown', reason: 'stale-identity-or-policy',
    });
  });

  it('keeps an older cached payload tied to its own policy revision', () => {
    const newPolicy = { ...base, revision: { ...revision, topicPolicyRevision: 'new-pin' } };
    expect(observeOwnedIdleModel(base.sessionId, 'local', () => newPolicy, () => candidate)).toMatchObject({
      eligibility: 'unknown', policy: 'unknown', configuredThreadModel: null,
    });
  });

  it('returns stored pin intent while live evidence is missing on the exact owner', () => {
    const known = { ...base, revision: { ...revision, runtimeObservationRevision: null } };
    expect(observeOwnedIdleModel(base.sessionId, 'local', () => known, () => ({
      ...candidate, captured: known.revision, policy: 'exact-pin', runtime: { kind: 'unknown' },
    }))).toEqual({
      policy: 'exact-pin', configuredThreadModel: null, eligibility: 'ineligible', reason: 'exact-policy-pin',
    });
  });
});
