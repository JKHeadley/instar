/**
 * resolveInboxBlobToken — the InboxDrainer's Blob token source (spec
 * docs/specs/feedback-inbox-vault-token.md §A).
 *
 * Real SecretStore on disk (forceFileKey — never the real keychain). Both sides
 * of every decision: env wins over vault, vault used when env is unset/blank,
 * none when neither holds it, and an unreadable vault resolves to none with a
 * flag — never a throw, never the value in the result's error surface.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  resolveInboxBlobToken,
  DEFAULT_INBOX_BLOB_TOKEN_ENV,
  DEFAULT_INBOX_BLOB_TOKEN_VAULT_KEY,
} from '../../src/feedback-factory/inbox/resolveInboxBlobToken.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-tok-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/feedback-inbox-blob-token.test.ts' }); });

function writeVault(entries: Record<string, unknown>): void {
  const store = new SecretStore({ stateDir: dir, forceFileKey: true });
  for (const [k, v] of Object.entries(entries)) store.set(k, v);
}

function resolve(env: Record<string, string | undefined>, vaultKey = DEFAULT_INBOX_BLOB_TOKEN_VAULT_KEY) {
  return resolveInboxBlobToken({ env, envName: DEFAULT_INBOX_BLOB_TOKEN_ENV, stateDir: dir, vaultKey, forceFileKey: true });
}

describe('resolveInboxBlobToken', () => {
  it('uses the defaults the operated vault already holds', () => {
    expect(DEFAULT_INBOX_BLOB_TOKEN_ENV).toBe('FEEDBACK_INBOX_BLOB_TOKEN');
    expect(DEFAULT_INBOX_BLOB_TOKEN_VAULT_KEY).toBe('feedback_inbox_blob_token');
  });

  it('env wins over the vault when set', () => {
    writeVault({ feedback_inbox_blob_token: 'vault-token' });
    expect(resolve({ FEEDBACK_INBOX_BLOB_TOKEN: 'env-token' })).toEqual({ token: 'env-token', source: 'env' });
  });

  it('falls back to the vault when the env var is unset', () => {
    writeVault({ feedback_inbox_blob_token: '  vault-token \n' });
    expect(resolve({})).toEqual({ token: 'vault-token', source: 'vault' });
  });

  it('treats a blank env var as unset and reads the vault', () => {
    writeVault({ feedback_inbox_blob_token: 'vault-token' });
    expect(resolve({ FEEDBACK_INBOX_BLOB_TOKEN: '   ' })).toEqual({ token: 'vault-token', source: 'vault' });
  });

  it('honours a configured vault key name', () => {
    writeVault({ feedback_inbox_blob_token: 'default-key', 'feedback.inbox': 'custom-key' });
    expect(resolve({}, 'feedback.inbox')).toEqual({ token: 'custom-key', source: 'vault' });
  });

  it('none when there is no vault and no env var', () => {
    expect(resolve({})).toEqual({ token: null, source: 'none' });
  });

  it('none when the vault lacks the key, holds a blank, or holds a non-string', () => {
    writeVault({ other: 'x' });
    expect(resolve({})).toEqual({ token: null, source: 'none' });
    writeVault({ feedback_inbox_blob_token: '  ' });
    expect(resolve({})).toEqual({ token: null, source: 'none' });
    writeVault({ feedback_inbox_blob_token: { nested: 'object' } });
    expect(resolve({})).toEqual({ token: null, source: 'none' });
  });

  it('an undecryptable vault resolves to none with vaultError, never throws', () => {
    writeVault({ feedback_inbox_blob_token: 'secret-value-xyz' });
    fs.writeFileSync(path.join(dir, 'secrets', 'config.secrets.enc'), Buffer.from('not-an-encrypted-vault'));
    const result = resolve({});
    expect(result).toEqual({ token: null, source: 'none', vaultError: true });
  });

  it('does not read the vault at all when env supplies the token', () => {
    // A corrupt vault would set vaultError if it were read.
    writeVault({ feedback_inbox_blob_token: 'v' });
    fs.writeFileSync(path.join(dir, 'secrets', 'config.secrets.enc'), Buffer.from('garbage'));
    expect(resolve({ FEEDBACK_INBOX_BLOB_TOKEN: 'env-token' })).toEqual({ token: 'env-token', source: 'env' });
  });
});
