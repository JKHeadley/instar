import { describe, expect, it } from 'vitest';
import { evaluateMachineIdentityActivation } from '../../src/core/MachineIdentityActivationGate.js';
import { hasFreshMachineIdentityActivationProof, recordMachineIdentityActivationProof } from '../../src/core/MachineIdentityActivationGate.js';
import type { MachineCapacity } from '../../src/core/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const modes = {
  'identityReannounce.enabled': 'live' as const,
  'observedEndpoints.enabled': 'dry-run' as const,
  'recoveryKeyEscrow.enabled': 'live' as const,
};
const NOW = 1_800_000_000_000;
const peer = (overrides: Partial<MachineCapacity> = {}): MachineCapacity => ({
  machineId: 'peer', online: true, sessions: 0, maxSessions: 1, availableSlots: 1,
  loadAvg: 0, memoryPressure: 'normal', routerReceivedAt: new Date().toISOString(),
  coherenceAdvertReceivedAt: new Date(NOW - 1000).toISOString(),
  coherenceAdvert: {
    instarVersion: '1.3.1217', protocolVersion: 1, manifestHash: 'a'.repeat(64),
    guard: 'dry-run', beatSeq: 1, flags: { ...modes },
  },
  ...overrides,
} as MachineCapacity);

describe('MachineIdentityActivationGate', () => {
  it('permits dry-run without peer evidence', () => {
    expect(evaluateMachineIdentityActivation({
      selfMachineId: 'self', capacities: [peer({ coherenceAdvert: undefined })],
      localModes: { ...modes, 'identityReannounce.enabled': 'dry-run', 'recoveryKeyEscrow.enabled': 'dry-run' },
    })).toEqual({ allowed: true, evidence: [] });
  });
  it('permits live only when every online peer has the accept route and exact modes', () => {
    expect(evaluateMachineIdentityActivation({ selfMachineId: 'self', capacities: [peer()], localModes: modes, now: NOW })).toMatchObject({ allowed: true, evidence: [{ machineId: 'peer' }] });
    expect(evaluateMachineIdentityActivation({ selfMachineId: 'self', capacities: [peer({ coherenceAdvert: undefined })], localModes: modes })).toMatchObject({ allowed: false });
    expect(evaluateMachineIdentityActivation({
      selfMachineId: 'self', capacities: [peer({ coherenceAdvert: { ...peer().coherenceAdvert!, instarVersion: '1.3.1216' } })], localModes: modes,
    })).toMatchObject({ allowed: false });
    expect(evaluateMachineIdentityActivation({
      selfMachineId: 'self', capacities: [peer({ coherenceAdvert: { ...peer().coherenceAdvert!, flags: { ...modes, 'recoveryKeyEscrow.enabled': 'dry-run' } } })], localModes: modes,
    })).toMatchObject({ allowed: false });
  });
  it('requires authenticated fresh evidence for every registered peer selected by boot', () => {
    expect(evaluateMachineIdentityActivation({
      selfMachineId: 'self', capacities: [peer({ online: false, coherenceAdvert: undefined })],
      localModes: modes, requiredPeerMachineIds: ['peer'], now: NOW,
    })).toMatchObject({ allowed: false, reasons: ['peer:authenticated-presence-missing'] });
    expect(evaluateMachineIdentityActivation({
      selfMachineId: 'self', capacities: [peer({ coherenceAdvertReceivedAt: new Date(NOW - 120_001).toISOString() })],
      localModes: modes, requiredPeerMachineIds: ['peer'], now: NOW,
    })).toMatchObject({ allowed: false, reasons: ['peer:coherence-advert-stale'] });
  });
  it('persists an exact, expiring proof for the pre-coordinator recovery seam', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-activation-'));
    try {
      const evidence = [{ machineId: 'peer', advertHash: 'a'.repeat(64), receivedAt: new Date(900).toISOString() }];
      recordMachineIdentityActivationProof(root, modes, evidence, 1000);
      expect(hasFreshMachineIdentityActivationProof(root, modes, ['peer'], 2000)).toBe(true);
      expect(hasFreshMachineIdentityActivationProof(root, { ...modes, 'recoveryKeyEscrow.enabled': 'dry-run' }, ['peer'], 2000)).toBe(false);
      expect(hasFreshMachineIdentityActivationProof(root, modes, [], 2000)).toBe(false);
      expect(hasFreshMachineIdentityActivationProof(root, modes, ['peer'], 1000 + 24 * 60 * 60_000 + 1)).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(root, {
        recursive: true, force: true, operation: 'MachineIdentityActivationGate.test:cleanup',
      });
    }
  });
});
