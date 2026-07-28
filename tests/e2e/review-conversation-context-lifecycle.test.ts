// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test — context-aware outbound
 * review (context-aware-outbound-review §5 Tier 3).
 *
 * Mirrors the PRODUCTION init path of src/commands/server.ts: the REAL
 * LiveConfig class over the on-disk .instar/config.json, the REAL dev-gate
 * funnel (resolveDevAgentGate) at the WIRING layer, the REAL TopicMemory +
 * TopicOperatorStore behind buildConversationContext, the REAL AgentServer
 * (real Bearer auth middleware), the REAL ReviewCanaryBattery behind its
 * trigger route. Proves:
 *   1. DEV-AGENT boot (`developmentAgent: true`, `enabled` OMITTED) → the
 *      feature is ALIVE: /review/evaluate 200 with the context section in the
 *      reviewer prompt; /review/canary-battery/run answers 200 (not 503).
 *   2. WIRING-INTEGRITY: the provider is non-null, not a no-op — it
 *      delegates to the real TopicMemory (a seeded ask appears enveloped in
 *      the prompt) and the real TopicOperatorStore (a bound operator flips
 *      the mode to verified-operator with the principal tag).
 *   3. Boundary 12 against the REAL wiring: an on-disk config flip of
 *      `responseReview.conversationalContext.enabled: false` applies at the
 *      NEXT evaluate — no restart.
 *   4. FLEET-DEFAULT boot (`developmentAgent` absent, `enabled` omitted) →
 *      byte-identical current behavior (no section; battery route 503) — the
 *      dark side of the Maturation Path.
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
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import type { InstarConfig, ResponseReviewConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TOPIC = 3141;
const ASK = 'send me the worktree keep/delete list so I can review it';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

const reviewConfig = (): ResponseReviewConfig => ({
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
});

/**
 * Boot one agent exactly the way src/commands/server.ts wires the feature.
 * `developmentAgent` distinguishes the dev boot from the fleet boot; the
 * conversationalContext.enabled key is OMITTED (the dev-gate convention).
 */
async function boot(opts: { auth: string; developmentAgent: boolean }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrctx-e2e-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent\n## Intent\n- Be helpful');
  // The on-disk config the REAL LiveConfig reads (kill-switch surface).
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({
      port: 0,
      projectName: 'e2e',
      ...(opts.developmentAgent ? { developmentAgent: true } : {}),
      responseReview: { enabled: true, observeOnly: true },
    }, null, 2),
  );

  const liveConfig = new LiveConfig(stateDir);
  const topicMemory = new TopicMemory(stateDir);
  await topicMemory.open();
  const operatorStore = new TopicOperatorStore(path.join(stateDir, 'state'));

  const prompts: string[] = [];
  const intelligence = {
    evaluate: async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({ pass: true, severity: 'warn', issue: '', suggestion: '' });
    },
  };

  const cfg = reviewConfig();
  // ── EXACTLY the server.ts resolveConversationalContext closure ──
  const resolveConversationalContext = () => {
    const cc = liveConfig.get<Record<string, unknown> | undefined>(
      'responseReview.conversationalContext',
      cfg.conversationalContext as Record<string, unknown> | undefined,
    ) ?? {};
    const dev = liveConfig.get<boolean | undefined>('developmentAgent', undefined);
    return {
      enabled: resolveDevAgentGate(
        typeof cc.enabled === 'boolean' ? cc.enabled : undefined,
        { developmentAgent: dev },
      ),
      maxMessages: typeof cc.maxMessages === 'number' ? cc.maxMessages : undefined,
      maxCharsPerMessage: typeof cc.maxCharsPerMessage === 'number' ? cc.maxCharsPerMessage : undefined,
      maxTotalChars: typeof cc.maxTotalChars === 'number' ? cc.maxTotalChars : undefined,
      injectReviewers: Array.isArray(cc.injectReviewers) ? (cc.injectReviewers as string[]) : undefined,
    };
  };

  const logPath = path.join(tmpDir, 'logs', 'response-review-decisions.jsonl');
  const gate = new CoherenceGate({
    config: cfg,
    stateDir,
    intelligence: intelligence as never,
    decisionLog: new ResponseReviewDecisionLog(logPath),
    liveConfig: () => ({
      failClosedOnCriticalAbstain: liveConfig.get<boolean | undefined>(
        'responseReview.failClosedOnCriticalAbstain', undefined,
      ),
      conversationalContext: resolveConversationalContext(),
    }),
    conversationContextProvider: (topicId, limit) => {
      const rows = topicMemory.getRecentMessages(topicId, limit);
      const operator = operatorStore.getOperator(topicId);
      return buildConversationContext(rows, operator);
    },
  });

  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: opts.auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    responseReview: cfg,
  } as unknown as InstarConfig;

  const server = new AgentServer({
    config,
    sessionManager: createMockSessionManager() as never,
    state: new StateManager(stateDir),
    topicMemory,
    responseReviewGate: gate,
    reviewCanaryBattery: undefined as never, // set below (needs app for the self-call)
  });
  await server.start();
  const app = server.getApp();

  const battery = new ReviewCanaryBattery({
    topicMemory,
    callReviewTest: async (body) => {
      const res = await request(app).post('/review/test').set('Authorization', `Bearer ${opts.auth}`).send(body);
      return { status: res.status, body: res.body };
    },
    writeDecisionRow: (row) => gate.appendDecisionRow(row),
    isFeatureLive: () => resolveConversationalContext().enabled,
    isObserveOnly: () => liveConfig.get<boolean>('responseReview.observeOnly', cfg.observeOnly === true),
    isTestEndpointEnabled: () => liveConfig.get<boolean>('responseReview.testEndpointDisabled', false) !== true,
  });
  // Late-bind the battery into the running server's route context the way
  // server.ts passes it at construction (the ctx object holds the reference).
  await server.stop();
  const server2 = new AgentServer({
    config,
    sessionManager: createMockSessionManager() as never,
    state: new StateManager(stateDir),
    topicMemory,
    responseReviewGate: gate,
    reviewCanaryBattery: battery,
  });
  await server2.start();

  return {
    tmpDir, stateDir, liveConfig, topicMemory, operatorStore, prompts,
    server: server2, app: server2.getApp(), auth: opts.auth,
  };
}

