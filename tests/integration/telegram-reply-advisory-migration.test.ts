/**
 * Integration test — the advisory migration through the REAL POST /telegram/reply
 * route (operator approval 2026-07-19, topic 33368).
 *
 * The migration's promise, end to end:
 *   1. A judgment rule that used to be a WALL (B2_FILE_PATH — the operator's
 *      founding complaint: "a check blocking me from sending you a directory
 *      path is too much power") returns an overridable nudge instead.
 *   2. The nudge hands back a `decisionRef` so the agent's reaction can be
 *      joined to the verdict it answers.
 *   3. An override REQUIRES a reason; with one, the message ships unchanged.
 *   4. A live credential is the one thing that still cannot be sent — and it is
 *      refused even WITH an ack, because the wall is deterministic and sits in
 *      front of the LLM authority entirely.
 *   5. B2 remains advisory even with the broader migration off; ordinary path
 *      usefulness is never an absolute wall.
 *
 * Only the IntelligenceProvider is mocked; route, gate, disposition resolver,
 * credential guard and the 422 plumbing are all real.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import {
  DecisionQualityRecorderImpl,
  installDecisionQualityRecorder,
} from '../../src/core/DecisionQualityRecorderImpl.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { DP_MESSAGING_TONE_GATE } from '../../src/data/provenanceCoverage.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * The advisory disposition is CONDITIONAL on the reaction being recordable
 * (the evidence-capturability invariant): with no live quality recorder the
 * gate keeps its authority and returns a plain block. So an advisory test must
 * install a live recorder — and the un-installed case is itself worth asserting.
 */
let ledger: FeatureMetricsLedger | null = null;
const tmpDirs: string[] = [];
function installLiveRecorder(): void {
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
  installDecisionQualityRecorder(
    new DecisionQualityRecorderImpl({
      ledger,
      config: {
        developmentAgent: true,
        provenance: { uniformSeam: { enabled: true, dryRun: false } },
      } as never,
    }),
  );
}

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

/**
 * A provider that behaves like the REAL routed path in the one respect this
 * feature depends on: `IntelligenceRouter.evaluate` fires
 * `provenance.onCorrelationId` synchronously at mint, before the first attempt.
 * A bare mock skips that, which would leave every verdict without a
 * `decisionRef` — and the evidence-capturability invariant would then correctly
 * demote every advisory to a block, making these tests silently vacuous.
 *
 * (A production install whose provider genuinely bypasses the router has the
 * same shape, and the same safe outcome: the migration stays inert, visibly, via
 * `advisoryUnavailable: 'no-decision-ref'`.)
 */
let refCounter = 0;
function makeProvider(response: { pass: boolean; rule: string; issue: string; suggestion: string }): IntelligenceProvider {
  return {
    evaluate: vi.fn(async (_prompt: string, opts?: { provenance?: { onCorrelationId?: (id: string) => void } }) => {
      refCounter += 1;
      opts?.provenance?.onCorrelationId?.(
        `d-testmach-00000000-0000-4000-8000-${String(refCounter).padStart(12, '0')}`,
      );
      return JSON.stringify(response);
    }),
  } as unknown as IntelligenceProvider;
}

function buildApp(opts: {
  toneGate: MessagingToneGate | null;
  sent: Array<{ topicId: number; text: string }>;
}): express.Express {
  const app = express();
  app.use(express.json());
  const ctx: any = {
    config: {
      authToken: 'test',
      stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'advisory-migration-')),
      port: 0,
      projectName: 'echo',
    },
    messagingToneGate: opts.toneGate,
    telegram: {
      sendToTopic: async (topicId: number, text: string) => {
        opts.sent.push({ topicId, text });
      },
    },
    sessionManager: { clearInjectionTracker: () => {} },
  };
  app.use(createRoutes(ctx));
  return app;
}

