/**
 * E2E — Graduated Feature Rollout on the PRODUCTION path. THE dogfood proof:
 * the reconciler, fed by the real scanner over a fixture specs tree, populates
 * the InitiativeTracker on its own, and the entries are visible through the real
 * AgentServer `/initiatives` route — the "a spec appears on the board without
 * anyone hand-adding it" promise. Also asserts /capabilities surfaces
 * /initiatives (discoverability) and that a ships-staged spec becomes an active
 * rollout track whose stage is derived from the observed flag.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { FeatureRolloutReconciler } from '../../src/core/FeatureRolloutReconciler.js';
import { scanSpecArtifactsWithCanonicalAsync, makeFlagObserver } from '../../src/core/featureRolloutScan.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Asynchronous rollout discovery on the initialized HTTP lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let tracker: InitiativeTracker;
  let reconciler: FeatureRolloutReconciler;
  const AUTH = 'test-e2e-graduated-rollout';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grollout-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'instar-dev-traces'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    // ── Fixture specs (the dogfood inputs) ──
    // 1) An approved+merged ships-staged feature (the SessionReaper-retroactive case).
    fs.writeFileSync(path.join(tmpDir, 'docs', 'specs', 'SAMPLE-REAPER-SPEC.md'),
      '---\napproved: true\nreview-convergence: "x"\nships-staged: true\nrollout-flag-path: monitoring.sampleReaper\nrollout-criteria: 2wk clean\n---\n# Sample Reaper');
    fs.writeFileSync(path.join(stateDir, 'instar-dev-traces', 'r.json'),
      JSON.stringify({ phase: 'complete', specPath: 'docs/specs/SAMPLE-REAPER-SPEC.md', prNumber: 393, createdAt: new Date().toISOString() }));
    // 2) A plain approved+merged spec (no rollout) — registers, recent ⇒ active.
    fs.writeFileSync(path.join(tmpDir, 'docs', 'specs', 'PLAIN-SPEC.md'), '---\napproved: true\n---\n# Plain');
    fs.writeFileSync(path.join(stateDir, 'instar-dev-traces', 'p.json'),
      JSON.stringify({ phase: 'complete', specPath: 'docs/specs/PLAIN-SPEC.md', createdAt: new Date().toISOString() }));

    tracker = new InitiativeTracker(stateDir);
    // Live config: the feature is enabled in watch-only (dry-run).
    const liveConfig = { monitoring: { sampleReaper: { enabled: true, dryRun: true } } };
    const shippedDefaults = { monitoring: { sampleReaper: { enabled: false } } };
    reconciler = new FeatureRolloutReconciler({
      tracker,
      listSpecArtifacts: (signal) => scanSpecArtifactsWithCanonicalAsync(tmpDir, { canonicalRefScanEnabled: false }, Date.now, signal),
      observeFlag: makeFlagObserver(liveConfig, shippedDefaults),
    });
    await reconciler.reconcile(); // the auto-population — no hand-adding

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    };
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), initiativeTracker: tracker });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await reconciler.stop();
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/rollout-async-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('DOGFOOD: an approved+merged spec appears on the board without being hand-added', async () => {
    const res = await request(app).get('/initiatives').set(auth());
    expect(res.status).toBe(200);
    const ids = (res.body.items ?? res.body).map((i: { id: string }) => i.id);
    expect(ids).toContain('sample-reaper-spec');
    expect(ids).toContain('plain-spec');
  });

  it('the ships-staged feature is an active rollout track at the observed (dry-run) stage', async () => {
    const res = await request(app).get('/initiatives/sample-reaper-spec').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('task');
    expect(res.body.pipelineStage).toBe('merged');
    expect(res.body.rollout?.stage).toBe('dry-run');
    expect(res.body.status).toBe('active');
  });

  it('discoverability: /capabilities surfaces the initiatives endpoint', async () => {
    const res = await request(app).get('/capabilities').set(auth());
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body).toLowerCase()).toContain('initiatives');
  });
});


describe('actual startup and shutdown own the asynchronous discovery dependency', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
  it('injects the actual async scanner and forwards its cancellation signal', () => {
    const start = source.indexOf('const featureRolloutReconciler = new FeatureRolloutReconciler(');
    const end = source.indexOf('// Project-scope Phase 1b', start);
    const block = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('scanSpecArtifactsWithCanonicalAsync(config.projectDir');
    expect(block).toContain('}, Date.now, signal)');
    expect(block).not.toContain('scanSpecArtifactsWithCanonical(config.projectDir');
    expect(block).not.toContain('runRolloutReconcile();');
  });
  it('starts observations only once signals and restart-triggered shutdown are owned', () => {
    const owner = source.indexOf("restartWatcher.on('restartDetected', shutdown)");
    const launch = source.indexOf('runRolloutReconcile();', owner);
    expect(owner).toBeGreaterThan(source.indexOf("process.on('SIGTERM', shutdown)"));
    expect(launch).toBeGreaterThan(owner);
  });
  it('marks stopped before awaiting and arms the existing deadline before awaiting cleanup', () => {
    const shutdown = source.slice(source.indexOf('const shutdown = async () => {'));
    const stop = shutdown.indexOf('const rolloutStop = featureRolloutReconciler.stop()');
    const deadline = shutdown.indexOf('armShutdownDeadline({');
    const awaitStop = shutdown.indexOf('await rolloutStop');
    expect(stop).toBeGreaterThan(-1);expect(deadline).toBeGreaterThan(stop);expect(awaitStop).toBeGreaterThan(deadline);
    expect(awaitStop).toBeLessThan(shutdown.indexOf('await telegramOriginBoot?.close()'));
  });
});
