// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the ContextBudgetSentinel's §17 rows are ALIVE on the production boot
 * path (context-budget-layered-summaries §7.8, §17, Phase 1 S12):
 *  1. Built exactly as server.ts builds it: buildFoldCoordinator + the boot
 *     sweep, buildFoldHolds, buildContextLayers, a real TopicMemory, the
 *     production live-topic and hold-carrier closures, and the REAL self-action
 *     governor handle for the orphan ladder. GET /context-budget/sentinel
 *     returns 200 with all three rows populated (not `unavailable`).
 *  2. An orphan hold left on disk is cleared through the real governor
 *     admission and token check for the orphan ladder's own controller id.
 *  3. WIRED: server.ts mints the orphan handle, passes the rows into the
 *     constructor, gates freshness on the layers, binds the rebuild seam to the
 *     capture wiring's re-projection, and hands the sentinel the same hold
 *     store the outbound chokepoints read.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { buildFoldCoordinator, buildFoldHolds } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { ContextBudgetSentinel, ORPHAN_GRACE_MS } from '../../src/monitoring/ContextBudgetSentinel.js';
import { productionSentinelSessionDeps, productionLiveTopics, productionHoldCarriers } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import { buildContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { initSelfActionGovernor, governor, consumeAdmissionToken, resetSelfActionGovernorModuleForTest } from '../../src/monitoring/selfaction/governor.js';
import { resetAnchorForTest } from '../../src/monitoring/selfaction/anchor.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-budget-sentinel-rows-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOPIC = 141133;

describe('ContextBudgetSentinel §17 rows on the production boot path', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  afterEach(() => {
    for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
    resetSelfActionGovernorModuleForTest(); resetAnchorForTest();
  });

  it('alive: 200 with all three rows, and an orphan hold cleared through the real governor', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-rows-e2e-')); dirs.push(stateDir);
    DegradationReporter.resetForTesting();
    const sessions = {
      listRunningSessions: () => [{ id: 's1', name: 'echo-t', tmuxSession: 'echo-t', telegramTopicId: TOPIC, framework: 'claude-code' as const } as never],
      killSessionByTmuxName: () => false,
    };
    const built = buildFoldCoordinator({
      stateDir, runningTopicSessions: () => [{ topicKey: String(TOPIC) }], poolPlacementLive: () => false, inboundQueueLive: () => true,
      topicRowsPresent: () => false, layerKindPresent: () => true,
    });
    const holds = buildFoldHolds({ stateDir });
    built.coordinator.recoverPendingFolds();
    const layers = buildContextLayers({ stateDir });
    const memory = new TopicMemory(stateDir); await memory.open(); mems.push(memory);
    initSelfActionGovernor({ stateDir, readEmergencyDisable: () => false, readClassesConfig: () => ({}), now: () => Date.now(), flushIntervalMs: 60_000 });
    const quarantineHandle = governor.for('context-budget-quarantine-reconcile');
    const orphanHandle = governor.for('context-budget-orphan-carrier-clear');
    let offset = 0;
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: () => true, ownsTopic: () => true,
      ...productionSentinelSessionDeps({ sessions, projectDir: stateDir }),
      liveTopics: productionLiveTopics({ sessions }),
      layers: { h1: (t) => layers.h1Freshness(Number(t), memory), requestRebuild: () => 'unavailable' },
      holdHealth: {
        carriers: productionHoldCarriers({ stateDir, holds }),
        admit: (target, opts) => orphanHandle.admit(target, opts),
        degradation: (r) => DegradationReporter.getInstance().report(r),
      },
      attention: () => {},
      admit: (target, opts) => quarantineHandle.admit(target, opts), consumeToken: consumeAdmissionToken,
      now: () => Date.now() + offset,
    });

    expect(holds.write(String(TOPIC), 'foldgone', Date.now() + 60_000)).toBe(true);
    offset += ORPHAN_GRACE_MS + 60_000;
    await sentinel.tick();

    const ctx = {
      config: { projectName: 'echo', projectDir: stateDir, stateDir, port: 0 } as never,
      sessionManager: sessions as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
      startTime: new Date(), contextBudgetSentinel: sentinel,
    } as unknown as RouteContext;
    const app = express(); app.use(express.json()); app.use('/', createRoutes(ctx));
    const res = await request(app).get('/context-budget/sentinel');
    expect(res.status).toBe(200);
    expect(res.body.heartbeatFresh).toBe(true);
    // No layer record yet for the live topic: freshness reads unknown, counted, not "fresh".
    expect(res.body.layerFreshness).toMatchObject({ state: 'ok', counts: { topics: 1, unknown: 1, rebuildRequests: 0 } });
    expect(res.body.holdHealth).toMatchObject({ state: 'ok', counts: { cleared: 1, clearedTotal: 1 } });
    expect(res.body.eligibleWithoutFold).toMatchObject({ state: 'ok', counts: { topics: 1, unknown: 1 } });
    expect(holds.check(String(TOPIC))).toEqual({ held: false });
    expect(DegradationReporter.getInstance().getEvents().some((e) => e.feature === 'ContextBudgetSentinel.holdHealth')).toBe(true);
  });

  it('WIRED: server.ts supplies the rows to the sentinel it builds', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const gate = src.indexOf("liveConfig.get<boolean>('contextBudget.sentinel.enabled', false) === true");
    const ctor = src.indexOf('_contextBudgetSentinel = new ContextBudgetSentinel({');
    expect(gate).toBeGreaterThan(-1);
    const block = src.slice(gate, ctor + 200);
    expect(block).toContain("sentinelGovernor.for('context-budget-orphan-carrier-clear')");
    expect(block).toContain('liveTopics: productionLiveTopics({ sessions: sessionManager })');
    expect(block).toContain('layers: sentinelLayers ? {');
    expect(block).toContain('const sentinelLayers = _contextLayers;');
    expect(block).toContain('carriers: productionHoldCarriers({ stateDir: config.stateDir, holds: _foldHolds })');
    expect(block).toContain('admit: (target: Parameters<typeof sentinelOrphanHandle.admit>[0], opts: Parameters<typeof sentinelOrphanHandle.admit>[1]) => sentinelOrphanHandle.admit(target, opts)');
    expect(block).toContain('DegradationReporter.getInstance().report(r)');
    expect(src.slice(ctor, ctor + 200)).toContain('...sentinelRows,');
    // The rebuild seam is bound to the capture wiring's re-projection once it exists.
    expect(src).toContain('_layerReproject = (topicId) => layerWiring.reproject(topicId);');
    expect(block).toContain("requestRebuild: (t: string) => (_layerReproject ? _layerReproject(Number(t)) : 'unavailable' as const)");
    // The layers are built before the sentinel (so `sentinelLayers` reads them).
    expect(src.indexOf('_contextLayers = buildContextLayers({')).toBeLessThan(gate);
  });
});
