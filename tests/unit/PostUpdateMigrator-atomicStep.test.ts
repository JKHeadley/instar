/**
 * Unit tests for the F-7 atomic-step primitive on `PostUpdateMigrator`.
 *
 * Spec: docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md §R1 (Upgrade
 * invariants) + §A35 + §A50 + §A57 Tier-2.
 *
 * Covers:
 *   1. New step runs once and records completion in the ledger.
 *   2. Already-completed step is skipped on subsequent runs.
 *   3. Failed step records a failure entry AND does not block other steps.
 *   4. Step whose version is newer than `toVersion` is skipped (and not
 *      recorded — it will run on a later upgrade boundary).
 *   5. State persists across PostUpdateMigrator instances (ledger lives
 *      on disk at `<stateDir>/migrator-steps-completed.json`).
 *
 * Cleanup uses `SafeFsExecutor.safeRmSync` per the F-7 brief.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import type { MigratorStep, MigratorContext } from '../../src/core/MigratorStepEngine.js';
import { compareSemver } from '../../src/core/MigratorStepEngine.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function buildMigrator(projectDir: string): PostUpdateMigrator {
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return new PostUpdateMigrator({
    projectDir,
    stateDir,
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

describe('PostUpdateMigrator.runPendingSteps (F-7 atomic-step primitive)', () => {
  let projectDir: string;
  let stateDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-f7-atomicstep-'));
    stateDir = path.join(projectDir, '.instar');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-atomicStep.test.ts:afterEach',
    });
  });

  it('1. runs a new step once and records completion in the ledger', async () => {
    const migrator = buildMigrator(projectDir);
    let runCount = 0;
    const step: MigratorStep = {
      name: 'test-step-completes',
      version: '1.0.0',
      run: async (_ctx: MigratorContext) => {
        runCount++;
        return { outcome: 'completed', details: 'did the thing' };
      },
    };
    migrator.registerStep(step);

    const report = await migrator.runPendingSteps('0.9.0', '1.0.0');

    expect(runCount).toBe(1);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({
      name: 'test-step-completes',
      outcome: 'completed',
      details: 'did the thing',
    });

    // Ledger written.
    const ledgerPath = path.join(stateDir, 'migrator-steps-completed.json');
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    expect(ledger['1.0.0:test-step-completes']).toMatchObject({
      outcome: 'completed',
      details: 'did the thing',
    });
    expect(ledger['1.0.0:test-step-completes'].recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('2. skips an already-completed step on subsequent runs', async () => {
    const migrator = buildMigrator(projectDir);
    let runCount = 0;
    migrator.registerStep({
      name: 'test-step-once',
      version: '1.0.0',
      run: async () => {
        runCount++;
        return { outcome: 'completed' };
      },
    });

    await migrator.runPendingSteps('0.9.0', '1.0.0');
    expect(runCount).toBe(1);

    // Second invocation — step body must not re-run.
    const report = await migrator.runPendingSteps('0.9.0', '1.0.0');
    expect(runCount).toBe(1);
    expect(report.steps[0].outcome).toBe('skipped');
    expect(report.steps[0].details).toBe('already-recorded:completed');
  });

  it('3. records a failed step AND does not block subsequent steps', async () => {
    const migrator = buildMigrator(projectDir);
    let step3Ran = false;
    migrator.registerStep({
      name: 'failing-step',
      version: '1.0.0',
      run: async () => {
        throw new Error('boom');
      },
    });
    migrator.registerStep({
      name: 'failing-via-outcome',
      version: '1.0.0',
      run: async () => ({ outcome: 'failed', details: 'I tried' }),
    });
    migrator.registerStep({
      name: 'subsequent-step',
      version: '1.0.0',
      run: async () => {
        step3Ran = true;
        return { outcome: 'completed' };
      },
    });

    const report = await migrator.runPendingSteps('0.9.0', '1.0.0');

    // Subsequent step still ran — the failure did not abort the engine.
    expect(step3Ran).toBe(true);

    // All three outcomes surfaced in the report.
    expect(report.steps).toHaveLength(3);
    expect(report.steps[0]).toMatchObject({ name: 'failing-step', outcome: 'failed' });
    expect(report.steps[0].details).toMatch(/threw: boom/);
    expect(report.steps[1]).toMatchObject({
      name: 'failing-via-outcome',
      outcome: 'failed',
      details: 'I tried',
    });
    expect(report.steps[2]).toMatchObject({
      name: 'subsequent-step',
      outcome: 'completed',
    });

    // Ledger captured all three outcomes — failed steps are NOT retried
    // on subsequent runs (operator must intervene).
    const ledger = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'migrator-steps-completed.json'), 'utf-8'),
    );
    expect(ledger['1.0.0:failing-step'].outcome).toBe('failed');
    expect(ledger['1.0.0:failing-via-outcome'].outcome).toBe('failed');
    expect(ledger['1.0.0:subsequent-step'].outcome).toBe('completed');

    // Re-run: failing steps stay failed-not-rerun.
    const report2 = await migrator.runPendingSteps('0.9.0', '1.0.0');
    for (const s of report2.steps) {
      expect(s.outcome).toBe('skipped');
    }
  });

  it('4. skips a step whose version > toVersion and does NOT record it', async () => {
    const migrator = buildMigrator(projectDir);
    let runCount = 0;
    migrator.registerStep({
      name: 'future-step',
      version: '2.0.0',
      run: async () => {
        runCount++;
        return { outcome: 'completed' };
      },
    });

    const report = await migrator.runPendingSteps('0.9.0', '1.5.0');

    expect(runCount).toBe(0);
    expect(report.steps[0].outcome).toBe('skipped');
    expect(report.steps[0].details).toMatch(/future-version/);

    // Ledger must not record a future-version skip — when the agent
    // eventually upgrades past 2.0.0 the step needs to fire.
    const ledgerPath = path.join(stateDir, 'migrator-steps-completed.json');
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
      expect(ledger['2.0.0:future-step']).toBeUndefined();
    }

    // Now bump toVersion past the step's version — it must run.
    const report2 = await migrator.runPendingSteps('1.5.0', '2.0.0');
    expect(runCount).toBe(1);
    expect(report2.steps[0].outcome).toBe('completed');
  });

  it('5. state persists across PostUpdateMigrator instances', async () => {
    // First instance — register and run.
    const migrator1 = buildMigrator(projectDir);
    let runCount = 0;
    const stepFactory = (name: string): MigratorStep => ({
      name,
      version: '1.0.0',
      run: async () => {
        runCount++;
        return { outcome: 'completed' };
      },
    });
    migrator1.registerStep(stepFactory('persisted-step'));
    await migrator1.runPendingSteps('0.9.0', '1.0.0');
    expect(runCount).toBe(1);

    // Brand-new instance pointed at the same stateDir — step body must
    // not re-run because the ledger is on disk.
    const migrator2 = buildMigrator(projectDir);
    migrator2.registerStep(stepFactory('persisted-step'));
    const report = await migrator2.runPendingSteps('0.9.0', '1.0.0');

    expect(runCount).toBe(1); // unchanged
    expect(report.steps[0].outcome).toBe('skipped');
    expect(report.steps[0].details).toBe('already-recorded:completed');
  });
});

describe('compareSemver (engine internals)', () => {
  it('compares major.minor.patch correctly', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
    expect(compareSemver('1.1.0', '1.0.99')).toBe(1);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
  });

  it('treats release > pre-release on the same triple', () => {
    expect(compareSemver('1.0.0', '1.0.0-rc1')).toBe(1);
    expect(compareSemver('1.0.0-rc1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0-rc1', '1.0.0-rc2')).toBe(-1);
  });

  it('treats unparseable as -Infinity (cannot block step execution)', () => {
    // fromVersion of '' (fresh install) must be < any real version.
    expect(compareSemver('', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', 'not-a-version')).toBe(1);
  });
});
