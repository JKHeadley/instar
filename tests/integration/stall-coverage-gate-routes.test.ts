// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration tests — the stall-coverage matrix gate through the REAL HTTP
 * transition pipeline (framework-stall-coverage-matrix §5 Integration rows):
 * the real inline routes in createRoutes(), behind the real authMiddleware,
 * backed by a real ApprenticeshipProgram wired to a real
 * ApprenticeshipStallGate + MatrixAcceptanceStore.
 *
 *  - active→complete refused (409, class-id + rule-name reasons) on an
 *    absent/invalid matrix under dryRun:false;
 *  - would-refuse logged (presence AND validity both suppressed) under
 *    dryRun:true;
 *  - pending→active refused (409, named reasons) on an absent/invalid
 *    provisional matrix under dryRun:false, would-refuse logged under dryRun:true;
 *  - malformed config block resolves to dry-run with a loud log;
 *  - the matrix-acceptance routes: Bearer enumerate; dashboard-PIN bind
 *    (single-use; wrong PIN 403; replay 409; accept-then-edit 409).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { ApprenticeshipProgram } from '../../src/core/ApprenticeshipProgram.js';
import {
  ApprenticeshipStallGate,
  appendTamperEvidentDecisionRow,
  runStallGateValidation,
} from '../../src/core/ApprenticeshipStallGate.js';
import { MatrixAcceptanceStore } from '../../src/core/ApprenticeshipMatrixAcceptance.js';
import { STALL_CLASSES } from '../../src/data/stall-classes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { validateRetroHarvest } from '../../src/core/retroHarvestValidator.js';
import { canonicalRowHash } from '../../src/core/ApprenticeshipStallGate.js';

const AUTH = 'stall-gate-routes-token';
const PIN = '123456';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

let tmpDir: string;
let projectDir: string;
let stateDir: string;
let gateLogs: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-gate-routes-'));
  projectDir = tmpDir;
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'docs', 'frameworks'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'docs', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'docs', 'specs', 'framework-stall-coverage-matrix.md'), '# stub\n');
  gateLogs = [];
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/stall-coverage-gate-routes.test.ts' });
});

function writeConfig(gateBlock: unknown): void {
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({ port: 4042, apprenticeship: { stallCoverageGate: gateBlock } }),
  );
}

function writeProvenance(): void {
  appendTamperEvidentDecisionRow(path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl'), {
    ts: new Date().toISOString(),
    gate: 'install-provenance',
    installClass: 'source-carrying',
    signals: { developmentAgent: false, frameworksDir: true, specFile: true },
  });
}

function writeMatrix(rows: Array<Record<string, unknown>>): void {
  const fm = yaml.dump({ framework: 'codex-cli', 'stall-coverage': rows });
  fs.writeFileSync(path.join(projectDir, 'docs', 'frameworks', 'codex-cli-stall-coverage.md'), `---\n${fm}---\n\nnotes\n`);
}

function fullGapRows(): Array<Record<string, unknown>> {
  return STALL_CLASSES.map((c) => ({
    class: c.id,
    status: 'declared-gap',
    reason: 'no detector yet',
    issueRef: `stallclass::${c.id}::codex-cli::gap`,
    closePath: 'CMT-OPEN',
    'liveness-surface': 'DEFECT: registry shows running',
  }));
}

const fakeFetch = (async (url: RequestInfo | URL) => {
  const route = String(url).replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
  const body =
    route === '/guards'
      ? { guards: [] }
      : route.startsWith('/commitments/CMT-OPEN')
        ? { status: 'pending' }
        : route === '/attention'
          ? { ok: true }
          : null;
  const status = body === null ? 404 : 200;
  return { ok: status === 200, status, json: async () => body } as Response;
}) as typeof fetch;

// A REAL parseable harvest (mirrors tests/integration/apprenticeship-routes) so
// the retro-gate passes and the stall-matrix sibling branch is what decides.
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

function makeProgram(store: MatrixAcceptanceStore): ApprenticeshipProgram {
  const stallGate = new ApprenticeshipStallGate({
    projectDir,
    stateDir,
    loopback: { port: 4042, authToken: AUTH },
    acceptance: store,
    fetchImpl: fakeFetch,
    getCurrentVersion: () => '1.3.900',
    log: (m) => gateLogs.push(m),
    runValidation: async (input) => ({ ok: true, output: runStallGateValidation(input) }),
  });
  return new ApprenticeshipProgram({
    stateDir,
    projectDir,
    stallGate,
    deps: {
      readHarvest: () => buildHarvest(),
      validate: validateRetroHarvest,
      countInstanceLedgerEntries: () => 1,
      detectorAuditExists: () => true,
    },
  });
}

