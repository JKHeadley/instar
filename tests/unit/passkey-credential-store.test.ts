import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PasskeyCredentialStore, PENDING_TTL_MS, type PasskeyRecord } from '../../src/core/PasskeyCredentialStore.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { spawn } from 'node:child_process';

// Spec docs/specs/agent-held-google-passkey.md §3.1 (custody).

const EMAIL = 'Adriana@SageMindAI.io'; // mixed case + dots on purpose
const MACHINE = 'm_studio';

function rec(overrides: Partial<PasskeyRecord> = {}): PasskeyRecord {
  return {
    credentialId: 'cred-1', rpId: 'google.com', privateKey: 'PRIVATE-KEY-MATERIAL', userHandle: 'uh',
    signCount: 0, canonicalEmail: EMAIL, mintedOnMachineId: MACHINE, mintedByAgent: 'echo',
    mintedAt: '2026-09-22T00:00:00.000Z', provenance: 'minted', quarantined: false, schemaVersion: 1,
    ...overrides,
  };
}

describe('PasskeyCredentialStore', () => {
  let stateDir: string;
  let now: number;
  const mk = (machineId = MACHINE) => new PasskeyCredentialStore({ stateDir, machineId, forceFileKey: true, now: () => now });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-store-'));
    now = Date.parse('2026-09-22T12:00:00Z');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/passkey-credential-store.test.ts:afterEach' });
  });

  it('stores in a separate file that the shared vault never sees', async () => {
    const shared = new SecretStore({ stateDir, forceFileKey: true });
    shared.write({ github_token: 'x' });
    await mk().put(rec());
    expect(fs.existsSync(path.join(stateDir, 'secrets', 'passkeys', 'store.enc'))).toBe(true);
    const vault = JSON.stringify(shared.read());
    expect(vault).not.toContain('PRIVATE-KEY-MATERIAL');
    expect(vault).not.toContain('adriana');
    // The file on disk is encrypted: no email or key material in plaintext.
    const raw = fs.readFileSync(path.join(stateDir, 'secrets', 'passkeys', 'store.enc'));
    expect(raw.toString('latin1')).not.toContain('PRIVATE-KEY-MATERIAL');
    expect(raw.toString('latin1').toLowerCase()).not.toContain('adriana');
  });

  it('works with a dotted, mixed-case email and loads it back case-insensitively', async () => {
    const s = mk();
    await s.put(rec());
    const r = s.load('adriana@sagemindai.io');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.privateKey).toBe('PRIVATE-KEY-MATERIAL');
  });

  it('the names-only index holds no email and no key material', async () => {
    await mk().put(rec());
    const idx = fs.readFileSync(path.join(stateDir, 'secrets', 'passkeys', 'index.json'), 'utf8');
    expect(idx).not.toContain('adriana');
    expect(idx).not.toContain('PRIVATE-KEY-MATERIAL');
    const entries = mk().listIndex();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ machineId: MACHINE, provenance: 'minted', custodyState: 'present' });
    expect(entries[0].emailKey).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('machine-scope guard', () => {
    it('refuses a credential minted on another machine unless adopted here', async () => {
      await mk().put(rec({ mintedOnMachineId: 'm_other', provenance: 'legacy-adopted' }));
      await expect(mk().put(rec({ canonicalEmail: 'minted@example.com' })).then(() => mk().commitAdoption('minted@example.com'))).rejects.toThrow(/only legacy-adopted/);
      expect(mk().load(EMAIL)).toEqual({ ok: false, reason: 'machine-scope' });
      await mk().commitAdoption(EMAIL);
      expect(mk().load(EMAIL).ok).toBe(true);
    });

    it('reports machine-id-changed when the record is filed under a different local id', async () => {
      await mk('m_old_id').put(rec({ mintedOnMachineId: 'm_old_id' }));
      expect(mk('m_new_id').load(EMAIL)).toEqual({ ok: false, reason: 'machine-id-changed' });
    });

    it('never loads a quarantined record until released', async () => {
      await mk().put(rec({ quarantined: true }));
      expect(mk().load(EMAIL)).toEqual({ ok: false, reason: 'quarantined' });
      await mk().release(EMAIL);
      expect(mk().load(EMAIL).ok).toBe(true);
    });

    it('absent is absent', () => {
      expect(mk().load('nobody@example.com')).toEqual({ ok: false, reason: 'absent' });
    });
  });

  it('remove deletes the entry, the pending record and adoption, and leaves a tombstone', async () => {
    const s = mk();
    await s.put(rec());
    s.writePending(rec());
    const out = await s.remove(EMAIL);
    expect(out).toEqual({ entryAbsent: true, pendingAbsent: true, tombstone: true, removedKeys: 1 });
    expect(s.load(EMAIL)).toEqual({ ok: false, reason: 'absent' });
    expect(s.has(EMAIL)).toBe(false);
  });

  describe('pending records (crash-safe mint)', () => {
    it('are encrypted on disk and resumable', () => {
      const s = mk();
      s.writePending(rec());
      const dir = path.join(stateDir, 'secrets', 'passkeys', 'pending');
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, files[0])).toString('latin1')).not.toContain('PRIVATE-KEY-MATERIAL');
      expect(s.readPending(EMAIL)?.privateKey).toBe('PRIVATE-KEY-MATERIAL');
      s.clearPending(EMAIL);
      expect(s.readPending(EMAIL)).toBeNull();
    });

    it('expire after 24h and not before', () => {
      const s = mk();
      s.writePending(rec());
      now += PENDING_TTL_MS - 1;
      expect(s.sweepExpiredPending()).toEqual({ removed: [], unreadable: [] });
      now += 1;
      expect(s.sweepExpiredPending().removed).toHaveLength(1);
      expect(s.readPending(EMAIL)).toBeNull();
    });
  });

  it('serialises concurrent writers so no write is lost', async () => {
    const emails = Array.from({ length: 12 }, (_, i) => `user${i}@example.com`);
    await Promise.all(emails.map((e, i) => mk().put(rec({ canonicalEmail: e, credentialId: `c${i}` }))));
    const s = mk();
    for (const e of emails) expect(s.has(e)).toBe(true);
    expect(s.listIndex()).toHaveLength(12);
  });

  it('serialises writers in SEPARATE processes (cross-process lock) so no write is lost', async () => {
    // Uses the compiled store so child processes can load it without a TS loader.
    const dist = path.resolve(__dirname, '../../dist/core/PasskeyCredentialStore.js');
    expect(fs.existsSync(dist)).toBe(true);
    // Initialise once so every child shares the same HMAC key.
    mk().emailKey('init@example.com');
    const script = `
      const { PasskeyCredentialStore } = await import(${JSON.stringify(dist)});
      const { PK_STATE_DIR: stateDir, PK_EMAIL: email, PK_ID: id } = process.env;
      const s = new PasskeyCredentialStore({ stateDir, machineId: 'm_studio', forceFileKey: true });
      await s.put({ credentialId: id, rpId: 'google.com', privateKey: 'k', userHandle: 'u', signCount: 0,
        canonicalEmail: email, mintedOnMachineId: 'm_studio', mintedByAgent: 'echo', mintedAt: 'x',
        provenance: 'minted', quarantined: false });
    `;
    const run = (i: number) => new Promise<number>((resolve) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script],
        { env: { ...process.env, VITEST: '1', PK_STATE_DIR: stateDir, PK_EMAIL: `p${i}@example.com`, PK_ID: `c${i}` }, stdio: 'ignore' });
      c.on('exit', (code) => resolve(code ?? 1));
    });
    const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
    expect(codes.every((c) => c === 0)).toBe(true);
    const s = mk();
    for (let i = 0; i < 8; i++) expect(s.has(`p${i}@example.com`)).toBe(true);
  }, 60_000);

  it('two processes initialising an absent store agree on one HMAC key', async () => {
    const dist = path.resolve(__dirname, '../../dist/core/PasskeyCredentialStore.js');
    const script = `
      const { PasskeyCredentialStore } = await import(${JSON.stringify(dist)});
      const stateDir = process.env.PK_STATE_DIR;
      const startAt = Number(process.env.PK_START_AT);
      while (Date.now() < startAt) { /* barrier: all children start together */ }
      const s = new PasskeyCredentialStore({ stateDir, machineId: 'm_studio', forceFileKey: true });
      process.stdout.write(s.emailKey('race@example.com'));
    `;
    const startAt = String(Date.now() + 1500);
    const run = () => new Promise<string>((resolve) => {
      let out = '';
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, VITEST: '1', PK_STATE_DIR: stateDir, PK_START_AT: startAt } });
      c.stdout.on('data', (b) => { out += String(b); });
      c.on('exit', () => resolve(out));
    });
    const keys = await Promise.all(Array.from({ length: 6 }, () => run()));
    expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
    expect(new Set(keys).size).toBe(1);
    expect(mk().emailKey('race@example.com')).toBe(keys[0]);
  }, 60_000);

  it('remove also deletes a record filed under an OLD machine id and reports it honestly', async () => {
    await mk('m_old_id').put(rec({ mintedOnMachineId: 'm_old_id' }));
    const out = await mk('m_new_id').remove(EMAIL);
    expect(out.removedKeys).toBe(1);
    expect(out.entryAbsent).toBe(true);
    expect(mk('m_old_id').load(EMAIL)).toEqual({ ok: false, reason: 'absent' });
  });

  it('never deletes an unreadable pending record — it reports it instead', () => {
    const s = mk();
    s.writePending(rec());
    const dir = path.join(stateDir, 'secrets', 'passkeys', 'pending');
    const f = path.join(dir, fs.readdirSync(dir)[0]);
    fs.writeFileSync(f, Buffer.from('corrupted-not-decryptable'));
    now += PENDING_TTL_MS * 10;
    const out = s.sweepExpiredPending();
    expect(out.removed).toEqual([]);
    expect(out.unreadable).toHaveLength(1);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('keeps one HMAC key for the life of the store (email keys are stable)', async () => {
    const before = mk().emailKey(EMAIL);
    await mk().put(rec());
    expect(mk().emailKey(EMAIL)).toBe(before);
  });
});
