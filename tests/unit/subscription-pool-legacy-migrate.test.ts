/**
 * Legacy single-file → per-machine authority migration (spec
 * subscription-pool-authority-foundation, operation `legacy-migrate`; built for
 * instar#2122, where a paired agent's `.instar/subscription-pool.json` was shared
 * through the agent home's git repo and a joined machine inherited another
 * machine's login locations).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  SubscriptionPoolAuthorityReadError,
  SubscriptionPoolAuthorityStore,
} from '../../src/core/SubscriptionPoolAuthority.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-legacy-migrate-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'subscription-pool-legacy-migrate.test:cleanup' });
  }
});

type Row = { id: string };
const validator = (row: unknown): row is Row => !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string';
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function reason(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionPoolAuthorityReadError);
    return (error as SubscriptionPoolAuthorityReadError).reason;
  }
  return undefined;
}

describe('SubscriptionPoolAuthorityStore.migrateLegacy', () => {
  it('publishes the authority, binds the witness to the untouched source, and removes a matching legacy when asked', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<Row>(dir, 'm_local', validator);
    writeJson(store.legacyPath, { version: 1, accounts: [{ id: 'a' }, { id: 'b' }], lastModified: 'x' });
    const digest = sha(store.legacyPath);
    const size = fs.statSync(store.legacyPath).size;
    const snapshot = store.migrateLegacy({ version: 1, accounts: [{ id: 'a' }], lastModified: 'y' }, { removeLegacy: true });
    expect(snapshot.accounts).toEqual([{ id: 'a' }]); // the caller's (filtered) root is what is published
    const witness = JSON.parse(fs.readFileSync(store.witnessPath, 'utf8'));
    expect(witness).toMatchObject({ operation: 'legacy-migrate', state: 'initialized', legacyDigest: digest, legacySize: size, cleanupPending: false });
    expect(fs.existsSync(store.legacyPath)).toBe(false);
    expect(store.loadSteadyState()).toEqual(snapshot);
    expect(fs.readdirSync(path.join(dir, 'state')).filter((n) => n.includes('candidate-'))).toEqual([]);
  });

  it('leaves the legacy file in place when removeLegacy is false (git-tracked copy), and the authority still wins', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<Row>(dir, 'm_local', validator);
    writeJson(store.legacyPath, { version: 1, accounts: [{ id: 'a' }], lastModified: 'x' });
    const snapshot = store.migrateLegacy({ version: 1, accounts: [{ id: 'a' }], lastModified: 'x' }, { removeLegacy: false });
    expect(fs.existsSync(store.legacyPath)).toBe(true);
    expect(store.loadSteadyState()).toEqual(snapshot);
  });

  it('refuses when an authority already exists, and refuses an invalid source without publishing anything', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<Row>(dir, 'm_local', validator);
    store.create({ version: 1, accounts: [{ id: 'z' }] });
    writeJson(store.legacyPath, { version: 1, accounts: [{ id: 'a' }] });
    expect(reason(() => store.migrateLegacy({ version: 1, accounts: [] }, { removeLegacy: true }))).toBe('recovery-conflict');

    const dir2 = temp();
    const store2 = new SubscriptionPoolAuthorityStore<Row>(dir2, 'm_local', validator);
    fs.mkdirSync(path.dirname(store2.legacyPath), { recursive: true });
    fs.writeFileSync(store2.legacyPath, 'not json');
    expect(reason(() => store2.migrateLegacy({ version: 1, accounts: [] }, { removeLegacy: true }))).toBe('parse');
    expect(fs.existsSync(store2.witnessPath)).toBe(false);
    expect(fs.existsSync(store2.authorityDir)).toBe(false);
  });

  it('recovery: finalizes a committed directory whose witness is still initializing', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<Row>(dir, 'm_local', validator);
    writeJson(store.legacyPath, { version: 1, accounts: [{ id: 'a' }] });
    const snapshot = store.migrateLegacy({ version: 1, accounts: [{ id: 'a' }] }, { removeLegacy: false });
    const witness = JSON.parse(fs.readFileSync(store.witnessPath, 'utf8'));
    writeJson(store.witnessPath, { ...witness, state: 'initializing' });
    expect(store.loadSteadyState()).toEqual(snapshot);
    expect(JSON.parse(fs.readFileSync(store.witnessPath, 'utf8')).state).toBe('initialized');
  });

  it('recovery: rebuilds from the matching source when nothing was published, and fails closed on a mutated source', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<Row>(dir, 'm_local', validator);
    writeJson(store.legacyPath, { version: 1, accounts: [{ id: 'a' }, { id: 'b' }] });
    const snapshot = store.migrateLegacy({ version: 1, accounts: [{ id: 'a' }, { id: 'b' }] }, { removeLegacy: false });
    const witness = JSON.parse(fs.readFileSync(store.witnessPath, 'utf8'));
    // Simulate a crash between writing the initializing witness and publishing.
    SafeFsExecutor.safeRmSync(store.authorityDir, { recursive: true, force: true, operation: 'test:simulate-crash' });
    writeJson(store.witnessPath, { ...witness, state: 'initializing' });
    const rebuilt = store.loadSteadyState();
    expect(rebuilt?.accounts).toEqual(snapshot.accounts);
    expect(rebuilt?.generation).toBe(witness.generation);

    // Same crash shape but the source changed underneath: fail closed, publish nothing.
    SafeFsExecutor.safeRmSync(store.authorityDir, { recursive: true, force: true, operation: 'test:simulate-crash-2' });
    writeJson(store.witnessPath, { ...witness, state: 'initializing' });
    writeJson(store.legacyPath, { version: 1, accounts: [{ id: 'mutated' }] });
    expect(reason(() => store.loadSteadyState())).toBe('recovery-conflict');
    expect(fs.existsSync(store.authorityDir)).toBe(false);
  });
});

describe('SubscriptionPool.migrateLegacyToMachineLocal', () => {
  const account = (id: string, configHome: string) => ({
    id, nickname: id, email: `${id}@example.com`, provider: 'anthropic', framework: 'claude-code', configHome,
    status: 'active', enrolledAt: '2026-01-01T00:00:00.000Z', version: 1,
  });

  it('drops rows whose login home is not on this machine, publishes the rest, and persists to the authority from then on', () => {
    const dir = temp();
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const hereHome = path.join(dir, 'claude-here');
    fs.mkdirSync(hereHome);
    const legacy = path.join(stateDir, 'subscription-pool.json');
    writeJson(legacy, { version: 1, accounts: [account('here', hereHome), account('laptop-only', '/Users/justin/.claude-laptop')], lastModified: 'x' });
    const legacyBytes = fs.readFileSync(legacy, 'utf8');

    const pool = new SubscriptionPool({ stateDir, machineId: 'm_studio' });
    expect(pool.list().map((a) => a.id).sort()).toEqual(['here', 'laptop-only']); // legacy read before migration

    const outcome = pool.migrateLegacyToMachineLocal({ removeLegacy: false });
    expect(outcome).toMatchObject({ status: 'migrated', kept: ['here'], legacyRemoved: false });
    expect((outcome as { dropped: Array<{ id: string }> }).dropped.map((d) => d.id)).toEqual(['laptop-only']);
    expect(pool.list().map((a) => a.id)).toEqual(['here']);
    // The shared legacy copy is untouched (it may be git-tracked), the authority exists.
    expect(fs.readFileSync(legacy, 'utf8')).toBe(legacyBytes);
    expect(fs.existsSync(path.join(stateDir, 'state', 'subscription-pool.initialized.json'))).toBe(true);

    // A fresh pool on this machine reads the authority, not the legacy file.
    const again = new SubscriptionPool({ stateDir, machineId: 'm_studio' });
    expect(again.list().map((a) => a.id)).toEqual(['here']);
    expect(again.migrateLegacyToMachineLocal({ removeLegacy: false })).toEqual({ status: 'already-machine-local' });

    // A later write goes to the authority and never back into the shared legacy file.
    again.remove('here');
    expect(fs.readFileSync(legacy, 'utf8')).toBe(legacyBytes);
    expect(new SubscriptionPool({ stateDir, machineId: 'm_studio' }).list()).toEqual([]);
  });

  it('after a crash-recovery rebuild republished the whole source, the next migration pass prunes foreign homes', () => {
    const dir = temp();
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const hereHome = path.join(dir, 'claude-here');
    fs.mkdirSync(hereHome);
    const legacy = path.join(stateDir, 'subscription-pool.json');
    writeJson(legacy, { version: 1, accounts: [account('here', hereHome), account('laptop-only', '/Users/justin/.claude-laptop')], lastModified: 'x' });
    const pool = new SubscriptionPool({ stateDir, machineId: 'm_studio' });
    expect(pool.migrateLegacyToMachineLocal({ removeLegacy: false }).status).toBe('migrated');
    // Simulate the crash shape recovery rebuilds from: witness initializing, directory gone.
    const witnessPath = path.join(stateDir, 'state', 'subscription-pool.initialized.json');
    const witness = JSON.parse(fs.readFileSync(witnessPath, 'utf8'));
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'state', 'subscription-pool'), { recursive: true, force: true, operation: 'test:simulate-crash' });
    writeJson(witnessPath, { ...witness, state: 'initializing' });
    const rebuilt = new SubscriptionPool({ stateDir, machineId: 'm_studio' });
    expect(rebuilt.list().map((a) => a.id).sort()).toEqual(['here', 'laptop-only']); // the whole source came back
    const outcome = rebuilt.migrateLegacyToMachineLocal({ removeLegacy: false });
    expect(outcome).toMatchObject({ status: 'migrated', kept: ['here'] });
    expect(new SubscriptionPool({ stateDir, machineId: 'm_studio' }).list().map((a) => a.id)).toEqual(['here']);
    // The pruning update advanced the witness past legacy-migrate, so a further pass is a no-op.
    expect(new SubscriptionPool({ stateDir, machineId: 'm_studio' }).migrateLegacyToMachineLocal({ removeLegacy: false })).toEqual({ status: 'already-machine-local' });
  });

  it('is a no-op without a legacy file or without a machine identity', () => {
    const dir = temp();
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    expect(new SubscriptionPool({ stateDir, machineId: 'm_x' }).migrateLegacyToMachineLocal({ removeLegacy: true })).toEqual({ status: 'no-legacy' });
    writeJson(path.join(stateDir, 'subscription-pool.json'), { version: 1, accounts: [] });
    expect(new SubscriptionPool({ stateDir, machineId: null }).migrateLegacyToMachineLocal({ removeLegacy: true })).toEqual({ status: 'machine-identity-unavailable' });
  });
});
