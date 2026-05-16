/**
 * Integration tests for Tier-3 S-2: Dashboard Proposals routes.
 *
 * Spec anchors:
 *   - §A13 — list / detail / dismiss routes; bearer auth + X-Instar-Request.
 *   - §A26 — dismiss requires `collaborative` trust; 10/hour rate-limit.
 *   - §A57 Tier-3 — sub-section placement.
 *   - §A10 — redaction of LLM-untrusted fields at < `collaborative` trust.
 *
 * Mounts the routes on a minimal Express app with a tiny auth middleware
 * mirroring the production bearer + X-Instar-Request check, plus a real
 * `TrustElevationSource` constructed per-test for trust-gating scenarios.
 *
 * Uses `SafeFsExecutor.safeRmSync` for tmp cleanup per the spec mandate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, timingSafeEqual } from 'node:crypto';
import { registerRemediationProposalsRoutes } from '../../src/server/routes/remediation-proposals.js';
import { TrustElevationSource } from '../../src/remediation/TrustElevationSource.js';
import type { AutonomyProfileLevel } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'test-auth-token-remediation-proposals';

/**
 * Mount a minimal Express app with bearer-auth + JSON middleware, then
 * register the proposals routes against the given state-dir + trust profile.
 *
 * `now()` is forwarded for deterministic rate-limit assertions.
 */
function makeApp(opts: {
  stateDir: string;
  profile: AutonomyProfileLevel;
  now?: () => number;
}): Express {
  const app = express();
  app.use(express.json());
  // Bearer-auth gate — identical structure to production middleware.
  app.use((req, res, next) => {
    const header = req.header('authorization') || '';
    if (!header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    const tb = createHash('sha256').update(token).digest();
    const eb = createHash('sha256').update(AUTH_TOKEN).digest();
    if (tb.length !== eb.length || !timingSafeEqual(tb, eb)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });
  const trustSource = new TrustElevationSource({ profile: opts.profile, channels: [] });
  registerRemediationProposalsRoutes({
    app,
    stateDir: opts.stateDir,
    trustSource,
    now: opts.now,
  });
  return app;
}

/**
 * Write a proposal JSON file into the per-machine directory used by S-1.
 * The fields mirror NovelFailureReviewer's `PersistedProposal` shape, with
 * the redaction-sensitive fields populated so we can assert the route
 * actually strips them at < collaborative trust.
 */
function writeProposal(
  stateDir: string,
  machineId: string,
  proposal: Record<string, unknown>,
): string {
  const dir = path.join(stateDir, 'remediation', `proposals-${machineId}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${proposal.proposalId}.json`);
  fs.writeFileSync(file, JSON.stringify(proposal, null, 2), { mode: 0o600 });
  return file;
}

function exampleProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proposalId: 'p-001',
    clusterSignature: 'abc:DEF_GH:01ff',
    occurrencesObserved: 3,
    processLifetimes: 2,
    sampleEvents: [
      {
        subsystem: 'memory',
        errorCode: 'NO_MATCHING_RUNBOOK',
        reason: {
          redacted: '<error> in <path>',
          full: 'sensitive details: token=hunter2',
        },
        timestamp: 1700000000000,
      },
    ],
    llmSummary: 'Failures originate from native-module mismatch',
    suggestedErrorCode: 'NATIVE_ABI_DRIFT',
    hypothesis: 'Node ABI changed and prebuilt binary is stale',
    producingAgentId: 'agent-alpha',
    producingAgentSignature: 'sig-deadbeef',
    generatedAt: 1700000000000,
    status: 'outstanding',
    forensic: {
      promptHash: 'sha256:1234',
      llmModel: 'claude-haiku-class-default',
      rawResponse: 'raw LLM output with PII: token=hunter2',
    },
    ...overrides,
  };
}

