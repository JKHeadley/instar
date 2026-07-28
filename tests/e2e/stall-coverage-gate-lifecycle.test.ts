// safe-git-allow: e2e fixture runs git init/add/commit strictly inside its OWN mkdtemp dir to fabricate the audit HEAD-SHA source — never against a real repo.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E lifecycle test — the stall-coverage matrix gate is ALIVE on the
 * production initialization path (framework-stall-coverage-matrix §5 E2E rows).
 *
 * Boots the REAL AgentServer (the same path server.ts uses) listening on a
 * real loopback port, so the gate's non-hermetic checks hit the server's OWN
 * live /guards route, the acceptance flow runs through the real HTTP
 * matrix-acceptance routes (dashboard-PIN), and install provenance is recorded
 * through the REAL init-path function. Verifies:
 *
 *   1. An onboarding instance with a COMPLETE valid matrix passes
 *      pending→active (provisional) AND active→complete (full, after the
 *      PIN-bound whole-set acceptance) — 200s, not 503s.
 *   2. Removing one class row BLOCKS completion (409 naming class + rule).
 *   3. The gate decision record carries the validated contentHash + the
 *      checkout HEAD SHA + dirty flag (single-read audit, no TOCTOU).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { recordInstallProvenanceIfAbsent } from '../../src/core/ApprenticeshipStallGate.js';
import { STALL_CLASSES } from '../../src/data/stall-classes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-e2e-stall-gate';
const PIN = '424242';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

const SCHEMA_ID = 'apprenticeship-retro-harvest/v1';
function buildHarvest(): string {
  const fm: Record<string, unknown> = {
    schema: SCHEMA_ID,
    instanceType: 'mentorship',
    from: 'echo',
    to: 'codey',
    framework: 'codex-cli',
    harvestedAt: '2026-06-02T03:00:00Z',
    scopeMode: 'full',
    completeness: 'complete',
    sourcesCovered: {
      ledger: { read: true, issueCount: 12 },
      playbook: { read: true, entryCount: 3 },
      memory: { read: true, files: 40 },
      threads: [{ id: 13435, messagesRead: 500, truncated: false }],
      prs: [666],
    },
    counts: { lessons: 1, metaLessons: 1, processInsights: 1 },
    seededToPlaybook: [],
    redaction: { scrubber: 'correction-scrub@v1', findingsRemoved: 2, scrubbedAt: '2026-06-02T03:00:00Z' },
    fidelityReview: { reviewer: 'indep', verdict: 'faithful', at: '2026-06-02T03:05:00Z' },
    programNeeds: 1,
  };
  const yamlLines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  const body = ['## Lessons', '- l. ledger:4c4a8ded', '## Meta-lessons', '- m. thread:13435#m1', '## Process-insights', '- p.', '## What the program needs', '- need-001 x.'].join('\n');
  return `---\n${yamlLines}\n---\n\n${body}\n`;
}

function fullMatrixRows(): Array<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10);
  return STALL_CLASSES.map((c) => ({
    class: c.id,
    status: 'declared-gap',
    reason: 'new-class, unreviewed',
    issueRef: `stallclass::${c.id}::codex-cli::gap`,
    closePath: 'pending-mint',
    seededAt: today,
    'liveness-surface': 'DEFECT: registry shows running',
  }));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
    srv.once('error', reject);
  });
}

