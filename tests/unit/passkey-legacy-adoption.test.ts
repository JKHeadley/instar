/**
 * Legacy passkey adoption (spec agent-held-google-passkey §6.2): copied in quarantined, committed only
 * after a `ready` cold proof on this machine, reverted otherwise; the shared copy is removed only after
 * a commit or a delete choice; nothing is adopted over a cell already held here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasskeyCredentialStore } from '../../src/core/PasskeyCredentialStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { adoptLegacyPasskey, deleteLegacyPasskey, listLegacyPasskeyNames, parseLegacyPasskey } from '../../src/core/PasskeyLegacyAdoption.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/passkey-legacy-adoption.test.ts:cleanup' }); });

const KEY = { credentialId: 'cred-legacy', rpId: 'google.com', privateKey: 'LEGACY-PRIVATE', userHandle: 'uh', signCount: 3 };
const NAME = 'google_passkey_person_studio';
const EMAIL = 'Person@Example.com';

function setup(opts: { proof?: string; proofThrows?: boolean; value?: unknown } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-adopt-')); dirs.push(stateDir);
  const store = new PasskeyCredentialStore({ stateDir, machineId: 'm_here', forceFileKey: true });
  const vault: Record<string, unknown> = { [NAME]: opts.value === undefined ? JSON.stringify(KEY) : opts.value, other_secret: 'x' };
  const coldProof = vi.fn(async () => { if (opts.proofThrows) throw new Error('boom'); return { outcome: opts.proof ?? 'ready', reason: 'signed-in' }; });
  const deps = { readLegacy: (n: string) => vault[n], removeLegacy: vi.fn((n: string) => { delete vault[n]; }), store, machineId: 'm_here', agentName: 'echo', coldProof };
  return { store, vault, deps, coldProof };
}

describe('legacy key parsing and listing', () => {
  it('lists only prototype key names and parses JSON or object values, refusing incomplete ones', () => {
    expect(listLegacyPasskeyNames({ google_passkey_b: 1, google_passkey_a: 1, github_token: 1 })).toEqual(['google_passkey_a', 'google_passkey_b']);
    expect(parseLegacyPasskey(JSON.stringify(KEY))).toEqual(KEY);
    expect(parseLegacyPasskey(KEY)).toEqual(KEY);
    expect(parseLegacyPasskey('not json')).toBeNull();
    expect(parseLegacyPasskey({ credentialId: 'x', rpId: 'google.com' })).toBeNull();
    expect(parseLegacyPasskey({ ...KEY, signCount: -1 })).toMatchObject({ signCount: 0 });
  });
});

describe('adoptLegacyPasskey', () => {
  it('commits after a ready proof: usable here as legacy-adopted, shared copy removed, proof saw the exact material', async () => {
    const s = setup();
    const r = await adoptLegacyPasskey(s.deps, { name: NAME, email: EMAIL });
    expect(r).toEqual({ adopted: true, crossAgent: false });
    expect(s.coldProof).toHaveBeenCalledWith({ canonicalEmail: 'person@example.com', material: KEY });
    expect(s.store.custodyOf(EMAIL)).toBe('legacy-adopted');
    const loaded = s.store.load(EMAIL);
    expect(loaded.ok && loaded.record.credentialId).toBe('cred-legacy');
    expect(s.vault[NAME]).toBeUndefined();
    expect(s.vault.other_secret).toBe('x');
  });

  it('reverts on a proof that is not ready or cannot run, and keeps the shared copy', async () => {
    for (const opts of [{ proof: 'credential-rejected' }, { proof: 'unknown' }, { proofThrows: true }]) {
      const s = setup(opts);
      const r = await adoptLegacyPasskey(s.deps, { name: NAME, email: EMAIL });
      expect(r.adopted).toBe(false);
      expect(s.store.custodyOf(EMAIL)).toBe('absent');
      expect(s.vault[NAME]).toBeDefined();
      expect(s.deps.removeLegacy).not.toHaveBeenCalled();
    }
  });

  it('refuses a missing, unrecognised or non-Google key, and never touches a cell already held', async () => {
    expect(await adoptLegacyPasskey(setup().deps, { name: 'google_passkey_missing', email: EMAIL })).toMatchObject({ reason: 'legacy-key-absent' });
    expect(await adoptLegacyPasskey(setup().deps, { name: 'github_token', email: EMAIL })).toMatchObject({ reason: 'legacy-key-absent' });
    expect(await adoptLegacyPasskey(setup({ value: '{}' }).deps, { name: NAME, email: EMAIL })).toMatchObject({ reason: 'legacy-key-unrecognized' });
    expect(await adoptLegacyPasskey(setup({ value: { ...KEY, rpId: 'example.com' } }).deps, { name: NAME, email: EMAIL })).toMatchObject({ reason: 'legacy-key-not-google' });
    const held = setup();
    await held.store.put({ ...KEY, credentialId: 'mine', canonicalEmail: EMAIL, mintedOnMachineId: 'm_here', mintedByAgent: 'echo', mintedAt: new Date().toISOString(), provenance: 'minted', quarantined: false });
    expect(await adoptLegacyPasskey(held.deps, { name: NAME, email: EMAIL })).toMatchObject({ reason: 'cell-already-held' });
    const still = held.store.load(EMAIL);
    expect(still.ok && still.record.credentialId).toBe('mine');
    expect(held.coldProof).not.toHaveBeenCalled();
  });

  it('records a key minted by another agent as cross-agent', async () => {
    const s = setup();
    expect(await adoptLegacyPasskey(s.deps, { name: NAME, email: EMAIL, mintedByAgent: 'other-agent' })).toEqual({ adopted: true, crossAgent: true });
  });
});

describe('deleteLegacyPasskey', () => {
  it('removes only the named shared copy and reports the Google side as pending the operator', async () => {
    const s = setup();
    expect(await deleteLegacyPasskey(s.deps, NAME)).toEqual({ deleted: true, googleSide: 'pending-operator' });
    expect(s.vault[NAME]).toBeUndefined();
    expect(await deleteLegacyPasskey(s.deps, NAME)).toEqual({ deleted: false, googleSide: null });
    expect(await deleteLegacyPasskey(s.deps, 'other_secret')).toEqual({ deleted: false, googleSide: null });
    expect(s.vault.other_secret).toBe('x');
  });
});

describe('adoptLegacyPasskey never destroys what this machine already holds', () => {
  it('refuses when an entry exists under an OLD machine id, and a failed adoption leaves it intact', async () => {
    const s = setup({ proof: 'unknown' });
    const stateDir = (s.store as unknown as { stateDir: string }).stateDir;
    const old = new PasskeyCredentialStore({ stateDir, machineId: 'm_old_id', forceFileKey: true });
    await old.put({ ...KEY, credentialId: 'old-id-cred', canonicalEmail: EMAIL, mintedOnMachineId: 'm_old_id', mintedByAgent: 'echo', mintedAt: new Date().toISOString(), provenance: 'minted', quarantined: false });
    expect(s.store.custodyOf(EMAIL)).toBe('absent'); // machine-id-changed reads absent for custody…
    expect(await adoptLegacyPasskey(s.deps, { name: NAME, email: EMAIL })).toMatchObject({ reason: 'cell-already-held' }); // …but adoption refuses
    expect(old.load(EMAIL)).toMatchObject({ ok: true });
  });

  it('refuses while an enrollment pending mint exists for the email', async () => {
    const s = setup();
    s.store.writePending({ ...KEY, canonicalEmail: 'person@example.com', mintedOnMachineId: 'm_here', mintedByAgent: 'echo', mintedAt: new Date().toISOString(), provenance: 'minted', quarantined: true, schemaVersion: 1 });
    expect(await adoptLegacyPasskey(s.deps, { name: NAME, email: EMAIL })).toMatchObject({ reason: 'cell-already-held' });
    expect(s.store.readPending(EMAIL)).not.toBeNull();
  });

  it('discardQuarantinedAdoption removes only a quarantined legacy copy on this machine', async () => {
    const s = setup();
    await s.store.put({ ...KEY, credentialId: 'minted', canonicalEmail: EMAIL, mintedOnMachineId: 'm_here', mintedByAgent: 'echo', mintedAt: new Date().toISOString(), provenance: 'minted', quarantined: true });
    expect(await s.store.discardQuarantinedAdoption(EMAIL)).toBe(false);
    expect(s.store.custodyOf(EMAIL)).toBe('quarantined');
  });
});
