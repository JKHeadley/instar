// safe-fs-allow: test file — temp dirs via mkdtemp, removed through SafeFsExecutor.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the context budget measurement backend is ALIVE on the production init
 * path (context-budget-layered-summaries §11, Phase 1 S13): with the layers on,
 * the boot builds the TokenLedger with every config home exactly as
 * AgentServer does (`claudeTranscriptRoots({ pool })` under the real home), a
 * fixture session written under a follow-me login is scanned, and
 * GET /context-budget/metrics answers 200 with non-empty numbers; with the
 * layers off it answers 503. Plus WIRED source checks on AgentServer.ts,
 * server.ts, routes.ts and the CapabilityIndex row.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { claudeTranscriptRoots } from '../../src/monitoring/claudeTranscriptRoots.js';
import { buildContextLayers, contextLayersEnabled } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-budget-metrics-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SID = '99999999-8888-4777-8666-555555555555';

describe('context budget metrics — alive on the production init path', () => {
  const dirs: string[] = [];
  const ledgers: TokenLedger[] = [];
  const env = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  afterEach(() => {
    process.env.HOME = env.HOME;
    if (env.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
    for (const l of ledgers.splice(0)) l.close();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  function boot(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-e2e-')); dirs.push(home);
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    const sd = path.join(home, '.instar'); fs.mkdirSync(sd);
    // A session that ran under a follow-me login: its transcript is NOT under ~/.claude.
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const proj = path.join(home, '.claude-followme-acct', 'projects', '-agent');
    fs.mkdirSync(proj, { recursive: true });
    const at = (n: number) => new Date(Date.now() - 600_000 + n * 1000).toISOString();
    fs.writeFileSync(path.join(proj, `${SID}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId: SID, timestamp: at(0), uuid: 'u0', message: { role: 'user', content: '[telegram:777 "t"] run the suite' } }),
      JSON.stringify({ type: 'assistant', sessionId: SID, timestamp: at(1), uuid: 'a1', requestId: 'r1', message: { content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 500 } } } }),
      JSON.stringify({ type: 'assistant', sessionId: SID, timestamp: at(2), uuid: 'a2', requestId: 'r2', message: { content: [{ type: 'tool_use', id: 'x2', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 21_000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 500 } } } }),
    ].join('\n') + '\n');
    // server.ts: the layers, gated.
    const contextLayers = contextLayersEnabled(config, config.contextBudget?.enabled) ? buildContextLayers({ stateDir: sd }) : null;
    // AgentServer.ts: the ledger, with the same options shape.
    const subscriptionPoolForRoots = null;
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    const claudeProjectsDirs = () => claudeTranscriptRoots({ pool: subscriptionPoolForRoots });
    const tokenLedger = new TokenLedger({ dbPath: path.join(sd, 'server-data', 'token-ledger.db'), claudeProjectsDir, claudeProjectsDirs, maxFileAgeMs: 30 * 86_400_000, maxFilesPerScan: 500, yieldEveryNFiles: 25, attributionBackfill: 'off' });
    ledgers.push(tokenLedger);
    const ctx = {
      config: { projectName: 'e2e', projectDir: sd, stateDir: sd, port: 0 } as never,
      sessionManager: { listRunningSessions: () => [] } as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
      startTime: new Date(), contextLayers, tokenLedger,
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    return { home, tokenLedger, app };
  }

  it('dev agent: the ledger scans the follow-me home and the route answers 200 with non-empty numbers', async () => {
    const b = boot({ developmentAgent: true });
    expect(b.tokenLedger.projectRoots()).toContain(path.join(b.home, '.claude-followme-acct', 'projects'));
    await b.tokenLedger.scanAllAsync();
    const r = await request(b.app).get('/context-budget/metrics');
    expect(r.status).toBe(200);
    expect(r.body.ledger.available).toBe(true);
    expect(r.body.sessions).toHaveLength(1);
    expect(r.body.sessions[0]).toMatchObject({ sessionId: SID, topicId: 777 });
    expect(r.body.sessions[0].cost.perRequest.inputWeighted).toBeGreaterThan(0);
    expect(r.body.sessions[0].rework).toMatchObject({ repeats: 1, toolInputs: 2 });
    expect(r.body.topics.map((t: { topicId: number }) => t.topicId)).toContain(777);
    expect(r.body.anchors).toEqual({ unavailable: 'anchor-ledger-not-built' });
  });

  it('fleet agent: the route answers 503', async () => {
    const b = boot({});
    expect((await request(b.app).get('/context-budget/metrics')).status).toBe(503);
  });

  it('WIRED: AgentServer builds the ledger with every config home; server.ts wires the usage observer; routes and CapabilityIndex serve the route', () => {
    const as = fs.readFileSync(path.join(ROOT, 'src/server/AgentServer.ts'), 'utf-8');
    expect(as).toContain('const claudeProjectsDirs = () => claudeTranscriptRoots({ pool: subscriptionPoolForRoots });');
    expect(as).toMatch(/claudeProjectsDir,\s*\n\s*claudeProjectsDirs,/);
    const sv = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(sv).toContain('if (layerWiring) onLayerExtractUsage = layerWiring.onExtractUsage;');
    expect(sv).toContain('}, (input, u) => onLayerExtractUsage?.(input, u));');
    expect(sv).toContain('...(layerWiring ? layerWiring.captureDeps : {}),');
    const rt = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf-8');
    expect(rt).toContain("router.get('/context-budget/metrics'");
    expect(rt).toContain('ledger: ctx.tokenLedger ?? null,');
    const ci = fs.readFileSync(path.join(ROOT, 'src/server/CapabilityIndex.ts'), 'utf-8');
    expect(ci).toContain("'GET /context-budget/metrics'");
    const wiring = fs.readFileSync(path.join(ROOT, 'src/monitoring/contextLayers/layerCaptureWiring.ts'), 'utf-8');
    expect(wiring).toContain("getFeatureMetricsRecorder()?.record({ feature: LAYER_UPDATE_COMPONENT, kind: 'event'");
  });
});
