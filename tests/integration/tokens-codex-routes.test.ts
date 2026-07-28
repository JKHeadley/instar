/**
 * Integration tests for the Codex token-ledger HTTP surface.
 *
 * Verifies the feature is actually reachable over HTTP (not dead code):
 *   - GET /tokens/summary       includes a `codex` rollup alongside `summary`
 *   - GET /tokens/codex-sessions returns the per-session Codex rows
 *
 * Uses supertest + createRoutes wired to a real in-memory TokenLedger.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import type { ParsedCodexSession } from '../../src/monitoring/CodexRolloutParser.js';

function codexSession(sessionId: string, totalTokens: number, cwd = '/tmp/agent'): ParsedCodexSession {
  return {
    sessionId, cwd, model: 'gpt-5.2', planType: 'prolite',
    inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    totalTokens, primaryUsedPercent: 11, secondaryUsedPercent: 3,
    firstTs: Date.parse('2026-05-24T01:20:00.514Z'), tokenCountEvents: 1,
  };
}

function ctxWithLedger(ledger: TokenLedger): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: ledger,
    startTime: new Date(),
  } as unknown as RouteContext;
}

describe('Codex token-ledger routes (integration)', () => {
  let ledger: TokenLedger;
  let app: express.Express;

  beforeEach(() => {
    ledger = new TokenLedger({ dbPath: ':memory:', claudeProjectsDir: '/nonexistent' });
    ledger.ingestCodexSession(codexSession('codex-1', 199006), Date.now());
    ledger.ingestCodexSession(codexSession('codex-2', 5000), Date.now());
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWithLedger(ledger)));
  });

  afterEach(() => ledger.close());

  it('GET /tokens/summary returns a codex rollup alongside the Claude summary', async () => {
    const res = await request(app).get('/tokens/summary');
    expect(res.status).toBe(200);
    // Claude side untouched (no token_events ingested) — proves isolation over HTTP too.
    expect(res.body.summary.totalTokens).toBe(0);
    // Codex side present and correct.
    expect(res.body.codex).toBeTruthy();
    expect(res.body.codex.totalTokens).toBe(204006);
    expect(res.body.codex.sessionCount).toBe(2);
    expect(res.body.codex.maxPrimaryUsedPercent).toBe(11);
  });

  it('GET /tokens/codex-sessions returns per-session rows, biggest first', async () => {
    const res = await request(app).get('/tokens/codex-sessions');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0].sessionId).toBe('codex-1');
    expect(res.body.sessions[0].totalTokens).toBe(199006);
    expect(res.body.sessions[0].model).toBe('gpt-5.2');
  });

  it('GET /tokens/codex-sessions returns 503 when the ledger is unavailable', async () => {
    const ctx = ctxWithLedger(ledger);
    (ctx as { tokenLedger: TokenLedger | null }).tokenLedger = null;
    const noLedgerApp = express();
    noLedgerApp.use(express.json());
    noLedgerApp.use('/', createRoutes(ctx));
    const res = await request(noLedgerApp).get('/tokens/codex-sessions');
    expect(res.status).toBe(503);
  });
});