describe('Stall-coverage matrix gate E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let matrixPath: string;

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  function writeMatrix(rows: Array<Record<string, unknown>>): void {
    fs.writeFileSync(matrixPath, `---\n${yaml.dump({ framework: 'codex-cli', 'stall-coverage': rows })}---\n\nnotes\n`);
  }

  function stallMatrixDecisions(): Array<Record<string, unknown>> {
    const p = path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl');
    return fs.readFileSync(p, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.gate === 'stall-matrix');
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-gate-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs', 'frameworks'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'specs', 'framework-stall-coverage-matrix.md'), '# stub\n');
    matrixPath = path.join(tmpDir, 'docs', 'frameworks', 'codex-cli-stall-coverage.md');
    writeMatrix(fullMatrixRows());

    // The bootstrap harvest at its canonical path (retro-gate + completion gate).
    const harvestFull = path.join(tmpDir, 'docs/apprenticeship/retro-harvests/echo-to-codey-mentorship.md');
    fs.mkdirSync(path.dirname(harvestFull), { recursive: true });
    fs.writeFileSync(harvestFull, buildHarvest());

    // A REAL git checkout so the decision record's HEAD SHA + dirty flag are live.
    // .instar/ is runtime state the server mutates constantly — ignore it so
    // the dirty flag tracks the SOURCE tree (matrix edits), like a real repo.
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.instar/\n');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=e2e@instar.local', '-c', 'user.name=e2e', ...args], { cwd: tmpDir, stdio: 'pipe' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'e2e fixture');

    const port = await freePort();
    // The gate reads this file LIVE at every evaluation (enforce mode from day one here).
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port, projectName: 'e2e', agentName: 'E2E', apprenticeship: { stallCoverageGate: { enabled: true, dryRun: false } } }),
    );

    // Install provenance through the REAL init-path function (source-carrying tree).
    expect(recordInstallProvenanceIfAbsent(tmpDir, stateDir)).toBe('recorded');

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port, authToken: AUTH, dashboardPin: PIN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir),
    });
    await server.start();
    app = server.getApp();

    for (const id of ['complete-me', 'block-me']) {
      await request(app)
        .post('/apprenticeship/instances')
        .set(auth())
        .send({
          id, instanceType: 'mentorship', overseer: 'echo', mentor: 'echo', mentee: 'codey',
          framework: 'codex-cli', priorInstanceId: null,
          requiredArtifacts: { retroHarvest: true, ledgerEntries: false, detectorAudit: false },
        })
        .expect(201);
    }
  }, 30_000);

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/stall-coverage-gate-lifecycle.test.ts' });
  });

  it('pending→active passes the PROVISIONAL gate with a complete valid matrix (200 through AgentServer, enforce mode)', async () => {
    for (const id of ['complete-me', 'block-me']) {
      const res = await request(app).post(`/apprenticeship/instances/${id}/transition`).set(auth()).send({ to: 'active' });
      expect(res.status).toBe(200);
      expect(res.body.instance.status).toBe('active');
    }
  }, 20_000);

  it('active→complete: refused for acceptance, then completes after the REAL PIN-bound whole-set acceptance', async () => {
    const refused = await request(app).post('/apprenticeship/instances/complete-me/transition').set(auth()).send({ to: 'complete' });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toContain('acceptance-missing');

    const enumRes = await request(app)
      .post('/apprenticeship/instances/complete-me/matrix-acceptance/enumerate')
      .set(auth())
      .expect(200);
    expect(enumRes.body.rowIds.length).toBe(STALL_CLASSES.length);
    await request(app)
      .post('/apprenticeship/instances/complete-me/matrix-acceptance')
      .set(auth())
      .send({ pin: PIN, challengeId: enumRes.body.challengeId })
      .expect(200);

    const done = await request(app).post('/apprenticeship/instances/complete-me/transition').set(auth()).send({ to: 'complete' });
    expect(done.status).toBe(200);
    expect(done.body.instance.status).toBe('complete');
  }, 20_000);

  it('removing one class row BLOCKS completion (409 naming class id + rule)', async () => {
    writeMatrix(fullMatrixRows().slice(1)); // drop the first class — worktree now dirty too
    const res = await request(app).post('/apprenticeship/instances/block-me/transition').set(auth()).send({ to: 'complete' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toContain('stallMatrix:invalid');
    expect(res.body.reason).toContain("rule 'class-row-missing'");
    expect(res.body.reason).toContain(`class '${STALL_CLASSES[0].id}'`);
  }, 20_000);

  it('the gate decision record carries the validated contentHash + checkout HEAD SHA + dirty flag', () => {
    const rows = stallMatrixDecisions();
    expect(rows.length).toBeGreaterThan(0);

    // The passing full evaluation ran against the committed matrix: clean checkout.
    const passed = rows.filter((r) => r.phase === 'full' && r.allow === true && r.verdict === 'valid');
    expect(passed.length).toBeGreaterThan(0);
    for (const r of passed) {
      expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(r.dirty).toBe(false);
    }

    // The blocked evaluation ran after the in-place edit: same HEAD, dirty tree.
    const blocked = rows.filter((r) => r.phase === 'full' && r.allow === false && r.verdict === 'invalid');
    expect(blocked.length).toBeGreaterThan(0);
    const last = blocked.at(-1) as Record<string, unknown>;
    expect(last.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(last.contentHash).not.toBe((passed.at(-1) as Record<string, unknown>).contentHash);
    expect(last.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(last.dirty).toBe(true);
    // Rule names + class ids only — never rejected raw content (Decision 16).
    expect(JSON.stringify(last.rules)).toContain('class-row-missing');
  });
});
