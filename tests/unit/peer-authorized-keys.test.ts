import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PeerAuthorizedKeys } from '../../src/core/PeerAuthorizedKeys.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
function publicKey(seed: number): string {
  const type = Buffer.from('ssh-ed25519');
  const wire = Buffer.alloc(4 + type.length + 4 + 32);
  wire.writeUInt32BE(type.length, 0);
  type.copy(wire, 4);
  wire.writeUInt32BE(32, 4 + type.length);
  wire.fill(seed & 0xff, 4 + type.length + 4);
  return `ssh-ed25519 ${wire.toString('base64')}`;
}
const key = (machineId = 'peer-a', generation = 1) => ({
  agentId: 'agent', machineId, pairingEpoch: 42, clientKeyGeneration: generation,
  publicKey: publicKey(generation + machineId.length),
});

afterEach(() => {
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'peer-authorized-keys.test.ts:cleanup' });
});

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-peer-keys-'));
  roots.push(root);
  return root;
}

describe('PeerAuthorizedKeys', () => {
  it('writes only the agent-home file with restrictive modes and is idempotent', () => {
    const root = home();
    const store = new PeerAuthorizedKeys(root, false);
    expect(store.reconcile(key())).toEqual({ changed: true, dryRun: false });
    expect(store.reconcile(key())).toEqual({ changed: false, dryRun: false });
    expect(store.file).toBe(path.join(root, '.ssh', 'authorized_keys'));
    expect(fs.statSync(path.dirname(store.file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    expect(store.has(key())).toBe(true);
  });

  it('replaces rotation, preserves operator lines, and revokes one peer', () => {
    const root = home();
    const store = new PeerAuthorizedKeys(root, false);
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(store.file, 'ssh-ed25519 b3BlcmF0b3I= operator\n');
    store.reconcile(key('peer-a', 1));
    store.reconcile(key('peer-a', 2));
    store.reconcile(key('peer-b'));
    store.revoke('agent', 'peer-a');
    const content = fs.readFileSync(store.file, 'utf8');
    expect(content).toContain('operator');
    expect(content).not.toContain(':peer-a:');
    expect(content).toContain(':peer-b:');
  });

  it('dry-run reports the intended change without touching disk', () => {
    const store = new PeerAuthorizedKeys(home(), true);
    expect(store.reconcile(key())).toEqual({ changed: true, dryRun: true });
    expect(fs.existsSync(store.file)).toBe(false);
  });

  it('refuses symlinked targets', () => {
    const other = home();
    const linkedHome = home();
    fs.symlinkSync(other, path.join(linkedHome, '.ssh'));
    expect(() => new PeerAuthorizedKeys(linkedHome, false).reconcile(key())).toThrow('peer-authorized-keys-symlink-refused');
  });

  it('refuses an active account-wide writer lock without deleting it', () => {
    const root = home();
    const store = new PeerAuthorizedKeys(root, false);
    const lock = path.join(root, '.ssh', '.instar-authorized-keys.lock');
    fs.mkdirSync(lock, { recursive: true });
    expect(() => store.reconcile(key())).toThrow('peer-authorized-keys-lock-busy');
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('recovers only a lock whose recorded owner process is gone', () => {
    const root = home();
    const store = new PeerAuthorizedKeys(root, false);
    const lock = path.join(root, '.ssh', '.instar-authorized-keys.lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner' }));
    expect(store.reconcile(key()).changed).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
