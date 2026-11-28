import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('SecretStore existing-copy deletion', () => {
  let stateDir: string;
  let store: SecretStore;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-drop-copy-'));
    store = new SecretStore({ stateDir, forceFileKey: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'existing-copy-delete-test-cleanup' });
  });
  it('leaves absent storage and keys absent', () => {
    store.deleteIfStoreExists('secretDrops.absent');
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });
  it('removes the selected stored copy and retains unrelated credentials', () => {
    store.set('secretDrops.selected', { values: { code: 'dummy-code' } });
    store.set('otherCredential', 'dummy-unrelated');
    store.deleteIfStoreExists('secretDrops.selected');
    const restarted = new SecretStore({ stateDir, forceFileKey: true });
    expect(restarted.get('secretDrops.selected')).toBeUndefined();
    expect(restarted.get('otherCredential')).toBe('dummy-unrelated');
  });
  it('propagates unknown filesystem state rather than treating it as absence', () => {
    const error = Object.assign(new Error('permission refused'), { code: 'EACCES' });
    vi.spyOn(fs, 'statSync').mockImplementationOnce(() => { throw error; });
    expect(() => store.deleteIfStoreExists('secretDrops.selected')).toThrow(error);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });
  it('refuses a corrupt existing vault without overwriting it', () => {
    const file = path.join(stateDir, 'secrets', 'config.secrets.enc');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'broken-ciphertext');
    expect(() => store.deleteIfStoreExists('secretDrops.selected')).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('broken-ciphertext');
  });
  it('propagates a failed replacement and leaves the stored copy available', () => {
    store.set('secretDrops.selected', { values: { code: 'dummy-code' } });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('replacement refused'); });
    expect(() => store.deleteIfStoreExists('secretDrops.selected')).toThrow('replacement refused');
    expect(store.get('secretDrops.selected')).toEqual({ values: { code: 'dummy-code' } });
  });
});
