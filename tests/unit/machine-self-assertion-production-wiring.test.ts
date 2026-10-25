import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'commands', 'server.ts'), 'utf8');

describe('machine self-assertion production wiring integrity', () => {
  it('places the fail-closed recovery barrier before coordinator startup', () => {
    const barrier = source.indexOf('enforceMachineIdentityBootRecovery({');
    const coordinator = source.indexOf('new MultiMachineCoordinator(');
    expect(barrier).toBeGreaterThan(0);
    expect(coordinator).toBeGreaterThan(barrier);
  });

  it('re-evaluates activation on the recurring authenticated presence tick', () => {
    expect(source).toContain('activateMachineIdentityAfterAuthenticatedPull({');
    expect(source).toMatch(/const reconcileIdentityActivation = \(\): Promise<void>[\s\S]*?activateMachineIdentityAfterAuthenticatedPull\([\s\S]*?const peerPresenceTick = \(\): void => \{\s*void reconcileIdentityActivation\(\)/);
  });

  it('starts pinned-continuity recovery before the first held activation pull', () => {
    const bootstrap = source.indexOf('identityReannounceClaimant.openContinuityRecovery()');
    const activation = source.indexOf('await reconcileIdentityActivation();');
    expect(bootstrap).toBeGreaterThan(0);
    expect(activation).toBeGreaterThan(bootstrap);
    expect(source).toContain('resolveContinuityBootstrapBearer({');
    expect(source).toContain('configuredBearerToken: config.multiMachine?.identityReannounce?.sharedBearerToken');
    expect(source).toContain('machineRecoveryKey?.has(meshSelfId, own.recoveryPublicKey)');
    expect(source).not.toMatch(/openContinuityRecovery\(\);\s*await identityReannounceClaimant\.tick\(\)/);
    expect(source).toMatch(/openContinuityRecovery\(\);[\s\S]*?void identityReannounceClaimant\.tick\(\)/);
  });

  it('uses the crash-tested rotation transaction and fences ACK propagation', () => {
    expect(source).toContain('executeRecoveryRootRotationTransaction({');
    expect(source).toContain('assertIdentityAckPropagationSettled(identityAckPropagation)');
    expect(source).toContain('operator recovery-signing root does not match the pinned local identity');
    expect(source).toContain('machineRecoveryKey.has(_meshSelfId, issuer.recoveryPublicKey)');
    const ackStart = source.indexOf('identityRotationAcknowledge: reannounceEnabled ? async');
    const mint = source.indexOf('const delegations = mintOperatorGrants(', ackStart);
    const acknowledge = source.indexOf('identityStore.acknowledge(machineId, keyEpoch)', mint);
    expect(mint).toBeGreaterThan(ackStart);
    expect(acknowledge).toBeGreaterThan(mint);
  });

  it('retires the completed old-root journal before deleting retained authority', () => {
    const retire = source.indexOf('identityRootPropagation.retireCompleted(job.id)');
    const finalize = source.indexOf('machineRecoveryKey?.finalizeRotationPropagation(', retire);
    expect(retire).toBeGreaterThan(0);
    expect(finalize).toBeGreaterThan(retire);
  });

  it('reconciles authenticated registry revocations before driving or blocking root rotation', () => {
    expect(source).toMatch(/const tickIdentityRootPropagation = async \(\) => \{[\s\S]*?reconcileRevokedPeers\(revokedIdentityPeerIds\(\)\)[\s\S]*?identityRootPropagation\.tick\(\)/);
    expect(source).toMatch(/identityRecoveryRotate: escrowEnabled \? async \(\) => \{[\s\S]*?await tickIdentityRootPropagation\(\)[\s\S]*?const unfinished = identityRootPropagation\.status\(\)/);
  });
});
