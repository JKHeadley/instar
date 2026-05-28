/**
 * E2E / wiring — THREADLINE-IDENTITY-DISCOVERY-UNIFICATION.
 *
 * The single most important assertion of this fix: boot the Threadline stack
 * and prove the fingerprint advertised in agent-info.json (discovery) EQUALS
 * the fingerprint the relay client registers with (the address the relay
 * actually answers to). Before the fix, discovery advertised the orphan
 * identity-keys.json hex key while the relay routed by the canonical
 * identity.json fingerprint — so a peer who discovered the agent got a dead
 * address. This test fails if that divergence ever returns.
 *
 * Also covers the no-fabrication boundary: a no-identity boot omits the fields
 * and does not throw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { IdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

function readAgentInfo(stateDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'threadline', 'agent-info.json'), 'utf-8'));
}

describe('Threadline identity-discovery wiring — advertised fp == relay-registered fp', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-id-wiring-'));
    projectDir = path.join(tmpDir, 'project');
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/threadline/identity-discovery-wiring.test.ts:cleanup' });
  });

  it('advertises the exact fingerprint the relay client registers with', async () => {
    // Seed a canonical identity.json (the relay routing identity).
    const kp = generateIdentityKeyPair();
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({
      publicKey: kp.publicKey.toString('base64'),
      privateKey: kp.privateKey.toString('base64'),
      privateKeyEncryption: 'none',
      createdAt: new Date().toISOString(),
    }, null, 2));

    const result = await bootstrapThreadline({ agentName: 'wired-agent', stateDir, projectDir, port: 4040 });
    await result.shutdown();

    // The relay client registers with IdentityManager.getOrCreate().fingerprint.
    const relayRegistrationFingerprint = new IdentityManager(stateDir).getOrCreate().fingerprint;

    const info = readAgentInfo(stateDir);
    expect(info.fingerprint).toBe(relayRegistrationFingerprint);
    expect(info.publicKey).toBe(kp.publicKey.toString('hex'));
    // Internal consistency: the advertised pair describes ONE identity.
    expect(computeFingerprint(Buffer.from(info.publicKey as string, 'hex'))).toBe(info.fingerprint);
  });

  it('omits fingerprint + publicKey and does not throw when no routing identity exists', async () => {
    const result = await bootstrapThreadline({ agentName: 'no-id-agent', stateDir, projectDir, port: 4040 });
    await result.shutdown();

    const info = readAgentInfo(stateDir);
    expect(info.fingerprint).toBeUndefined();
    expect(info.publicKey).toBeUndefined();
  });
});
