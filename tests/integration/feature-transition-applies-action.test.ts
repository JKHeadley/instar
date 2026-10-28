// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration — POST /features/:id/transition applies the feature's setting
 * change (spec feature-transition-applies-action §2.1–§2.5) through the real
 * route pipeline: createRoutes + a listening express server, so the loopback
 * request dials the same socket the transition arrived on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import type { FeatureDefinition } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createRoutes } from '../../src/server/routes.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const GOOD_PROOF = 'operator-proof-ok';

/** A feature whose action targets a key PATCH /config refuses — the refused path. */
const REFUSED_DEF: FeatureDefinition = {
  id: 'test-refused',
  name: 'Test Refused',
  category: 'infrastructure',
  featureVersion: '1.0.0',
  configPath: 'notPatchable',
  enableAction: { method: 'PATCH', path: '/config', body: { notPatchable: { enabled: true } } },
  disableAction: { method: 'PATCH', path: '/config', body: { notPatchable: { enabled: false } } },
  oneLiner: 'x', fullDescription: 'x', consentTier: 'local', dataImplications: [], reversibilityNote: 'x', discoveryTriggers: [],
};

describe('Integration: feature switch applies its setting', () => {
  let projectDir: string;
  let stateDir: string;
  let server: Server;
  let baseUrl: string;
  let registry: FeatureRegistry;
  const configPath = () => path.join(stateDir, 'config.json');
  const readConfig = () => JSON.parse(fs.readFileSync(configPath(), 'utf-8'));

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feature-apply-int-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    const rawConfig = { projectName: 'feature-apply-int', publishing: { enabled: false } };
    fs.writeFileSync(configPath(), JSON.stringify(rawConfig));

    const config: InstarConfig = {
      projectDir, stateDir, projectName: 'feature-apply-int', agentName: 'test-agent', port: 0, authToken: 'tok',
      sessions: { maxConcurrent: 2, defaultModel: 'sonnet' }, scheduler: { enabled: false }, users: [], messaging: [],
      monitoring: { healthCheck: { enabled: false } }, publishing: { enabled: false },
    } as unknown as InstarConfig;

    registry = new FeatureRegistry(stateDir);
    await registry.open();
    for (const def of BUILTIN_FEATURES) registry.register(def);
    registry.register(REFUSED_DEF);
    registry.bootstrap(rawConfig);

    const app = express();
    app.use(express.json());
    const router = createRoutes({
      config, state: new StateManager(stateDir), sessionManager: null as any, scheduler: null, telegram: null, relationships: null,
      feedback: null, dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null, triageNurse: null, topicMemory: null,
      feedbackAnomalyDetector: null, projectMapper: null, coherenceGate: null, contextHierarchy: null, canonicalState: null,
      operationGate: null, sentinel: null, adaptiveTrust: null, memoryMonitor: null, orphanReaper: null, coherenceMonitor: null,
      commitmentTracker: null, semanticMemory: null, activitySentinel: null, messageRouter: null, summarySentinel: null,
      spawnManager: null, workingMemory: null, quotaManager: null, systemReviewer: null, capabilityMapper: null,
      selfKnowledgeTree: null, coverageAuditor: null, topicResumeMap: null, autonomyManager: null, trustElevationTracker: null,
      autonomousEvolution: null, whatsapp: null, messageBridge: null, hookEventReceiver: null, worktreeMonitor: null,
      subagentTracker: null, instructionsVerifier: null, threadlineRouter: null, handshakeManager: null,
      threadlineRelayClient: null, listenerManager: null, responseReviewGate: null, telemetryHeartbeat: null, pasteManager: null,
      wsManager: null, soulManager: null, featureRegistry: registry, discoveryEvaluator: null, startTime: new Date(),
      verifyDashboardOperatorSession: (t) => t === GOOD_PROOF,
    } as any);
    app.use(router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    registry.close();
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/feature-transition-applies-action.test.ts' });
  });

  const transition = (id: string, to: string, opts: { proof?: string; userId?: string } = {}) =>
    fetch(`${baseUrl}/features/${id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.proof ? { 'X-Instar-Operator-Session': opts.proof } : {}) },
      body: JSON.stringify({ to, ...(opts.userId ? { userId: opts.userId } : {}) }),
    });

  it('a Bearer-only caller gains no new reach: undiscovered → enabled is still refused; a present-but-invalid proof is told to re-unlock, never downgraded', async () => {
    const r = await transition('publishing-telegraph', 'enabled');
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe('INVALID_TRANSITION');
    const bad = await transition('publishing-telegraph', 'enabled', { proof: 'forged-or-expired' });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe('OPERATOR_PROOF_INVALID');
    // An EMPTY header is present, not omitted: it is invalid, never the agent path.
    const empty = await fetch(`${baseUrl}/features/publishing-telegraph/transition`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Operator-Session': '' }, body: JSON.stringify({ to: 'enabled' }),
    });
    expect(empty.status).toBe(401);
    expect(readConfig().publishing).toEqual({ enabled: false });
    expect(registry.getState('publishing-telegraph')!.discoveryState).toBe('undiscovered');
  });

  it('a read-only switch (a key the runtime ignores) is refused with 409, even for the operator', async () => {
    const r = await transition('evolution-system', 'disabled', { proof: GOOD_PROOF });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error.code).toBe('FEATURE_NOT_SWITCHABLE');
    expect(readConfig().evolution).toBeUndefined();
    const shown = await (await fetch(`${baseUrl}/features/evolution-system`)).json();
    expect(shown.effective.status).toBe('on');
    expect(shown.effective.summary).toContain('read-only');
  });

  it("the operator's switch enables from any state, applies the setting to config.json, writes consent, and answers honestly", async () => {
    const r = await transition('publishing-telegraph', 'enabled', { proof: GOOD_PROOF });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ success: true, previousState: 'undiscovered', newState: 'enabled', viaOperatorSwitch: true });
    expect(body.apply).toMatchObject({ direction: 'enable', outcome: 'applied', httpStatus: 200 });
    expect(readConfig().publishing).toEqual({ enabled: true });
    // Booted with publishing off → saved on, not claimed running.
    expect(body.effective).toMatchObject({ recorded: true, configured: true, atBoot: false, status: 'on-after-restart' });
    expect(registry.getConsentRecordsForFeature('publishing-telegraph', 'default')).toHaveLength(1);
  });

  it('every read route carries `effective`', async () => {
    const one = await (await fetch(`${baseUrl}/features/publishing-telegraph`)).json();
    expect(one.effective.status).toBe('on-after-restart');
    expect(one.state.lastApply.outcome).toBe('applied');
    const all = await (await fetch(`${baseUrl}/features`)).json();
    expect(all.features.every((f: { effective?: unknown }) => f.effective && typeof f.effective === 'object')).toBe(true);
    const summary = await (await fetch(`${baseUrl}/features/summary`)).json();
    expect(summary.features.find((f: { id: string }) => f.id === 'publishing-telegraph').effective.status).toBe('on-after-restart');
  });

  it('a refused setting change keeps the recorded choice, records the refusal, and shows "recorded-only" with the reason', async () => {
    const r = await transition('test-refused', 'enabled', { proof: GOOD_PROOF });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.apply).toMatchObject({ outcome: 'refused', httpStatus: 400 });
    expect(body.apply.detail).toContain('Cannot patch these config keys');
    expect(body.effective.status).toBe('recorded-only');
    expect(body.effective.summary).toContain('Cannot patch these config keys');
    expect(readConfig().notPatchable).toBeUndefined();
    expect(registry.getState('test-refused')!.discoveryState).toBe('enabled'); // choice kept
    expect(registry.getState('test-refused')!.lastApply!.outcome).toBe('refused');
  });

  it('a route that cannot serve the change (telemetry with no heartbeat) reads as failed, never as applied', async () => {
    const body = await (await transition('baseline-telemetry', 'enabled', { proof: GOOD_PROOF })).json();
    expect(body.apply).toMatchObject({ outcome: 'failed', httpStatus: 503 });
    expect(body.effective.status).toBe('recorded-only');
  });

  it("another user's switch is recorded but never changes the agent-wide setting", async () => {
    const before = readConfig();
    const body = await (await transition('git-backup', 'disabled', { proof: GOOD_PROOF, userId: 'user-b' })).json();
    expect(body.apply).toMatchObject({ outcome: 'not-applied' });
    expect(body.apply.detail).toContain('agent-wide');
    expect(readConfig()).toEqual(before);
  });

  it('disabling applies too, and the shown state says off', async () => {
    const body = await (await transition('publishing-telegraph', 'disabled', { proof: GOOD_PROOF })).json();
    expect(body.apply.outcome).toBe('applied');
    expect(readConfig().publishing).toEqual({ enabled: false });
    expect(body.effective).toMatchObject({ recorded: false, configured: false, atBoot: false, status: 'off' });
  });

  it('overlapping switches on one feature are serialized: the recorded choice and the setting never diverge', async () => {
    const [a, b] = await Promise.all([
      transition('publishing-telegraph', 'enabled', { proof: GOOD_PROOF }),
      transition('publishing-telegraph', 'disabled', { proof: GOOD_PROOF }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const after = await (await fetch(`${baseUrl}/features/publishing-telegraph`)).json();
    expect(after.effective.recorded).toBe(after.effective.configured);
    expect(readConfig().publishing.enabled).toBe(after.effective.configured);
  });

  it('there is no separate retry route: re-sending the same switch re-applies', async () => {
    expect((await fetch(`${baseUrl}/features/publishing-telegraph/apply`, { method: 'POST' })).status).toBe(404);
    const body = await (await transition('publishing-telegraph', 'enabled', { proof: GOOD_PROOF })).json();
    expect(body.apply.outcome).toBe('applied');
    expect(readConfig().publishing).toEqual({ enabled: true });
  });
});
