/**
 * Integration test — the tone-gate outcome evidence source through the REAL
 * POST /telegram/reply route + the REAL grading pass.
 *
 * Spec: docs/specs/tone-gate-outcome-evidence-source.md
 *
 * Before this feature, `messaging-tone-gate` produced ~99% of all decision volume
 * and EVERY settled verdict was `unknown` — the only rule registered against it
 * was a window CLOSER. These tests prove the two real evidence paths end-to-end:
 *
 *   1. An advisory HOLD explicitly overridden (`metadata.toneAdvisoryAck`) and
 *      delivered unchanged settles `wrong` at SELF-REPORT strength — visible on
 *      GET /decision-quality, and never booked as proof (FD-H).
 *   2. THE LOAD-BEARING NEGATIVE (spec G2/FD-A): a PASS that simply drew no
 *      complaint NEVER settles `right`. It terminalizes `unknown`. A gate that
 *      approved everything unconditionally would be indistinguishable from a
 *      perfect one, so silence must never score.
 *
 * Only the IntelligenceProvider is mocked; the route, the gate, the store, the
 * annotate chokepoint, the grading pass and the read surface are all real.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import {
  IntelligenceRouter,
  type ComponentFrameworksConfig,
} from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import {
  DecisionQualityRecorderImpl,
  installDecisionQualityRecorder,
} from '../../src/core/DecisionQualityRecorderImpl.js';
import { _resetDecisionQualityForTest } from '../../src/core/decisionQualityTypes.js';
import { DP_MESSAGING_TONE_GATE } from '../../src/data/provenanceCoverage.js';
import {
  TONE_OVERRIDE_WRONG_RULE_ID,
  getToneContestationCounters,
  _resetToneContestationCountersForTest,
} from '../../src/core/toneDecisionToken.js';

interface TestServer { url: string; close: () => Promise<void> }

async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const AUTH = 'test-tone-evidence';
let server: TestServer | null = null;
let ledger: FeatureMetricsLedger | null = null;
let tmpDir: string | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  ledger?.close();
  ledger = null;
  installDecisionQualityRecorder(null);
  _resetDecisionQualityForTest();
  vi.restoreAllMocks();
  _resetToneContestationCountersForTest();
  if (tmpDir) {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/tone-gate-outcome-evidence.test.ts' });
    tmpDir = null;
  }
});

/**
 * A REAL IntelligenceRouter over a scripted default provider. The router is what
 * mints the correlation id and fires the settlement seam that writes the decision
 * row — driving the gate with a bare provider bypasses it, so nothing would be
 * recorded and nothing could be graded. This is the production path.
 *
 * The script lets the verdict change between calls (hold, then pass on the rewrite).
 */
function scriptedRouter(responses: Array<{ pass: boolean; rule: string; issue: string; suggestion: string }>): IntelligenceRouter {
  let i = 0;
  const defaultProvider: IntelligenceProvider = {
    async evaluate(_prompt: string, _opts?: IntelligenceOptions): Promise<string> {
      return JSON.stringify(responses[Math.min(i++, responses.length - 1)]);
    },
  };
  const cfg: ComponentFrameworksConfig | undefined = undefined;
  return new IntelligenceRouter({
    defaultProvider,
    defaultFramework: 'claude-code' as IntelligenceFramework,
    resolveConfig: () => cfg,
    buildProvider: () => null,
  });
}

const HOLD_B21 = {
  pass: false,
  rule: 'B21_USER_TASK_SUBSTITUTION',
  issue: 'hands the user a portal click procedure the agent could perform itself',
  suggestion: 'do the portal steps yourself and ask only for the credential you lack',
};
const CLEAN_PASS = { pass: true, rule: '', issue: '', suggestion: '' };

async function buildServer(router: IntelligenceRouter, sent: Array<{ topicId: number; text: string }>) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-evidence-'));
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
  // Live recorder on the SAME ledger so the annotate chokepoint writes durably.
  installDecisionQualityRecorder(new DecisionQualityRecorderImpl({
    ledger,
    config: { developmentAgent: true, provenance: { uniformSeam: { enabled: true, dryRun: false } } },
  }));
  const app = express();
  app.use(express.json());
  const ctx: any = {
    config: {
      authToken: AUTH, stateDir: tmpDir, port: 0, projectName: 'echo',
      developmentAgent: true,
      // Seam LIVE + persisting, so the evidence carrier actually records.
      provenance: { uniformSeam: { enabled: true, dryRun: false } },
    },
    messagingToneGate: new MessagingToneGate(router),
    telegram: { sendToTopic: async (topicId: number, text: string) => { sent.push({ topicId, text }); } },
    sessionManager: { clearInjectionTracker: () => {}, listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    featureMetricsLedger: ledger,
    startTime: new Date(),
  };
  app.use(createRoutes(ctx));
  server = await listen(app);
  return server;
}

