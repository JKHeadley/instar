// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e (context-budget-layered-summaries §18 Tier 3: "the layer store is alive
 * and permissioned"): on the production init path, with server.ts's own gate
 * expression, a development agent gets a live, 0700 layer store and archive
 * whose route answers 200; a fleet agent gets nothing on disk and a 503; the
 * Disk Steward prune child runs the archive category; and a backup taken with
 * the layers on carries the store but never the archive. Plus WIRED source
 * checks that server.ts constructs it this way and serves it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContextLayers, contextLayersEnabled, type ContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { runPruneChild } from '../../src/monitoring/diskStewardMain.js';
import { BackupManager } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-layer-store-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const META = { author: { sessionId: null, machine: 'm_e2e', model: null, kind: 'derived' as const }, asOf: { at: Date.now(), lastMessageId: null } };

function app(stateDir: string, layers: ContextLayers | null): express.Express {
  const ctx = {
    config: { projectName: 'e2e', projectDir: stateDir, stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(), contextLayers: layers,
  } as unknown as RouteContext;
  const a = express();
  a.use(express.json());
  a.use('/', createRoutes(ctx));
  return a;
}

/** server.ts's boot step: gate, then construct (no emitter when the journal is off). */
function boot(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }, stateDir: string): ContextLayers | null {
  return contextLayersEnabled(config, config.contextBudget?.enabled) ? buildContextLayers({ stateDir, authToken: 'e2e-auth-token-0123456789' }) : null;
}

describe('context layer store — alive on the production init path', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });
  const home = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-e2e-')); dirs.push(h); const sd = path.join(h, '.instar'); fs.mkdirSync(sd); return { h, sd }; };

  it('a development agent (switch omitted) gets a live 0700 store, and the route answers 200 with what it holds', async () => {
    const { sd } = home();
    const layers = boot({ developmentAgent: true }, sd);
    expect(layers).not.toBeNull();
    expect(fs.statSync(path.join(sd, 'state', 'context-layers')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(sd, 'state', 'context-archive')).mode & 0o777).toBe(0o700);
    layers!.store.writeDerived('141133', 'h1', 'current', { text: 'next: verify' }, META);
    const r = await request(app(sd, layers)).get('/context-budget/layers');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, topics: 1, layersRoot: { mode: '0700' } });
  });

  it('a fleet agent (switch omitted, not a development agent) creates nothing and answers 503', async () => {
    const { sd } = home();
    const layers = boot({}, sd);
    expect(layers).toBeNull();
    expect(fs.existsSync(path.join(sd, 'state', 'context-layers'))).toBe(false);
    expect(fs.existsSync(path.join(sd, 'state', 'context-archive'))).toBe(false);
    expect((await request(app(sd, layers)).get('/context-budget/layers')).status).toBe(503);
  });

  it('an explicit false on a development agent stays dark', () => {
    const { sd } = home();
    expect(boot({ developmentAgent: true, contextBudget: { enabled: false } }, sd)).toBeNull();
  });

  it('the Disk Steward prune child runs the archive category against this agent\'s archive', async () => {
    const { h, sd } = home();
    const layers = boot({ developmentAgent: true }, sd)!;
    layers.archive.archiveSpan('141133', 's1', [{ entryId: 'e1', fields: { text: 'tool output' } }]);
    const fakeSeams = {
      processes: async () => [], run: async () => { throw new Error('ENOENT'); }, sizeOf: async () => null,
      devOf: () => null, readdir: () => null, lstat: () => null, realpath: () => null, remove: async () => {}, now: () => Date.now(), home: h, platform: 'linux' as NodeJS.Platform,
    };
    const result = await runPruneChild({
      runId: 'a'.repeat(24), agent: 'e2e', agentHome: h, trigger: 'manual', dryRun: true, npmCacheMaxGiB: 1, categoryBudgetMs: 10_000,
      measure: false, resultPath: path.join(h, 'r.json'), auditPath: path.join(h, 'a.jsonl'),
    }, fakeSeams);
    expect(result.categories.find((c) => c.category === 'context-archive')).toMatchObject({ skipped: 'under-limit' });
  });

  it('a backup with the layers on carries the store and TopicMemory, never the archive', () => {
    const { sd } = home();
    fs.writeFileSync(path.join(sd, 'config.json'), JSON.stringify({ developmentAgent: true }));
    fs.writeFileSync(path.join(sd, 'topic-memory.db'), 'db');
    const layers = boot({ developmentAgent: true }, sd)!;
    layers.store.writeDerived('141133', 'h1', 'current', { text: 'x' }, META);
    layers.archive.archiveSpan('141133', 's1', [{ entryId: 'e1', fields: { text: 'y' } }]);
    const snap = new BackupManager(sd).createSnapshot('manual');
    expect(snap.files).toContain('topic-memory.db');
    expect(snap.files.some((f) => f.includes('context-layers'))).toBe(true);
    expect(snap.files.some((f) => f.includes('context-archive'))).toBe(false);
  });

  it('WIRED: server.ts gates the store on contextBudget.enabled through the dev-agent gate and serves it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain("contextLayersEnabled(config as { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }, liveConfig.get<boolean | undefined>('contextBudget.enabled', undefined))");
    expect(src).toContain('_contextLayers = buildContextLayers({');
    expect(src).toContain('emitter: replicatedRecordEmitter as unknown as LayerEmitter | undefined');
    expect(src).toContain('contextLayers: _contextLayers ?? undefined');
    const routes = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf-8');
    expect(routes).toContain("router.get('/context-budget/layers'");
  });
});
