/**
 * A READ of an existing vault must never create, replace or rotate master key
 * material. Reported: a loop of `secret-get.mjs dashboardPin` hit keychain
 * misses; each miss minted a fresh master key (new per-agent keychain entry /
 * file key), so the existing vault stopped decrypting for good.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SecretStore, perAgentKeychainAccount, type KeychainOps } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SERVICE = 'instar-secret-store';

describe('SecretStore read on a keychain miss', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-read-no-mint-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  it('repeated reads during a keychain miss fail loudly and leave key material untouched', () => {
    const account = `${SERVICE}:${perAgentKeychainAccount(stateDir)}`;
    const original = crypto.randomBytes(32);
    const kc = new Map<string, Buffer>([[account, original]]);
    let missing = false; // simulates a transient keychain miss (locked / SSH session)
    const writes: string[] = [];
    const ops: KeychainOps = {
      read: (service, acct) => (missing ? null : kc.get(`${service}:${acct}`) ?? null),
      write: (service, acct, key) => { writes.push(acct); kc.set(`${service}:${acct}`, key); return true; },
    };

    new SecretStore({ stateDir, keychainOps: ops }).write({ dashboardPin: '1234' });
    const fileKeyPath = path.join(stateDir, 'machine', 'secrets-master.key');
    expect(fs.existsSync(fileKeyPath)).toBe(false);

    missing = true;
    let failures = 0;
    for (let i = 0; i < 5; i++) {
      try { new SecretStore({ stateDir, keychainOps: ops }).get('dashboardPin'); } catch { failures++; }
    }

    // Reads fail clearly rather than "succeeding" with a freshly minted key…
    expect(failures).toBe(5);
    // …and no key material was created, replaced or rotated.
    expect(writes).toEqual([]);
    expect(kc.get(account)?.equals(original)).toBe(true);
    expect(fs.existsSync(fileKeyPath)).toBe(false);

    // Once the keychain answers again, the original vault still decrypts.
    missing = false;
    expect(new SecretStore({ stateDir, keychainOps: ops }).get('dashboardPin')).toBe('1234');
  });
});
