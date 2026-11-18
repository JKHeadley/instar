// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration — design review routes (frontier-design-review-standard §3, §4):
 * the full HTTP pipeline over a REAL ledger file, real documents on disk, a stub
 * hook-event store and token ledger.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createDesignReviewRoutes, ingestDesignReviewSpool, DESIGN_REVIEW_SPOOL_FILE, type DesignReviewRouteDeps } from '../../src/server/designReviewRoutes.js';
import { designFingerprint } from '../../src/core/designReviewRecord.js';
import { designReviewLedgerPath, readDesignReviewLedger } from '../../src/core/designReviewLedger.js';

const runId = () => crypto.randomBytes(16).toString('hex');
const PASS_OK = { family: 'claude', door: 'claude-code', attempts: [{ askedModel: 'claude-fable-5-2', outcome: 'ok' }], model: 'claude-fable-5-2', modelBasis: 'requested', status: 'ok', verdict: 'CLEAN' };
const PASS_GPT = { family: 'codex', door: 'codex-cli', attempts: [{ askedModel: 'gpt-6-astra', outcome: 'ok' }], model: 'gpt-6-astra', modelBasis: 'requested', status: 'ok', verdict: 'MINOR ISSUES' };

describe('design review routes', () => {
  let root: string;
  let project: string;
  let stateDir: string;
  let outside: string;
  let doc: string;
  let app: express.Express;
  let deps: DesignReviewRouteDeps;
  let hookFiles: Record<string, Array<{ receivedAt: string; payload: Record<string, unknown> }>>;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'design-review-routes-')));
    project = path.join(root, 'agent');
    stateDir = path.join(project, '.instar');
    outside = path.join(root, 'elsewhere');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(outside);
    doc = path.join(project, 'plan.md');
    fs.writeFileSync(doc, '---\nslug: plan\n---\n# The export plan\n\nDo the thing.\n');
    hookFiles = {};
    deps = {
      stateDir,
      projectDir: project,
      machineId: () => 'local',
      sessionRecord: (id) => (id === 'sess-cwd' ? { cwd: outside, subscriptionAccountId: 'acct-1' } : null),
      hookEvents: { listSessions: () => Object.keys(hookFiles), getSessionEvents: (id) => hookFiles[id] ?? [] },
      tokenLedger: { modelsAround: (sid) => (sid === 'writer' ? { before: 'claude-opus-5-5', after: 'claude-opus-5-5' } : { before: 'claude-opus-5-5', after: 'claude-fable-5-2' }) },
    };
    app = express();
    app.use(express.json());
    app.use(createDesignReviewRoutes(deps));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/integration/design-review-routes.test.ts' });
  });

  const report = (over: Record<string, unknown> = {}) => ({ runId: runId(), path: doc, fingerprint: designFingerprint(fs.readFileSync(doc, 'utf8')), sessionId: null, passes: [PASS_OK, PASS_GPT], ...over });
  const post = (body: unknown, session?: string) => {
    const r = request(app).post('/design/review/runs');
    if (session) r.set('X-Instar-Session-Id', session);
    return r.send(body as object);
  };

  it('records a run and renders the line; GET answers the same line', async () => {
    hookFiles.writer = [{ receivedAt: '2026-11-17T20:00:00.000Z', payload: { tool_name: 'Write', tool_input: { file_path: doc } } }];
    const res = await post(report());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ recorded: true, status: 'reviewed', timesReviewed: 1 });
    expect(res.body.reference).toMatch(/^[0-9a-f]{12}$/);
    expect(res.body.line).toBe(`On record as written in a session running Claude Opus 5.5. Reviewed 1 time. On this version: Claude Fable 5.2 found no issues, GPT-6 Astra found minor issues. (Review record ${res.body.reference})`);
    const get = await request(app).get('/design/review').query({ path: doc });
    expect(get.status).toBe(200);
    expect(get.body.line).toBe(res.body.line);
    const rows = readDesignReviewLedger(stateDir).runs;
    expect(rows[0]).toMatchObject({ title: 'The export plan', path: doc, machineId: 'local', account: null });
  });

  it('a write whose usage rows disagree has no model on record', async () => {
    hookFiles.mixed = [{ receivedAt: '2026-11-17T20:00:00.000Z', payload: { tool_name: 'Edit', tool_input: { file_path: doc } } }];
    const res = await post(report());
    expect(res.body.line).toContain('On record as written in a session with no model on record.');
  });

  it('a file created by a shell command has no write on record', async () => {
    const res = await post(report());
    expect(res.body.line).toContain('No record of which model wrote this.');
  });

  it('a report delivered twice is recorded once; the same run id with another fingerprint is refused', async () => {
    const r = report();
    expect((await post(r)).status).toBe(201);
    const again = await post(r);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    fs.appendFileSync(doc, 'more\n');
    const conflict = await post({ ...r, fingerprint: designFingerprint(fs.readFileSync(doc, 'utf8')) });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('run-id-conflict');
    expect(readDesignReviewLedger(stateDir).runs).toHaveLength(1);
  });

  it('a file changed during the review is refused', async () => {
    const r = report();
    fs.appendFileSync(doc, 'edited while reviewing\n');
    const res = await post(r);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('document-changed-during-review');
  });

  it('after an edit the old record no longer covers the file', async () => {
    await post(report());
    fs.appendFileSync(doc, 'a real change\n');
    const get = await request(app).get('/design/review').query({ path: doc });
    expect(get.body.status).toBe('not-reviewed');
    expect(get.body.timesReviewed).toBe(1);
  });

  it('paths: the state folder and outside roots are refused; the session working folder is allowed only for that session', async () => {
    const inState = path.join(stateDir, 'plan.md');
    fs.writeFileSync(inState, '# x\n');
    expect((await post(report({ path: inState, fingerprint: designFingerprint('# x\n') }))).body.error).toBe('path-outside-allowed-roots');
    const out = path.join(outside, 'plan.md');
    fs.writeFileSync(out, '# y\n');
    const r = report({ path: out, fingerprint: designFingerprint('# y\n') });
    expect((await post(r)).status).toBe(403);
    const allowed = await post({ ...r, runId: runId() }, 'sess-cwd');
    expect(allowed.status).toBe(201);
    expect(readDesignReviewLedger(stateDir).runs.find((x) => x.path === out)?.account).toBe('acct-1');
    const missing = await request(app).get('/design/review').query({ path: path.join(project, 'nope.md') });
    expect(missing.status).toBe(404);
    // Outside the roots every path gets the same answer, existing or not, file or folder.
    for (const probe of [path.join(outside, 'does-not-exist.md'), outside, '/etc/hosts']) {
      const r = await request(app).get('/design/review').query({ path: probe });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('path-outside-allowed-roots');
    }
    // A link inside the project that points outside is refused too.
    fs.symlinkSync(out, path.join(project, 'link.md'));
    expect((await request(app).get('/design/review').query({ path: path.join(project, 'link.md') })).status).toBe(403);
  });

  it('off-list values are refused', async () => {
    expect((await post(report({ passes: [{ ...PASS_OK, verdict: 'GREAT' }] }))).status).toBe(400);
    expect((await post(report({ passes: [{ ...PASS_OK, model: 'made-up-model' }] }))).status).toBe(400);
    expect((await post(report({ runId: 'short' }))).status).toBe(400);
  });

  it('a durable-only run reads no-reviewer-reachable and still has a line', async () => {
    const res = await post(report({ passes: [{ family: 'claude', door: 'claude-code', attempts: [], model: null, modelBasis: 'requested', status: 'unavailable', reason: 'not-installed' }] }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('no-reviewer-reachable');
    expect(res.body.line.startsWith('No reviewer could be reached (not installed).')).toBe(true);
  });

  it('a torn last line from a crash does not swallow the next record', async () => {
    fs.writeFileSync(designReviewLedgerPath(stateDir), '{"runId":"torn","pa');
    expect((await post(report())).status).toBe(201);
    const read = readDesignReviewLedger(stateDir);
    expect(read.runs).toHaveLength(1);
    expect(read.skipped).toBe(1);
  });

  it('serves this machine\'s rows to peers with a cursor', async () => {
    await post(report());
    await post(report());
    const page = await request(app).get('/design/review/runs').query({ since: 1 });
    expect(page.status).toBe(200);
    expect(page.body.runs).toHaveLength(1);
    expect(page.body.cursor).toBe(2);
    expect(page.body.total).toBe(2);
  });

  it('spooled reports are taken in at start; one that no longer matches its file is dropped and counted', async () => {
    const good = report();
    const stale = report();
    fs.writeFileSync(path.join(stateDir, DESIGN_REVIEW_SPOOL_FILE), [JSON.stringify({ report: good })].join('\n') + '\n');
    fs.appendFileSync(path.join(stateDir, DESIGN_REVIEW_SPOOL_FILE), JSON.stringify({ report: { ...stale, fingerprint: 'c'.repeat(64) } }) + '\n');
    expect(ingestDesignReviewSpool(deps)).toEqual({ recorded: 1, dropped: 1 });
    expect(fs.readFileSync(path.join(stateDir, DESIGN_REVIEW_SPOOL_FILE), 'utf8')).toBe('');
    expect(readDesignReviewLedger(stateDir).runs).toHaveLength(1);
  });

  it('a spooled report the server cannot take right now (ledger unreadable) is kept, not dropped', async () => {
    fs.mkdirSync(designReviewLedgerPath(stateDir)); // a directory where the ledger file should be: unreadable
    const spool = path.join(stateDir, DESIGN_REVIEW_SPOOL_FILE);
    fs.writeFileSync(spool, JSON.stringify({ report: report() }) + '\n');
    expect(ingestDesignReviewSpool(deps)).toEqual({ recorded: 0, dropped: 0 });
    expect(fs.readFileSync(spool, 'utf8').trim().length).toBeGreaterThan(0);
  });
});