describe('Tier-3 S-2: Dashboard Proposals routes', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remediation-proposals-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      operation: 's2-dashboard-proposals-test-cleanup',
      recursive: true,
      force: true,
    });
  });

  // ── 1. Bearer auth required ────────────────────────────────────────
  it('rejects GET /remediation/proposals without bearer auth (401)', async () => {
    const app = makeApp({ stateDir, profile: 'collaborative' });
    const res = await request(app)
      .get('/remediation/proposals')
      .set('X-Instar-Request', '1');
    expect(res.status).toBe(401);
  });

  // ── 2. Bearer + X-Instar-Request returns the list ─────────────────
  it('returns proposals list with bearer + X-Instar-Request', async () => {
    writeProposal(stateDir, 'mach-A', exampleProposal({ proposalId: 'p-a1' }));
    writeProposal(stateDir, 'mach-A', exampleProposal({ proposalId: 'p-a2', generatedAt: 1700000001000 }));
    const app = makeApp({ stateDir, profile: 'supervised' });
    const res = await request(app)
      .get('/remediation/proposals')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    expect(res.status).toBe(200);
    expect(res.body.visible).toBeDefined();
    expect(res.body.visible).toHaveLength(2);
    expect(res.body.queued).toHaveLength(0);
    expect(res.body.trust.hasCollaborative).toBe(false);
  });

  // ── 3. Detail at < collaborative trust returns redacted view ─────
  it('GET /:id at less-than-collaborative trust strips reason.full + forensic.rawResponse', async () => {
    writeProposal(stateDir, 'mach-A', exampleProposal({ proposalId: 'p-detail-1' }));
    const app = makeApp({ stateDir, profile: 'supervised' });
    const res = await request(app)
      .get('/remediation/proposals/p-detail-1')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    expect(res.status).toBe(200);
    const proposal = res.body.proposal;
    expect(proposal.redactionApplied).toBe(true);
    // forensic.rawResponse must be stripped.
    expect(proposal.forensic).toBeDefined();
    expect(proposal.forensic.rawResponse).toBeUndefined();
    // sampleEvents[].reason.full must be stripped; .redacted survives.
    expect(proposal.sampleEvents[0].reason.full).toBeUndefined();
    expect(proposal.sampleEvents[0].reason.redacted).toBe('<error> in <path>');
  });

  // ── 4. Detail at collaborative trust shows full fields ───────────
  it('GET /:id at collaborative trust includes reason.full + forensic.rawResponse', async () => {
    writeProposal(stateDir, 'mach-A', exampleProposal({ proposalId: 'p-detail-2' }));
    const app = makeApp({ stateDir, profile: 'collaborative' });
    const res = await request(app)
      .get('/remediation/proposals/p-detail-2')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    expect(res.status).toBe(200);
    const proposal = res.body.proposal;
    expect(proposal.redactionApplied).toBe(false);
    expect(proposal.forensic.rawResponse).toBe('raw LLM output with PII: token=hunter2');
    expect(proposal.sampleEvents[0].reason.full).toBe('sensitive details: token=hunter2');
  });

  // ── 5. Dismiss at < collaborative trust returns 403 ──────────────
  it('POST /:id/dismiss at supervised trust returns 403', async () => {
    writeProposal(stateDir, 'mach-A', exampleProposal({ proposalId: 'p-d1' }));
    const app = makeApp({ stateDir, profile: 'supervised' });
    const res = await request(app)
      .post('/remediation/proposals/p-d1/dismiss')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('trust-level-below-collaborative');
  });

  // ── 6. Dismiss at collaborative trust succeeds + moves out of outstanding ─
  it('POST /:id/dismiss at collaborative trust marks proposal dismissed', async () => {
    const filePath = writeProposal(stateDir, 'mach-A', exampleProposal({ proposalId: 'p-d2' }));
    const app = makeApp({ stateDir, profile: 'collaborative' });
    const dismissRes = await request(app)
      .post('/remediation/proposals/p-d2/dismiss')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    expect(dismissRes.status).toBe(200);
    expect(dismissRes.body.dismissed).toBe(true);
    // On-disk state mutated.
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(onDisk.status).toBe('dismissed');
    // List now reports zero outstanding, one dismissed.
    const listRes = await request(app)
      .get('/remediation/proposals')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    expect(listRes.body.visible).toHaveLength(0);
    expect(listRes.body.dismissed).toHaveLength(1);
  });

  // ── 7. X-Instar-Request header required ──────────────────────────
  it('returns 400 when X-Instar-Request header is missing', async () => {
    writeProposal(stateDir, 'mach-A', exampleProposal({ proposalId: 'p-h1' }));
    const app = makeApp({ stateDir, profile: 'collaborative' });
    const listRes = await request(app)
      .get('/remediation/proposals')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(listRes.status).toBe(400);
    expect(listRes.body.reason).toBe('missing-user-intent');
    const detailRes = await request(app)
      .get('/remediation/proposals/p-h1')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(detailRes.status).toBe(400);
    const dismissRes = await request(app)
      .post('/remediation/proposals/p-h1/dismiss')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(dismissRes.status).toBe(400);
  });

  // ── 8. Missing proposals-<machineId>/ directory → empty array ────
  it('handles missing proposals-<machineId>/ directory gracefully', async () => {
    // No write — the dir simply doesn't exist.
    const app = makeApp({ stateDir, profile: 'collaborative' });
    const res = await request(app)
      .get('/remediation/proposals')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    expect(res.status).toBe(200);
    expect(res.body.visible).toEqual([]);
    expect(res.body.queued).toEqual([]);
    expect(res.body.dismissed).toEqual([]);
  });

  // ── 9. Dismiss rate-limit (≤ 10/hour per principal) ──────────────
  it('rate-limits dismiss to 10 per hour per principal (returns 429 on the 11th)', async () => {
    // Pre-write 11 outstanding proposals so each dismiss has a target.
    for (let i = 0; i < 11; i++) {
      writeProposal(stateDir, 'mach-A', exampleProposal({
        proposalId: `p-rl-${i}`,
        generatedAt: 1700000000000 + i,
      }));
    }
    // Freeze the clock so all 11 calls fall inside the same hour.
    let t = 1_750_000_000_000;
    const app = makeApp({ stateDir, profile: 'collaborative', now: () => t });
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post(`/remediation/proposals/p-rl-${i}/dismiss`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .set('X-Instar-Request', '1');
      expect(res.status).toBe(200);
      t += 1; // monotone, still within the same hour.
    }
    const eleventh = await request(app)
      .post('/remediation/proposals/p-rl-10/dismiss')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.reason).toBe('rate-limited');
    expect(eleventh.body.retryAfterMs).toBeGreaterThan(0);
  });

  // ── Bonus: 404 on missing proposalId ─────────────────────────────
  it('returns 404 for an unknown proposalId', async () => {
    const app = makeApp({ stateDir, profile: 'collaborative' });
    const res = await request(app)
      .get('/remediation/proposals/does-not-exist')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    expect(res.status).toBe(404);
  });

  // ── Bonus: invalid proposalId format ─────────────────────────────
  it('returns 400 for an invalid proposalId format', async () => {
    const app = makeApp({ stateDir, profile: 'collaborative' });
    const res = await request(app)
      .get('/remediation/proposals/../../etc/passwd')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    // Express normalizes the path before our regex runs; we still expect a
    // non-2xx outcome (either 404 from express, or 400 from our regex).
    expect([400, 404]).toContain(res.status);
  });

  // ── Bonus: visible-3 cap with queued overflow ────────────────────
  it('returns at most 3 visible outstanding proposals; remainder queued', async () => {
    for (let i = 0; i < 5; i++) {
      writeProposal(stateDir, 'mach-A', exampleProposal({
        proposalId: `p-cap-${i}`,
        generatedAt: 1700000000000 + i,
      }));
    }
    const app = makeApp({ stateDir, profile: 'collaborative' });
    const res = await request(app)
      .get('/remediation/proposals')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`)
      .set('X-Instar-Request', '1');
    expect(res.status).toBe(200);
    expect(res.body.visible).toHaveLength(3);
    expect(res.body.queued).toHaveLength(2);
  });
});
