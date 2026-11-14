// safe-fs-allow: test file — temp dirs via mkdtemp, removed through SafeFsExecutor.
// safe-git-allow: test file — no git calls.
/**
 * e2e — Settings → Context is ALIVE against the real routes (context-budget-layered-summaries
 * §11, Phase 1 S14): the layers, the TokenLedger and the ContextBudgetSentinel are built the way
 * server.ts / AgentServer build them, mounted through createRoutes, and the console's own
 * view model (dashboard/console/context-model.js) reads the REAL HTTP answers — so a renamed
 * field in a route breaks this test rather than leaving a blank card. With the feature off on a
 * fleet agent, the same page reads "switched off", never an error. Plus WIRED checks: the page
 * is registered in console.js, Settings shows its tile, and Home's count reads its source.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { buildContextLayers, contextLayersEnabled } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { ContextBudgetSentinel } from '../../src/monitoring/ContextBudgetSentinel.js';
import { productionSentinelSessionDeps, productionLiveTopics } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildContextPage } from '../../dashboard/console/context-model.js';
import { NEED_SOURCES } from '../../dashboard/console/needs-model.js';

const OP = 'tests/e2e/console-context-page-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOPIC = 141133;

/** The console reader's answer shape (console.js getOnce), from a supertest response. */
function asConsoleRead(r: request.Response) {
  if (r.status === 503) return { ok: false, status: 503, reason: 'switched off on this agent' };
  if (r.status >= 400) return { ok: false, status: r.status, reason: `the server answered ${r.status}` };
  return { ok: true, status: 200, data: r.body };
}

describe('Settings → Context reads the real routes', () => {
  const dirs: string[] = [];
  const ledgers: TokenLedger[] = [];
  afterEach(() => {
    for (const l of ledgers.splice(0)) l.close();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  function boot(config: { developmentAgent?: boolean }) {
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'cb-card-e2e-')); dirs.push(home);
    const stateDir = path.join(home, '.instar'); fs.mkdirSync(stateDir);
    const on = contextLayersEnabled(config, undefined);
    const contextLayers = on ? buildContextLayers({ stateDir }) : null;
    const projects = path.join(home, 'projects'); fs.mkdirSync(projects);
    const tokenLedger = new TokenLedger({ dbPath: path.join(stateDir, 'server-data', 'token-ledger.db'), claudeProjectsDir: projects, claudeProjectsDirs: () => [projects], maxFileAgeMs: 86_400_000, maxFilesPerScan: 50, yieldEveryNFiles: 25, attributionBackfill: 'off' });
    ledgers.push(tokenLedger);
    let sentinel: ContextBudgetSentinel | null = null;
    if (on) {
      const sessions = { listRunningSessions: () => [{ id: 's1', name: 'echo-t', tmuxSession: 'echo-t', telegramTopicId: TOPIC, framework: 'claude-code' as const } as never], killSessionByTmuxName: () => false };
      const built = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [{ topicKey: String(TOPIC) }], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
      built.coordinator.recoverPendingFolds();
      sentinel = new ContextBudgetSentinel({
        stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
        ownsFold: () => true, ownsTopic: () => true,
        ...productionSentinelSessionDeps({ sessions, projectDir: stateDir }),
        liveTopics: productionLiveTopics({ sessions }),
        attention: () => {},
        admit: () => ({ admitted: false, reason: 'test' }) as never, consumeToken: () => false,
      } as never);
    }
    const ctx = {
      config: { projectName: 'e2e', projectDir: stateDir, stateDir, port: 0 } as never,
      sessionManager: { listRunningSessions: () => [] } as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
      startTime: new Date(), contextLayers, tokenLedger, contextBudgetSentinel: sentinel,
    } as unknown as RouteContext;
    const app = express(); app.use(express.json()); app.use('/', createRoutes(ctx));
    return { app, sentinel };
  }

  async function readAll(app: express.Express) {
    const [layers, metrics, sentinel, delta] = await Promise.all(['/context-budget/layers', '/context-budget/metrics', '/context-budget/sentinel', '/context-budget/delta-shadow'].map((p) => request(app).get(p)));
    return { raw: { layers, metrics, sentinel, delta }, reads: { layers: asConsoleRead(layers), metrics: asConsoleRead(metrics), sentinel: asConsoleRead(sentinel), delta: asConsoleRead(delta) } };
  }

  it('dev agent: the routes answer 200 and the page model reads them into a full page', async () => {
    const b = boot({ developmentAgent: true });
    await b.sentinel!.tick();
    const { raw, reads } = await readAll(b.app);
    expect([raw.layers.status, raw.metrics.status, raw.sentinel.status]).toEqual([200, 200, 200]);
    const page = buildContextPage(reads, Date.now(), {});
    expect(page.ok).toBe(true);
    expect(page.off).toBe(false);
    expect(page.partial).toBe(false);
    expect(page.needsUnreadable).toBe(false);
    expect(page.needs).toEqual([]);
    expect(page.headline).toMatch(/^Running summaries are on for \d+ conversations? on this machine\.$/);
    expect(page.recovery.state).toBe('ok');
    expect(page.recovery.lines.length).toBeGreaterThan(0);
    expect(page.upkeep.lines[0]).toMatch(/The watcher last checked just now/);
    expect(page.cost.state).toBe('ok');
    // The Home count source reads the same real answer without calling it unreadable.
    const src = NEED_SOURCES.find((s: { id: string }) => s.id === 'context');
    expect(src.rows({ sentinel: reads.sentinel }, Date.now())).toEqual([]);
  });

  it('fleet agent: everything off reads as one plain "switched off" page', async () => {
    const b = boot({});
    const { raw, reads } = await readAll(b.app);
    expect(raw.layers.status).toBe(503);
    expect(raw.metrics.status).toBe(503);
    expect(raw.sentinel.status).toBe(503);
    const page = buildContextPage(reads, Date.now(), {});
    expect(page).toMatchObject({ ok: true, off: true, needs: [] });
    expect(page.headline).toBe('Conversation summaries are switched off on this machine.');
  });

  it('WIRED: the console routes the page, Settings shows its tile, and Home reads its source', () => {
    const js = fs.readFileSync(path.join(ROOT, 'dashboard/console/console.js'), 'utf-8');
    expect(js).toContain("import { renderContext } from './context.js';");
    expect(js).toContain("'settings/context': renderContext,");
    const nav = fs.readFileSync(path.join(ROOT, 'dashboard/console/nav-model.js'), 'utf-8');
    expect(nav).toContain("context: '#/settings/context',");
    const needs = fs.readFileSync(path.join(ROOT, 'dashboard/console/needs-model.js'), 'utf-8');
    expect(needs).toContain("{ id: 'context', page: 'settings/context', reads: { sentinel: '/context-budget/sentinel' },");
  });
});
