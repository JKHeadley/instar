import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  canonicalStageBRcArtifact, migrateStageBConfig, migrateStageBReleaseConfig, resolveStageBProductionActivation,
  stageBConfigSha256, StageBActivationGate,
  type StageBRcArtifact, type StageBRcArtifactUnsigned,
} from '../../src/core/StageBActivationGate.js';

const keys = crypto.generateKeyPairSync('ed25519');
const otherKeys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const bindings = {
  packageVersion: '1.2.3', gitCommit: 'abc123', configSha256: 'c'.repeat(64),
  echoMachineId: 'echo-machine', echoPublicKeyPem: publicKey,
};

function unsigned(overrides: Partial<StageBRcArtifactUnsigned> = {}): StageBRcArtifactUnsigned {
  return {
    schemaVersion: 1,
    packageVersion: bindings.packageVersion,
    gitCommit: bindings.gitCommit,
    configSha256: bindings.configSha256,
    echoMachineId: bindings.echoMachineId,
    startedAt: 1_000,
    endedAt: 1_000 + 2 * 60 * 60 * 1_000,
    deliveryCount: 50,
    caseCounts: { identical: 1, multiline: 1, 'active-turn': 1, resize: 1, outage: 1, transfer: 1 },
    failures: { falseUnknown: 0, falseExhaustion: 0, duplicateKeyOwnership: 0, lostInbound: 0, staleOwnerAction: 0 },
    rawEvidenceDigests: ['d'.repeat(64)],
    reviewerDecision: 'approved',
    ...overrides,
  };
}

function signed(overrides: Partial<StageBRcArtifactUnsigned> = {}, privateKey = keys.privateKey): StageBRcArtifact {
  const row = unsigned(overrides);
  return { ...row, signature: crypto.sign(null, Buffer.from(canonicalStageBRcArtifact(row)), privateKey).toString('base64') };
}

