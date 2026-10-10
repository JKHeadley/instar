/**
 * Integration — a machine that joined via pairing initialises unified trust (ACT-072).
 * Spec: docs/specs/joined-machine-unified-trust.md
 *
 * Runs the REAL path end to end: a source machine's canonical identity →
 * readAgentIdentityForHandover → sealIdentityForJoiner → the real pairing
 * installer write (installAgentIdentityFromPairing) on the joiner →
 * createUnifiedTrustSystem on the joiner, which calls
 * CanonicalIdentityManager.load(). Before the fix that load threw
 * "Unknown encryption method: undefined" and unified trust never started.
 *
 * Both sides of the boundary: the installer shape is accepted; a genuinely
 * malformed file in the same place is still refused and left untouched.
 */

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installAgentIdentityFromPairing,
  readAgentIdentityForHandover,
  sealIdentityForJoiner,
} from '../../src/core/AgentIdentityHandover.js';
import { CanonicalIdentityManager } from '../../src/identity/IdentityManager.js';
import { IdentityFileInvalidError } from '../../src/identity/IdentityKeyFile.js';
import { createUnifiedTrustSystem, type UnifiedTrustSystem } from '../../src/threadline/UnifiedTrustWiring.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { sign, verify } from '../../src/threadline/ThreadlineCrypto.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/joined-machine-unified-trust.test.ts';

describe('joined machine → unified trust initialises (ACT-072)', () => {
  const dirs: string[] = [];
  const systems: UnifiedTrustSystem[] = [];
  const tmp = (prefix: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  afterEach(() => {
    for (const s of systems.splice(0)) s.shutdown();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  function joinerKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    return {
      publicB64: spki.subarray(spki.length - 32).toString('base64'),
      privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    };
  }

  /** Pair a joiner to a source machine through the real seal + installer. */
  function joinFrom(sourceDir: string): { joinerDir: string; fingerprint: string } {
    const agent = readAgentIdentityForHandover(sourceDir);
    expect(agent).not.toBeNull();
    const j = joinerKeys();
    const joinerDir = tmp('joined-trust-dst-');
    const transcript = {
      pairingSessionId: 'CODE-WORD-1234',
      joinerMachineId: 'm_joiner',
      joinerEncryptionPublicKey: j.publicB64,
      agentName: 'echo',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const sealed = sealIdentityForJoiner({ payload: agent!.payload, transcript, identityFingerprint: agent!.fingerprint });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const outcome = installAgentIdentityFromPairing({
      envelope: sealed.envelope,
      stateDir: joinerDir,
      expected: transcript,
      encryptionPrivateKeyPem: j.privatePem,
      pinnedFingerprint: agent!.fingerprint,
    });
    expect(outcome.ok).toBe(true);
    return { joinerDir, fingerprint: agent!.fingerprint };
  }

  it('the joiner starts unified trust on the SOURCE identity — no throw, no new identity', () => {
    const sourceDir = tmp('joined-trust-src-');
    const source = new CanonicalIdentityManager(sourceDir).create({ skipRecovery: true }).identity;
    const { joinerDir } = joinFrom(sourceDir);

    // The file the installer wrote carries no privateKeyEncryption — the shape under test.
    const installed = JSON.parse(fs.readFileSync(path.join(joinerDir, 'identity.json'), 'utf-8'));
    expect('privateKeyEncryption' in installed).toBe(false);
    const before = fs.readFileSync(path.join(joinerDir, 'identity.json'), 'utf-8');

    const system = createUnifiedTrustSystem(new AgentTrustManager({ stateDir: joinerDir }), { stateDir: joinerDir });
    systems.push(system);

    const id = system.identity.get();
    expect(id).not.toBeNull();
    expect(id!.publicKey.equals(source.publicKey)).toBe(true);
    expect(id!.canonicalId).toBe(source.canonicalId);
    expect(id!.displayFingerprint).toBe(source.displayFingerprint);
    // Unified trust did not mint or overwrite: the installed file is byte-identical.
    expect(fs.readFileSync(path.join(joinerDir, 'identity.json'), 'utf-8')).toBe(before);

    // The loaded private key really is the agent's: a joiner signature verifies
    // against the source machine's public key.
    const msg = Buffer.from('signed on the joined machine');
    expect(verify(source.publicKey, msg, sign(id!.privateKey, msg))).toBe(true);
  });

  it('a genuinely malformed identity on a joiner is still refused, untouched, not replaced', () => {
    const joinerDir = tmp('joined-trust-bad-');
    const file = path.join(joinerDir, 'identity.json');
    // Installer-shaped, but the "private key" is not a 32-byte seed.
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      publicKey: Buffer.alloc(32, 1).toString('base64'),
      privateKey: Buffer.alloc(72, 7).toString('base64'),
      createdAt: '2026-10-01T00:00:00.000Z',
    }));
    const before = fs.readFileSync(file, 'utf-8');
    expect(() => createUnifiedTrustSystem(new AgentTrustManager({ stateDir: joinerDir }), { stateDir: joinerDir }))
      .toThrow(IdentityFileInvalidError);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });
});