function appFor(program: ApprenticeshipProgram, store: MatrixAcceptanceStore): express.Express {
  const ctx = {
    config: {
      projectName: 'stall-gate-routes', projectDir, stateDir, port: 0,
      authToken: AUTH, dashboardPin: PIN, monitoring: {}, sessions: {} as never, scheduler: {} as never,
    },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, correctionLedger: null,
    apprenticeshipProgram: program,
    apprenticeshipMatrixAcceptance: store,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

async function createInstance(app: express.Express, id: string): Promise<void> {
  await request(app)
    .post('/apprenticeship/instances')
    .set(auth())
    .send({ id, instanceType: 'mentorship', mentor: 'echo', mentee: 'codey', framework: 'codex-cli', priorInstanceId: null })
    .expect(201);
}

function stallMatrixDecisions(): Array<Record<string, unknown>> {
  const p = path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l))
    .filter((r) => r.gate === 'stall-matrix');
}

async function bindAcceptanceViaHttp(app: express.Express, id: string): Promise<void> {
  const enumRes = await request(app)
    .post(`/apprenticeship/instances/${id}/matrix-acceptance/enumerate`)
    .set(auth())
    .expect(200);
  await request(app)
    .post(`/apprenticeship/instances/${id}/matrix-acceptance`)
    .set(auth())
    .send({ pin: PIN, challengeId: enumRes.body.challengeId })
    .expect(200);
}

