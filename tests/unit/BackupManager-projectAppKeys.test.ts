/**
 * Project apps part 2 (docs/specs/project-apps-sandbox.md §3.2 "App keys"): the per-machine app key
 * file `state/project-app-keys.json` is never backed up, whatever the include setting — a restored
 * backup must not be able to read data the owner erased.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BackupManager } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('BackupManager — project app key file is never backed up', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-pa-keys-'));
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'project-app-keys.json'), '{"v":1,"apps":{"pa_0123456789abcdef":{}}}');
    fs.writeFileSync(path.join(stateDir, 'state', 'other.json'), '{}');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/BackupManager-projectAppKeys.test.ts' });
  });

  it('skips the key file named directly in includeFiles', () => {
    const bm = new BackupManager(stateDir, { includeFiles: ['state/project-app-keys.json', 'AGENT.md'] });
    const snap = bm.createSnapshot('manual');
    expect(snap.files).toContain('AGENT.md');
    expect(snap.files.some((f) => f.includes('project-app-keys'))).toBe(false);
  });

  it('skips the key file inside an included state/ directory', () => {
    const bm = new BackupManager(stateDir, { includeFiles: ['state/'] });
    const snap = bm.createSnapshot('manual');
    const dir = path.join(stateDir, 'backups', snap.id);
    expect(fs.existsSync(path.join(dir, 'state', 'other.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'state', 'project-app-keys.json'))).toBe(false);
  });
});
