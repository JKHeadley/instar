/**
 * Vault key coherence (CMT-1038, docs/specs/vault-key-coherence.md) — the
 * root-cause fix for the 2026-06-05 bifurcation incident: a machine-global
 * keychain slot shared by every agent, silently overwritable, split the vault
 * into keychain-readers seeing "empty" and file-readers seeing data.
 *
 * Pins: per-agent keychain accounts + legacy adoption (never writes the global
 * slot); the v2 keyId header (wrong-key is a precise, named error distinct
 * from corruption); dual-key read fallback with loud convergence-on-write;
 * v1 stores remain readable; the #789 real-keychain test guard still holds
 * when no fake keychain is injected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SecretStore,
  MasterKeyManager,
  perAgentKeychainAccount,
  keyIdOf,
  type KeychainOps,
} from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SERVICE = 'instar-secret-store';
const LEGACY = 'master-key';

/** In-memory fake keychain (service:account → key). */
function fakeKeychain(seed: Record<string, Buffer> = {}) {
  const store = new Map<string, Buffer>(Object.entries(seed));
  const ops: KeychainOps = {
    read: (service, account) => store.get(`${service}:${account}`) ?? null,
    write: (service, account, key) => { store.set(`${service}:${account}`, key); return true; },
  };
  return { ops, store };
}

function writeFileKey(stateDir: string, key: Buffer): void {
  fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'machine', 'secrets-master.key'), key.toString('hex'), { mode: 0o600 });
}

