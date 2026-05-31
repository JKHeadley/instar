/**
 * Tier-2 integration tests for the Framework-Onboarding Mentor System issue
 * ledger routes (FRAMEWORK-ONBOARDING-MENTOR-SPEC §5, §17, §18).
 *
 *   GET /framework-issues                       — list, with framework allowlist
 *   GET /framework-issues/playbook?targetFramework=X
 *
 * Verifies the full HTTP pipeline: 503 when unavailable, 200 when wired,
 * limit clamping, framework-allowlist validation, and the playbook query.
 * Uses supertest with a minimal Express app and a real in-memory ledger.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { FrameworkIssueLedger } from '../../src/monitoring/FrameworkIssueLedger.js';

function baseCtx(over: Partial<RouteContext>): RouteContext {
  return {
    config: { projectName: 't', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null,
    telegram: null,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    discoveryEvaluator: null,
    startTime: new Date(),
    ...over,
  } as RouteContext;
}

function appWith(ledger: FrameworkIssueLedger | null): express.Express {
  const ctx = baseCtx({ frameworkIssueLedger: ledger });
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('Framework-issues routes (integration)', () => {
  let ledger: FrameworkIssueLedger;

  beforeEach(() => {
    ledger = new FrameworkIssueLedger({ dbPath: ':memory:' });
  });
  afterEach(() => ledger.close());

  describe('503 when ledger unavailable', () => {
    it('GET /framework-issues → 503', async () => {
      const res = await request(appWith(null)).get('/framework-issues');
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/unavailable/);
    });
    it('GET /framework-issues/playbook → 503', async () => {
      const res = await request(appWith(null)).get('/framework-issues/playbook?targetFramework=cursor');
      expect(res.status).toBe(503);
    });
  });

  describe('GET /framework-issues', () => {
    it('returns 200 with issues when wired (feature is alive)', async () => {
      ledger.recordObservation({ framework: 'codex-cli', bucket: 'instar-integration-gap', title: 'A', dedupKey: 'k1' });
      const res = await request(appWith(ledger)).get('/framework-issues');
      expect(res.status).toBe(200);
      expect(res.body.issues).toHaveLength(1);
      expect(res.body.knownFrameworks).toContain('codex-cli');
    });

    it('clamps limit to 1..500', async () => {
      const res = await request(appWith(ledger)).get('/framework-issues?limit=99999');
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(500);
      const res2 = await request(appWith(ledger)).get('/framework-issues?limit=0');
      expect(res2.body.limit).toBe(1);
    });

    it('returns empty for a framework not on the allowlist (no injection/unbounded query)', async () => {
      ledger.recordObservation({ framework: 'codex-cli', bucket: 'framework-limitation', title: 'A', dedupKey: 'k1' });
      const res = await request(appWith(ledger)).get(
        `/framework-issues?framework=${encodeURIComponent("codex-cli'; DROP TABLE framework_issues;--")}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.issues).toHaveLength(0);
      // Table intact — the known framework still returns its issue.
      const res2 = await request(appWith(ledger)).get('/framework-issues?framework=codex-cli');
      expect(res2.body.issues).toHaveLength(1);
    });

    it('returns 400 for an invalid bucket enum', async () => {
      ledger.recordObservation({ framework: 'codex-cli', bucket: 'framework-limitation', title: 'A', dedupKey: 'k1' });
      const res = await request(appWith(ledger)).get('/framework-issues?bucket=nonsense');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid bucket/);
    });
  });

  describe('GET /framework-issues/playbook', () => {
    it('requires targetFramework', async () => {
      const res = await request(appWith(ledger)).get('/framework-issues/playbook');
      expect(res.status).toBe(400);
    });

    it('returns generalizable prior-framework lessons, impact-ranked', async () => {
      const a = ledger.recordObservation({ framework: 'codex-cli', bucket: 'instar-integration-gap', title: 'big', dedupKey: 'a', severity: 'high', episodeKey: 'v1' });
      ledger.recordObservation({ framework: 'codex-cli', bucket: 'instar-integration-gap', title: 'big', dedupKey: 'a', severity: 'high', episodeKey: 'v2' });
      ledger.updateIssue(a.issueId, { playbookStatus: 'extracted' });
      const res = await request(appWith(ledger)).get('/framework-issues/playbook?targetFramework=cursor');
      expect(res.status).toBe(200);
      expect(res.body.targetFramework).toBe('cursor');
      expect(res.body.playbook).toHaveLength(1);
      expect(res.body.playbook[0].dedupKey).toBe('a');
    });

    it('excludes the target framework\'s own issues', async () => {
      const a = ledger.recordObservation({ framework: 'cursor', bucket: 'instar-integration-gap', title: 'x', dedupKey: 'a' });
      ledger.updateIssue(a.issueId, { playbookStatus: 'extracted' });
      const res = await request(appWith(ledger)).get('/framework-issues/playbook?targetFramework=cursor');
      expect(res.body.playbook).toHaveLength(0);
    });
  });

  describe('GET /framework-issues/observability (§15)', () => {
    it('503 when unavailable; 200 with telemetry when wired', async () => {
      expect((await request(appWith(null)).get('/framework-issues/observability')).status).toBe(503);
      ledger.recordObservation({ framework: 'codex-cli', bucket: 'generic-agent-mistake', title: 'A', dedupKey: 'a' });
      const res = await request(appWith(ledger)).get('/framework-issues/observability');
      expect(res.status).toBe(200);
      expect(res.body.bucketDistribution['generic-agent-mistake']).toBe(1);
    });
  });

  describe('POST /framework-issues/:id/promote (§13.6 non-Echo gate)', () => {
    it('rejects candidate→extracted by Echo (400)', async () => {
      const r = ledger.recordObservation({ framework: 'codex-cli', bucket: 'framework-limitation', title: 'A', dedupKey: 'a' });
      ledger.promotePlaybook(r.issueId, 'candidate', 'echo');
      const res = await request(appWith(ledger)).post(`/framework-issues/${r.issueId}/promote`).send({ status: 'extracted', promotedBy: 'echo' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/non-Echo/);
    });

    it('allows candidate→extracted with a non-Echo attester (200)', async () => {
      const r = ledger.recordObservation({ framework: 'codex-cli', bucket: 'framework-limitation', title: 'A', dedupKey: 'a' });
      ledger.promotePlaybook(r.issueId, 'candidate', 'echo');
      const res = await request(appWith(ledger)).post(`/framework-issues/${r.issueId}/promote`).send({ status: 'extracted', promotedBy: 'justin' });
      expect(res.status).toBe(200);
      expect(res.body.playbookStatus).toBe('extracted');
      expect(res.body.promotedBy).toBe('justin');
    });

    it('404 for an unknown issue', async () => {
      const res = await request(appWith(ledger)).post('/framework-issues/nope/promote').send({ status: 'candidate', promotedBy: 'x' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /framework-issues/capture-stats', () => {
    it('returns 503 when ledger unavailable', async () => {
      const res = await request(appWith(null)).get('/framework-issues/capture-stats');
      expect(res.status).toBe(503);
    });

    it('reports the capture funnel (runs vs observations) — including zero-finding runs', async () => {
      ledger.captureRun({ framework: 'codex-cli', findings: [{ bucket: 'framework-limitation', title: 'A', dedupKey: 'a' }] });
      ledger.captureRun({ framework: 'codex-cli', findings: [] }); // ran, found nothing
      const res = await request(appWith(ledger)).get('/framework-issues/capture-stats');
      expect(res.status).toBe(200);
      expect(res.body.totalRuns).toBe(2);
      expect(res.body.totalObservationsWritten).toBe(1);
      expect(res.body.lastRanAt).toBeGreaterThan(0);
    });
  });

  describe('POST /framework-issues/observe (§5 durable write path)', () => {
    it('503 when ledger unavailable', async () => {
      const res = await request(appWith(null))
        .post('/framework-issues/observe')
        .send({ framework: 'codex-cli', bucket: 'instar-integration-gap', title: 'x', dedupKey: 'k' });
      expect(res.status).toBe(503);
    });

    it('records a new engineering-discovered issue, then it is listable (feature is alive)', async () => {
      const app = appWith(ledger);
      const res = await request(app)
        .post('/framework-issues/observe')
        .send({ framework: 'codex-cli', bucket: 'instar-integration-gap', severity: 'high', title: 'jsonlExists claude-only', dedupKey: 'codex-jsonl', evidence: 'PR #572' });
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(true);
      expect(res.body.issueId).toBeTruthy();
      const list = await request(app).get('/framework-issues?framework=codex-cli');
      expect(list.body.issues).toHaveLength(1);
      expect(list.body.issues[0].title).toBe('jsonlExists claude-only');
      expect(list.body.issues[0].severity).toBe('high');
    });

    it('records an already-fixed backfill in one call (status:fixed + fixedInVersion)', async () => {
      const app = appWith(ledger);
      const res = await request(app)
        .post('/framework-issues/observe')
        .send({ framework: 'codex-cli', bucket: 'instar-integration-gap', title: 'CompactionSentinel codex-blind', dedupKey: 'codex-compaction', status: 'fixed', fixedInVersion: '1.3.136' });
      expect(res.status).toBe(200);
      expect(res.body.issue.status).toBe('fixed');
      expect(res.body.issue.fixedInVersion).toBe('1.3.136');
      const list = await request(app).get('/framework-issues?framework=codex-cli&status=fixed');
      expect(list.body.issues).toHaveLength(1);
    });

    it('is idempotent on dedupKey — re-recording updates, never duplicates', async () => {
      const app = appWith(ledger);
      const first = await request(app)
        .post('/framework-issues/observe')
        .send({ framework: 'codex-cli', bucket: 'framework-limitation', title: 'no loop driver', dedupKey: 'codex-loop', observedVersion: '1.3.128' });
      expect(first.body.created).toBe(true);
      const second = await request(app)
        .post('/framework-issues/observe')
        .send({ framework: 'codex-cli', bucket: 'framework-limitation', title: 'no loop driver', dedupKey: 'codex-loop', observedVersion: '1.3.129' });
      expect(second.status).toBe(200);
      expect(second.body.created).toBe(false);
      const list = await request(app).get('/framework-issues?framework=codex-cli');
      expect(list.body.issues).toHaveLength(1);
    });

    it('allows a NEW framework string (onboarding the next framework introduces one)', async () => {
      const app = appWith(ledger);
      const res = await request(app)
        .post('/framework-issues/observe')
        .send({ framework: 'cursor', bucket: 'instar-integration-gap', title: 'cursor gap', dedupKey: 'cursor-1' });
      expect(res.status).toBe(200);
      const list = await request(app).get('/framework-issues?framework=cursor');
      expect(list.body.issues).toHaveLength(1);
    });

    it('400 when a required field is missing', async () => {
      const res = await request(appWith(ledger))
        .post('/framework-issues/observe')
        .send({ framework: 'codex-cli', bucket: 'instar-integration-gap', dedupKey: 'k' }); // no title
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/title/);
    });

    it('400 for an invalid bucket enum (ledger validates)', async () => {
      const res = await request(appWith(ledger))
        .post('/framework-issues/observe')
        .send({ framework: 'codex-cli', bucket: 'nonsense', title: 'x', dedupKey: 'k' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid bucket/);
    });

    it('400 when status:wont-fix is set without a reason (ledger §13.7)', async () => {
      const res = await request(appWith(ledger))
        .post('/framework-issues/observe')
        .send({ framework: 'codex-cli', bucket: 'framework-limitation', title: 'x', dedupKey: 'k', status: 'wont-fix' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/wont-fix requires/);
    });
  });
});
