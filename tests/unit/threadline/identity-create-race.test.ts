/**
 * Unit — two processes that both find NO identity file must end up with ONE
 * identity (spec: threadline-identity-single-writer §1, "create-if-absent").
 *
 * The interleaving is forced deterministically: process A reads "no file" and
 * begins to mint; while A is generating its key, process B runs its whole
 * getOrCreate. Before the fix A's write replaced B's file, leaving B holding
 * (and registering with the relay under) a key that no longer existed on disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hook = vi.hoisted(() => ({ duringMint: null as null | (() => void) }));

vi.mock('../../../src/threadline/ThreadlineCrypto.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/threadline/ThreadlineCrypto.js')>();
  return {
    ...actual,
    generateIdentityKeyPair: () => {
      const run = hook.duringMint;
      hook.duringMint = null; // only the outer mint is interleaved
      run?.();
      return actual.generateIdentityKeyPair();
    },
  };
});

import { IdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('identity creation race — one identity, whoever writes first', () => {
  let stateDir: string;
  const legacyFile = (): string => path.join(stateDir, 'threadline', 'identity.json');
  const diskFingerprint = (): string => new IdentityManager(stateDir).get()!.fingerprint;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-race-'));
  });

  afterEach(() => {
    hook.duringMint = null;
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/threadline/identity-create-race.test.ts:cleanup' });
  });

  it('the later writer adopts the identity already on disk instead of replacing it', () => {
    const a = new IdentityManager(stateDir);
    const b = new IdentityManager(stateDir);
    let bFingerprint = '';
    hook.duringMint = () => { bFingerprint = b.getOrCreate().fingerprint; };

    const aFingerprint = a.getOrCreate().fingerprint;

    expect(bFingerprint).toHaveLength(32);
    expect(aFingerprint).toBe(bFingerprint);
    expect(diskFingerprint()).toBe(bFingerprint);
    expect(fs.readdirSync(path.dirname(legacyFile()))).toEqual(['identity.json']);
  });

  it('a handshake racing the relay client ends on the relay client\'s identity', () => {
    const relaySide = new IdentityManager(stateDir);
    const handshake = new HandshakeManager(stateDir, 'agent');
    let relayPub = '';
    hook.duringMint = () => { relayPub = relaySide.getOrCreate().publicKey.toString('hex'); };

    expect(handshake.getIdentityPublicKey()).toBe(relayPub);
  });

  it('without a race, a mint still lands and is reloadable', () => {
    const fp = new IdentityManager(stateDir).getOrCreate().fingerprint;
    expect(diskFingerprint()).toBe(fp);
  });
});
