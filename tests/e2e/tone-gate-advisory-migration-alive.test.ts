// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the tone-gate advisory
 * migration (operator approval 2026-07-19, topic 33368).
 *
 * Per TESTING-INTEGRITY-SPEC this is the tier that catches a feature which
 * passes every unit test and is inert in production. Three things have to be
 * TRUE on the real boot path, and each has already failed in this codebase's
 * history in some form:
 *
 *   1. The migration reaches the live gate. The 2026-07-24 candidate-body gap
 *      was exactly this: a knob that worked everywhere except through the real
 *      construction site, so the feature shipped green and captured nothing.
 *   2. The credential wall holds on a boot with NO tone gate configured. It is
 *      the only unoverridable outbound check, so it must not depend on the
 *      authority it replaced.
 *   3. The new evidence rules are accepted by the LIVE annotate chokepoint. A
 *      rule that is registered in source but rejected at runtime (owner or
 *      rung mismatch) records nothing — and the meter would keep reading
 *      "unknown" forever with no visible error.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resolveToneGateOperatorConfig } from '../../src/core/MessagingToneGate.js';
import { annotateDecisionOutcome, decisionQualityRecordingLive } from '../../src/core/DecisionQualityRecorderImpl.js';
import { DP_MESSAGING_TONE_GATE } from '../../src/data/provenanceCoverage.js';
import { getDecisionQualityRecorder } from '../../src/core/decisionQualityTypes.js';
import type { DecisionQualityRecorderImpl } from '../../src/core/DecisionQualityRecorderImpl.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';

function createMockSessionManager() {
  return {
    listRunningSessions: () => [],
    getSession: () => null,
    clearInjectionTracker: () => {},
    on: () => {},
  };
}

/**
 * The minimum TelegramAdapter surface the reply route needs, injected through
 * the REAL AgentServer option so the route is reachable without opening a
 * network connection. Everything under test — the guard, the gate seam, the
 * 422 plumbing — is production code; only the wire is stubbed. `sent` proves a
 * refusal genuinely delivered nothing.
 */
const sent: Array<{ topicId: number; text: string }> = [];
function createStubTelegram() {
  return {
    sendToTopic: async (topicId: number, text: string) => {
      sent.push({ topicId, text });
      return { ok: true };
    },
  };
}