async function reply(topicId: number, text: string, metadata?: Record<string, unknown>) {
  const res = await fetch(`${server!.url}/telegram/reply/${topicId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata ? { text, metadata } : { text }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function gradePass() {
  const res = await fetch(`${server!.url}/decision-quality/grade-pass`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` },
    body: '{}',
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function tonePoint() {
  const res = await fetch(`${server!.url}/decision-quality?sinceHours=24`, {
    headers: { Authorization: `Bearer ${AUTH}` },
  });
  const body = await res.json();
  return (body.points as Array<any>).find((p) => p.decisionPoint === DP_MESSAGING_TONE_GATE);
}

const CLICK_LIST =
  'Quick fix on your side: open the app config portal, add the four scopes under OAuth & Permissions, click Reinstall, then /invite the bot in both channels.';

describe('tone-gate contestation — the token round trip through the REAL route', () => {
  it('the advisory 422 carries a token; echoing it settles `wrong` at SELF-REPORT strength', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    await buildServer(scriptedRouter([HOLD_B21]), sent);

    // 1. The gate holds — advisory, so it is a nudge and nothing is delivered.
    const held = await reply(4242, CLICK_LIST);
    expect(held.status).toBe(422);
    expect(held.body.error).toBe('tone-gate-advisory');
    expect(sent).toHaveLength(0);
    // The response hands back the token identifying THIS held decision.
    expect(typeof held.body.decisionToken).toBe('string');
    expect(String(held.body.howToProceed)).toContain('toneDecisionToken');

    // 2. The sender overrides, echoing the token back.
    const overridden = await reply(4242, CLICK_LIST, {
      toneAdvisoryAck: 'B21_USER_TASK_SUBSTITUTION',
      toneDecisionToken: held.body.decisionToken,
    });
    expect(overridden.status).toBe(200);
    expect(sent).toHaveLength(1);

    // 3. Graded immediately against the decision the token names.
    const point = await tonePoint();
    expect(point.gradeDistribution.wrong).toBeGreaterThan(0);
    expect(point.byRule[TONE_OVERRIDE_WRONG_RULE_ID].wrong).toBeGreaterThan(0);
    // FD-H: booked as SELF-REPORT, never as proof.
    expect(point.byStrength['self-report'].wrong).toBeGreaterThan(0);
    expect(point.byStrength['deterministic-proof']?.wrong ?? 0).toBe(0);
    expect(getToneContestationCounters().gradedViaToken).toBeGreaterThan(0);
  });

  it('an override WITHOUT a token still delivers, grades nothing, and is COUNTED as a miss', async () => {
    // The additive contract: a caller that ignores the token keeps working
    // unchanged. Its override delivers; the decision honestly settles unknown;
    // and the miss is counted so the override tally's looseness is knowable.
    const sent: Array<{ topicId: number; text: string }> = [];
    await buildServer(scriptedRouter([HOLD_B21]), sent);

    const held = await reply(4343, CLICK_LIST);
    expect(held.status).toBe(422);

    const overridden = await reply(4343, CLICK_LIST, { toneAdvisoryAck: 'B21_USER_TASK_SUBSTITUTION' });
    expect(overridden.status).toBe(200);
    expect(sent).toHaveLength(1); // delivery is UNAFFECTED

    const point = await tonePoint();
    expect(point.gradeDistribution.wrong).toBe(0);
    expect(getToneContestationCounters().overridesWithoutToken).toBeGreaterThan(0);
  });

  it('a FORGED token delivers the message but grades nothing (fail-closed, never blocks)', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    await buildServer(scriptedRouter([HOLD_B21]), sent);

    const held = await reply(4444, CLICK_LIST);
    expect(held.status).toBe(422);

    const overridden = await reply(4444, CLICK_LIST, {
      toneAdvisoryAck: 'B21_USER_TASK_SUBSTITUTION',
      toneDecisionToken: 'ZmFrZQ.00000000000000000000000000000000',
    });
    // The send is never blocked by an evidence failure.
    expect(overridden.status).toBe(200);
    expect(sent).toHaveLength(1);

    const point = await tonePoint();
    expect(point.gradeDistribution.wrong).toBe(0);
    const c = getToneContestationCounters();
    expect(c.rejected['bad-signature'] + c.rejected.malformed).toBeGreaterThan(0);
    expect(c.gradedViaToken).toBe(0);
  });
});

describe('tone-gate contestation — G2/FD-A: silence is NOT evidence', () => {
  it('a PASS that drew no complaint NEVER settles `right` — it terminalizes `unknown`', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    await buildServer(scriptedRouter([CLEAN_PASS]), sent);

    // A perfectly ordinary message that passes and is never objected to.
    const ok = await reply(6161, 'Deploy finished cleanly — nothing needed from you.');
    expect(ok.status).toBe(200);
    expect(sent).toHaveLength(1);

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 7 * 60 * 60 * 1000);
    await gradePass();

    const point = await tonePoint();
    // THE property: no complaint is not a point for the gate.
    expect(point.gradeDistribution.right).toBe(0);
    expect(point.byRule[TONE_OVERRIDE_WRONG_RULE_ID]?.right ?? 0).toBe(0);
    expect(point.gradeDistribution.unknown).toBeGreaterThan(0);
    expect(point.byRule['tone-window-unknown-v1'].unknown).toBeGreaterThan(0);
  });

  it('a later unrelated message to the same topic does not retroactively score an earlier PASS', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    await buildServer(scriptedRouter([CLEAN_PASS]), sent);

    await reply(7171, 'First clean message.');
    await reply(7171, 'Second, entirely unrelated clean message.');
    expect(sent).toHaveLength(2);

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 7 * 60 * 60 * 1000);
    await gradePass();

    const point = await tonePoint();
    expect(point.gradeDistribution.right).toBe(0);
  });
});
