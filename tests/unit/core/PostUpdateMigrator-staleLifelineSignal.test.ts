/**
 * Tests for PostUpdateMigrator.migrateStaleLifelineSignal — the one-time
 * bootstrap that unsticks agents whose running lifeline is on a pre-
 * coordination version of instar.
 *
 * Spec: docs/specs/auto-updater-lifeline-coordination.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../../src/core/PostUpdateMigrator.js';
import { lifelineRestartSignalPath, readLifelineRestartSignal } from '../../../src/core/version-skew.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

function makeMigrator(stateDir: string) {
  return new PostUpdateMigrator({
    projectDir: path.dirname(stateDir),
    stateDir,
    hasTelegram: false,
    port: 4042,
  });
}

function writeLifelineStartedAt(stateDir: string, version: string | null): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const data = version === null ? {} : { startedAt: new Date().toISOString(), pid: 1234, version };
  fs.writeFileSync(path.join(stateDir, 'lifeline-started-at.json'), JSON.stringify(data));
}

// Read the migrator's own installed package version — it compares against this
// to decide whether to write the bootstrap signal.
function installedVersion(): string {
  const pkgPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version as string;
}

describe('PostUpdateMigrator.migrateStaleLifelineSignal', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-lifeline-mig-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/core/PostUpdateMigrator-staleLifelineSignal.test.ts:cleanup' }); } catch { /* ignore */ }
  });

  it('writes the bootstrap signal when lifeline is on an older major.minor', () => {
    // Use a clearly-old version that any current installed version crosses.
    writeLifelineStartedAt(stateDir, '0.0.1');
    const migrator = makeMigrator(stateDir);
    const result = migrator.migrate();

    const upgrade = result.upgraded.find(u => u.startsWith('stale-lifeline-signal'));
    expect(upgrade).toBeDefined();
    const signal = readLifelineRestartSignal(stateDir);
    expect(signal).not.toBeNull();
    expect(signal!.requestedBy).toBe('post-update-migrator-bootstrap');
    expect(signal!.reason).toBe('stale-lifeline-bootstrap');
    expect(signal!.previousVersion).toBe('0.0.1');
    expect(signal!.targetVersion).toBe(installedVersion());
  });

  it('skips when no lifeline-started-at.json exists', () => {
    const migrator = makeMigrator(stateDir);
    const result = migrator.migrate();
    const skip = result.skipped.find(s => s.startsWith('stale-lifeline-signal'));
    expect(skip).toBeDefined();
    expect(skip).toMatch(/no lifeline-started-at\.json/);
    expect(fs.existsSync(lifelineRestartSignalPath(stateDir))).toBe(false);
  });

  it('skips when lifeline is on the same major.minor as installed', () => {
    writeLifelineStartedAt(stateDir, installedVersion());
    const migrator = makeMigrator(stateDir);
    const result = migrator.migrate();
    const skip = result.skipped.find(s => s.startsWith('stale-lifeline-signal'));
    expect(skip).toBeDefined();
    expect(skip).toMatch(/same major\.minor/);
    expect(fs.existsSync(lifelineRestartSignalPath(stateDir))).toBe(false);
  });

  it('skips when lifeline-started-at.json has no version field', () => {
    writeLifelineStartedAt(stateDir, null);
    const migrator = makeMigrator(stateDir);
    const result = migrator.migrate();
    const skip = result.skipped.find(s => s.startsWith('stale-lifeline-signal'));
    expect(skip).toBeDefined();
    expect(skip).toMatch(/no version field/);
  });

  it('is idempotent — second run does not overwrite a fresh signal', () => {
    writeLifelineStartedAt(stateDir, '0.0.1');
    const m1 = makeMigrator(stateDir).migrate();
    expect(m1.upgraded.find(u => u.startsWith('stale-lifeline-signal'))).toBeDefined();
    const firstSignal = readLifelineRestartSignal(stateDir);

    // Second run — should observe the existing signal and skip-fresh.
    const m2 = makeMigrator(stateDir).migrate();
    const upgrade = m2.upgraded.find(u => u.startsWith('stale-lifeline-signal'));
    expect(upgrade).toMatch(/skipped-fresh/);

    const secondSignal = readLifelineRestartSignal(stateDir);
    expect(secondSignal).not.toBeNull();
    expect(secondSignal!.requestedAt).toBe(firstSignal!.requestedAt);
  });
});