describe('Tone-gate advisory migration E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let config: InstarConfig;
  const AUTH = 'test-e2e-advisory-migration';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisory-migration-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }),
    );

    config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      // The migration ships dev-gated: live here, dark on the fleet.
      developmentAgent: true,
      provenance: { uniformSeam: { enabled: true, dryRun: false } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      telegram: createStubTelegram() as any,
      messagingToneGate: new MessagingToneGate({
        evaluate: async () => JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' }),
      } as never, { advisoryMigration: true }),
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true, force: true, operation: 'tests/e2e/tone-gate-advisory-migration-alive.test.ts',
    });
  });

  it('the migration resolves LIVE through the production config resolver on a dev agent', () => {
    // The SAME call the server construction site makes (src/commands/server.ts).
    // Asserting the resolver against the REAL config object is what would have
    // caught the candidate-body wiring gap.
    expect(resolveToneGateOperatorConfig(config).advisoryMigration).toBe(true);
  });

  it('an explicit false rolls the migration back on the same live config (no deploy)', () => {
    expect(
      resolveToneGateOperatorConfig({ ...config, toneGate: { advisoryMigration: false } })
        .advisoryMigration,
    ).toBe(false);
  });

  it('the live annotate chokepoint ACCEPTS the override evidence rule', () => {
    // Orphan (no parent decision row on this fresh boot) is expected and fine —
    // what matters is that it is not REJECTED for an unregistered rule, a rung
    // mismatch, or a wrong owning component. A rejection here means every
    // override in production would record nothing, silently.
    const res = annotateDecisionOutcome({
      correlationId: 'd-e2e-00000000-0000-4000-8000-000000000001',
      ruleId: 'tone-agent-override-v1',
      gradedBy: { component: 'ToneGateAdvisory' },
      grade: 'wrong',
      decisionPoint: DP_MESSAGING_TONE_GATE,
      evidenceNote: 'the operator explicitly asked for this detail',
      evidence: { reaction: 'override', rule: 'B2_FILE_PATH' },
    });
    expect(res.rejected).toBeUndefined();
    // `rejected: undefined` alone is NOT proof of landing — it is also true on
    // the dry-run branch, which writes nothing. Assert the row actually landed,
    // or this test proves registration while the evidence silently evaporates.
    expect(res.applied).toBe(true);
  });

  it('the live annotate chokepoint ACCEPTS the compliance evidence rule', () => {
    const res = annotateDecisionOutcome({
      correlationId: 'd-e2e-00000000-0000-4000-8000-000000000002',
      ruleId: 'tone-agent-complied-v1',
      gradedBy: { component: 'ToneGateAdvisory' },
      grade: 'right',
      decisionPoint: DP_MESSAGING_TONE_GATE,
      evidence: { reaction: 'complied', rule: 'B2_FILE_PATH' },
    });
    expect(res.rejected).toBeUndefined();
    expect(res.applied).toBe(true);
  });

  it('reports recording as LIVE on this boot — the precondition the migration depends on', () => {
    // The advisory disposition is conditional on this being true. If the
    // quality seam were dark or dry-run (its DEFAULT), the gate would keep its
    // authority instead of trading it for evidence that never lands.
    expect(decisionQualityRecordingLive()).toBe(true);
  });

  it('a production machine-prefixed reaction lands and GET /decision-quality reports a settled grade', async () => {
    const correlationId = 'd-m_03b30f-00000000-0000-4000-8000-000000000004';
    const recorder = getDecisionQualityRecorder() as DecisionQualityRecorderImpl | null;
    expect(recorder).not.toBeNull();
    recorder!.recordSettlement({
      correlationId,
      mintedBy: 'router',
      enrolled: true,
      provenance: {
        decisionPoint: DP_MESSAGING_TONE_GATE,
        context: { channel: 'telegram' },
        optionsPresented: ['pass', 'advisory'],
        promptId: 'tone-gate-sigv1',
      },
      settledAttempt: { model: 'gpt-5.4-mini', framework: 'codex-cli', usage: { inputTokens: 5, outputTokens: 2 } },
      verdictClass: 'advisory',
      mintedAtMs: Date.now() - 100,
      settledAtMs: Date.now(),
    } as never);

    const sentBefore = sent.length;
    const reaction = await request(app)
      .post('/telegram/reply/9004')
      .set({ Authorization: `Bearer ${AUTH}` })
      .send({
        text: 'I revised the message to remove the unnecessary internal path.',
        metadata: {
          toneAdvisoryComplied: 'B2_FILE_PATH',
          toneAdvisoryDecisionRef: correlationId,
        },
      });
    expect(reaction.status).toBe(200);
    expect(sent).toHaveLength(sentBefore + 1);
    await new Promise((resolve) => setImmediate(resolve));

    const read = await request(app).get('/decision-quality').set({ Authorization: `Bearer ${AUTH}` });
    expect(read.status).toBe(200);
    const point = read.body.points.find((row: { decisionPoint: string }) => row.decisionPoint === DP_MESSAGING_TONE_GATE);
    expect(point).toMatchObject({
      settledGrades: 1,
      gradeDistribution: { right: 1, wrong: 0, unknown: 0, selfReportOnly: true },
      byRule: { 'tone-agent-complied-v1': { right: 1, wrong: 0, unknown: 0 } },
    });
    // Keep the pre-existing credential-wall assertions independent of this send.
    sent.length = 0;
  });

  it('REJECTS an impostor annotator claiming the rule (self-report cannot be forged by another component)', () => {
    const res = annotateDecisionOutcome({
      correlationId: 'd-e2e-00000000-0000-4000-8000-000000000003',
      ruleId: 'tone-agent-override-v1',
      gradedBy: { component: 'DecisionGrading' },
      grade: 'wrong',
      decisionPoint: DP_MESSAGING_TONE_GATE,
    });
    expect(res.rejected).toBe('owner-mismatch');
  });

  it('the credential wall is alive on the real boot and refuses without echoing the value', async () => {
    const res = await request(app)
      .post('/telegram/reply/9001')
      .set({ Authorization: `Bearer ${AUTH}` })
      .send({ text: 'the key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });

    expect(res.status).toBe(422);
    expect(res.body.blockedBy).toBe('credential-exposure-guard');
    expect(res.body.overridable).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('sk-ant-api03');
    expect(sent).toHaveLength(0);
  });

  it('the credential wall cannot be acknowledged away on the real boot', async () => {
    const res = await request(app)
      .post('/telegram/reply/9002')
      .set({ Authorization: `Bearer ${AUTH}` })
      .send({
        text: 'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        metadata: {
          toneAdvisoryAck: 'B2_FILE_PATH',
          toneAdvisoryAckReason: 'the operator asked me to send it',
          allowDebugText: true,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.blockedBy).toBe('credential-exposure-guard');
    expect(sent).toHaveLength(0);
  });

  it('a clean message DOES send on the same boot (the wall is not a blanket refusal)', async () => {
    const res = await request(app)
      .post('/telegram/reply/9003')
      .set({ Authorization: `Bearer ${AUTH}` })
      .send({ text: 'I already hold that credential in the vault, so I do not need you to send one.' });

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});
