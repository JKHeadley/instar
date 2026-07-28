/**
 * Vault-backed GitHub token resolution (Phase-3 increment P3b, option C —
 * per-agent credential isolation, CMT-1125 gap 1).
 *
 * Exercises resolveGhTokenFromVault against a REAL SecretStore on disk: both
 * canonical key paths, precedence, trimming, and every failure shape resolving
 * to null WITHOUT throwing (session spawning must never depend on vault
 * health). Vaults are written with forceFileKey so tests never touch the real
 * keychain; one test reads through the production path (no forceFileKey) to
 * prove the dual-key file-candidate read (CMT-1038) covers it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resolveGhTokenFromVault, GH_TOKEN_VAULT_KEYS } from '../../src/core/ghToken.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghtok-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/gh-token-vault.test.ts' }); });

function writeVault(entries: Record<string, unknown>): void {
  const store = new SecretStore({ stateDir: dir, forceFileKey: true });
  for (const [k, v] of Object.entries(entries)) store.set(k, v);
}

describe('resolveGhTokenFromVault', () => {
  it('resolves the canonical flat github_token key', () => {
    writeVault({ github_token: 'ghp_flat_token_value' });
    expect(resolveGhTokenFromVault(dir, { forceFileKey: true })).toBe('ghp_flat_token_value');
  });

  it('resolves the nested github.token variant', () => {
    writeVault({ 'github.token': 'ghp_nested_token_value' });
    expect(resolveGhTokenFromVault(dir, { forceFileKey: true })).toBe('ghp_nested_token_value');
  });

  it('flat github_token takes precedence over the nested variant (documented key order)', () => {
    writeVault({ github_token: 'ghp_flat_wins', 'github.token': 'ghp_nested_loses' });
    expect(GH_TOKEN_VAULT_KEYS[0]).toBe('github_token');
    expect(resolveGhTokenFromVault(dir, { forceFileKey: true })).toBe('ghp_flat_wins');
  });

  it('trims surrounding whitespace from the stored token', () => {
    writeVault({ github_token: '  ghp_padded_token  \n' });
    expect(resolveGhTokenFromVault(dir, { forceFileKey: true })).toBe('ghp_padded_token');
  });

  it('returns null when no vault exists (machine-global gh behavior preserved)', () => {
    expect(resolveGhTokenFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('returns null when the vault has secrets but no GitHub token', () => {
    writeVault({ 'telegram.token': 'tg-something' });
    expect(resolveGhTokenFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('returns null for an empty or whitespace-only stored value', () => {
    writeVault({ github_token: '   ' });
    expect(resolveGhTokenFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('returns null for a non-string value at the key', () => {
    writeVault({ github_token: { oops: 'object' } });
    expect(resolveGhTokenFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('returns null (never throws) when the vault file is corrupt', () => {
    writeVault({ github_token: 'ghp_will_be_corrupted' });
    const encPath = path.join(dir, 'secrets', 'config.secrets.enc');
    fs.writeFileSync(encPath, Buffer.from('not-an-encrypted-vault'));
    expect(() => resolveGhTokenFromVault(dir, { forceFileKey: true })).not.toThrow();
    expect(resolveGhTokenFromVault(dir, { forceFileKey: true })).toBeNull();
  });

  it('production path (no forceFileKey) still reads a file-keyed vault via the dual-key candidates', () => {
    writeVault({ github_token: 'ghp_prod_path_token' });
    // No forceFileKey here — the resolver tries the keychain candidate first
    // (absent for this throwaway stateDir) and reads via the file key
    // candidate, the CMT-1038 dual-key guarantee.
    expect(resolveGhTokenFromVault(dir)).toBe('ghp_prod_path_token');
  });
});
