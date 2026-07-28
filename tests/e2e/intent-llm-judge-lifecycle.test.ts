/**
 * E2E lifecycle — Phase-2 LLM judge for ORG-INTENT governance (CMT-1128).
 *
 * Tier 3 of the Testing Integrity Standard on the PRODUCTION initialization
 * path: a REAL AgentServer.start() (the same call src/commands/server.ts
 * makes) with the judge flag enabled and an intelligence provider injected
 * through the real options seam must
 *   Phase 1 — Feature is alive: POST /intent/org/test-action answers 200 (not
 *             404/503) with an llm-judge verdict for the semantic-miss action
 *             the keyword matcher provably cannot govern.
 *   Phase 2 — Dark by default: the same server WITHOUT the flag serves the
 *             Phase-1 heuristic response unchanged (no method field), and a
 *             judge problem never breaks the route (200 with the honest
 *             judgeUnavailable flag).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const AUTH = 'test-intent-judge-e2e';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

const ORG_INTENT = [
  '# Organizational Intent: E2E Org',
  '',
  '> MTP: Make the test suite honest.',
  '',
  '## Constraints (Mandatory — agents cannot override)',
  '',
  '- Never present unverified work as completed.',
  '',
  '## Goals (Defaults — agents can specialize)',
  '',
  '- Ship reliable software quickly.',
  '',
  '## Values',
  '',
  '- Honesty',
].join('\n');

const SEMANTIC_MISS_ACTION = 'report revenue estimates to the client as confirmed final numbers';

const FORBIDS_1 = JSON.stringify({
  forbidden: true,
  constraintIndex: 1,
  reason: 'Estimates are unverified work; calling them confirmed presents them as completed.',
});

function mkStateDir(prefix: string): { tmpDir: string; stateDir: string } {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'intent-judge-e2e' }));
  fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), ORG_INTENT);
  return { tmpDir, stateDir };
}

function mkConfig(tmpDir: string, stateDir: string, judgeEnabled: boolean): InstarConfig {
  return {
    projectName: 'intent-judge-e2e',
    projectDir: tmpDir,
    stateDir,
    port: 0,
    authToken: AUTH,
    requestTimeoutMs: 10000,
    version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    monitoring: judgeEnabled ? { orgIntentLlmJudge: { enabled: true } } : {},
    updates: {},
  } as InstarConfig;
}

describe('intent LLM-judge E2E lifecycle (CMT-1128)', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const providerCalls: string[] = [];
  const replies: Array<string | Error> = [FORBIDS_1, new Error('circuit open')];
  const provider: IntelligenceProvider = {
    async evaluate(prompt) {
      providerCalls.push(prompt);
      const next = replies.shift();
      if (next === undefined) throw new Error('no reply queued');
      if (next instanceof Error) throw next;
      return next;
    },
  };

  beforeAll(async () => {
    const dirs = mkStateDir('intent-judge-e2e-');
    tmpDir = dirs.tmpDir;
    server = new AgentServer({
      config: mkConfig(tmpDir, dirs.stateDir, true),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(dirs.stateDir),
      intelligence: provider,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    try {
      await server.stop();
    } catch {
      /* already stopped */
    }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/intent-llm-judge-lifecycle.test.ts' });
  });

  // ── Phase 1: feature is alive on the production boot path ──

  it('FEATURE IS ALIVE: the judge governs the semantic-miss action through a real AgentServer (200, llm-judge verdict)', async () => {
    const res = await request(app)
      .post('/intent/org/test-action')
      .set(auth())
      .send({ action: SEMANTIC_MISS_ACTION });
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    expect(res.body.refusal.refused).toBe(true);
    expect(res.body.refusal.method).toBe('llm-judge');
    expect(res.body.refusal.matchedConstraint).toBe('Never present unverified work as completed.');
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toContain('Never present unverified work as completed.');
  });

  it('a judge problem never breaks the route: 200 with the heuristic verdict honestly flagged judgeUnavailable', async () => {
    const res = await request(app)
      .post('/intent/org/test-action')
      .set(auth())
      .send({ action: SEMANTIC_MISS_ACTION });
    expect(res.status).toBe(200);
    expect(res.body.refusal.refused).toBe(false);
    expect(res.body.refusal.method).toBe('keyword-heuristic');
    expect(res.body.refusal.judgeUnavailable).toBe(true);
  });

  // ── Phase 2: dark by default ──

  it('without the flag, a real server serves the Phase-1 heuristic response unchanged (no method field)', async () => {
    const dirs = mkStateDir('intent-judge-e2e-dark-');
    const dark = new AgentServer({
      config: mkConfig(dirs.tmpDir, dirs.stateDir, false),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(dirs.stateDir),
      intelligence: provider,
    });
    await dark.start();
    try {
      const before = providerCalls.length;
      const res = await request(dark.getApp())
        .post('/intent/org/test-action')
        .set(auth())
        .send({ action: SEMANTIC_MISS_ACTION });
      expect(res.status).toBe(200);
      expect(res.body.refusal.refused).toBe(false);
      expect(res.body.refusal.method).toBeUndefined();
      expect(providerCalls.length).toBe(before);
    } finally {
      await dark.stop();
      SafeFsExecutor.safeRmSync(dirs.tmpDir, { recursive: true, force: true, operation: 'tests/e2e/intent-llm-judge-lifecycle.test.ts' });
    }
  });
});
