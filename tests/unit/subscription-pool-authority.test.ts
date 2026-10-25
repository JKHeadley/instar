import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  SUBSCRIPTION_POOL_MAX_BYTES,
  SubscriptionPoolAuthorityReadError,
  SubscriptionPoolAuthorityStore,
  newSubscriptionPoolGeneration,
  parseAccountsAuthority,
  readAuthorityFileBounded,
  validateGenerationRecord,
  validateSubscriptionPoolWitness,
} from '../../src/core/SubscriptionPoolAuthority.js';

const dirs: string[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-authority-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true, force: true, operation: 'subscription-pool-authority.test:cleanup',
    });
  }
});

function reason(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionPoolAuthorityReadError);
    return (error as SubscriptionPoolAuthorityReadError).reason;
  }
  return undefined;
}

describe('SubscriptionPoolAuthority', () => {
  const validator = (row: unknown): row is { id: string } =>
    !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string';
  const writeJson = (file: string, value: unknown) =>
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  it('mints lowercase 128-bit generation ids', () => {
    const a = newSubscriptionPoolGeneration();
    const b = newSubscriptionPoolGeneration();
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(b).not.toBe(a);
  });

  it('captures bytes, size, and digest from one no-follow descriptor', () => {
    const file = path.join(temp(), 'accounts.json');
    fs.writeFileSync(file, '{"version":1,"accounts":[]}');
    const captured = readAuthorityFileBounded(file);
    expect(captured.bytes.toString()).toBe('{"version":1,"accounts":[]}');
    expect(captured.size).toBe(captured.bytes.length);
    expect(captured.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses symlinks and static files beyond the byte cap', () => {
    const dir = temp();
    const target = path.join(dir, 'target');
    const link = path.join(dir, 'link');
    fs.writeFileSync(target, 'ok');
    fs.symlinkSync(target, link);
    expect(reason(() => readAuthorityFileBounded(link))).toBe('recovery-conflict');
    const large = path.join(dir, 'large');
    const fd = fs.openSync(large, 'w');
    fs.ftruncateSync(fd, SUBSCRIPTION_POOL_MAX_BYTES + 1);
    fs.closeSync(fd);
    expect(reason(() => readAuthorityFileBounded(large))).toBe('size-limit');
  });

  it('parses a bounded root and refuses shape, version, row, and duplicate boundaries', () => {
    const capture = (value: unknown) => ({
      bytes: Buffer.from(JSON.stringify(value)), sha256: 'a'.repeat(64), size: 1,
    });
    const valid = (row: unknown): row is { id: string } =>
      !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string';
    expect(parseAccountsAuthority(capture({ version: 1, accounts: [{ id: 'a' }] }), valid)).toEqual([{ id: 'a' }]);
    expect(reason(() => parseAccountsAuthority(capture([]), valid))).toBe('root-shape');
    expect(reason(() => parseAccountsAuthority(capture({ version: 2, accounts: [] }), valid))).toBe('root-version');
    expect(reason(() => parseAccountsAuthority(capture({ version: 1, accounts: null }), valid))).toBe('root-shape');
    expect(reason(() => parseAccountsAuthority(capture({ version: 1, accounts: [{ id: 'a' }, { id: 'a' }] }), valid))).toBe('duplicate-id');
    expect(reason(() => parseAccountsAuthority(capture({ version: 1, accounts: [{ nope: true }] }), valid))).toBe('invalid-row');
    const tooMany = Array.from({ length: 8_193 }, (_, i) => ({ id: String(i) }));
    expect(reason(() => parseAccountsAuthority(capture({ version: 1, accounts: tooMany }), valid))).toBe('row-limit');
  });

  it('binds generation metadata to captured bytes and the persisted machine id', () => {
    const generation = newSubscriptionPoolGeneration();
    const row = {
      schemaVersion: 1, generation, baseGeneration: null, machineId: 'm_local',
      accountsSha256: 'b'.repeat(64), accountsSize: 123,
    };
    expect(validateGenerationRecord(row, {
      machineId: 'm_local', accountsSha256: 'b'.repeat(64), accountsSize: 123,
    })).toEqual(row);
    expect(reason(() => validateGenerationRecord(row, {
      machineId: 'm_other', accountsSha256: 'b'.repeat(64), accountsSize: 123,
    }))).toBe('foreign-authority');
    expect(reason(() => validateGenerationRecord({ ...row, accountsSize: 122 }, {
      machineId: 'm_local', accountsSha256: 'b'.repeat(64), accountsSize: 123,
    }))).toBe('recovery-conflict');
  });

  it('accepts only the closed witness cross-product', () => {
    const generation = newSubscriptionPoolGeneration();
    const nextGeneration = newSubscriptionPoolGeneration();
    const base = {
      generation, nextGeneration: null, machineId: 'm_local', legacyDigest: null,
      legacySize: null, cleanupPending: false,
    };
    const accepted = [
      { ...base, operation: 'first-create', state: 'initializing' },
      { ...base, operation: 'first-create', state: 'initialized' },
      { ...base, operation: 'legacy-migrate', state: 'initializing', legacyDigest: 'a'.repeat(64), legacySize: 12 },
      { ...base, operation: 'legacy-migrate', state: 'initialized', legacyDigest: 'a'.repeat(64), legacySize: 12 },
      { ...base, operation: 'update', state: 'updating', nextGeneration },
      { ...base, operation: 'update', state: 'initialized', cleanupPending: false },
      { ...base, operation: 'update', state: 'initialized', cleanupPending: true },
    ];
    for (const row of accepted) expect(validateSubscriptionPoolWitness(row)).toEqual(row);
    const rejected = [
      { ...base, operation: 'update', state: 'updating', nextGeneration: null },
      { ...base, operation: 'update', state: 'updating', nextGeneration: generation },
      { ...base, operation: 'first-create', state: 'initialized', cleanupPending: true },
      { ...base, operation: 'legacy-migrate', state: 'initializing' },
      { ...base, operation: 'update', state: 'initialized', legacyDigest: 'a'.repeat(64), legacySize: 12 },
    ];
    for (const row of rejected) expect(reason(() => validateSubscriptionPoolWitness(row))).toBe('recovery-conflict');
  });

  it('publishes first-create as a machine-bound directory plus initialized witness', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<{ id: string }>(
      dir, 'm_local', (row): row is { id: string } =>
        !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string',
    );
    const root = { version: 1, accounts: [{ id: 'a' }], lastModified: new Date().toISOString() };
    const created = store.create(root);
    expect(created.accounts).toEqual([{ id: 'a' }]);
    expect(created.cleanupPending).toBe(false);
    expect(fs.statSync(store.authorityDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(store.authorityDir, 'accounts.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(store.witnessPath).mode & 0o777).toBe(0o600);
    expect(store.loadSteadyState()).toEqual(created);
    const foreign = new SubscriptionPoolAuthorityStore<{ id: string }>(
      dir, 'm_other', (row): row is { id: string } =>
        !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string',
    );
    expect(reason(() => foreign.loadSteadyState())).toBe('foreign-authority');
  });

  it('publishes a subsequent update as a complete generation and removes rollback', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<{ id: string }>(
      dir, 'm_local', (row): row is { id: string } =>
        !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string',
    );
    const initial = store.create({ version: 1, accounts: [{ id: 'a' }], lastModified: 'one' });
    const updated = store.update(initial.generation, {
      version: 1, accounts: [{ id: 'a' }, { id: 'b' }], lastModified: 'two',
    });
    expect(updated.generation).not.toBe(initial.generation);
    expect(updated.accounts.map((row) => row.id)).toEqual(['a', 'b']);
    expect(updated.cleanupPending).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'state')).filter((name) => name.includes('candidate-') || name.includes('rollback-'))).toEqual([]);
    expect(store.loadSteadyState()).toEqual(updated);
  });

  it('finalizes a first-create crash after the directory rename', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<{ id: string }>(dir, 'm_local', validator);
    const created = store.create({ version: 1, accounts: [{ id: 'a' }] });
    const witness = JSON.parse(fs.readFileSync(store.witnessPath, 'utf8'));
    writeJson(store.witnessPath, { ...witness, state: 'initializing' });
    expect(store.loadSteadyState()).toEqual(created);
    expect(JSON.parse(fs.readFileSync(store.witnessPath, 'utf8')).state).toBe('initialized');
  });

  it('aborts an update intent with no candidate back to validated OLD', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<{ id: string }>(dir, 'm_local', validator);
    const old = store.create({ version: 1, accounts: [{ id: 'a' }] });
    const next = newSubscriptionPoolGeneration();
    writeJson(store.witnessPath, {
      generation: old.generation, nextGeneration: next, machineId: 'm_local',
      operation: 'update', legacyDigest: null, legacySize: null,
      state: 'updating', cleanupPending: false,
    });
    expect(store.loadSteadyState()).toEqual(old);
    expect(JSON.parse(fs.readFileSync(store.witnessPath, 'utf8'))).toMatchObject({
      generation: old.generation, nextGeneration: null, state: 'initialized', cleanupPending: false,
    });
  });

  it('resumes an update after OLD was renamed to rollback and NEW remained staged', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<{ id: string }>(dir, 'm_local', validator);
    const old = store.create({ version: 1, accounts: [{ id: 'a' }] });

    const donorDir = temp();
    const donor = new SubscriptionPoolAuthorityStore<{ id: string }>(donorDir, 'm_local', validator);
    const next = donor.create({ version: 1, accounts: [{ id: 'a' }, { id: 'b' }] });
    const candidate = `${store.authorityDir}.candidate-${old.generation}-${next.generation}`;
    fs.cpSync(donor.authorityDir, candidate, { recursive: true });
    fs.renameSync(store.authorityDir, `${store.authorityDir}.rollback-${old.generation}`);
    writeJson(store.witnessPath, {
      generation: old.generation, nextGeneration: next.generation, machineId: 'm_local',
      operation: 'update', legacyDigest: null, legacySize: null,
      state: 'updating', cleanupPending: false,
    });

    const recovered = store.loadSteadyState();
    expect(recovered?.accounts.map((row) => row.id)).toEqual(['a', 'b']);
    expect(recovered).toMatchObject({ generation: next.generation, cleanupPending: false });
    expect(fs.existsSync(`${store.authorityDir}.rollback-${old.generation}`)).toBe(false);
  });

  it('fails closed on an unrecognized sibling without deleting it', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<{ id: string }>(dir, 'm_local', validator);
    store.create({ version: 1, accounts: [{ id: 'a' }] });
    const foreign = `${store.authorityDir}.candidate-${newSubscriptionPoolGeneration()}-${newSubscriptionPoolGeneration()}`;
    fs.mkdirSync(foreign);
    expect(reason(() => store.loadSteadyState())).toBe('recovery-conflict');
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('returns committed NEW with cleanup pending, then restart-only cleanup preserves NEW', () => {
    const dir = temp();
    const store = new SubscriptionPoolAuthorityStore<{ id: string }>(dir, 'm_local', validator);
    const old = store.create({ version: 1, accounts: [{ id: 'a' }] });
    const realRemove = SafeFsExecutor.safeRmSync.bind(SafeFsExecutor);
    const remove = vi.spyOn(SafeFsExecutor, 'safeRmSync').mockImplementation((target, options) => {
      if (String(target).includes('.rollback-')) throw new Error('injected cleanup fault');
      return realRemove(target, options);
    });
    const committed = store.update(old.generation, { version: 1, accounts: [{ id: 'b' }] });
    expect(committed).toMatchObject({ accounts: [{ id: 'b' }], cleanupPending: true });
    expect(store.loadSteadyState()).toMatchObject({ accounts: [{ id: 'b' }], cleanupPending: true });
    remove.mockRestore();

    const restarted = new SubscriptionPoolAuthorityStore<{ id: string }>(dir, 'm_local', validator);
    expect(restarted.loadSteadyState()).toMatchObject({ accounts: [{ id: 'b' }], cleanupPending: false });
    expect(restarted.loadSteadyState()).toMatchObject({ accounts: [{ id: 'b' }], cleanupPending: false });
  });
});