function runReplyScript(opts: {
  port: number;
  args: string[];
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-reply-client-int-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.instar', 'config.json'),
    JSON.stringify({ port: opts.port, projectName: 'client-int' }),
  );
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.resolve('src/templates/scripts/telegram-reply.sh'), ...opts.args], {
      cwd: dir,
      env: {
        ...process.env,
        INSTAR_SENDER_CLASS: 'script',
        INSTAR_AUTH_TOKEN: '',
        INSTAR_PORT: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** The founding complaint: a message whose only sin is naming a directory. */
const PATH_MESSAGE =
  'I put the convergence report in docs/audits/tone-gate-grading.md — it lists every scenario and the verdicts.';

const B2_VERDICT = {
  pass: false,
  rule: 'B2_FILE_PATH',
  issue: 'exposes a raw repository path the user cannot act on',
  suggestion: 'describe the document and offer a link instead of the path',
};

describe('advisory migration through POST /telegram/reply', () => {
  let server: TestServer;
  beforeEach(() => { installLiveRecorder(); });
  afterEach(async () => {
    await server?.close();
    installDecisionQualityRecorder(null);
    ledger?.close();
    ledger = null;
    for (const dir of tmpDirs.splice(0)) {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/telegram-reply-advisory-migration.test.ts',
      });
    }
  });

  async function reply(topicId: number, text: string, metadata?: Record<string, unknown>) {
    const res = await fetch(`${server.url}/telegram/reply/${topicId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata ? { text, metadata } : { text }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  }

  it('turns a former WALL (B2_FILE_PATH) into a nudge, and names both reaction paths', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    const gate = new MessagingToneGate(makeProvider(B2_VERDICT), { advisoryMigration: true });
    server = await listen(buildApp({ toneGate: gate, sent }));

    const res = await reply(201, PATH_MESSAGE);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('tone-gate-advisory');
    expect(res.body.notSent).toBe(true);
    // Both directions are offered: compliance is recordable, not just dissent.
    expect(String(res.body.howToProceed)).toContain('toneAdvisoryComplied');
    expect(String(res.body.howToProceed)).toContain('toneAdvisoryAckReason');
    expect(sent).toHaveLength(0);
  });

  it('refuses an override with no reason, then delivers unchanged once a reason is given', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    const gate = new MessagingToneGate(makeProvider(B2_VERDICT), { advisoryMigration: true });
    server = await listen(buildApp({ toneGate: gate, sent }));

    const reasonless = await reply(202, PATH_MESSAGE, { toneAdvisoryAck: 'B2_FILE_PATH' });
    expect(reasonless.status).toBe(422);
    expect(reasonless.body.error).toBe('tone-gate-advisory-reason-required');
    expect(sent).toHaveLength(0);

    const withReason = await reply(202, PATH_MESSAGE, {
      toneAdvisoryAck: 'B2_FILE_PATH',
      toneAdvisoryAckReason: 'the operator asked for the exact path so they can open it in the Files tab',
      allowDuplicate: true,
    });
    expect(withReason.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(PATH_MESSAGE);
  });


  /**
   * A provider whose verdict CHANGES between calls — which is what the live
   * gate does, because it re-reviews on every attempt.
   *
   * Found by dogfooding on 2026-07-25: overriding a live advisory failed four
   * times with byte-identical text and a matching rule. Every existing test
   * here pins ONE verdict for the whole run, so `result.rule` is constant by
   * construction and the ack always matches. That harness cannot see a gate
   * that re-reviews — it removes the exact variability that breaks the feature.
   */
  function shiftingProvider(sequence: Array<{ pass: boolean; rule: string; issue: string; suggestion: string }>) {
    let call = 0;
    return {
      evaluate: vi.fn(async (_prompt: string, opts?: { provenance?: { onCorrelationId?: (id: string) => void } }) => {
        refCounter += 1;
        opts?.provenance?.onCorrelationId?.(
          `d-testmach-00000000-0000-4000-8000-${String(refCounter).padStart(12, '0')}`,
        );
        const r = sequence[Math.min(call, sequence.length - 1)];
        call += 1;
        return JSON.stringify(r);
      }),
    } as unknown as IntelligenceProvider;
  }

  const B11_VERDICT = {
    pass: false,
    rule: 'B11_STYLE_MISMATCH',
    issue: 'reads as machine output rather than plain English',
    suggestion: 'rewrite it as plain prose',
  };

  it('honors an ack when the RE-REVIEW returns the same rule the agent acked', async () => {
    // The live shape: attempt 1 nudges with rule X; the agent re-sends unchanged
    // acking X; the gate re-reviews and again says X. The ack must be honored on
    // that second call — otherwise "the decision is yours" is false and the
    // advisory is a hard block wearing a nudge's wording.
    const sent: Array<{ topicId: number; text: string }> = [];
    const gate = new MessagingToneGate(shiftingProvider([B11_VERDICT, B11_VERDICT]), {
      advisoryMigration: true,
    });
    server = await listen(buildApp({ toneGate: gate, sent }));

    const first = await reply(207, PATH_MESSAGE);
    expect(first.status).toBe(422);
    expect(first.body.rule).toBe('B11_STYLE_MISMATCH');

    const acked = await reply(207, PATH_MESSAGE, {
      toneAdvisoryAck: 'B11_STYLE_MISMATCH',
      toneAdvisoryAckReason: 'the finding quoted evidence that never appeared in the reviewed text',
      allowDuplicate: true,
    });
    expect(acked.status, JSON.stringify(acked.body)).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('an ack for the PREVIOUS rule does not silently pass a NEW finding', async () => {
    // The other side of the boundary: the agent acks X, the re-review raises a
    // DIFFERENT rule Y. Honoring the stale ack would let an unreviewed objection
    // through. It must nudge again, naming Y.
    const sent: Array<{ topicId: number; text: string }> = [];
    const gate = new MessagingToneGate(shiftingProvider([B2_VERDICT, B11_VERDICT]), {
      advisoryMigration: true,
    });
    server = await listen(buildApp({ toneGate: gate, sent }));

    const first = await reply(208, PATH_MESSAGE);
    expect(first.body.rule).toBe('B2_FILE_PATH');

    const staleAck = await reply(208, PATH_MESSAGE, {
      toneAdvisoryAck: 'B2_FILE_PATH',
      toneAdvisoryAckReason: 'the operator asked for the exact path so they can open it',
      allowDuplicate: true,
    });
    expect(staleAck.status).toBe(422);
    expect(staleAck.body.rule).toBe('B11_STYLE_MISMATCH');
    expect(sent).toHaveLength(0);
  });

  it('keeps B2 advisory when the broader migration is off', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    const gate = new MessagingToneGate(makeProvider(B2_VERDICT), { advisoryMigration: false });
    server = await listen(buildApp({ toneGate: gate, sent }));

    const res = await reply(203, PATH_MESSAGE);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('tone-gate-advisory');
    expect(sent).toHaveLength(0);

    // The explicit override remains available because B2 is advisory by baseline.
    const acked = await reply(203, PATH_MESSAGE, {
      toneAdvisoryAck: 'B2_FILE_PATH',
      toneAdvisoryAckReason: 'the operator asked for the exact path',
      allowDuplicate: true,
    });
    expect(acked.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('does NOT demote baseline-advisory B2 when reaction recording is unavailable', async () => {
    // The evidence-capturability invariant. The migration's justification IS
    // the recorded reaction; with no live recorder there is nothing to record,
    // so the gate must keep its authority rather than hand out a loosening for
    // free. This is the default-configuration hazard: the quality seam is a
    // SEPARATE gate whose dryRun defaults true, so a fleet flip of the
    // migration alone would otherwise be pure weakening.
    installDecisionQualityRecorder(null);
    const sent: Array<{ topicId: number; text: string }> = [];
    const gate = new MessagingToneGate(makeProvider(B2_VERDICT), { advisoryMigration: true });
    server = await listen(buildApp({ toneGate: gate, sent }));

    const res = await reply(205, PATH_MESSAGE);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('tone-gate-advisory');
    expect(res.body.decisionRef).toMatch(/^d-testmach-/);
    expect(res.body.howToProceed).toContain('recording is unavailable');
    expect(res.body.howToProceed).not.toContain('Both are recorded');
    expect(res.body.howToProceed).not.toContain('gets credit');
    expect(sent).toHaveLength(0);

    const overridden = await reply(205, PATH_MESSAGE, {
      toneAdvisoryAck: 'B2_FILE_PATH',
      toneAdvisoryAckReason: 'the exact path is the artifact the operator asked to open',
      allowDuplicate: true,
    });
    expect(overridden.status).toBe(200);
    expect(sent).toEqual([{ topicId: 205, text: PATH_MESSAGE }]);
  });

  it('credits compliance SERVER-SIDE when a revised send follows a nudge — no agent metadata', async () => {
    // The asymmetry fix. An override cannot happen without producing its grade
    // (the message will not send otherwise); compliance must not depend on the
    // agent remembering two fields across a revise cycle, or the sample skews
    // permanently toward "the gate was wrong".
    const sent: Array<{ topicId: number; text: string }> = [];
    let verdict = { ...B2_VERDICT };
    const provider = {
      evaluate: vi.fn(async (_p: string, opts?: { provenance?: { onCorrelationId?: (id: string) => void } }) => {
        opts?.provenance?.onCorrelationId?.('d-testmach-00000000-0000-4000-8000-00000000aaaa');
        return JSON.stringify(verdict);
      }),
    } as never;
    const gate = new MessagingToneGate(provider, { advisoryMigration: true });
    server = await listen(buildApp({ toneGate: gate, sent }));

    // 1. The nudge.
    const nudged = await reply(206, PATH_MESSAGE);
    expect(nudged.body.error).toBe('tone-gate-advisory');
    expect(sent).toHaveLength(0);

    // 2. The agent revises. It declares NOTHING — no complied flag, no ref.
    verdict = { pass: true, rule: '', issue: '', suggestion: '' } as never;
    const revised = await reply(206, 'The convergence report is ready — want the summary here or a link?');
    expect(revised.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('does NOT credit compliance for an unchanged resend (a resend is not a revision)', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    let verdict = { ...B2_VERDICT };
    const provider = {
      evaluate: vi.fn(async (_p: string, opts?: { provenance?: { onCorrelationId?: (id: string) => void } }) => {
        opts?.provenance?.onCorrelationId?.('d-testmach-00000000-0000-4000-8000-00000000bbbb');
        return JSON.stringify(verdict);
      }),
    } as never;
    const gate = new MessagingToneGate(provider, { advisoryMigration: true });
    server = await listen(buildApp({ toneGate: gate, sent }));

    await reply(207, PATH_MESSAGE);
    // Same text passing on a re-review is a flaky verdict, not the agent
    // agreeing — crediting it would manufacture evidence out of noise.
    verdict = { pass: true, rule: '', issue: '', suggestion: '' } as never;
    const same = await reply(207, PATH_MESSAGE, { allowDuplicate: true });
    expect(same.status).toBe(200);
  });

  it('a revised re-send carrying toneAdvisoryComplied is delivered (compliance is a first-class reaction)', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    // The revised message passes the gate.
    const gate = new MessagingToneGate(
      makeProvider({ pass: true, rule: '', issue: '', suggestion: '' }),
      { advisoryMigration: true },
    );
    server = await listen(buildApp({ toneGate: gate, sent }));

    const res = await reply(204, 'The convergence report is ready — I can link it or paste the summary here.', {
      toneAdvisoryComplied: 'B2_FILE_PATH',
      // Production mesh ids contain an underscore (`m_<hex>`). This exact
      // shape was rejected by the old route validator while test-only ids passed.
      toneAdvisoryDecisionRef: 'd-m_03b30f-00000000-0000-4000-8000-000000000000',
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('the documented reply client preserves a machine-prefixed decisionRef and settles the outcome', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    const gate = new MessagingToneGate(
      makeProvider({ pass: true, rule: '', issue: '', suggestion: '' }),
      { advisoryMigration: true },
    );
    server = await listen(buildApp({ toneGate: gate, sent }));
    const port = Number(new URL(server.url).port);
    const correlationId = 'd-m_03b30f-00000000-0000-4000-8000-000000000111';
    expect(ledger).not.toBeNull();
    ledger!.recordDecision({
      correlationId,
      decisionPoint: DP_MESSAGING_TONE_GATE,
      feature: 'messaging-tone-gate',
      verdictClass: 'advisory',
      mintedBy: 'router',
      volumeClass: 'all',
      contentClass: 'identity-only',
      ts: Date.now() - 100,
    });

    const result = await runReplyScript({
      port,
      args: [
        '--tone-complied', 'B2_FILE_PATH',
        '--tone-decision-ref', correlationId,
        '204',
        'The revised answer avoids the raw path.',
      ],
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(sent).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    const point = ledger!.decisionQualityRollupDaily({ decisionPoint: DP_MESSAGING_TONE_GATE })[0];
    expect(point).toMatchObject({
      right: 1,
      wrong: 0,
      orphanOutcomes: 0,
    });
  });
});

describe('live-credential hard wall through POST /telegram/reply', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  async function reply(topicId: number, text: string, metadata?: Record<string, unknown>) {
    const res = await fetch(`${server.url}/telegram/reply/${topicId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata ? { text, metadata } : { text }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  }

  const LEAK = 'Here is the token you asked for: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('refuses a live credential and says so without echoing the value', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    const gate = new MessagingToneGate(makeProvider({ pass: true, rule: '', issue: '', suggestion: '' }), {
      advisoryMigration: true,
    });
    server = await listen(buildApp({ toneGate: gate, sent }));

    const res = await reply(301, LEAK);
    expect(res.status).toBe(422);
    expect(res.body.blockedBy).toBe('credential-exposure-guard');
    expect(res.body.overridable).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('ghp_');
    expect(sent).toHaveLength(0);
  });

  it('cannot be acknowledged away — no ack, reason, or allow-flag reaches it', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    const gate = new MessagingToneGate(makeProvider({ pass: true, rule: '', issue: '', suggestion: '' }), {
      advisoryMigration: true,
    });
    server = await listen(buildApp({ toneGate: gate, sent }));

    const res = await reply(302, LEAK, {
      toneAdvisoryAck: 'B2_FILE_PATH',
      toneAdvisoryAckReason: 'the operator asked me to send it',
      allowDebugText: true,
    });
    expect(res.status).toBe(422);
    expect(res.body.blockedBy).toBe('credential-exposure-guard');
    expect(sent).toHaveLength(0);
  });

  it('holds even with NO tone gate configured — it needs no LLM and no availability', async () => {
    // This is the reason the wall is deterministic: it must survive the exact
    // conditions (no authority, provider outage, capacity shed) under which the
    // LLM rules cannot run at all.
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp({ toneGate: null, sent }));

    const res = await reply(303, LEAK);
    expect(res.status).toBe(422);
    expect(res.body.blockedBy).toBe('credential-exposure-guard');
    expect(sent).toHaveLength(0);
  });

  it('does not touch an ordinary message that merely mentions a secret by NAME', async () => {
    const sent: Array<{ topicId: number; text: string }> = [];
    server = await listen(buildApp({ toneGate: null, sent }));

    const res = await reply(304, 'I already hold github_token in the vault, so I do not need you to send one.');
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});