type Boot = Awaited<ReturnType<typeof boot>>;

describe('context-aware review E2E — feature alive on the production init path', () => {
  let dev: Boot;
  let fleet: Boot;

  beforeAll(async () => {
    dev = await boot({ auth: 'e2e-rrctx-dev', developmentAgent: true });
    fleet = await boot({ auth: 'e2e-rrctx-fleet', developmentAgent: false });
    for (const b of [dev, fleet]) {
      b.topicMemory.insertMessages([
        {
          messageId: 7001, topicId: TOPIC, text: ASK, fromUser: true,
          timestamp: new Date(Date.now() - 30_000).toISOString(),
          sessionName: 'e2e', telegramUserId: 42, privacyScope: 'private',
        },
      ]);
    }
  });

  afterAll(async () => {
    for (const b of [dev, fleet]) {
      await b.server.stop();
      b.liveConfig.stop();
      b.topicMemory.close?.();
      SafeFsExecutor.safeRmSync(b.tmpDir, { recursive: true, force: true, operation: 'tests/e2e/review-conversation-context-lifecycle.test.ts' });
    }
  });

  const isTonePrompt = (p: string) => p.includes('communication quality reviewer');

  it('DEV boot: /review/evaluate is 200 with context LIVE — the seeded ask reaches the reviewer through real TopicMemory (wiring integrity)', async () => {
    dev.prompts.length = 0;
    const res = await request(dev.app)
      .post('/review/evaluate')
      .set('Authorization', `Bearer ${dev.auth}`)
      .send({
        message: 'Here is the worktree keep/delete list: KEEP a, DELETE b.',
        sessionId: 'e2e-1',
        context: { channel: 'telegram', topicId: TOPIC, recipientType: 'primary-user' },
      })
      .expect(200);
    expect(res.body.pass).toBe(true);
    const tone = dev.prompts.find(isTonePrompt)!;
    expect(tone).toContain('=== RECENT CONVERSATION');
    expect(tone).toContain(JSON.stringify(ASK)); // delegates to REAL TopicMemory — not a no-op
    expect(tone).toContain('ask-license mode: single-sender');
  });

  it('DEV boot: a REAL TopicOperatorStore binding flips the mode to verified-operator with the principal tag (wiring integrity, Know Your Principal)', async () => {
    dev.operatorStore.setOperator(TOPIC, { platform: 'telegram', uid: '42', displayName: 'Justin' });
    dev.prompts.length = 0;
    await request(dev.app)
      .post('/review/evaluate')
      .set('Authorization', `Bearer ${dev.auth}`)
      .send({
        message: 'Worktree list again.', sessionId: 'e2e-2',
        context: { channel: 'telegram', topicId: TOPIC, recipientType: 'primary-user' },
      })
      .expect(200);
    const tone = dev.prompts.find(isTonePrompt)!;
    expect(tone).toContain('ask-license mode: verified-operator');
    expect(tone).toContain(`USER(verified-operator): ${JSON.stringify(ASK)}`);
  });

  it('DEV boot: POST /review/canary-battery/run is ALIVE (200, not 503) and honest about the mocked reviewer (inconclusive, recorded)', async () => {
    const res = await request(dev.app)
      .post('/review/canary-battery/run')
      .set('Authorization', `Bearer ${dev.auth}`)
      .expect(200);
    expect(res.body.batterySummary).toBe(true);
    // All-pass mocked reviewer ⇒ adversarial baselines can't flag ⇒ honest
    // fixture-invalid INCONCLUSIVE — and the summary row is durable.
    expect(res.body.verdict).toBe('inconclusive');
    const logPath = path.join(dev.tmpDir, 'logs', 'response-review-decisions.jsonl');
    const rows = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.some((r) => r.batterySummary === true)).toBe(true);
    // Cleanup contract on the REAL store: no fixture rows remain.
    expect(dev.topicMemory.getRecentMessages(-910_001, 10)).toHaveLength(0);
  });

  it('boundary 12 on the REAL wiring: flipping conversationalContext.enabled=false ON DISK applies at the next evaluate — no restart', async () => {
    const configPath = path.join(dev.stateDir, 'config.json');
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    onDisk.responseReview.conversationalContext = { enabled: false };
    fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2));
    dev.liveConfig.forceRefresh();
    try {
      dev.prompts.length = 0;
      await request(dev.app)
        .post('/review/evaluate')
        .set('Authorization', `Bearer ${dev.auth}`)
        .send({
          message: 'After the kill switch.', sessionId: 'e2e-3',
          context: { channel: 'telegram', topicId: TOPIC, recipientType: 'primary-user' },
        })
        .expect(200);
      expect(dev.prompts.find(isTonePrompt)).not.toContain('RECENT CONVERSATION');
      // …and the battery route follows the flag → 503.
      await request(dev.app)
        .post('/review/canary-battery/run')
        .set('Authorization', `Bearer ${dev.auth}`)
        .expect(503);
    } finally {
      delete onDisk.responseReview.conversationalContext;
      fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2));
      dev.liveConfig.forceRefresh();
    }
  });

  it('FLEET boot (enabled omitted, not a dev agent): behavior byte-identical to current — no section, battery route 503 (the dark side of the Maturation Path)', async () => {
    fleet.prompts.length = 0;
    const res = await request(fleet.app)
      .post('/review/evaluate')
      .set('Authorization', `Bearer ${fleet.auth}`)
      .send({
        message: 'Here is the worktree keep/delete list: KEEP a, DELETE b.',
        sessionId: 'e2e-f1',
        context: { channel: 'telegram', topicId: TOPIC, recipientType: 'primary-user' },
      })
      .expect(200);
    expect(res.body.pass).toBe(true);
    const tone = fleet.prompts.find(isTonePrompt)!;
    expect(tone).not.toContain('RECENT CONVERSATION');
    expect(tone).not.toContain('ask-license mode');
    await request(fleet.app)
      .post('/review/canary-battery/run')
      .set('Authorization', `Bearer ${fleet.auth}`)
      .expect(503);
  });

  it('routes are Bearer-gated (real auth middleware on the production path)', async () => {
    await request(dev.app).post('/review/evaluate').send({ message: 'x', sessionId: 'nope' }).expect(401);
    await request(dev.app).post('/review/canary-battery/run').expect(401);
  });
});
