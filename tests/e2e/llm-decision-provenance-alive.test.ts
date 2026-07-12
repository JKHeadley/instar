// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" for ACT-562 LLM-decision provenance wiring
 * (docs/specs/llm-decision-provenance-wiring.md §4).
 *
 * Boots the REAL AgentServer (the same factory server.ts uses) and proves:
 *   (a) §3.6 HOIST — on a single-machine boot GET /judgment-provenance is ALIVE
 *       (200, NOT 503) with no session pool. The log is constructed
 *       UNCONDITIONALLY (the AgentServer default-construct).
 *   (b) GATE ON — a live CompletionEvaluator verdict (recordProvenance wired)
 *       writes a DURABLE row under state/judgment-provenance/ (mode 0600, never
 *       served raw) and GET /judgment-provenance returns 200 with the row.
 *   (c) GATE OFF — a CompletionEvaluator with NO recordProvenance writes NO row,
 *       and the route still returns 200-empty (not 503).
 *   (d) the route requires Bearer auth (401 without a token).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import { CompletionEvaluator } from '../../src/core/CompletionEvaluator.js';
import type { InstarConfig, IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function stubProvider(reply: string): IntelligenceProvider {
  return {
    async evaluate(_p: string, opts?: IntelligenceOptions): Promise<string> {
      opts?.onModel?.({ model: 'e2e-model', framework: 'e2e-fw' });
      opts?.onUsage?.({ inputTokens: 5, outputTokens: 2 });
      return reply;
    },
  };
}

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function baseConfig(stateDir: string, auth: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir: stateDir, stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    provenance: { retentionDays: 14, deterministicSampling: 1.0 },
  } as InstarConfig;
}

function mkStateDir(tmpDir: string, name: string): string {
  const stateDir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return stateDir;
}

const AUTH = 'test-e2e-provenance';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('LLM-decision provenance E2E (feature is alive): 200-not-503 + durable row', () => {
  let tmpDir: string;

  // (a)/(b) GATE ON server: completion evaluator wired to the log.
  let onServer: AgentServer;
  let onApp: express.Express;
  let onStateDir: string;
  let onLog: JudgmentProvenanceLog;

  // (c) GATE OFF server: completion evaluator NOT wired to the log.
  let offServer: AgentServer;
  let offApp: express.Express;
  let offStateDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-e2e-'));

    // ── GATE ON ────────────────────────────────────────────────────────────
    onStateDir = mkStateDir(tmpDir, 'on-state');
    onLog = new JudgmentProvenanceLog({ dir: path.join(onStateDir, 'state', 'judgment-provenance') });
    const onEvaluator = new CompletionEvaluator({
      intelligence: stubProvider('MET\nall done per transcript'),
      recordProvenance: (row) => { onLog.recordDecision(row); },
    });
    onServer = new AgentServer({
      config: baseConfig(onStateDir, AUTH),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(onStateDir),
      judgmentProvenance: onLog,
      completionEvaluator: onEvaluator as never,
    });
    await onServer.start();
    onApp = onServer.getApp();

    // ── GATE OFF ───────────────────────────────────────────────────────────
    offStateDir = mkStateDir(tmpDir, 'off-state');
    const offEvaluator = new CompletionEvaluator({
      intelligence: stubProvider('MET\nall done'),
      // NO recordProvenance — the fleet-dark path.
    });
    offServer = new AgentServer({
      config: baseConfig(offStateDir, AUTH),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(offStateDir),
      // Let AgentServer DEFAULT-CONSTRUCT the log (proves the §3.6 hoist works
      // even when no log instance is passed).
      completionEvaluator: offEvaluator as never,
    });
    await offServer.start();
    offApp = offServer.getApp();
  });

  afterAll(async () => {
    await onServer?.stop();
    await offServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/llm-decision-provenance-alive.test.ts' });
  });

  it('(a) §3.6 HOIST: GET /judgment-provenance is ALIVE on a single-machine boot — 200, NOT 503', async () => {
    const res = await request(onApp).get('/judgment-provenance').set(auth());
    expect(res.status).toBe(200); // the alive proof
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('(a2) the DEFAULT-CONSTRUCTED log (no instance passed) is also alive — 200-empty', async () => {
    const res = await request(offApp).get('/judgment-provenance').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
  });

  it('(b) GATE ON: a live completion verdict writes a DURABLE 0600 row, visible at 200', async () => {
    const post = await request(onApp)
      .post('/autonomous/evaluate-completion')
      .set(auth())
      .send({ condition: 'all tasks done', transcriptTail: 'agent reports complete', topicId: '4242' });
    expect(post.status).toBe(200);
    expect(post.body.met).toBe(true); // the verdict flowed

    // Flush to disk and assert the durable row exists under state/judgment-provenance.
    await onLog.close();
    const dir = path.join(onStateDir, 'state', 'judgment-provenance');
    const files = fs.readdirSync(dir).filter((f) => /\.jsonl$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const day = files[0];
    // 0600 mode (owner rw only) — never world/group readable.
    const mode = fs.statSync(path.join(dir, day)).mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group/other bits
    const rows = fs.readFileSync(path.join(dir, day), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const decision = rows.find((r) => r.decisionPoint === 'CompletionEvaluator:continue-stop:v1');
    expect(decision).toBeDefined();
    expect(decision.decision).toBe('met');
    // Machine-local full context is on DISK (honesty) but never served (checked below).
    expect(decision.contextFull).toBeDefined();

    // The HTTP surface shows the row WITHOUT contextFull.
    const read = await request(onApp).get('/judgment-provenance').set(auth());
    expect(read.status).toBe(200);
    const served = read.body.rows.find((r: any) => r.decisionPoint === 'CompletionEvaluator:continue-stop:v1');
    expect(served).toBeDefined();
    expect('contextFull' in served).toBe(false); // never served raw
  });

  it('(c) GATE OFF: a completion verdict writes NO row; the route stays 200-empty (not 503)', async () => {
    const post = await request(offApp)
      .post('/autonomous/evaluate-completion')
      .set(auth())
      .send({ condition: 'all tasks done', transcriptTail: 'agent reports complete', topicId: '999' });
    expect(post.status).toBe(200);
    expect(post.body.met).toBe(true);

    const read = await request(offApp).get('/judgment-provenance').set(auth());
    expect(read.status).toBe(200); // still alive — never 503
    expect(read.body.rows).toEqual([]); // no provenance written (gate off)
  });

  it('(d) the route requires Bearer auth (401 without a token)', async () => {
    expect((await request(onApp).get('/judgment-provenance')).status).toBe(401);
  });
});
