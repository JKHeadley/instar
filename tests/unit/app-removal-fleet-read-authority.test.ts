import { describe, expect, it } from 'vitest';
import { decideAppRemovalFleetRead } from '../../src/core/AppRemovalFleetReadAuthority.js';

const conversationKey = '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab';
const serving = { conversationKey, creationEventId: 'creation-a',
  machineId: 'custodian', instanceId: 'process-a', generation: 4, listener: 'protected-slot-a' };
const enrolled = { kind: 'enrolled' as const, conversationKey, creationEventId: 'creation-a', custodianMachineId: serving.machineId };
const attestation = { ...serving, artifactDigest: 'verified-build', readProtocol: 1, expiresAt: 200 };
const input = { conversationKey, classification: enrolled, local: { kind: 'unrecorded' as const },
  serving, attestation, approvedArtifacts: new Set(['verified-build']), now: 100 };

describe('fleet removal read authority', () => {
  it('selects only the attested current custodian for authoritative enrollment', () => {
    expect(decideAppRemovalFleetRead(input)).toEqual({ kind: 'protected', serving });
    expect(decideAppRemovalFleetRead({ ...input, serving: { ...serving, creationEventId: 'old-creation' } })).toEqual({ kind: 'unavailable' });
    expect(decideAppRemovalFleetRead({ ...input, serving: null })).toEqual({ kind: 'unavailable' });
    expect(decideAppRemovalFleetRead({ ...input, serving: { ...serving, machineId: 'peer' } })).toEqual({ kind: 'unavailable' });
  });

  it('does not let a later lease mutation change the selected destination', () => {
    const mutable = { ...serving };
    const result = decideAppRemovalFleetRead({ ...input, serving: mutable });
    mutable.listener = 'alternate';
    expect(result).toEqual({ kind: 'protected', serving });
    expect(result.kind === 'protected' && Object.isFrozen(result.serving)).toBe(true);
  });

  it('requires complete per-conversation authority before falling back to legacy', () => {
    const classification = { kind: 'unenrolled' as const, conversationKey };
    expect(decideAppRemovalFleetRead({ ...input, classification })).toEqual({ kind: 'legacy' });
    expect(decideAppRemovalFleetRead({ ...input, classification: { kind: 'unknown' } })).toEqual({ kind: 'unavailable' });
    expect(decideAppRemovalFleetRead({ ...input, classification, local: { kind: 'unavailable' } })).toEqual({ kind: 'unavailable' });
    const local = { kind: 'recorded' as const, record: { version: 1 as const, conversationKey,
      creationEventId: 'previous-creation', custodianMachineId: serving.machineId } };
    expect(decideAppRemovalFleetRead({ ...input, classification, local })).toEqual({ kind: 'unavailable' });
    expect(decideAppRemovalFleetRead({ ...input, local })).toEqual({ kind: 'unavailable' });
  });

  it.each([
    { generation: 3 }, { listener: 'alternate' }, { instanceId: 'previous-process' },
    { machineId: 'peer' }, { artifactDigest: 'unapproved-build' }, { readProtocol: 0 }, { expiresAt: 100 },
  ])('refuses attestation outside current serving scope (%j)', (override) => {
    expect(decideAppRemovalFleetRead({ ...input, attestation: { ...attestation, ...override } })).toEqual({ kind: 'unavailable' });
  });
});
