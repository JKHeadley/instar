/**
 * Integration — context-aware outbound review over the FULL HTTP pipeline
 * (context-aware-outbound-review §5 Tier 2).
 *
 * Real AgentServer (real Bearer auth middleware) + real TopicMemory (SQLite)
 * + a CoherenceGate wired exactly like src/commands/server.ts (liveConfig
 * getter + buildConversationContext provider) + the ReviewCanaryBattery
 * behind its trigger route. The IntelligenceProvider is mocked (captures
 * prompts, scripted verdicts) — everything else is production plumbing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { CoherenceGate } from '../../src/core/CoherenceGate.js';
import { ResponseReviewDecisionLog } from '../../src/core/ResponseReviewDecisionLog.js';
import { ReviewCanaryBattery } from '../../src/monitoring/ReviewCanaryBattery.js';
import { buildConversationContext } from '../../src/core/conversationContextWiring.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import type { InstarConfig, ResponseReviewConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-review-ctx-integration';
const TOPIC = 4711;
const ASK = 'Before you clean anything up, send me the worktree keep/delete list so I can review it.';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

describe('context-aware review — full HTTP pipeline', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let topicMemory: TopicMemory;
  let gate: CoherenceGate;
  let battery: ReviewCanaryBattery;
  let logPath: string;
  const prompts: string[] = [];
  const featureFlag = { enabled: true };
  let providerThrow = false;

  const isTonePrompt = (p: string) => p.includes('communication quality reviewer');
  const normalize = (p: string) =>
    p.replace(/REVIEW_BOUNDARY_[0-9a-f]+/g, 'RB').replace(/CTX_BOUNDARY_[0-9a-f]+/g, 'CB');

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrctx-int-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent\n## Intent\n- Be helpful');

    topicMemory = new TopicMemory(stateDir);
    await topicMemory.open();

    const reviewConfig: ResponseReviewConfig = {
      enabled: true,
      observeOnly: true,
      reviewers: {
        'conversational-tone': { enabled: true, mode: 'block' },
        'claim-provenance': { enabled: true, mode: 'block' },
        'settling-detection': { enabled: false, mode: 'block' },
        'context-completeness': { enabled: false, mode: 'block' },
        'capability-accuracy': { enabled: false, mode: 'block' },
        'url-validity': { enabled: false, mode: 'block' },
        'value-alignment': { enabled: false, mode: 'block' },
        'information-leakage': { enabled: false, mode: 'block' },
        'escalation-resolution': { enabled: false, mode: 'block' },
      },
      timeoutMs: 8000,
      channelDefaults: {
        external: { failOpen: false, skipGate: true, queueOnFailure: true },
        internal: { failOpen: true, skipGate: true, queueOnFailure: false },
      },
    };

    const intelligence = {
      evaluate: async (prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' });
      },
    };

    logPath = path.join(tmpDir, 'logs', 'response-review-decisions.jsonl');
    // Mirror src/commands/server.ts wiring: liveConfig getter + provider over
    // real TopicMemory + buildConversationContext.
    gate = new CoherenceGate({
      config: reviewConfig,
      stateDir,
      intelligence: intelligence as never,
      decisionLog: new ResponseReviewDecisionLog(logPath),
      liveConfig: () => ({ conversationalContext: { enabled: featureFlag.enabled } }),
      conversationContextProvider: (topicId, limit) => {
        if (providerThrow) throw new Error('sqlite wedged (test fixture)');
        return buildConversationContext(topicMemory.getRecentMessages(topicId, limit), null);
      },
    });

    battery = new ReviewCanaryBattery({
      topicMemory,
      callReviewTest: async (body) => {
        const res = await request(app)
          .post('/review/test')
          .set('Authorization', `Bearer ${AUTH}`)
          .send(body);
        return { status: res.status, body: res.body };
      },
      writeDecisionRow: (row) => gate.appendDecisionRow(row),
      isFeatureLive: () => featureFlag.enabled,
      isObserveOnly: () => true,
      isTestEndpointEnabled: () => true,
    });

    const config = {
      projectName: 'rrctx', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
      responseReview: reviewConfig,
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir),
      topicMemory,
      responseReviewGate: gate,
      reviewCanaryBattery: battery,
    });
    await server.start();
    app = server.getApp();

    // Seed the topic's real conversation: the veto-day ask.
    topicMemory.insertMessages([
      {
        messageId: 9001, topicId: TOPIC, text: ASK, fromUser: true,
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        sessionName: 'it', telegramUserId: 42, privacyScope: 'private',
      },
    ]);
  });

  afterAll(async () => {
    await server.stop();
    topicMemory.close?.();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/review-conversation-context.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });
  const readRows = () =>
    fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  it('POST /review/evaluate with a real TopicMemory ask → the captured tone prompt contains the enveloped ask', async () => {
    prompts.length = 0;
    const res = await request(app)
      .post('/review/evaluate')
      .set(auth())
      .send({
        message: 'Here is the worktree keep/delete list: KEEP a, DELETE b.',
        sessionId: 'it-1',
        context: { channel: 'telegram', topicId: TOPIC, recipientType: 'primary-user' },
      })
      .expect(200);
    expect(res.body.pass).toBe(true);
    const tone = prompts.find(isTonePrompt)!;
    expect(tone).toContain('=== RECENT CONVERSATION');
    expect(tone).toContain(JSON.stringify(ASK));
    expect(tone).toContain('ask-license mode: single-sender');
  });

  it('same route, topic with NO rows → no context section; prompt byte-identical to a feature-dark run', async () => {
    prompts.length = 0;
    await request(app)
      .post('/review/evaluate')
      .set(auth())
      .send({
        message: 'plain status', sessionId: 'it-2',
        context: { channel: 'telegram', topicId: 999_999, recipientType: 'primary-user' },
      })
      .expect(200);
    const withFeature = prompts.filter(isTonePrompt).map(normalize);

    featureFlag.enabled = false; // the live kill-switch — no restart
    prompts.length = 0;
    await request(app)
      .post('/review/evaluate')
      .set(auth())
      .send({
        message: 'plain status', sessionId: 'it-3',
        context: { channel: 'telegram', topicId: 999_999, recipientType: 'primary-user' },
      })
      .expect(200);
    const dark = prompts.filter(isTonePrompt).map(normalize);
    featureFlag.enabled = true;

    expect(withFeature).toEqual(dark);
    expect(withFeature[0]).not.toContain('RECENT CONVERSATION');
  });

  it('provider-throw fixture → 200 with the unchanged verdict path (never the route fail-open error body)', async () => {
    providerThrow = true;
    try {
      const res = await request(app)
        .post('/review/evaluate')
        .set(auth())
        .send({
          message: 'plain status', sessionId: 'it-4',
          context: { channel: 'telegram', topicId: TOPIC, recipientType: 'primary-user' },
        })
        .expect(200);
      expect(res.body.pass).toBe(true);
      // NOT the fail-open catch body — the pipeline completed normally.
      expect(res.body.warnings ?? []).not.toContain('[review-error] Pipeline encountered an error');
    } finally {
      providerThrow = false;
    }
  });

  it('GET /review/history entries carry contextMeta and NEVER context bodies', async () => {
    const res = await request(app).get('/review/history?limit=50').set(auth()).expect(200);
    const withMeta = (res.body.history as Array<Record<string, unknown>>).filter((e) => e.contextMeta);
    expect(withMeta.length).toBeGreaterThan(0);
    expect(withMeta[0].contextMeta).toMatchObject({ source: 'topic-memory', askLicenseMode: 'single-sender' });
    expect(JSON.stringify(res.body)).not.toContain(ASK); // bodies never persisted/served
  });

  it('POST /review/test with canary + fixtureId → D8 row carries the tags and the response carries contextMeta', async () => {
    const res = await request(app)
      .post('/review/test')
      .set(auth())
      .send({
        message: 'canary arm replay',
        canary: true,
        fixtureId: 'it-fixture/with-context',
        context: { channel: 'telegram', topicId: TOPIC, recipientType: 'primary-user' },
      })
      .expect(200);
    expect(res.body.contextMeta).toMatchObject({ askLicenseMode: 'single-sender' });
    const row = readRows().find((r) => r.fixtureId === 'it-fixture/with-context');
    expect(row).toBeTruthy();
    expect(row!.canary).toBe(true);
  });

  it('the SAME canary fields on POST /review/evaluate are IGNORED (boundary 13 side B — a real turn cannot self-tag)', async () => {
    await request(app)
      .post('/review/evaluate')
      .set(auth())
      .send({
        message: 'a real turn trying to self-tag',
        sessionId: 'it-6',
        canary: true,
        fixtureId: 'self-tag-attempt',
        context: { channel: 'telegram', topicId: TOPIC, recipientType: 'primary-user' },
      })
      .expect(200);
    const rows = readRows();
    const selfTag = rows.find((r) => r.fixtureId === 'self-tag-attempt');
    expect(selfTag).toBeUndefined();
    const evalRow = rows.find((r) => r.sessionId === 'it-6')!;
    expect(evalRow.canary).toBeUndefined();
  });

  it('POST /review/canary-battery/run is Bearer-gated and alive when the feature is live', async () => {
    await request(app).post('/review/canary-battery/run').expect(401); // no Bearer
    const res = await request(app).post('/review/canary-battery/run').set(auth()).expect(200);
    expect(res.body.batterySummary).toBe(true);
    expect(['passed', 'failed', 'inconclusive']).toContain(res.body.verdict);
    // The mocked all-pass reviewer means adversarial baselines don't flag →
    // fixture-invalid → an honest INCONCLUSIVE (never a silent skip).
    expect(res.body.verdict).toBe('inconclusive');
    // Cleanup contract: no fixture rows remain in the store.
    expect(topicMemory.getRecentMessages(-910_001, 10)).toHaveLength(0);
  });

  it('POST /review/canary-battery/run 503s while the feature is dark', async () => {
    featureFlag.enabled = false;
    try {
      await request(app).post('/review/canary-battery/run').set(auth()).expect(503);
    } finally {
      featureFlag.enabled = true;
    }
  });
});
