import { describe, expect, it, vi } from 'vitest';
import { dispatchAppRemovalRead } from '../../src/lifeline/AppRemovalDispatchFence.js';

const conversationKey = '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab';
const worker = { compartment: 'protected' as const, machineId: 'custodian',
  instanceId: 'worker-a', listener: 'slot-a', generation: 4 };
const serving = { ...worker, conversationKey, creationEventId: 'creation' };
const read = {
  conversationKey,
  classification: { kind: 'enrolled' as const, conversationKey,
    creationEventId: 'creation', custodianMachineId: worker.machineId },
  local: { kind: 'unrecorded' as const },
  serving,
  attestation: { ...worker, artifactDigest: 'approved', readProtocol: 1, expiresAt: 200 },
  now: 100,
  approvedArtifacts: new Set(['approved']),
};

describe('Delete supervisor dispatch fence', () => {
  it('dispatches enrolled reads only to the exact protected worker', () => {
    const dispatch = vi.fn(() => 'response');
    expect(dispatchAppRemovalRead(conversationKey, () => ({ read, worker }), dispatch))
      .toEqual({ kind: 'dispatched', result: 'response' });
    expect(dispatchAppRemovalRead(conversationKey, () => ({
      read, worker: { ...worker, compartment: 'legacy' },
    }), dispatch)).toEqual({ kind: 'unavailable' });
    expect(dispatchAppRemovalRead(conversationKey, () => ({
      read, worker: { ...worker, listener: 'other' },
    }), dispatch)).toEqual({ kind: 'unavailable' });
    expect(dispatch.mock.calls).toEqual([[worker]]);
  });

  it('denies old stream dispatch after worker replacement and controller loss', () => {
    const dispatch = vi.fn();
    const replacement = { ...worker, generation: 5 };
    const current = { ...read, serving: { ...serving, generation: 5 },
      attestation: { ...read.attestation, generation: 5 } };
    expect(dispatchAppRemovalRead(conversationKey, () => ({ read: current, worker: replacement }),
      dispatch, worker)).toEqual({ kind: 'unavailable' });
    expect(dispatchAppRemovalRead(conversationKey, () => null, dispatch, worker))
      .toEqual({ kind: 'unavailable' });
    expect(dispatchAppRemovalRead(conversationKey, () => ({
      read: { ...read, now: 200 }, worker,
    }), dispatch, worker)).toEqual({ kind: 'unavailable' });
    expect(dispatchAppRemovalRead(conversationKey, () => ({
      read: { ...read, classification: { kind: 'unknown' } }, worker,
    }), dispatch, worker)).toEqual({ kind: 'unavailable' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('admits exact authoritative unenrolled reads to the isolated legacy worker', () => {
    const legacy = { ...worker, compartment: 'legacy' as const };
    const dispatch = vi.fn();
    const unenrolled = { ...read, classification: { kind: 'unenrolled' as const, conversationKey } };
    expect(dispatchAppRemovalRead(conversationKey, () => ({ read: unenrolled, worker: legacy }),
      dispatch)).toMatchObject({ kind: 'dispatched' });
    expect(dispatchAppRemovalRead('another-conversation', () => ({ read: unenrolled, worker: legacy }),
      dispatch)).toEqual({ kind: 'unavailable' });
    expect(dispatch.mock.calls).toEqual([[legacy]]);
  });
});
