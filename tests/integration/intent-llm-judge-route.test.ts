/**
 * Integration tests — POST /intent/org/test-action with the Phase-2 LLM judge
 * (CMT-1128) over the full HTTP pipeline.
 *
 * Decision boundary, both sides:
 *   - flag ON + keyword MISS → the judge runs; refusal carries method
 *     'llm-judge' and the semantically-matched constraint;
 *   - flag ON + keyword MATCH → no LLM call (pre-filter contract); method
 *     'keyword-heuristic';
 *   - flag ON + judge unavailable → heuristic verdict + judgeUnavailable:true
 *     (honest), still 200 — the route never breaks on a judge problem;
 *   - flag OFF → the response is the Phase-1 shape, byte-compatible (no
 *     method field), and the provider is never called.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

const ORG_INTENT = [
  '# Organizational Intent: Test Org',
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

// Zero content-word overlap with the constraint — the live false-negative shape.
const SEMANTIC_MISS_ACTION = 'report revenue estimates to the client as confirmed final numbers';

function fakeProvider(replies: Array<string | Error>) {
  const calls: Array<{ prompt: string; options?: IntelligenceOptions }> = [];
  const provider: IntelligenceProvider = {
    async evaluate(prompt, options) {
      calls.push({ prompt, options });
      const next = replies.shift();
      if (next === undefined) throw new Error('fakeProvider: no reply queued');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { provider, calls };
}

const FORBIDS_1 = JSON.stringify({
  forbidden: true,
  constraintIndex: 1,
  reason: 'Estimates are unverified work; calling them confirmed presents them as completed.',
});

function buildApp(opts: { judgeEnabled: boolean; provider: IntelligenceProvider | null; stateDir: string }) {
  const ctx = {
    config: {
      projectName: 'judge-itest',
      projectDir: path.dirname(opts.stateDir),
      stateDir: opts.stateDir,
      port: 0,
      sessions: {} as never,
      scheduler: {} as never,
      monitoring: opts.judgeEnabled ? { orgIntentLlmJudge: { enabled: true } } : {},
    },
    intelligence: opts.provider,
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  return app;
}

describe('POST /intent/org/test-action — Phase-2 LLM judge (integration)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-judge-itest-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), ORG_INTENT);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/intent-llm-judge-route.test.ts' });
  });

  it('flag ON + keyword MISS: the judge governs the semantic-miss action (the CMT-1126 replay, over the wire)', async () => {
    const { provider, calls } = fakeProvider([FORBIDS_1]);
    const app = buildApp({ judgeEnabled: true, provider, stateDir });
    const res = await request(app).post('/intent/org/test-action').send({ action: SEMANTIC_MISS_ACTION });
    expect(res.status).toBe(200);
    expect(res.body.refusal.refused).toBe(true);
    expect(res.body.refusal.method).toBe('llm-judge');
    expect(res.body.refusal.matchedConstraint).toBe('Never present unverified work as completed.');
    expect(calls).toHaveLength(1);
  });

  it('flag ON + keyword MATCH: no LLM call; refusal carries method keyword-heuristic', async () => {
    const { provider, calls } = fakeProvider([]);
    const app = buildApp({ judgeEnabled: true, provider, stateDir });
    const res = await request(app).post('/intent/org/test-action').send({ action: 'present unverified work as completed' });
    expect(res.status).toBe(200);
    expect(res.body.refusal.refused).toBe(true);
    expect(res.body.refusal.method).toBe('keyword-heuristic');
    expect(calls).toHaveLength(0);
  });

  it('flag ON + judge unavailable: 200 with the heuristic verdict, honestly flagged judgeUnavailable', async () => {
    const { provider } = fakeProvider([new Error('circuit open')]);
    const app = buildApp({ judgeEnabled: true, provider, stateDir });
    const res = await request(app).post('/intent/org/test-action').send({ action: SEMANTIC_MISS_ACTION });
    expect(res.status).toBe(200);
    expect(res.body.refusal.refused).toBe(false);
    expect(res.body.refusal.method).toBe('keyword-heuristic');
    expect(res.body.refusal.judgeUnavailable).toBe(true);
  });

  it('flag OFF: the Phase-1 response shape is unchanged (no method field) and the provider is never called', async () => {
    const { provider, calls } = fakeProvider([]);
    const app = buildApp({ judgeEnabled: false, provider, stateDir });
    const res = await request(app).post('/intent/org/test-action').send({ action: SEMANTIC_MISS_ACTION });
    expect(res.status).toBe(200);
    expect(res.body.refusal.refused).toBe(false);
    expect(res.body.refusal.method).toBeUndefined();
    expect(res.body.refusal.judgeUnavailable).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('flag ON but NO intelligence provider configured: Phase-1 behavior, no method field (the judge needs both)', async () => {
    const app = buildApp({ judgeEnabled: true, provider: null, stateDir });
    const res = await request(app).post('/intent/org/test-action').send({ action: SEMANTIC_MISS_ACTION });
    expect(res.status).toBe(200);
    expect(res.body.refusal.method).toBeUndefined();
  });
});