/** Hand-craft a v1 (headerless legacy) store blob: iv | tag | ciphertext. */
function v1Blob(secrets: Record<string, unknown>, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(secrets), 'utf-8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

describe('vault key coherence', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-key-coherence-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  // ── Per-agent accounts + adoption ─────────────────────────────────

  it('prefers the per-agent keychain entry over the legacy global slot', () => {
    const own = crypto.randomBytes(32);
    const legacy = crypto.randomBytes(32);
    const { ops } = fakeKeychain({
      [`${SERVICE}:${perAgentKeychainAccount(stateDir)}`]: own,
      [`${SERVICE}:${LEGACY}`]: legacy,
    });
    const mgr = new MasterKeyManager(stateDir, false, ops);
    expect(mgr.getMasterKey().equals(own)).toBe(true);
  });

  it('ADOPTS the legacy global key into the per-agent account — and never rewrites the global slot', () => {
    const legacy = crypto.randomBytes(32);
    const { ops, store } = fakeKeychain({ [`${SERVICE}:${LEGACY}`]: legacy });
    const mgr = new MasterKeyManager(stateDir, false, ops);

    expect(mgr.getMasterKey().equals(legacy)).toBe(true);
    // Adopted: per-agent slot now holds the key.
    expect(store.get(`${SERVICE}:${perAgentKeychainAccount(stateDir)}`)?.equals(legacy)).toBe(true);
    // The global slot is untouched (other agents may still depend on it).
    expect(store.get(`${SERVICE}:${LEGACY}`)?.equals(legacy)).toBe(true);
  });

  it('a freshly GENERATED key is written to the per-agent account — NEVER the legacy global slot', () => {
    const { ops, store } = fakeKeychain();
    const mgr = new MasterKeyManager(stateDir, false, ops);
    const key = mgr.getMasterKey();
    expect(store.get(`${SERVICE}:${perAgentKeychainAccount(stateDir)}`)?.equals(key)).toBe(true);
    expect(store.has(`${SERVICE}:${LEGACY}`)).toBe(false);
  });

  it('the #789 guard holds: WITHOUT an injected fake, a test-run manager is file-key-only', () => {
    const mgr = new MasterKeyManager(stateDir, false); // no keychainOps, VITEST set
    const key = mgr.getMasterKey();
    expect(fs.existsSync(path.join(stateDir, 'machine', 'secrets-master.key'))).toBe(true);
    expect(Buffer.from(fs.readFileSync(path.join(stateDir, 'machine', 'secrets-master.key'), 'utf-8').trim(), 'hex').equals(key)).toBe(true);
  });

  // ── v2 format: keyId header ───────────────────────────────────────

  it('write() produces v2 (magic + keyId of the primary key) and read() round-trips it', () => {
    const key = crypto.randomBytes(32);
    const { ops } = fakeKeychain({ [`${SERVICE}:${perAgentKeychainAccount(stateDir)}`]: key });
    const store = new SecretStore({ stateDir, keychainOps: ops });

    store.write({ github_token: 'ghp_test' });
    const raw = fs.readFileSync(path.join(stateDir, 'secrets', 'config.secrets.enc'));
    expect(raw.subarray(0, 4).toString('ascii')).toBe('ISv2');
    expect(raw.subarray(4, 12).equals(keyIdOf(key))).toBe(true);
    expect(store.read()).toEqual({ github_token: 'ghp_test' });
    expect(store.lastReadKeySource).toBe('keychain');
  });

  it('a v2 store encrypted with an UNKNOWN key fails with a precise, named error — not "empty"', () => {
    const writerKey = crypto.randomBytes(32);
    const { ops: writerOps } = fakeKeychain({ [`${SERVICE}:${perAgentKeychainAccount(stateDir)}`]: writerKey });
    new SecretStore({ stateDir, keychainOps: writerOps }).write({ a: '1' });

    // A different agent-process world: different keychain content, different file key.
    const { ops: readerOps } = fakeKeychain({ [`${SERVICE}:${perAgentKeychainAccount(stateDir)}`]: crypto.randomBytes(32) });
    const reader = new SecretStore({ stateDir, keychainOps: readerOps });
    expect(() => reader.read()).toThrowError(new RegExp(`encrypted with key id ${keyIdOf(writerKey).toString('hex')}`));
    expect(() => reader.read()).toThrowError(/NOT empty/);
  });

  it('corruption of a v2 store with the MATCHING key still surfaces as a GCM auth failure (distinct from wrong-key)', () => {
    const key = crypto.randomBytes(32);
    const { ops } = fakeKeychain({ [`${SERVICE}:${perAgentKeychainAccount(stateDir)}`]: key });
    const store = new SecretStore({ stateDir, keychainOps: ops });
    store.write({ a: '1' });
    const p = path.join(stateDir, 'secrets', 'config.secrets.enc');
    const raw = fs.readFileSync(p);
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext byte
    fs.writeFileSync(p, raw);
    expect(() => store.read()).toThrowError(/Unsupported state|unable to authenticate/i);
  });

  // ── v1 back-compat + dual-key fallback ────────────────────────────

  it('a legacy v1 store still reads (primary key)', () => {
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.join(stateDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'secrets', 'config.secrets.enc'), v1Blob({ legacy: 'data' }, key));
    const { ops } = fakeKeychain({ [`${SERVICE}:${perAgentKeychainAccount(stateDir)}`]: key });
    const store = new SecretStore({ stateDir, keychainOps: ops });
    expect(store.read()).toEqual({ legacy: 'data' });
  });

  it('THE INCIDENT: a v1 store written with the FILE key stays readable when the primary resolves to a different keychain key', () => {
    const fileKey = crypto.randomBytes(32);
    const keychainKey = crypto.randomBytes(32); // diverged (e.g. a test once clobbered the slot)
    writeFileKey(stateDir, fileKey);
    fs.mkdirSync(path.join(stateDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'secrets', 'config.secrets.enc'), v1Blob({ github_token: 'ghp_survives' }, fileKey));

    const { ops } = fakeKeychain({ [`${SERVICE}:${perAgentKeychainAccount(stateDir)}`]: keychainKey });
    const store = new SecretStore({ stateDir, keychainOps: ops });

    // Pre-fix behavior: decrypt-fail → "empty vault" to keychain readers.
    // Post-fix: the file-key alternate decrypts it, loudly.
    expect(store.read()).toEqual({ github_token: 'ghp_survives' });
    expect(store.lastReadKeySource).toBe('file');
  });

  it('the next write() after a fallback read CONVERGES the store to the primary key (v2)', () => {
    const fileKey = crypto.randomBytes(32);
    const keychainKey = crypto.randomBytes(32);
    writeFileKey(stateDir, fileKey);
    fs.mkdirSync(path.join(stateDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'secrets', 'config.secrets.enc'), v1Blob({ a: '1' }, fileKey));

    const { ops } = fakeKeychain({ [`${SERVICE}:${perAgentKeychainAccount(stateDir)}`]: keychainKey });
    const store = new SecretStore({ stateDir, keychainOps: ops });
    store.set('b', '2'); // read (file-key fallback) + write (primary keychain key)

    const raw = fs.readFileSync(path.join(stateDir, 'secrets', 'config.secrets.enc'));
    expect(raw.subarray(0, 4).toString('ascii')).toBe('ISv2');
    expect(raw.subarray(4, 12).equals(keyIdOf(keychainKey))).toBe(true);
    expect(store.read()).toEqual({ a: '1', b: '2' });
    expect(store.lastReadKeySource).toBe('keychain'); // converged
  });

  it('forceFileKey still wins as the primary, with an existing keychain key only as a read alternate', () => {
    const fileKey = crypto.randomBytes(32);
    const keychainKey = crypto.randomBytes(32);
    writeFileKey(stateDir, fileKey);
    fs.mkdirSync(path.join(stateDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'secrets', 'config.secrets.enc'), v1Blob({ k: 'v' }, keychainKey));

    const { ops } = fakeKeychain({ [`${SERVICE}:${perAgentKeychainAccount(stateDir)}`]: keychainKey });
    const store = new SecretStore({ stateDir, forceFileKey: true, keychainOps: ops });
    expect(store.read()).toEqual({ k: 'v' });
    expect(store.lastReadKeySource).toBe('keychain'); // alternate decrypted it
    store.set('x', 'y');
    // Converged to the FILE key (forceFileKey primary).
    const raw = fs.readFileSync(path.join(stateDir, 'secrets', 'config.secrets.enc'));
    expect(raw.subarray(4, 12).equals(keyIdOf(fileKey))).toBe(true);
  });
});
