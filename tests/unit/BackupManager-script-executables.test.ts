/**
 * Script-class jobs and backups: a snapshot that keeps jobs.json but not the
 * executables its script jobs run is a snapshot of pointers. The snapshot must
 * capture the managed scripts, and a restore must name every script job whose
 * executable the snapshot did not hold.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BackupManager } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function writeExecutable(file: string, body = '#!/bin/sh\necho ok\n'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function scriptJob(slug: string, value: string): Record<string, unknown> {
  return { slug, name: slug, schedule: '0 * * * *', enabled: true, execute: { type: 'script', value } };
}

describe('BackupManager — script-class job executables', () => {
  let root: string;
  let projectDir: string;
  let stateDir: string;
  let outsideDir: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backup-scripts-test-')));
    projectDir = path.join(root, 'project');
    stateDir = path.join(projectDir, '.instar');
    outsideDir = path.join(root, 'outside');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/BackupManager-script-executables.test.ts:afterEach' });
  });

  function writeJobs(jobs: unknown[]): void {
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify(jobs, null, 2));
  }

  it('snapshot captures the .instar/scripts executables of script jobs and restore brings them back', () => {
    writeExecutable(path.join(stateDir, 'scripts', 'stale-sweep.sh'));
    writeExecutable(path.join(stateDir, 'scripts', 'tls-expiry-watch.sh'));
    writeExecutable(path.join(stateDir, 'silos', 'paperless-ngx', 'scripts', 'backup.sh'));
    writeJobs([
      scriptJob('stale-sweep', 'bash .instar/scripts/stale-sweep.sh'),
      scriptJob('tls-expiry-watch', '.instar/scripts/tls-expiry-watch.sh --days 14'),
      scriptJob('paperless-backup', '.instar/silos/paperless-ngx/scripts/backup.sh'),
    ]);

    const mgr = new BackupManager(stateDir);
    const snap = mgr.createSnapshot('manual');
    expect(snap.files).toContain('jobs.json');
    expect(snap.files).toContain('scripts/stale-sweep.sh');
    expect(snap.files).toContain('scripts/tls-expiry-watch.sh');
    expect(snap.files).toContain('silos/paperless-ngx/scripts/backup.sh');

    // Lose the scripts, then restore.
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'scripts'), { recursive: true, force: true, operation: 'tests/unit/BackupManager-script-executables.test.ts:lose' });
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'silos'), { recursive: true, force: true, operation: 'tests/unit/BackupManager-script-executables.test.ts:lose' });

    const report = mgr.restoreSnapshot(snap.id);
    const restored = path.join(stateDir, 'scripts', 'stale-sweep.sh');
    expect(fs.existsSync(restored)).toBe(true);
    expect(fs.statSync(restored).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(stateDir, 'silos', 'paperless-ngx', 'scripts', 'backup.sh'))).toBe(true);
    expect(report?.uncapturedExecutables ?? []).toEqual([]);
  });

  it('restore reports script jobs whose executable the snapshot did not capture, even when the file exists here', () => {
    const external = path.join(outsideDir, 'external-tool.sh');
    writeExecutable(external);
    writeExecutable(path.join(stateDir, 'scripts', 'ok.sh'));
    writeJobs([
      scriptJob('ok-job', '.instar/scripts/ok.sh'),
      scriptJob('external-job', `"${external}" --flag`),
      scriptJob('missing-job', '.instar/scripts/never-written.sh'),
    ]);

    const mgr = new BackupManager(stateDir);
    const snap = mgr.createSnapshot('manual');
    const recorded = (snap as unknown as { scriptExecutables?: Array<{ slug: string; captured: boolean }> }).scriptExecutables;
    expect(recorded?.find((e) => e.slug === 'ok-job')?.captured).toBe(true);
    expect(recorded?.find((e) => e.slug === 'external-job')?.captured).toBe(false);

    const report = mgr.restoreSnapshot(snap.id);
    const slugs = (report?.uncapturedExecutables ?? []).map((e) => e.slug).sort();
    // external-job's file still exists on this machine; it is reported anyway,
    // because the snapshot never held it.
    expect(slugs).toEqual(['external-job', 'missing-job']);
  });

  it('resolves quoted executable paths containing spaces', () => {
    writeExecutable(path.join(stateDir, 'silos', 'my silo', 'run job.sh'));
    writeJobs([scriptJob('spaced', 'bash ".instar/silos/my silo/run job.sh" --now')]);

    const mgr = new BackupManager(stateDir);
    const snap = mgr.createSnapshot('manual');
    expect(snap.files).toContain('silos/my silo/run job.sh');
    expect(mgr.restoreSnapshot(snap.id)?.uncapturedExecutables ?? ['unset']).toEqual([]);
  });

  it('never follows a symlinked parent directory out of the state directory', () => {
    writeExecutable(path.join(outsideDir, 'scripts', 'secret.sh'), '#!/bin/sh\necho outside\n');
    fs.mkdirSync(path.join(stateDir, 'silos'), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(stateDir, 'silos', 'linked'));
    writeJobs([scriptJob('linked-job', '.instar/silos/linked/scripts/secret.sh')]);

    const mgr = new BackupManager(stateDir);
    const snap = mgr.createSnapshot('manual');
    expect(snap.files.some((f) => f.includes('secret.sh'))).toBe(false);
    const report = mgr.restoreSnapshot(snap.id);
    expect((report?.uncapturedExecutables ?? []).map((e) => e.slug)).toEqual(['linked-job']);
  });
});
