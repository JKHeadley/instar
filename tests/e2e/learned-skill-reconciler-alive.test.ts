/**
 * E2E lifecycle for the LearnedSkillReconciler — Tier 3 of the Testing
 * Integrity Standard (skill-learning-sentinel §3.2, decisions 19/28):
 *
 *  1. ALIVE: the reconciler constructed with the SAME dependency shape the
 *     production boot path in src/commands/server.ts uses (projectDir,
 *     stateDir, machineId, live enabledFrameworks + kill-switch readers, the
 *     tickMinutes config knob) runs `reconcileAll('boot')` against a real
 *     agent home and renders a pulled learned canonical into both layouts —
 *     not a stub, not a 503-shaped no-op.
 *  2. WIRED (dead-code guard): server.ts constructs it, runs the boot pass,
 *     starts the tick, hands the boot pull its `reconcileAll('pull')`, and
 *     SyncOrchestrator exposes the `onPulled` seam at its own sync() call site.
 *     The reconciler has no HTTP route (by design — it is a repair of existing
 *     design, surfaced through the sentinel's routes in slice 1), so the
 *     source check is what proves the boot path reaches it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LearnedSkillReconciler } from '../../src/monitoring/LearnedSkillReconciler.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('LearnedSkillReconciler E2E — alive on the production init path', () => {
  let projectDir: string;
  let stateDir: string;
  let reconciler: LearnedSkillReconciler;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsr-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'skills/weekly-ci-health'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ projectDir, stateDir, port: 0, monitoring: { skillLearning: { enabled: false, tickMinutes: 7 } } }),
    );
    fs.writeFileSync(
      path.join(stateDir, 'skills/weekly-ci-health/SKILL.md'),
      '---\nname: weekly-ci-health\ndescription: "Use when the operator asks for the weekly CI health."\nmetadata:\n  instar-learned-origin: "skill-learning-sentinel"\n---\n# Weekly CI health\n',
    );
    // Mirror server.ts: live config readers, the enabledFrameworks fallback,
    // and the machine id from identity (hostname fallback when not paired).
    const config = { projectDir, stateDir, enabledFrameworks: ['claude-code', 'codex-cli'] } as unknown as InstarConfig;
    const liveConfig = new LiveConfig(stateDir, {});
    reconciler = new LearnedSkillReconciler({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      machineId: os.hostname(),
      enabledFrameworks: () => config.enabledFrameworks ?? config.sessions?.enabledFrameworks,
      reconcileEnabled: () => liveConfig.get<boolean>('monitoring.skillLearning.reconcile.enabled', true) !== false,
      tickMinutes: liveConfig.get<number>('monitoring.skillLearning.tickMinutes', 10),
    });
  });

  afterAll(() => {
    reconciler.stop();
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/learned-skill-reconciler-alive.test.ts' });
  });

  it('reconcileAll("boot") renders the learned canonical even though monitoring.skillLearning.enabled is false', async () => {
    const run = await reconciler.reconcileAll('boot');
    expect(run.inert).toBeUndefined();
    expect(run.learned).toBe(1);
    expect(run.rendered).toBe(2);
    expect(fs.existsSync(path.join(projectDir, '.claude/skills/weekly-ci-health/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.agents/skills/weekly-ci-health/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.agents/skills/weekly-ci-health/agents/openai.yaml'))).toBe(true);
    const status = reconciler.status();
    expect(status.lastRun?.reason).toBe('boot');
    expect(status.tickMinutes).toBe(7); // the config knob reached the live component
    expect(fs.existsSync(path.join(stateDir, 'skill-learning/rendered-baselines', `${os.hostname()}.json`))).toBe(true);
  });

  it('start() then a pull-reason reconcile on the live component is a zero-write pass once in sync', async () => {
    reconciler.start();
    const run = await reconciler.reconcileAll('pull');
    expect(run.rendered).toBe(0);
    expect(run.skipped).toBe(2);
    expect(reconciler.status().runs).toBe(2);
  });
});

describe('LearnedSkillReconciler E2E — WIRED into the boot path (dead-code guard)', () => {
  const serverSrc = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
  const orchestratorSrc = fs.readFileSync(path.join(process.cwd(), 'src/core/SyncOrchestrator.ts'), 'utf-8');

  it('server.ts constructs the reconciler with the live kill switch and the tick knob', () => {
    expect(serverSrc).toContain('new LearnedSkillReconciler({');
    expect(serverSrc).toContain("'monitoring.skillLearning.reconcile.enabled'");
    expect(serverSrc).toContain("'monitoring.skillLearning.tickMinutes'");
  });

  it('server.ts runs the boot pass and starts the tick', () => {
    expect(serverSrc).toMatch(/learnedSkillReconciler\.reconcileAll\('boot'\)/);
    expect(serverSrc).toMatch(/learnedSkillReconciler\.start\(\)/);
  });

  it('server.ts hands the boot pull its reconcile when commits were pulled', () => {
    const idx = serverSrc.indexOf("learnedSkillReconciler.reconcileAll('pull')");
    expect(idx).toBeGreaterThan(0);
    const window = serverSrc.slice(Math.max(0, idx - 400), idx);
    expect(window).toContain('await gitSync.sync()');
    expect(window).toContain('syncResult.pulled');
  });

  it('SyncOrchestrator exposes onPulled at its sync() call site', () => {
    expect(orchestratorSrc).toContain('onPulled?: (result: SyncResult) => void;');
    const idx = orchestratorSrc.indexOf('this.onPulled(syncResult)');
    expect(idx).toBeGreaterThan(0);
    expect(orchestratorSrc.slice(Math.max(0, idx - 300), idx)).toContain('await this.gitSync.sync()');
  });

  it('the reconciler is registered as a self-action controller (convergence ratchet)', () => {
    const reconcilerSrc = fs.readFileSync(path.join(process.cwd(), 'src/monitoring/LearnedSkillReconciler.ts'), 'utf-8');
    expect(reconcilerSrc).toContain('@self-action-controller: learned-skill-reconciler');
    const registrySrc = fs.readFileSync(path.join(process.cwd(), 'src/testing/selfActionRegistry.ts'), 'utf-8');
    expect(registrySrc).toContain("id: 'learned-skill-reconciler'");
    // No CALL to removeOrphans (the prose mention in its header is not a call).
    expect(reconcilerSrc).not.toMatch(/\.removeOrphans\s*\(/);
  });
});