describe('stall-coverage gate — real HTTP transition pipeline', () => {
  it('pending→active is REFUSED (409, named reasons) on an invalid provisional matrix under dryRun:false — and passes once the matrix is complete', async () => {
    writeConfig({ enabled: true, dryRun: false });
    writeProvenance();
    writeMatrix(fullGapRows().slice(1)); // one class row missing
    const store = new MatrixAcceptanceStore({ stateDir });
    const app = appFor(makeProgram(store), store);
    await createInstance(app, 'prov');

    const refused = await request(app).post('/apprenticeship/instances/prov/transition').set(auth()).send({ to: 'active' });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toContain('provisional stall-coverage matrix gate refused');
    expect(refused.body.reason).toContain("rule 'class-row-missing'");
    expect(refused.body.reason).toContain(`class '${STALL_CLASSES[0].id}'`);

    writeMatrix(fullGapRows());
    await request(app).post('/apprenticeship/instances/prov/transition').set(auth()).send({ to: 'active' }).expect(200);
  });

  it('pending→active on an ABSENT matrix: 409 under dryRun:false; suppressed + would-refuse logged under dryRun:true', async () => {
    writeConfig({ enabled: true, dryRun: false });
    writeProvenance();
    const store = new MatrixAcceptanceStore({ stateDir });
    const app = appFor(makeProgram(store), store);
    await createInstance(app, 'absent');

    const refused = await request(app).post('/apprenticeship/instances/absent/transition').set(auth()).send({ to: 'active' });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toContain('matrix-file-missing');

    // Flip to dryRun live (no restart — the gate reads config at the callsite).
    writeConfig({ enabled: true, dryRun: true });
    await request(app).post('/apprenticeship/instances/absent/transition').set(auth()).send({ to: 'active' }).expect(200);
    const rows = stallMatrixDecisions().filter((r) => r.instanceId === 'absent');
    expect(rows.some((r) => r.verdict === 'would-refuse' && r.phase === 'provisional')).toBe(true);
  });

  it('active→complete is REFUSED (409, class-id + rule reasons) on an invalid matrix under dryRun:false', async () => {
    writeConfig({ enabled: true, dryRun: false });
    writeProvenance();
    writeMatrix(fullGapRows());
    const store = new MatrixAcceptanceStore({ stateDir });
    const app = appFor(makeProgram(store), store);
    await createInstance(app, 'full');
    await request(app).post('/apprenticeship/instances/full/transition').set(auth()).send({ to: 'active' }).expect(200);

    writeMatrix(fullGapRows().slice(1)); // break the matrix AFTER activation
    const refused = await request(app).post('/apprenticeship/instances/full/transition').set(auth()).send({ to: 'complete' });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toContain('completion gate refused');
    expect(refused.body.reason).toContain('stallMatrix:invalid');
    expect(refused.body.reason).toContain("rule 'class-row-missing'");
  });

  it('active→complete: acceptance-missing refuses; the PIN-bound acceptance then completes it (the full loop)', async () => {
    writeConfig({ enabled: true, dryRun: false });
    writeProvenance();
    writeMatrix(fullGapRows());
    const store = new MatrixAcceptanceStore({ stateDir });
    const app = appFor(makeProgram(store), store);
    await createInstance(app, 'loop');
    await request(app).post('/apprenticeship/instances/loop/transition').set(auth()).send({ to: 'active' }).expect(200);

    const refused = await request(app).post('/apprenticeship/instances/loop/transition').set(auth()).send({ to: 'complete' });
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toContain('acceptance-missing');

    await bindAcceptanceViaHttp(app, 'loop');
    const done = await request(app).post('/apprenticeship/instances/loop/transition').set(auth()).send({ to: 'complete' });
    expect(done.status).toBe(200);
    expect(done.body.instance.status).toBe('complete');
  });

  it('would-refuse is logged for BOTH presence and validity suppression under dryRun:true (active→complete)', async () => {
    writeConfig({ enabled: true, dryRun: true });
    writeProvenance();
    const store = new MatrixAcceptanceStore({ stateDir });
    const app = appFor(makeProgram(store), store);
    await createInstance(app, 'dry');
    await request(app).post('/apprenticeship/instances/dry/transition').set(auth()).send({ to: 'active' }).expect(200);

    // Presence: no matrix at all → suppressed.
    const canComplete1 = await request(app).post('/apprenticeship/instances/dry/can-complete').set(auth()).expect(200);
    expect(canComplete1.body.allow).toBe(true);

    // Validity: an invalid matrix → suppressed.
    writeMatrix(fullGapRows().slice(1));
    const canComplete2 = await request(app).post('/apprenticeship/instances/dry/can-complete').set(auth()).expect(200);
    expect(canComplete2.body.allow).toBe(true);

    const rows = stallMatrixDecisions().filter((r) => r.instanceId === 'dry' && r.verdict === 'would-refuse');
    expect(rows.length).toBeGreaterThanOrEqual(3); // provisional + two can-complete evaluations
  });

  it('a malformed config block resolves to dry-run with a loud log line', async () => {
    writeConfig('total garbage');
    writeProvenance();
    const store = new MatrixAcceptanceStore({ stateDir });
    const app = appFor(makeProgram(store), store);
    await createInstance(app, 'malformed');
    // Absent matrix + malformed block: safe default is dry-run → allowed.
    await request(app).post('/apprenticeship/instances/malformed/transition').set(auth()).send({ to: 'active' }).expect(200);
    expect(gateLogs.some((l) => l.includes('malformed apprenticeship.stallCoverageGate'))).toBe(true);
  });

  describe('matrix-acceptance routes', () => {
    it('enumerate is Bearer-gated and renders the exact enumerated set', async () => {
      writeConfig({ enabled: true, dryRun: false });
      writeProvenance();
      writeMatrix(fullGapRows());
      const store = new MatrixAcceptanceStore({ stateDir });
      const app = appFor(makeProgram(store), store);
      await createInstance(app, 'enum');

      await request(app).post('/apprenticeship/instances/enum/matrix-acceptance/enumerate').expect(401);
      const res = await request(app).post('/apprenticeship/instances/enum/matrix-acceptance/enumerate').set(auth()).expect(200);
      expect(res.body.challengeId).toMatch(/^MAC-[0-9a-f]{16}$/);
      expect(res.body.scope).toBe('whole-set');
      expect(res.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.rowIds).toEqual(STALL_CLASSES.map((c) => `codex-cli:${c.id}`));
      expect(res.body.renderedText).toContain('single-use');
    });

    it('bind requires the dashboard PIN (wrong PIN 403 — a Bearer token is structurally insufficient), is single-use, and voids on accept-then-edit', async () => {
      writeConfig({ enabled: true, dryRun: false });
      writeProvenance();
      writeMatrix(fullGapRows());
      const store = new MatrixAcceptanceStore({ stateDir });
      const app = appFor(makeProgram(store), store);
      await createInstance(app, 'bind');

      const enumRes = await request(app).post('/apprenticeship/instances/bind/matrix-acceptance/enumerate').set(auth()).expect(200);
      const challengeId = enumRes.body.challengeId;

      // No PIN / wrong PIN → 403; nothing recorded.
      await request(app).post('/apprenticeship/instances/bind/matrix-acceptance').set(auth()).send({ challengeId }).expect(403);
      await request(app).post('/apprenticeship/instances/bind/matrix-acceptance').set(auth()).send({ pin: '999999', challengeId }).expect(403);
      expect(store.hasWholeSetAcceptance('bind', enumRes.body.contentHash)).toBe(false);

      // Correct PIN binds.
      await request(app).post('/apprenticeship/instances/bind/matrix-acceptance').set(auth()).send({ pin: PIN, challengeId }).expect(200);
      expect(store.hasWholeSetAcceptance('bind', enumRes.body.contentHash)).toBe(true);

      // Replay refused (single-use).
      const replay = await request(app).post('/apprenticeship/instances/bind/matrix-acceptance').set(auth()).send({ pin: PIN, challengeId });
      expect(replay.status).toBe(409);
      expect(replay.body.reason).toContain('replay refused');

      // Accept-then-edit: a NEW challenge minted, matrix edited before bind → 409.
      const enum2 = await request(app).post('/apprenticeship/instances/bind/matrix-acceptance/enumerate').set(auth()).expect(200);
      writeMatrix([...fullGapRows().slice(0, 7), { ...fullGapRows()[7], reason: 'edited after enumerate' }]);
      const stale = await request(app).post('/apprenticeship/instances/bind/matrix-acceptance').set(auth()).send({ pin: PIN, challengeId: enum2.body.challengeId });
      expect(stale.status).toBe(409);
      expect(stale.body.reason).toContain('content hash mismatch');
    });

    it('row-scoped acceptance is mintable through the PRODUCTION route: acceptanceRef clears bind, survive unrelated edits, void on row change', async () => {
      writeConfig({ enabled: true, dryRun: false });
      writeProvenance();
      const today = new Date().toISOString().slice(0, 10);
      // quota-wall is a CLEARED seeded row (seededAt + non-unreviewed reason):
      // the validator REQUIRES an acceptanceRef on it (Decision 19) — the exact
      // production shape that made rows-scope minting load-bearing.
      const clearedRow = (acceptanceRef: string, reason = 'seed reviewed by overseer'): Record<string, unknown> => ({
        class: 'quota-wall',
        status: 'declared-gap',
        reason,
        issueRef: 'stallclass::quota-wall::codex-cli::gap',
        closePath: 'CMT-OPEN',
        seededAt: today,
        acceptanceRef,
        'liveness-surface': 'DEFECT: registry shows running',
      });
      const otherRows = (extraReason?: string) => fullGapRows()
        .filter((r) => r.class !== 'quota-wall')
        .map((r) => (extraReason && r.class === 'wedged-context' ? { ...r, reason: extraReason } : r));
      writeMatrix([clearedRow('MAC-0000000000000000'), ...otherRows()]);

      const store = new MatrixAcceptanceStore({ stateDir });
      const app = appFor(makeProgram(store), store);
      await createInstance(app, 'rowscope');
      await request(app).post('/apprenticeship/instances/rowscope/transition').set(auth()).send({ to: 'active' }).expect(200);

      // Whole-set acceptance alone: the placeholder acceptanceRef FAILS
      // authenticity (the both-sides refusal arm).
      await bindAcceptanceViaHttp(app, 'rowscope');
      const refInvalid = await request(app).post('/apprenticeship/instances/rowscope/transition').set(auth()).send({ to: 'complete' });
      expect(refInvalid.status).toBe(409);
      expect(refInvalid.body.reason).toContain('acceptance-ref-invalid');

      // Mint + PIN-bind the rows-scope challenge through the production route.
      const rowsEnum = await request(app)
        .post('/apprenticeship/instances/rowscope/matrix-acceptance/enumerate')
        .set(auth())
        .send({ scope: 'rows', rowIds: ['codex-cli:quota-wall'] })
        .expect(200);
      expect(rowsEnum.body.scope).toBe('rows');
      expect(rowsEnum.body.rowIds).toEqual(['codex-cli:quota-wall']);
      expect(rowsEnum.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
      await request(app)
        .post('/apprenticeship/instances/rowscope/matrix-acceptance')
        .set(auth())
        .send({ pin: PIN, challengeId: rowsEnum.body.challengeId })
        .expect(200);

      // Write the REAL ref into the row AND make an UNRELATED codemod-style
      // edit to another row — neither voids the row-scoped acceptance (the ref
      // field is excluded from canonical content; only the accepted row's
      // substantive fields are hashed).
      writeMatrix([clearedRow(rowsEnum.body.challengeId), ...otherRows('updated by an unrelated codemod pass')]);
      await bindAcceptanceViaHttp(app, 'rowscope'); // whole-set re-accept over the edited file
      const done = await request(app).post('/apprenticeship/instances/rowscope/transition').set(auth()).send({ to: 'complete' });
      expect(done.status).toBe(200);
      expect(done.body.instance.status).toBe('complete');
    });

    it('a row-scoped acceptance goes INERT when the accepted row itself changes (gate refuses acceptance-ref-invalid)', async () => {
      writeConfig({ enabled: true, dryRun: false });
      writeProvenance();
      const today = new Date().toISOString().slice(0, 10);
      const seededRow = (acceptanceRef: string, reason: string): Record<string, unknown> => ({
        class: 'quota-wall', status: 'declared-gap', reason,
        issueRef: 'stallclass::quota-wall::codex-cli::gap', closePath: 'CMT-OPEN',
        seededAt: today, acceptanceRef, 'liveness-surface': 'DEFECT: registry shows running',
      });
      const rest = fullGapRows().filter((r) => r.class !== 'quota-wall');
      writeMatrix([seededRow('MAC-0000000000000000', 'seed reviewed by overseer'), ...rest]);
      const store = new MatrixAcceptanceStore({ stateDir });
      const app = appFor(makeProgram(store), store);
      await createInstance(app, 'rowvoid');
      await request(app).post('/apprenticeship/instances/rowvoid/transition').set(auth()).send({ to: 'active' }).expect(200);

      const rowsEnum = await request(app)
        .post('/apprenticeship/instances/rowvoid/matrix-acceptance/enumerate')
        .set(auth())
        .send({ scope: 'rows', rowIds: ['codex-cli:quota-wall'] })
        .expect(200);
      await request(app)
        .post('/apprenticeship/instances/rowvoid/matrix-acceptance')
        .set(auth())
        .send({ pin: PIN, challengeId: rowsEnum.body.challengeId })
        .expect(200);

      // The accepted row's SUBSTANTIVE content then changes: acceptance inert.
      writeMatrix([seededRow(rowsEnum.body.challengeId, 'reason rewritten AFTER acceptance'), ...rest]);
      await bindAcceptanceViaHttp(app, 'rowvoid');
      const refused = await request(app).post('/apprenticeship/instances/rowvoid/transition').set(auth()).send({ to: 'complete' });
      expect(refused.status).toBe(409);
      expect(refused.body.reason).toContain('acceptance-ref-invalid');
    });

    it('override challenges are mintable through the PRODUCTION route and bind to (rule, row), inert on row change', async () => {
      writeConfig({ enabled: true, dryRun: false });
      writeProvenance();
      writeMatrix(fullGapRows());
      const store = new MatrixAcceptanceStore({ stateDir });
      const app = appFor(makeProgram(store), store);
      await createInstance(app, 'override');

      const res = await request(app)
        .post('/apprenticeship/instances/override/matrix-acceptance/enumerate')
        .set(auth())
        .send({ scope: 'override', rule: 'symbol-unresolvable', classId: 'quota-wall' })
        .expect(200);
      expect(res.body.scope).toBe('override');
      expect(res.body.rule).toBe('symbol-unresolvable');
      expect(res.body.rowIds).toEqual(['codex-cli:quota-wall']);
      await request(app)
        .post('/apprenticeship/instances/override/matrix-acceptance')
        .set(auth())
        .send({ pin: PIN, challengeId: res.body.challengeId })
        .expect(200);

      const row = fullGapRows().find((r) => r.class === 'quota-wall')!;
      // Excuses exactly the named (rule, row) at the CURRENT row content…
      expect(store.overrideExcuses('override', 'symbol-unresolvable', 'codex-cli:quota-wall', canonicalRowHash(row))).toBe(true);
      expect(store.overrideExcuses('override', 'evidence-missing', 'codex-cli:quota-wall', canonicalRowHash(row))).toBe(false);
      // …and goes inert the moment the row changes (expires on change).
      expect(store.overrideExcuses('override', 'symbol-unresolvable', 'codex-cli:quota-wall', canonicalRowHash({ ...row, reason: 'edited' } as never))).toBe(false);
    });

    it('503 when the program is unavailable; 404 for an unknown instance/challenge', async () => {
      writeConfig({ enabled: true, dryRun: false });
      const store = new MatrixAcceptanceStore({ stateDir });
      const appNoProgram = appFor(null as never, store);
      await request(appNoProgram).post('/apprenticeship/instances/x/matrix-acceptance/enumerate').set(auth()).expect(503);

      writeProvenance();
      writeMatrix(fullGapRows());
      const app = appFor(makeProgram(store), store);
      await request(app).post('/apprenticeship/instances/ghost/matrix-acceptance/enumerate').set(auth()).expect(404);
      await createInstance(app, 'known');
      await request(app).post('/apprenticeship/instances/known/matrix-acceptance').set(auth()).send({ pin: PIN, challengeId: 'MAC-nope' }).expect(404);
    });
  });
});
