/**
 * Unit tests for WS5.2 §5.2 — AccountFollowMeService (composes detector + orchestrator + bridge).
 * Verifies the scan surfaces ONE aggregated consent (never enrolls), and a delivered+verified
 * mandate yields an enroll-drive instruction while a forged one yields nothing.
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { AccountFollowMeService, type AccountFollowMeServiceDeps } from '../../src/core/AccountFollowMeService.js';
import { AccountFollowMeOrchestrator } from '../../src/core/AccountFollowMeOrchestrator.js';
import { packageMandateForDelivery } from '../../src/coordination/AccountFollowMeMandateBridge.js';
import type { CoordinationMandate } from '../../src/coordination/types.js';

const orchestrator = (gate: { evaluate: (e: any) => { decision: 'allow' | 'deny'; reason: string } }) =>
  new AccountFollowMeOrchestrator({ gate, agentFp: () => 'fp-self', mandatesDeepLink: () => 'https://dash/mandates' });

function deps(over: Partial<AccountFollowMeServiceDeps> = {}): AccountFollowMeServiceDeps {
  return {
    readPoolDepth: () => ({
      machines: [
        { machineId: 'laptop', nickname: 'Laptop', usableAccountCount: 1 },
        { machineId: 'mini', nickname: 'the Mini', usableAccountCount: 0 },
      ],
      accounts: [{ accountId: 'acct-1', email: 'justin@example.com', heldByMachineIds: ['laptop'] }],
    }),
    maxFollowMachines: () => 5,
    inFlight: () => new Set<string>(),
    orchestrator: orchestrator({ evaluate: () => ({ decision: 'deny', reason: 'no mandate' }) }),
    emitAggregatedConsent: vi.fn(),
    ...over,
  };
}

describe('AccountFollowMeService (WS5.2 §5.2)', () => {
  it('scanAndOffer surfaces ONE aggregated consent for a depth-zero machine, enrolls nothing', () => {
    const emit = vi.fn();
    const svc = new AccountFollowMeService(deps({ emitAggregatedConsent: emit }));
    const r = svc.scanAndOffer();
    expect(r.offered).toHaveLength(1);
    expect(r.offered[0].targetMachineId).toBe('mini');
    expect(emit).toHaveBeenCalledTimes(1); // ONE aggregated item, not per-machine
    expect(emit.mock.calls[0][0].offers).toHaveLength(1);
    expect(emit.mock.calls[0][0].priority).toBe('medium');
  });

  it('scanAndOffer is a no-op when no machine is depth-zero', () => {
    const emit = vi.fn();
    const svc = new AccountFollowMeService(deps({
      emitAggregatedConsent: emit,
      readPoolDepth: () => ({ machines: [{ machineId: 'laptop', nickname: 'Laptop', usableAccountCount: 2 }], accounts: [{ accountId: 'a', email: 'e', heldByMachineIds: ['laptop'] }] }),
    }));
    expect(svc.scanAndOffer().offered).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('onMandateDelivered: a verified mandate + allow → enroll-drive instruction', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const mandate: CoordinationMandate = {
      id: 'MND-1', scope: 'account-follow-me', agents: ['fp-self', 'fp-x'],
      authorities: [{ action: 'account-follow-me', bounds: { accountId: 'acct-1', targetMachineId: 'mini', mechanism: 're-mint' } }],
      author: 'justin', createdAt: '2026-06-17T00:00:00Z', expiresAt: '2026-06-18T00:00:00Z', revoked: null, authProof: 'x',
    };
    const portable = packageMandateForDelivery(mandate, 'fp-op-machine', op.privateKey);
    const svc = new AccountFollowMeService(deps({ orchestrator: orchestrator({ evaluate: () => ({ decision: 'allow', reason: 'granted' }) }) }));
    const instr = svc.onMandateDelivered({
      portable,
      operatorEd25519PublicKey: op.publicKey,
      expectedOperatorMachineFingerprint: 'fp-op-machine',
      request: { accountId: 'acct-1', accountEmail: 'justin@example.com', targetMachineId: 'mini', targetMachineNickname: 'the Mini' },
    });
    expect(instr).not.toBeNull();
    expect(instr).toMatchObject({ accountId: 'acct-1', targetMachineId: 'mini', mechanism: 're-mint', mandateId: 'MND-1' });
  });

  it('onMandateDelivered: a FORGED mandate (wrong signer) → null, no enroll-drive', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const attacker = crypto.generateKeyPairSync('ed25519');
    const mandate: CoordinationMandate = {
      id: 'MND-evil', scope: 'account-follow-me', agents: ['fp-self', 'fp-x'],
      authorities: [{ action: 'account-follow-me', bounds: { accountId: 'acct-1', targetMachineId: 'mini', mechanism: 're-mint' } }],
      author: 'justin', createdAt: '2026-06-17T00:00:00Z', expiresAt: '2026-06-18T00:00:00Z', revoked: null, authProof: 'x',
    };
    const portable = packageMandateForDelivery(mandate, 'fp-op-machine', attacker.privateKey); // wrong key
    const svc = new AccountFollowMeService(deps({ orchestrator: orchestrator({ evaluate: () => ({ decision: 'allow', reason: 'granted' }) }) }));
    const instr = svc.onMandateDelivered({
      portable,
      operatorEd25519PublicKey: op.publicKey,
      expectedOperatorMachineFingerprint: 'fp-op-machine',
      request: { accountId: 'acct-1', accountEmail: 'justin@example.com', targetMachineId: 'mini', targetMachineNickname: 'the Mini' },
    });
    expect(instr).toBeNull(); // verification failed → never proceed
  });
});
