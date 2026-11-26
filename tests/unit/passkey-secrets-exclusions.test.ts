import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BackupManager } from '../../src/core/BackupManager.js';
import { isNeverServed } from '../../src/server/fileRoutes.js';
import { DEFAULT_GITIGNORE } from '../../src/core/GitStateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Spec docs/specs/agent-held-google-passkey.md §3.1 "Exclusions, each verified by a
// test": the secrets tree (shared vault, passkey store, pending mint records, passkey
// browser profiles) is never backed up, never served by the file viewer, and never
// committed. (The working-set carrier refusal is covered in WorkingSetManifest.test.ts.)

describe('secrets tree exclusions', () => {
  let d: string;
  beforeEach(() => {
    d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-excl-'));
    fs.mkdirSync(path.join(d, 'secrets', 'passkeys', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(d, 'secrets', 'passkeys', 'profiles', 'cell'), { recursive: true });
    fs.writeFileSync(path.join(d, 'secrets', 'passkeys', 'store.enc'), 'X');
    fs.writeFileSync(path.join(d, 'secrets', 'passkeys', 'pending', 'a.enc'), 'X');
    fs.writeFileSync(path.join(d, 'secrets', 'passkeys', 'profiles', 'cell', 'Cookies'), 'X');
    fs.writeFileSync(path.join(d, 'secrets', 'config.secrets.enc'), 'X');
    fs.writeFileSync(path.join(d, 'AGENT.md'), 'a');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/passkey-secrets-exclusions.test.ts:afterEach' });
  });

  it.each([
    [['secrets/passkeys/store.enc']],
    [['secrets/passkeys/']],
    [['secrets/passkeys/pending/a.enc']],
    [['secrets/config.secrets.enc']],
    [['secrets/']],
    [['./secrets/passkeys/']],
    [['Secrets/passkeys/store.enc']],
  ])('BackupManager never snapshots the secrets tree, even when named directly: %j', (includeFiles) => {
    const snap = new BackupManager(d, { includeFiles } as never).createSnapshot('manual' as never);
    expect(snap.files.filter((f) => f.includes('secrets'))).toEqual([]);
    expect(snap.files).toContain('AGENT.md'); // the snapshot still ran
  });

  it.each([
    '.instar/secrets/passkeys/store.enc',
    '.instar/secrets/passkeys/pending/a.enc',
    '.instar/secrets/passkeys/profiles/cell/Cookies',
    '.instar/secrets/passkeys/index.json',
    '.INSTAR/Secrets/Passkeys/store.enc',
  ])('the file viewer never serves %s', (p) => {
    expect(isNeverServed(p)).toBe(true);
  });

  it('new agents ignore the whole secrets tree in their state repo', () => {
    expect(DEFAULT_GITIGNORE.split('\n').map((l) => l.trim())).toContain('secrets/');
  });
});
