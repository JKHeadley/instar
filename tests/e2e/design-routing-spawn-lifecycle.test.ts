/**
 * E2E lifecycle — design routing at spawn
 * (docs/specs/frontier-design-review-standard.md §2, build stage 1).
 *
 * Production composition: a real AgentServer with the topic-profile bundle
 * built like src/commands/server.ts (real TopicProfileStore +
 * TopicProfileResolver, real TopicProfileOrchestrator), a real review ledger
 * file and a real FeatureEvidenceLog. Only tmux and the LLM are faked.
 *
 *   Phase 1 — alive: on a development agent a design spawn returns 201 (not
 *             503/500) on the design model, with the decision on the session
 *             and one evidence row.
 *   Phase 2 — an undeclared design brief is classified through the shared
 *             intelligence provider and routed.
 *   Phase 3 — a pinned topic's design session is not respawned at reboot.
 *   Phase 4 — the fleet (no developmentAgent): today's behaviour, nothing recorded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileWriteSurface } from '../../src/core/topicProfileWriteSurface.js';
import { ProfileConfirmSlots } from '../../src/core/topicProfileIngress.js';
import { TopicProfileOrchestrator } from '../../src/core/TopicProfileOrchestrator.js';
import { TopicSpawnBriefStore } from '../../src/core/TopicSpawnBriefStore.js';
import { FeatureEvidenceLog, setFeatureEvidenceLog } from '../../src/monitoring/FeatureEvidenceLog.js';
import { designReviewLedgerPath, type DesignReviewRun } from '../../src/core/designReviewLedger.js';
import { resolveDesignModel } from '../../src/core/designLane.js';
import { createMockSessionManager, type MockSessionManager } from '../helpers/setup.js';
import { makeOrchestratorDeps, newRecorder } from '../helpers/topicProfileOrchestratorDeps.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-design-routing-e2e';
const PINNED_TOPIC = 33230;
const LANE = resolveDesignModel('claude-code')!;

describe('Design routing × spawn E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let sm: MockSessionManager;
  let store: TopicProfileStore;
  let resolver: TopicProfileResolver;
  let orch: TopicProfileOrchestrator;
  let orchStatePath: string;
  let evidence: FeatureEvidenceLog;
  const servers: AgentServer[] = [];
  const classifierPrompts: string[] = [];
  const spawnsByName = new Map<string, any>();

  function serverWith(extra: Partial<InstarConfig>): AgentServer {
    const config = {
      projectName: 'design-routing-e2e', agentName: 'E2E Agent', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      ...extra,
    } as InstarConfig;
    const surface = new TopicProfileWriteSurface({
      store, resolver, regime: () => ({ enabled: true, dryRun: false }), boundOperator: () => null,
      localModelBinding: () => null, legacyFrameworkRespawn: async () => ({ respawned: false }),
      orchestrator: null, disclose: async () => {}, audit: () => 'seq-e2e',
    });
    const server = new AgentServer({
      config,
      sessionManager: sm as any,
      state: new StateManager(stateDir),
      intelligence: { evaluate: async (prompt: string) => { classifierPrompts.push(prompt); return '{"kind":"design"}'; } },
      topicProfile: {
        store, resolver, surface, confirmSlots: new ProfileConfirmSlots({ ttlMs: () => 300_000 }),
        orchestrator: orch, spawnBriefs: new TopicSpawnBriefStore(stateDir),
      },
    } as any);
    servers.push(server);
    return server;
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-routing-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'design-routing-e2e' }));
    store = new TopicProfileStore({
      stateFilePath: path.join(stateDir, 'state', 'topic-profiles.json'),
      legacyFrameworksPath: path.join(stateDir, 'state', 'topic-frameworks.json'),
      isDryRun: () => false,
    });
    resolver = new TopicProfileResolver({
      store, defaultFramework: () => 'claude-code', configTopicFrameworks: () => ({}), configProfileDefaults: () => ({}),
      frameworkDefaultModels: () => ({}), tierEscalationConfig: () => undefined, localModelBinding: () => null,
      frameworkBinaryPath: () => null,
    });
    await store.mutate(String(PINNED_TOPIC), { model: 'claude-opus-5-5', updatedBy: 'api-token' });
    orchStatePath = path.join(stateDir, 'state', 'topic-profile-orchestrator.json');
    orch = new TopicProfileOrchestrator(makeOrchestratorDeps({ store, resolveProfile: (k) => resolver.resolve(k), stateFilePath: orchStatePath, rec: newRecorder() }));
    evidence = new FeatureEvidenceLog({ projectDir: tmpDir, machine: 'e2e', instarVersion: 'test' });
    setFeatureEvidenceLog(evidence);
    sm = createMockSessionManager();
    // The production composition starts its own background sessions at boot, so
    // assertions read the spawn by its name, never "the last spawn".
    const realSpawn = sm.spawnSession.bind(sm);
    (sm as any).spawnSession = async (opts: any) => { spawnsByName.set(opts.name, opts); return realSpawn(opts); };
    // The default login has a recorded same-door review that answered on the design model.
    const run: DesignReviewRun = {
      v: 1, runId: 'e2e-run', machineId: 'local', recordedAt: new Date().toISOString(), path: path.join(tmpDir, 'plan.md'),
      fingerprint: 'b'.repeat(64), title: 'Plan', sessionId: 'prior', account: null,
      passes: [{ family: 'claude', door: 'claude-code', attempts: [{ askedModel: LANE, outcome: 'ok' }], model: LANE, modelBasis: 'reported', status: 'ok', verdict: 'CLEAN' }],
    };
    fs.writeFileSync(designReviewLedgerPath(stateDir), JSON.stringify(run) + '\n');
  });

  afterAll(async () => {
    setFeatureEvidenceLog(null);
    orch?.dispose();
    for (const s of servers) { try { await (s as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ } }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'design-routing-spawn-lifecycle' });
  });

  const evidenceRows = () => fs.existsSync(evidence.filePath)
    ? fs.readFileSync(evidence.filePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.featureId === 'frontier-design-review')
    : [];

  let designTmux = '';

  it('Phase 1 — a declared design spawn on a development agent launches on the design model', async () => {
    const dev = serverWith({ developmentAgent: true } as Partial<InstarConfig>);
    const res = await request(dev.getApp()).post('/sessions/spawn').set('Authorization', `Bearer ${AUTH}`)
      .send({ name: 'design-e2e', prompt: 'Write the plan for the export feature.', workKind: 'design', topicId: PINNED_TOPIC });
    expect(res.status).toBe(201);
    designTmux = res.body.tmuxSession;
    const args = spawnsByName.get('design-e2e');
    expect(args.model).toBe(LANE);
    expect(args.designRouting).toEqual({ workKind: 'design', workKindSource: 'declared', designRouting: { decision: 'design-lane', model: LANE } });
    expect(evidenceRows().map((r) => r.reason)).toContain('spawn-routed:design-lane');
  });

  it('Phase 2 — an undeclared design brief is classified through the shared provider and routed', async () => {
    const dev = serverWith({ developmentAgent: true } as Partial<InstarConfig>);
    const res = await request(dev.getApp()).post('/sessions/spawn').set('Authorization', `Bearer ${AUTH}`)
      .send({ name: 'design-e2e-2', prompt: 'Draft the architecture for the sync service.' });
    expect(res.status).toBe(201);
    expect(classifierPrompts.some((p) => p.includes('Draft the architecture for the sync service.'))).toBe(true);
    expect(spawnsByName.get('design-e2e-2').model).toBe(LANE);
    expect(spawnsByName.get('design-e2e-2').designRouting.workKindSource).toBe('classified');
  });

  it('Phase 3 — after a restart the pinned topic\'s design session is not respawned to restore the pin', async () => {
    const rec = newRecorder();
    rec.sessions.set(String(PINNED_TOPIC), designTmux);
    const rebooted = new TopicProfileOrchestrator(makeOrchestratorDeps({ store, resolveProfile: (k) => resolver.resolve(k), stateFilePath: orchStatePath, rec }));
    rebooted.bootReconcileSweep();
    await new Promise((r) => setTimeout(r, 100));
    rebooted.dispose();
    expect(rec.disclosures).toEqual([]);
    expect(rec.kills).toEqual([]);
    expect(rec.spawns).toEqual([]);
  });

  it('Phase 4 — the fleet keeps today\'s behaviour and records nothing', async () => {
    const before = evidenceRows().length;
    const prompts = classifierPrompts.length;
    const fleet = serverWith({});
    const res = await request(fleet.getApp()).post('/sessions/spawn').set('Authorization', `Bearer ${AUTH}`)
      .send({ name: 'fleet-e2e', prompt: 'Write the plan for the export feature.', workKind: 'design' });
    expect(res.status).toBe(201);
    expect(spawnsByName.get('fleet-e2e').model).toBeUndefined();
    expect(spawnsByName.get('fleet-e2e').designRouting).toBeUndefined();
    expect(evidenceRows().length).toBe(before);
    expect(classifierPrompts.length).toBe(prompts);
  });
});
