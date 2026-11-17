import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SecretStore, perAgentKeychainAccount, type KeychainOps } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Feedback cluster "repeated secret reads on a keychain miss mint a new master
// key": a READ (secret-get.mjs → SecretStore.read()) that hit a keychain miss
// generated a fresh master key (new file key + recreated per-agent keychain
// entry), orphaning the existing vault. Reads must never create or rotate key
// material; a missing key must fail loudly and leave everything untouched.

describe('SecretStore.read() on a keychain miss', () => {
  let tmpDir: string;
  let stateDir: string;
  const keyFile = () => path.join(stateDir, 'machine', 'secrets-master.key');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-read-miss-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/secret-store-read-never-mints-key.test.ts:afterEach' });
  });

  function seedVaultInKeychain(): { key: Buffer; vaultBytes: Buffer } {
    const key = crypto.randomBytes(32);
    const healthy: KeychainOps = {
      read: (_s, account) => (account === perAgentKeychainAccount(stateDir) ? Buffer.from(key) : null),
      write: () => true,
    };
    new SecretStore({ stateDir, keychainOps: healthy }).write({ dashboardPin: '424242' });
    const vaultBytes = fs.readFileSync(path.join(stateDir, 'secrets', 'config.secrets.enc'));
    return { key, vaultBytes };
  }

  it('repeated reads after a keychain miss never mint or write a master key and fail loudly', () => {
    const { key, vaultBytes } = seedVaultInKeychain();
    expect(fs.existsSync(keyFile())).toBe(false);

    const writes: string[] = [];
    const missing: KeychainOps = {
      read: () => null, // the keychain miss (locked keychain, SSH session, ...)
      write: (_s, account) => { writes.push(account); return true; },
    };

    for (let i = 0; i < 3; i++) {
      const store = new SecretStore({ stateDir, keychainOps: missing });
      expect(() => store.read()).toThrow(/master key/i);
      expect(() => store.get('dashboardPin')).toThrow(/master key/i);
    }

    // No key material was created or rotated by the reads.
    expect(writes).toEqual([]);
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(fs.readFileSync(path.join(stateDir, 'secrets', 'config.secrets.enc')).equals(vaultBytes)).toBe(true);

    // When the keychain is reachable again, the original key still decrypts the vault.
    const back: KeychainOps = { read: () => Buffer.from(key), write: () => true };
    expect(new SecretStore({ stateDir, keychainOps: back }).get('dashboardPin')).toBe('424242');
  });

  it('a file-key-only read (VITEST / forceFileKey) does not generate a file key for a keychain-encrypted vault', () => {
    seedVaultInKeychain();
    const store = new SecretStore({ stateDir, forceFileKey: true, keychainOps: { read: () => null, write: () => true } });
    expect(() => store.read()).toThrow(/master key/i);
    expect(fs.existsSync(keyFile())).toBe(false);
  });
});
