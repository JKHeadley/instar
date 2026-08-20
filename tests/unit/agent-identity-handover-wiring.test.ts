/**
 * WIRING integrity — the pieces are actually CONNECTED, not merely correct.
 *
 * Spec: docs/specs/agent-identity-continuity-on-expansion.md §1, acceptance criterion 3.
 *
 * WHY THIS SUITE EXISTS. The first version of this change shipped `sealIdentityForJoiner` and
 * `openHandoverEnvelope` with twelve passing tests — and nothing called either of them. The
 * mint guard shipped wired, so joining a mesh refused to mint and had no way to receive the
 * identity: joining was broken by the very change meant to fix it.
 *
 * Every gate passed. Unit tests exercised the piece in isolation and the piece was correct.
 * The cross-model review examined the design and the design was right. The suite ran the code
 * that existed, not the code that was absent. All of them answered a narrower question than
 * the one that mattered: is it plugged in?
 *
 * So these tests assert REACHABILITY through the real seams rather than behaviour of a part.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  sealIdentityForJoiner,
  installAgentIdentityFromPairing,
  readAgentIdentityForHandover,
  fingerprintOf,
} from '../../src/core/AgentIdentityHandover.js';

const SRC = path.resolve(__dirname, '..', '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('the handover is reachable from the real callers', () => {
  it('the pair ROUTE calls the sealer — without this the response carries nothing', () => {
    const route = read('server/machineRoutes.ts');
    expect(route).toContain('sealIdentityForJoiner');
    expect(route).toContain('agentIdentityEnvelope');
  });

  it('the JOIN command calls the installer — without this the joiner ignores the envelope', () => {
    const join = read('commands/machine.ts');
    expect(join).toContain('installAgentIdentityFromPairing');
    expect(join).toContain('agentIdentityEnvelope');
  });

  it('the server passes stateDir + agentName to the route, or the sealer has nothing to read', () => {
    const server = read('server/AgentServer.ts');
    expect(server).toMatch(/stateDir: options\.config\.stateDir/);
    expect(server).toMatch(/agentName: options\.config\.projectName/);
  });

  it('the joiner NEVER falls back to minting on a handover failure', () => {
    const join = read('commands/machine.ts');
    // The refusal path must not reach for getOrCreate or any local mint.
    const afterInstall = join.slice(join.indexOf('installAgentIdentityFromPairing'));
    expect(afterInstall).not.toContain('getOrCreate');
    expect(join).toContain('NOT minting an identity here');
  });
});

describe('seal → install, through the real functions', () => {
  function joinerKeys() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    return {
      publicB64: spki.subarray(spki.length - 32).toString('base64'),
      privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    };
  }

  function sourceStateDir(): { dir: string; fingerprint: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-src-'));
    const kp = crypto.generateKeyPairSync('ed25519');
    const pub = (kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
    const priv = (kp.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64');
    fs.writeFileSync(
      path.join(dir, 'identity.json'),
      JSON.stringify({ version: 1, publicKey: pub, privateKey: priv, createdAt: '2026-05-02T00:00:00.000Z' }),
    );
    return { dir, fingerprint: fingerprintOf(pub) };
  }

  it('round-trips: the joiner ends up with the SOURCE machine identity, not a new one', () => {
    const src = sourceStateDir();
    const j = joinerKeys();
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-dst-'));

    const agent = readAgentIdentityForHandover(src.dir);
    expect(agent).not.toBeNull();
    expect(agent!.fingerprint).toBe(src.fingerprint);

    const transcript = {
      pairingSessionId: 'CODE-WORD-1234',
      joinerMachineId: 'm_joiner',
      joinerEncryptionPublicKey: j.publicB64,
      agentName: 'echo',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const sealed = sealIdentityForJoiner({
      payload: agent!.payload,
      transcript,
      identityFingerprint: agent!.fingerprint,
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    const outcome = installAgentIdentityFromPairing({
      envelope: sealed.envelope,
      stateDir: dst,
      expected: transcript,
      encryptionPrivateKeyPem: j.privatePem,
      pinnedFingerprint: src.fingerprint,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // THE assertion: the two machines now present the SAME identity.
    expect(outcome.fingerprint).toBe(src.fingerprint);
    const installed = JSON.parse(fs.readFileSync(path.join(dst, 'identity.json'), 'utf-8'));
    expect(fingerprintOf(installed.publicKey)).toBe(src.fingerprint);
    expect(installed.provenance.origin).toBe('received-on-join');
  });

  it('writes the identity owner-only — a key the rest of the machine can read has failed', () => {
    const src = sourceStateDir();
    const j = joinerKeys();
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-perm-'));
    const agent = readAgentIdentityForHandover(src.dir)!;
    const transcript = {
      pairingSessionId: 'c', joinerMachineId: 'm', joinerEncryptionPublicKey: j.publicB64,
      agentName: 'echo', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const sealed = sealIdentityForJoiner({ payload: agent.payload, transcript, identityFingerprint: agent.fingerprint });
    if (!sealed.ok) throw new Error('seal failed');
    installAgentIdentityFromPairing({
      envelope: sealed.envelope, stateDir: dst, expected: transcript,
      encryptionPrivateKeyPem: j.privatePem, pinnedFingerprint: agent.fingerprint,
    });
    const mode = fs.statSync(path.join(dst, 'identity.json')).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group/other bits
  });

  it('an ABSENT envelope is `not-offered` and writes nothing — the old-peer case', () => {
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-none-'));
    const r = installAgentIdentityFromPairing({
      envelope: undefined,
      stateDir: dst,
      expected: { pairingSessionId: 'c', joinerMachineId: 'm', joinerEncryptionPublicKey: 'k', agentName: 'echo', expiresAt: '' },
      encryptionPrivateKeyPem: 'x',
      pinnedFingerprint: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-offered');
    expect(fs.existsSync(path.join(dst, 'identity.json'))).toBe(false);
  });

  it('a REFUSED envelope writes nothing — no partial provisioning', () => {
    const src = sourceStateDir();
    const j = joinerKeys();
    const attacker = joinerKeys();
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-refuse-'));
    const agent = readAgentIdentityForHandover(src.dir)!;
    const transcript = {
      pairingSessionId: 'c', joinerMachineId: 'm', joinerEncryptionPublicKey: j.publicB64,
      agentName: 'echo', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const sealed = sealIdentityForJoiner({ payload: agent.payload, transcript, identityFingerprint: agent.fingerprint });
    if (!sealed.ok) throw new Error('seal failed');
    const r = installAgentIdentityFromPairing({
      envelope: sealed.envelope, stateDir: dst, expected: transcript,
      encryptionPrivateKeyPem: attacker.privatePem, // wrong machine
      pinnedFingerprint: agent.fingerprint,
    });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(dst, 'identity.json'))).toBe(false);
  });

  it('a machine with no agent identity hands over nothing rather than something empty', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-empty-'));
    expect(readAgentIdentityForHandover(empty)).toBeNull();
  });
});
