import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SecretStore, type KeychainOps } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// fb cluster "repeated secret reads on a keychain miss mint a new master key":
// a READ (secret-get.mjs dashboardPin → SecretStore.read()) must never create or
// rotate master-key material. A keychain miss on read fails loudly and leaves the
// keychain, the key file and the vault untouched, so the vault decrypts again
// once the keychain answers.

describe('SecretStore.read — a keychain miss never mints a master key', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-read-nomint-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/secret-read-never-mints-master-key.test.ts:afterEach' });
  });

  function fakeKeychain() {
    const slots = new Map<string, Buffer>();
    const state = { available: true, writes: 0 };
    const ops: KeychainOps = {
      read: (service, account) => {
        if (!state.available) return null;
        const v = slots.get(service + '|' + account);
        return v ? Buffer.from(v) : null;
      },
      write: (service, account, key) => {
        state.writes++;
        slots.set(service + '|' + account, Buffer.from(key));
        return true;
      },
    };
    return { ops, slots, state };
  }

  it('repeated reads during a keychain miss leave key material and the vault untouched', () => {
    const kc = fakeKeychain();
    // Seed the agent's own keychain key, then write the vault with it.
    const original = crypto.randomBytes(32);
    kc.ops.write('instar-secret-store', `master-key:${path.resolve(stateDir)}`, original);
    kc.state.writes = 0;
    new SecretStore({ stateDir, keychainOps: kc.ops }).write({ dashboardPin: '4321' });
    const vaultPath = path.join(stateDir, 'secrets', 'config.secrets.enc');
    const vaultBefore = fs.readFileSync(vaultPath);
    const keyFile = path.join(stateDir, 'machine', 'secrets-master.key');
    expect(fs.existsSync(keyFile)).toBe(false);

    // Keychain becomes unavailable (SSH session / locked keychain).
    kc.state.available = false;
    for (let i = 0; i < 3; i++) {
      const store = new SecretStore({ stateDir, keychainOps: kc.ops });
      expect(() => store.read()).toThrow();
      expect(() => store.get('dashboardPin')).toThrow();
    }

    // Nothing minted, nothing rotated.
    expect(kc.state.writes).toBe(0);
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(kc.slots.get(`instar-secret-store|master-key:${path.resolve(stateDir)}`)?.equals(original)).toBe(true);
    expect(fs.readFileSync(vaultPath).equals(vaultBefore)).toBe(true);

    // Keychain comes back: the vault still decrypts with the original key.
    kc.state.available = true;
    expect(new SecretStore({ stateDir, keychainOps: kc.ops }).get('dashboardPin')).toBe('4321');
  });

  it('a forceFileKey read with no key file does not generate one', () => {
    const kc = fakeKeychain();
    const original = crypto.randomBytes(32);
    kc.ops.write('instar-secret-store', `master-key:${path.resolve(stateDir)}`, original);
    new SecretStore({ stateDir, keychainOps: kc.ops }).write({ dashboardPin: '4321' });
    kc.state.available = false;
    kc.state.writes = 0;
    const keyFile = path.join(stateDir, 'machine', 'secrets-master.key');

    expect(() => new SecretStore({ stateDir, forceFileKey: true, keychainOps: kc.ops }).read()).toThrow();
    expect(fs.existsSync(keyFile)).toBe(false);
    expect(kc.state.writes).toBe(0);
  });

  it('reading with no vault still returns empty without creating a key', () => {
    const kc = fakeKeychain();
    expect(new SecretStore({ stateDir, keychainOps: kc.ops }).read()).toEqual({});
    expect(kc.state.writes).toBe(0);
    expect(fs.existsSync(path.join(stateDir, 'machine', 'secrets-master.key'))).toBe(false);
  });
});
