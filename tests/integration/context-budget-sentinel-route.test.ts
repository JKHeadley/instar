// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — GET /context-budget/sentinel through the real routes
 * (context-budget-layered-summaries §7.8/§9.1): 503 when the sentinel is off;
 * with a sentinel wired, its status including the canary report; and the
 * capability index classifies the prefix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { ContextBudgetSentinel } from '../../src/monitoring/ContextBudgetSentinel.js';
import { CompactionCanary } from '../../src/monitoring/compactionCanary.js';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import { CAPABILITY_INDEX } from '../../src/server/CapabilityIndex.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { RouteContext } from '../../src/server/routes.js';

const OP = 'tests/integration/context-budget-sentinel-route.test.ts';

function appFor(stateDir: string, sentinel: ContextBudgetSentinel | null): express.Express {
  const ctx = {
    config: { projectName: 'echo', projectDir: stateDir, stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(),
    contextBudgetSentinel: sentinel,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('GET /context-budget/sentinel', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('503 when the sentinel is off, naming the switch', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-route-off-')); dirs.push(stateDir);
    const r = await request(appFor(stateDir, null)).get('/context-budget/sentinel');
    expect(r.status).toBe(503);
    expect(r.body.enableWith).toBe('contextBudget.sentinel.enabled');
  });

  it('200 with the live status: heartbeat, folds, and the canary counting a real-shaped compaction', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-route-on-')); dirs.push(stateDir);
    const transcript = path.join(stateDir, 't.jsonl');
    fs.writeFileSync(transcript, '');
    const built = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: () => true, ownsTopic: () => true, candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null, attention: () => {},
      admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
      episodeStore: new InMemorySelfHealEpisodeStore(),
      canary: { instance: new CompactionCanary({ stateDir, machineId: built.holderId }), sessions: () => [{ topicKey: '141133', claudeSessionId: 'sid', transcriptPath: transcript, engine: 'claude-code' }], switchOn: () => true },
    });
    await sentinel.tick(); // epoch starts with the switch on
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' }, uuid: 'b1', timestamp: new Date().toISOString(), sessionId: 'sid', version: '2.1.321' })}\n`);
    await sentinel.tick();
    const r = await request(appFor(stateDir, sentinel)).get('/context-budget/sentinel');
    expect(r.status).toBe(200);
    expect(r.body.heartbeatFresh).toBe(true);
    expect(r.body.quarantined).toEqual([]);
    expect(r.body.canary.switchOn).toBe(true);
    expect(r.body.canary.groups[0]).toMatchObject({ engine: 'claude-code', version: '2.1.321', detected: 1, pending: 1 });
  });

  it('a Codex session\'s rollout compaction reads as a counted, synthesized-marked group beside Claude Code (S16, §9.6)', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-route-codex-')); dirs.push(stateDir);
    const rollout = path.join(stateDir, 'rollout-2026-11-10T10-00-00-cdx.jsonl');
    fs.writeFileSync(rollout, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: 'cdx', cli_version: '0.167.0' } })}\n`);
    const built = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: () => true, ownsTopic: () => true, candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null, attention: () => {},
      admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
      episodeStore: new InMemorySelfHealEpisodeStore(),
      canary: { instance: new CompactionCanary({ stateDir, machineId: built.holderId }), sessions: () => [{ topicKey: '200', claudeSessionId: 'cdx', transcriptPath: rollout, engine: 'codex-cli' }], switchOn: () => true },
    });
    await sentinel.tick();
    const t = new Date().toISOString();
    fs.appendFileSync(rollout, [
      JSON.stringify({ timestamp: t, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 230_000 }, model_context_window: 258_400 } } }),
      JSON.stringify({ timestamp: t, type: 'compacted', payload: { message: '', window_id: 'w-route-1', replacement_history: [] } }),
      '',
    ].join('\n'));
    await sentinel.tick();
    const r = await request(appFor(stateDir, sentinel)).get('/context-budget/sentinel');
    expect(r.status).toBe(200);
    const g = r.body.canary.groups.find((x: { engine: string }) => x.engine === 'codex-cli');
    expect(g).toMatchObject({ engine: 'codex-cli', version: '0.167.0', detected: 1, state: 'counted', marking: 'synthesized', synthesizedSignals: 1 });
    expect(g.profile).toMatchObject({ detection: 'supported', postCompactEvent: 'synthesized', healByInjection: false });
  });

  it('the status carries the adapter verification suite\'s recorded results (newest first)', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-route-suite-')); dirs.push(stateDir);
    const { writeSuiteResult, evaluateSuite } = await import('../../src/monitoring/adapterVerificationSuite.js');
    writeSuiteResult(stateDir, { schema: 'adapter-suite/1', engine: 'claude-code', version: '2.1.322', machine: 'm1', ranAt: 2, durationMs: 70_715, capabilities: evaluateSuite({ tokens: { alpha: 'A-1', steer: 'S-1', seed: 'D-1', clear: 'C-1', delta: 'E-1', deny: 'F-1' }, errors: [] }) });
    const built = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: () => true, ownsTopic: () => true, candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null, attention: () => {},
      admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }), consumeToken: () => ({ proceed: true, valid: true }),
      episodeStore: new InMemorySelfHealEpisodeStore(),
    });
    const r = await request(appFor(stateDir, sentinel)).get('/context-budget/sentinel');
    expect(r.status).toBe(200);
    expect(r.body.adapterSuite).toMatchObject({ running: false, results: [{ engine: 'claude-code', version: '2.1.322', machine: 'm1' }] });
    expect(r.body.adapterSuite.results[0].capabilities.toolPolicy).toMatchObject({ state: 'absent' });
  });

  it('the capability index classifies /context-budget and reports the sentinel', () => {
    const entry = CAPABILITY_INDEX.find((e) => e.key === 'contextBudget')!;
    expect(entry.prefixes).toContain('/context-budget');
    expect(entry.build({ ctx: { contextBudgetSentinel: null } } as never)).toEqual({ enabled: false });
    expect(entry.build({ ctx: { contextBudgetSentinel: { heartbeatFresh: () => true } } } as never)).toMatchObject({ enabled: true, endpoints: ['GET /context-budget/sentinel'] });
  });
});