describe('StageBActivationGate', () => {
  const gate = new StageBActivationGate(bindings);

  it('permits explicit candidate canary only on a development agent', () => {
    expect(gate.evaluate({ candidateCanaryEnabled: true }).active).toBe(false);
    const devGate = new StageBActivationGate({ ...bindings, developmentAgent: true });
    expect(devGate.evaluate({ candidateCanaryEnabled: true })).toMatchObject({
      active: true, reason: 'candidate-canary',
    });
  });

  it('ships dark when absent and preserves an explicit false', () => {
    expect(gate.evaluate(undefined)).toMatchObject({ configured: null, active: false, reason: 'unconfigured-dark' });
    expect(gate.evaluate({ ledgerObserverEnabled: false }, signed())).toMatchObject({
      configured: false, active: false, reason: 'explicitly-disabled',
    });
  });

  it('requires pending restart state and a signed artifact', () => {
    expect(gate.evaluate({ ledgerObserverEnabled: true }, signed()).reason).toBe('not-pending-restart');
    expect(gate.evaluate({ ledgerObserverEnabled: true, stageBPendingActivation: true }).reason).toBe('artifact-missing');
  });

  it('activates only the exact build/config-bound approved Echo artifact', () => {
    const artifact = signed();
    const status = gate.evaluate({ ledgerObserverEnabled: true, stageBPendingActivation: true }, artifact);
    expect(status).toMatchObject({ configured: true, pendingActivation: true, active: true, reason: 'active' });
    expect(status.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['packageVersion', { packageVersion: '9.9.9' }],
    ['gitCommit', { gitCommit: 'wrong' }],
    ['configSha256', { configSha256: 'f'.repeat(64) }],
    ['echoMachineId', { echoMachineId: 'not-echo' }],
  ] as const)('rejects a mismatched %s binding', (_name, override) => {
    expect(gate.evaluate({ ledgerObserverEnabled: true, stageBPendingActivation: true }, signed(override)).reason)
      .toBe('artifact-binding-mismatch');
  });

  it('rejects a forged signer', () => {
    expect(gate.evaluate({ ledgerObserverEnabled: true, stageBPendingActivation: true }, signed({}, otherKeys.privateKey)).reason)
      .toBe('artifact-signature-invalid');
  });

  it.each([
    ['canary-too-short', { endedAt: 1_000 + 2 * 60 * 60 * 1_000 - 1 }],
    ['delivery-threshold-not-met', { deliveryCount: 49 }],
    ['required-case-missing', { caseCounts: { identical: 1, multiline: 1, 'active-turn': 1, resize: 1, outage: 1, transfer: 0 } }],
    ['canary-failures', { failures: { falseUnknown: 0, falseExhaustion: 0, duplicateKeyOwnership: 1, lostInbound: 0, staleOwnerAction: 0 } }],
    ['review-not-approved', { reviewerDecision: 'rejected' }],
  ] as const)('rejects threshold failure %s', (reason, override) => {
    expect(gate.evaluate({ ledgerObserverEnabled: true, stageBPendingActivation: true }, signed(override)).reason).toBe(reason);
  });

  it('migrates absent/already-true only with valid evidence and remains idempotent', () => {
    const artifact = signed();
    expect(migrateStageBConfig(undefined, artifact, gate)).toEqual({ ledgerObserverEnabled: true, stageBPendingActivation: true });
    expect(migrateStageBConfig({ ledgerObserverEnabled: true }, artifact, gate)).toEqual({ ledgerObserverEnabled: true, stageBPendingActivation: true });
    expect(migrateStageBConfig(migrateStageBConfig(undefined, artifact, gate), artifact, gate))
      .toEqual({ ledgerObserverEnabled: true, stageBPendingActivation: true });
  });

  it('never overrides explicit false and does not migrate invalid evidence', () => {
    expect(migrateStageBConfig({ ledgerObserverEnabled: false, stageBPendingActivation: true }, signed(), gate))
      .toEqual({ ledgerObserverEnabled: false, stageBPendingActivation: false });
    expect(migrateStageBConfig(undefined, signed({ deliveryCount: 49 }), gate)).toEqual({});
  });

  it('retires candidate mode and arms the restart fence after valid release evidence', () => {
    expect(migrateStageBReleaseConfig({
      ledgerObserverEnabled: true,
      candidateCanaryEnabled: true,
      stageBPendingActivation: false,
      stageCRecoveryEnabled: false,
    }, true)).toEqual({
      ledgerObserverEnabled: true,
      candidateCanaryEnabled: false,
      stageBPendingActivation: true,
      stageCRecoveryEnabled: false,
    });
  });

  it('preserves an explicit observer false and keeps both later stages dark', () => {
    expect(migrateStageBReleaseConfig({
      ledgerObserverEnabled: false,
      candidateCanaryEnabled: true,
      stageBPendingActivation: true,
    }, true)).toEqual({
      ledgerObserverEnabled: false,
      candidateCanaryEnabled: false,
      stageBPendingActivation: false,
      stageCRecoveryEnabled: false,
    });
  });

  it('does not retire an active development canary without valid release evidence', () => {
    expect(migrateStageBReleaseConfig({
      ledgerObserverEnabled: true,
      candidateCanaryEnabled: true,
      stageBPendingActivation: false,
    }, false)).toEqual({
      ledgerObserverEnabled: true,
      candidateCanaryEnabled: true,
      stageBPendingActivation: false,
      stageCRecoveryEnabled: false,
    });
  });

  it('activates fleet machines from package-pinned Echo evidence, not their own identity key', () => {
    const packageVersion = '1.2.4';
    const config = { ledgerObserverEnabled: true, stageBPendingActivation: true };
    const releaseUnsigned = unsigned({
      packageVersion,
      gitCommit: `package:${packageVersion}`,
      configSha256: stageBConfigSha256(config),
    });
    const artifact: StageBRcArtifact = {
      ...releaseUnsigned,
      signature: crypto.sign(null, Buffer.from(canonicalStageBRcArtifact(releaseUnsigned)), keys.privateKey).toString('base64'),
    };
    const status = resolveStageBProductionActivation({
      stateDir: '/definitely/absent',
      config,
      packageVersion,
      gitCommit: `package:${packageVersion}`,
      echoMachineId: 'fleet-machine-not-echo',
      echoPublicKeyPem: otherKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      shippedEvidence: { schemaVersion: 1, echoPublicKeyPem: publicKey, artifact },
    });
    expect(status).toMatchObject({ active: true, reason: 'active' });
  });

  it('lets valid bundled evidence supersede a stale local candidate artifact', () => {
    const packageVersion = '1.2.4';
    const config = { ledgerObserverEnabled: true, stageBPendingActivation: true };
    const releaseUnsigned = unsigned({
      packageVersion,
      gitCommit: `package:${packageVersion}`,
      configSha256: stageBConfigSha256(config),
    });
    const artifact: StageBRcArtifact = {
      ...releaseUnsigned,
      signature: crypto.sign(null, Buffer.from(canonicalStageBRcArtifact(releaseUnsigned)), keys.privateKey).toString('base64'),
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-b-release-'));
    fs.mkdirSync(path.join(dir, 'state'));
    fs.writeFileSync(path.join(dir, 'state', 'codex-stage-b-rc.json'), JSON.stringify(signed()));
    try {
      expect(resolveStageBProductionActivation({
        stateDir: dir, config, packageVersion, gitCommit: `package:${packageVersion}`,
        echoMachineId: 'echo-machine', echoPublicKeyPem: publicKey,
        shippedEvidence: { schemaVersion: 1, echoPublicKeyPem: publicKey, artifact },
      })).toMatchObject({ active: true, reason: 'active' });
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'StageBActivationGate.test cleanup' });
    }
  });
});
