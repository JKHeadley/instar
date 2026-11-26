/**
 * Unit tests — the `google-passkey` login method in PlaywrightProfileRegistry.
 * Spec: docs/specs/agent-held-google-passkey.md §3.4 (method + `passkey` binding role +
 * `priorLoginMethod`) and the `revert-method` rollback lever.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  PlaywrightProfileRegistry,
  PlaywrightRegistryError,
  type PlaywrightProfileRegistryOptions,
} from '../../src/core/PlaywrightProfileRegistry.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pwreg-passkey-')); fs.mkdirSync(path.join(root, 'state'), { recursive: true }); });
afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/playwright-registry-passkey-method.test.ts:cleanup' }));

const reg = (overrides: Partial<PlaywrightProfileRegistryOptions> = {}) => new PlaywrightProfileRegistry({
  stateDir: root, projectDir: root, listVaultNames: () => ['google_password_justin', 'google_totp_justin'], hostname: 'TestMac', ...overrides,
});
const status = (fn: () => unknown): number => {
  try { fn(); } catch (err) { if (err instanceof PlaywrightRegistryError) return err.status; throw err; }
  throw new Error('expected a PlaywrightRegistryError');
};
const base = { service: 'google', identity: 'justin@example.com', owner: 'operator' as const };

describe('PlaywrightProfileRegistry — google-passkey login method', () => {
  it('refuses a passkey binding when no passkey store is wired (the fleet default) — 409, nothing written', () => {
    const r = reg();
    r.createProfile({ id: 'justin-google' });
    expect(status(() => r.assignAccount('justin-google', { ...base, loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-entry-1' } }))).toBe(409);
    expect(r.listProfiles().find((p) => p.id === 'justin-google')!.accounts).toEqual([]);
  });

  it('fails CLOSED when the passkey store is unreadable (null) and refuses an unknown entry key', () => {
    {
      const r = reg({ passkeyEntryExists: () => null });
      r.createProfile({ id: 'p' });
      expect(status(() => r.assignAccount('p', { ...base, loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-entry-1' } }))).toBe(409);
    }
    const r = reg({ passkeyEntryExists: (key) => key === 'pk-entry-1' });
    r.createProfile({ id: 'p2' });
    expect(status(() => r.assignAccount('p2', { ...base, loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-other' } }))).toBe(409);
  });

  it('method and binding are one thing: passkey method without a binding, or a binding on another method, is 400', () => {
    const r = reg({ passkeyEntryExists: () => true });
    r.createProfile({ id: 'p' });
    expect(status(() => r.assignAccount('p', { ...base, loginMethod: 'google-passkey' }))).toBe(400);
    expect(status(() => r.assignAccount('p', { ...base, loginMethod: 'password', vaultRefs: ['google_password_justin'],
      vaultBindings: { password: 'google_password_justin', passkey: 'pk-entry-1' } }))).toBe(400);
  });

  it('the passkey entry key is NOT a vault name: it need not appear in vaultRefs, while password/totp still must', () => {
    const r = reg({ passkeyEntryExists: () => true });
    r.createProfile({ id: 'p' });
    const a = r.assignAccount('p', { ...base, loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-entry-1' } });
    expect(a).toMatchObject({ loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-entry-1' }, vaultRefs: [] });
    expect(a.priorLoginMethod).toBeUndefined(); // fresh assignment: nothing was replaced
    expect(status(() => r.assignAccount('p', { ...base, identity: 'other@example.com', loginMethod: 'password',
      vaultBindings: { password: 'google_password_justin' } }))).toBe(409);
    // The read surface never flags the passkey key as a dangling VAULT ref.
    expect(r.listProfiles().find((p) => p.id === 'p')!.accounts[0].danglingRefs).toEqual([]);
  });

  it('records the REPLACED method as priorLoginMethod, keeps it across a passkey re-assign, and never records unknown', () => {
    const r = reg({ passkeyEntryExists: () => true });
    r.createProfile({ id: 'p' });
    r.assignAccount('p', { ...base, loginMethod: 'password+totp', vaultRefs: ['google_password_justin', 'google_totp_justin'],
      vaultBindings: { password: 'google_password_justin', totp: 'google_totp_justin' } });
    const enrolled = r.assignAccount('p', { ...base, loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-1' } });
    expect(enrolled.priorLoginMethod).toBe('password+totp');
    const rotated = r.assignAccount('p', { ...base, loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-2' } });
    expect(rotated.priorLoginMethod).toBe('password+totp');
    expect(rotated.vaultBindings).toEqual({ passkey: 'pk-2' });
    // Moving OFF the passkey method by a plain assign drops the prior record.
    const back = r.assignAccount('p', { ...base, loginMethod: 'session-cookie' });
    expect(back.priorLoginMethod).toBeUndefined();
    // An 'unknown' prior is not worth restoring.
    r.assignAccount('p', { ...base, identity: 'u@example.com', loginMethod: 'unknown' });
    const fromUnknown = r.assignAccount('p', { ...base, identity: 'u@example.com', loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-3' } });
    expect(fromUnknown.priorLoginMethod).toBeUndefined();
  });

  it('revertLoginMethod restores the prior method and drops the passkey binding; no prior ⇒ unchanged + named', () => {
    const r = reg({ passkeyEntryExists: () => true });
    r.createProfile({ id: 'p' });
    r.assignAccount('p', { ...base, loginMethod: 'password', vaultRefs: ['google_password_justin'], vaultBindings: { password: 'google_password_justin' } });
    r.assignAccount('p', { ...base, loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-1' } });
    r.assignAccount('p', { ...base, identity: 'fresh@example.com', loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-2' } });
    r.assignAccount('p', { ...base, identity: 'cookie@example.com', loginMethod: 'session-cookie' });

    expect(r.listPasskeyAccounts()).toEqual([
      { profileId: 'p', service: 'google', identity: 'justin@example.com', priorLoginMethod: 'password' },
      { profileId: 'p', service: 'google', identity: 'fresh@example.com', priorLoginMethod: null },
    ]);

    expect(r.revertLoginMethod('p', 'google', 'justin@example.com')).toEqual({
      profileId: 'p', service: 'google', identity: 'justin@example.com', reverted: true, from: 'google-passkey', to: 'password', bindingMissing: true });
    const reverted = r.listProfiles().find((p) => p.id === 'p')!.accounts.find((a) => a.identity === 'justin@example.com')!;
    expect(reverted.loginMethod).toBe('password');
    expect(reverted.priorLoginMethod).toBeUndefined();
    expect(reverted.vaultBindings).toBeUndefined(); // the password binding was replaced at enrollment; nothing is invented back
    expect(reverted.vaultRefs).toEqual([]);

    expect(r.revertLoginMethod('p', 'google', 'fresh@example.com')).toMatchObject({ reverted: false, reason: 'no-prior-method' });
    expect(r.listProfiles().find((p) => p.id === 'p')!.accounts.find((a) => a.identity === 'fresh@example.com'))
      .toMatchObject({ loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-2' } });
    expect(r.revertLoginMethod('p', 'google', 'cookie@example.com')).toMatchObject({ reverted: false, reason: 'not-passkey' });
    expect(r.hasAccount('p', 'google', 'fresh@example.com')).toBe(true);
    expect(r.hasAccount('p', 'google', 'nobody@example.com')).toBe(false);
    expect(status(() => r.revertLoginMethod('p', 'google', 'nobody@example.com'))).toBe(404);
    expect(status(() => r.revertLoginMethod('missing', 'google', 'justin@example.com'))).toBe(404);
  });

  it('a restored session-cookie method needs no binding: bindingMissing is false', () => {
    const r = reg({ passkeyEntryExists: () => true });
    r.createProfile({ id: 'p' });
    r.assignAccount('p', { ...base, loginMethod: 'session-cookie' });
    r.assignAccount('p', { ...base, loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-1' } });
    expect(r.revertLoginMethod('p', 'google', 'justin@example.com')).toMatchObject({ reverted: true, to: 'session-cookie', bindingMissing: false });
  });

  it('older registry rows without the new fields load unchanged (additive schema)', () => {
    const r = reg();
    r.createProfile({ id: 'p' });
    r.assignAccount('p', { ...base, loginMethod: 'session-cookie' });
    const file = path.join(root, 'state', 'playwright-profiles.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(JSON.stringify(raw)).not.toContain('priorLoginMethod');
    expect(reg().listPasskeyAccounts()).toEqual([]);
  });
});
