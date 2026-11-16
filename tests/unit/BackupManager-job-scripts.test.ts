/**
 * BackupManager — script-class jobs keep their executable across a restore.
 *
 * Reported defect: a snapshot carried jobs.json but not `.instar/scripts`,
 * so a restored script job was registered but failed at exec. A snapshot
 * must capture managed job scripts, and a restore must name every job whose
 * executable it could not bring back.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BackupManager } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('BackupManager job script coverage', () => {
  let projectDir: string;
  let stateDir: string;
  let isolatedProject: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backup-scripts-'));
    isolatedProject = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backup-scripts-restore-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'silos', 'paperless', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'scripts', 'sweep.sh'), '#!/bin/sh\necho sweep\n', { mode: 0o755 });
    fs.writeFileSync(path.join(stateDir, 'silos', 'paperless', 'scripts', 'backup.sh'), '#!/bin/sh\necho backup\n', { mode: 0o755 });
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify([
      { slug: 'sweep', schedule: '0 * * * *', enabled: true, execute: { type: 'script', value: '.instar/scripts/sweep.sh' } },
      { slug: 'paperless-backup', schedule: '0 * * * *', enabled: true, execute: { type: 'script', value: 'bash .instar/silos/paperless/scripts/backup.sh', args: '--full' } },
      { slug: 'external', schedule: '0 * * * *', enabled: true, execute: { type: 'script', value: '/opt/elsewhere/run.sh' } },
      { slug: 'gone', schedule: '0 * * * *', enabled: true, execute: { type: 'script', value: '.instar/scripts/never-existed.sh' } },
      { slug: 'reflect', schedule: '0 * * * *', enabled: true, execute: { type: 'prompt', value: 'reflect on the day' } },
    ], null, 2));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/BackupManager-job-scripts.test.ts:cleanup' });
    SafeFsExecutor.safeRmSync(isolatedProject, { recursive: true, force: true, operation: 'tests/unit/BackupManager-job-scripts.test.ts:cleanup' });
  });

  it('snapshot captures managed job scripts and restore reports jobs whose executable was not captured', () => {
    const snapshot = new BackupManager(stateDir).createSnapshot('manual');

    // The managed scripts directory and a silo script a job points at are captured.
    expect(snapshot.files).toContain(path.join('scripts', 'sweep.sh'));
    expect(snapshot.files).toContain(path.join('silos', 'paperless', 'scripts', 'backup.sh'));

    // The manifest records which job executables the snapshot could not hold.
    const missingAtSnapshot = (snapshot.uncapturedExecutables ?? []).map((u) => u.slug).sort();
    expect(missingAtSnapshot).toEqual(['external', 'gone']);

    // Restore into an isolated environment that has nothing but the snapshot.
    const isolatedState = path.join(isolatedProject, '.instar');
    fs.mkdirSync(path.join(isolatedState, 'backups'), { recursive: true });
    fs.cpSync(path.join(stateDir, 'backups', snapshot.id), path.join(isolatedState, 'backups', snapshot.id), { recursive: true });

    const report = new BackupManager(isolatedState).restoreSnapshot(snapshot.id);

    const restoredScript = path.join(isolatedState, 'scripts', 'sweep.sh');
    expect(fs.existsSync(restoredScript)).toBe(true);
    expect(fs.statSync(restoredScript).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(isolatedState, 'silos', 'paperless', 'scripts', 'backup.sh'))).toBe(true);

    expect(report).toBeDefined();
    const missingAfterRestore = (report?.jobsMissingExecutable ?? []).map((j) => j.slug).sort();
    expect(missingAfterRestore).toEqual(['external', 'gone']);
  });
});
