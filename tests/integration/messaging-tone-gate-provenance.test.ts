/**
 * Integration: a REAL MessagingToneGate verdict — driven through a REAL
 * IntelligenceRouter (which mints the correlation id + fires the §5.1.5
 * settlement seam) into a LIVE DecisionQualityRecorderImpl wired to a real
 * JudgmentProvenanceLog + FeatureMetricsLedger — emits a provenance row visible
 * via GET /judgment-provenance (llm-decision-quality-meter §5.6 tone-gate
 * enrollment).
 *
 * Proves the DATA FLOW end-to-end (not a stub): the served, redacted row carries
 * the tone gate's component + decision point + a non-empty verdict/reason, its
 * context is IDENTITY-ONLY (candidate sha256 — never the outbound body), and the
 * served free-text rides #1458's redaction envelope (the full body never crosses
 * the surface, and the raw candidate text is not archived on the row).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import {
  IntelligenceRouter,
  type ComponentFrameworksConfig,
} from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { MessagingToneGate } from '../../src/core/MessagingToneGate.js';
import {
  DecisionQualityRecorderImpl,
  installDecisionQualityRecorder,
} from '../../src/core/DecisionQualityRecorderImpl.js';
import { _resetDecisionQualityForTest } from '../../src/core/decisionQualityTypes.js';
import { DP_MESSAGING_TONE_GATE } from '../../src/data/provenanceCoverage.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-tone-provenance';

let ledger: FeatureMetricsLedger | null = null;
let jpl: JudgmentProvenanceLog | null = null;
let tmpDir: string | null = null;

/**
 * A REAL router over a stub default provider that returns the tone verdict.
 * The router mints the correlation id and fires the settlement seam — exactly
 * the production path (nothing about provenance is stubbed).
 */
function makeRouter(reply: string): { router: IntelligenceRouter } {
  const defaultProvider: IntelligenceProvider = {
    async evaluate(_prompt: string, _opts?: IntelligenceOptions): Promise<string> {
      return reply;
    },
  };
  const cfg: ComponentFrameworksConfig | undefined = undefined;
  const router = new IntelligenceRouter({
    defaultProvider,
    defaultFramework: 'claude-code' as IntelligenceFramework,
    resolveConfig: () => cfg,
    buildProvider: () => null, // no other framework built → the default provider serves
  });
  return { router };
}

function ctxWith(): RouteContext {
  return {
    config: {
      projectName: 'test', projectDir: '/tmp', stateDir: tmpDir ?? '/tmp/.instar', port: 0, authToken: AUTH,
      developmentAgent: true,
      provenance: { uniformSeam: { enabled: true, dryRun: false } },
      sessions: {} as unknown, scheduler: {} as unknown,
    } as unknown,
    sessionManager: { listRunningSessions: () => [] } as unknown,
    state: { getJobState: () => null, getSession: () => null } as unknown,
    judgmentProvenance: jpl,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctx));
  return app;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tone-provenance-int-'));
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
  jpl = new JudgmentProvenanceLog({
    dir: path.join(tmpDir, 'state', 'judgment-provenance'),
    log: () => {},
  });
  _resetDecisionQualityForTest();
  // Live recorder wired to the SAME JPL + ledger the route reads.
  installDecisionQualityRecorder(
    new DecisionQualityRecorderImpl({
      ledger,
      judgmentProvenance: jpl,
      config: { developmentAgent: true, provenance: { uniformSeam: { enabled: true, dryRun: false } } },
    }),
  );
});

afterEach(async () => {
  installDecisionQualityRecorder(null);
  _resetDecisionQualityForTest();
  ledger?.close();
  ledger = null;
  if (jpl) { await jpl.close(); jpl = null; }
  if (tmpDir) {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/messaging-tone-gate-provenance.test.ts' });
    tmpDir = null;
  }
});

describe('GET /judgment-provenance — a real tone-gate verdict emits a row (integration)', () => {
  const OUTBOUND_BODY = 'ZX9_OUTBOUND_BODY_MARKER — everything looks good, deploy is green';
  const PASS = JSON.stringify({ pass: true, issue: '', suggestion: '' });

  it('a PASS verdict lands a redacted provenance row with the tone component, decision point, and identity-only context', async () => {
    const { router } = makeRouter(PASS);
    const gate = new MessagingToneGate(router);
    const result = await gate.review(OUTBOUND_BODY, { channel: 'telegram' });
    expect(result.pass).toBe(true); // the gate's verdict is unaffected by enrollment

    await jpl!.flush();

    const res = await request(appWith(ctxWith()))
      .get('/judgment-provenance?limit=50')
      .set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.decisionPoint === DP_MESSAGING_TONE_GATE);
    expect(row, 'a messaging-tone-gate provenance row must be served').toBeTruthy();

    // Component + a non-empty decision/reason (a real, reconstructable verdict).
    expect(row!.component).toBe('MessagingToneGate');
    expect(String(row!.decision ?? '')).not.toBe('');
    expect(String(row!.reason ?? '')).not.toBe('');
    // A router-minted seam row (correlation id present).
    expect(String(row!.correlationId ?? '')).toMatch(/^d-/);
    expect(row!.contentClass).toBe('content-bearing');

    // The full outbound body NEVER crosses the surface (identity-only envelope).
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('ZX9_OUTBOUND_BODY_MARKER');
    expect(serialized).not.toContain('deploy is green');

    // The served context is #1458's REDACTED envelope (a bounded JSON string)
    // carrying the candidate IDENTITY structure — never the body. (The JPL's
    // own write-time scrub additionally tokenizes the raw hash — defense in
    // depth — so we assert the identity STRUCTURE, not the literal hex.)
    const ctxStr = String(row!.contextRedacted ?? '');
    const ctxParsed = JSON.parse(ctxStr) as Record<string, any>;
    expect(ctxParsed.candidate).toBeDefined();
    expect(ctxParsed.candidate.bytes).toBe(Buffer.byteLength(OUTBOUND_BODY, 'utf8'));
    expect(ctxParsed.candidate.chars).toBe(OUTBOUND_BODY.length);
    expect(ctxParsed.candidate.head).toBeUndefined(); // no plaintext slice on the row
    expect(ctxStr).not.toContain('ZX9_OUTBOUND_BODY_MARKER');
  });

  it('a BLOCK verdict ALSO enrolls (the block/allow decision is unchanged; the row is still visible)', async () => {
    const BLOCK = JSON.stringify({
      pass: false, rule: 'B1_CLI_COMMAND',
      issue: 'CLI command handed to the user', suggestion: 'Run it yourself.',
    });
    const { router } = makeRouter(BLOCK);
    const gate = new MessagingToneGate(router);
    const result = await gate.review('To fix, run: `npm install`', { channel: 'telegram' });
    expect(result.pass).toBe(false);
    expect(result.rule).toBe('B1_CLI_COMMAND');

    await jpl!.flush();

    const res = await request(appWith(ctxWith()))
      .get('/judgment-provenance?limit=50')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    const row = (res.body.rows as Array<Record<string, unknown>>).find(
      (r) => r.decisionPoint === DP_MESSAGING_TONE_GATE,
    );
    expect(row, 'the blocked verdict must still emit a provenance row').toBeTruthy();
    expect(row!.component).toBe('MessagingToneGate');
  });
});
