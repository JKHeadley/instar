/**
 * Never-served path deny in the file-viewer routes
 * (ownership-gated-spawn-and-judgment-within-floors spec §3.5;
 * dual-root + hog store: llm-decision-quality-meter spec §5.3).
 *
 * The judgment-provenance dir holds machine-local judgment-call decision
 * context (full-fidelity rows) and the external-hog decision store holds
 * grading GROUND TRUTH. The HTTP read surface for provenance data is
 * GET /judgment-provenance (redacted rows only) — the FILES must never be
 * served: not read, not downloaded, not linked, not edited, and not reachable
 * through a symlink that dereferences into the prefix (Layer 5e re-runs the
 * deny on the FULLY-RESOLVED project-relative path). The deny is HARDCODED
 * and config-immune — PATCH /api/files/config cannot whitelist it.
 *
 * PRODUCTION LAYOUT (SEC r4): the prefix list matches PROJECTDIR-relative
 * paths, and in production both stores live under <projectDir>/.instar/state/
 * (stateDir) — so these tests seed `<projectDir>/.instar/state/...` exactly as
 * production produces. The prior revision of this suite seeded
 * `<projectDir>/state/...` — a layout production never produces — which is how
 * the 'state/judgment-provenance/' no-op went green. That legacy layout is
 * kept below only as a regression pin for the legacy literal.
 *
 * Harness mirrors tests/e2e/file-viewer-e2e.test.ts (express app +
 * createFileRoutes) but uses supertest like the integration route suites.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createFileRoutes, isNeverServed, NEVER_SERVED_PREFIXES } from '../../src/server/fileRoutes.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const CSRF = { 'x-instar-request': '1' };

describe('isNeverServed (unit)', () => {
  it('the prefix list carries BOTH provenance roots AND the hog decision store', () => {
    // Legacy literal kept as a regression pin; the .instar/ spellings are the
    // ones production paths actually hit (projectDir/stateDir divergence).
    expect(NEVER_SERVED_PREFIXES).toContain('state/judgment-provenance/');
    expect(NEVER_SERVED_PREFIXES).toContain('.instar/state/judgment-provenance/');
    expect(NEVER_SERVED_PREFIXES).toContain('.instar/state/external-hog-decisions.json');
  });

  it('matches PRODUCTION-layout paths under the prefix and the bare dir itself', () => {
    expect(isNeverServed('.instar/state/judgment-provenance/x')).toBe(true);
    expect(isNeverServed('.instar/state/judgment-provenance/2026-01-01.jsonl')).toBe(true);
    expect(isNeverServed('.instar/state/judgment-provenance')).toBe(true); // bare dir (list target)
    expect(isNeverServed('.instar/state/judgment-provenance/')).toBe(true);
    expect(isNeverServed('.instar/state/external-hog-decisions.json')).toBe(true);
  });

  it('matches legacy-layout paths (regression pin for the legacy literal)', () => {
    expect(isNeverServed('state/judgment-provenance/x')).toBe(true);
    expect(isNeverServed('state/judgment-provenance/2026-01-01.jsonl')).toBe(true);
    expect(isNeverServed('state/judgment-provenance')).toBe(true);
    expect(isNeverServed('state/judgment-provenance/')).toBe(true);
  });

  it('does NOT over-match a sibling name sharing the prefix characters', () => {
    expect(isNeverServed('.instar/state/judgment-provenanceX')).toBe(false);
    expect(isNeverServed('.instar/state/judgment-provenanceX/y.jsonl')).toBe(false);
    expect(isNeverServed('state/judgment-provenanceX')).toBe(false);
    expect(isNeverServed('state/judgment-provenanceX/y.jsonl')).toBe(false);
    expect(isNeverServed('.instar/state/external-hog-decisions-notes.md')).toBe(false);
    expect(isNeverServed('docs/readme.md')).toBe(false);
  });

  it('normalizes traversal spellings before matching', () => {
    expect(isNeverServed('docs/../.instar/state/judgment-provenance/x.jsonl')).toBe(true);
    expect(isNeverServed('./.instar/state/judgment-provenance/x.jsonl')).toBe(true);
    expect(isNeverServed('docs/../.instar/state/external-hog-decisions.json')).toBe(true);
    expect(isNeverServed('docs/../state/judgment-provenance/x.jsonl')).toBe(true);
    expect(isNeverServed('./state/judgment-provenance/x.jsonl')).toBe(true);
  });
});

describe('file routes deny never-served paths (default config, allowedPaths ["./"], PRODUCTION layout)', () => {
  let projectDir: string;
  let app: express.Express;
  const liveConfigCalls: Array<{ path: string; value: unknown }> = [];

  const jpDir = () => path.join(projectDir, '.instar', 'state', 'judgment-provenance');
  const hogStore = () => path.join(projectDir, '.instar', 'state', 'external-hog-decisions.json');

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'never-served-'));
    // PRODUCTION layout: both stores under <projectDir>/.instar/state/ — the
    // paths the JP log and the hog store actually write. The files EXIST so a
    // 403 proves the deny, never a 404.
    fs.mkdirSync(jpDir(), { recursive: true });
    fs.writeFileSync(
      path.join(jpDir(), '2026-01-01.jsonl'),
      '{"id":"jp-1","contextFull":{"secret":"machine-local"}}\n',
    );
    fs.writeFileSync(
      path.join(jpDir(), 'secret.jsonl'),
      '{"id":"jp-2","contextFull":{"secret":"machine-local"}}\n',
    );
    fs.writeFileSync(hogStore(), '{"decisions":{"hog-1":{"verdict":"kill","enacted":"killed"}}}\n');
    // Legacy layout regression pin: the pre-fix literal must keep matching.
    fs.mkdirSync(path.join(projectDir, 'state', 'judgment-provenance'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'state', 'judgment-provenance', 'legacy.jsonl'),
      '{"id":"jp-legacy","contextFull":{"secret":"machine-local"}}\n',
    );
    // A normal file that must stay servable (no over-block).
    fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'docs', 'readme.md'), '# hello docs\n');
    // SYMLINK EVASION: allowed-path aliases dereferencing INTO the denied paths.
    fs.symlinkSync(
      path.join('..', '.instar', 'state', 'judgment-provenance', 'secret.jsonl'),
      path.join(projectDir, 'docs', 'alias.jsonl'),
    );
    fs.symlinkSync(
      path.join('..', '.instar', 'state', 'external-hog-decisions.json'),
      path.join(projectDir, 'docs', 'hog-alias.json'),
    );

    const config = {
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      projectName: 'never-served-test',
      port: 0,
      // No dashboard.fileViewer override → DEFAULT config (allowedPaths ['./'],
      // editablePaths ['./']) — the deny must hold under the widest config.
    } as unknown as InstarConfig;

    app = express();
    app.use(express.json());
    app.use(createFileRoutes({
      config,
      liveConfig: { set: (p: string, v: unknown) => liveConfigCalls.push({ path: p, value: v }) },
    }));
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/fileRoutes-never-served.test.ts' });
  });

  it('GET /api/files/read on a provenance row file (production layout) → 403 (the deny, not a 404)', async () => {
    const res = await request(app).get('/api/files/read').query({ path: '.instar/state/judgment-provenance/2026-01-01.jsonl' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
    expect(JSON.stringify(res.body)).not.toContain('machine-local');
  });

  it('GET /api/files/read on the hog decision store → 403', async () => {
    const res = await request(app).get('/api/files/read').query({ path: '.instar/state/external-hog-decisions.json' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
    expect(JSON.stringify(res.body)).not.toContain('verdict');
  });

  it('GET /api/files/read on the LEGACY-layout provenance file → 403 (regression pin)', async () => {
    const res = await request(app).get('/api/files/read').query({ path: 'state/judgment-provenance/legacy.jsonl' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
    expect(JSON.stringify(res.body)).not.toContain('machine-local');
  });

  it('GET /api/files/download on a provenance row file → 403', async () => {
    const res = await request(app).get('/api/files/download').query({ path: '.instar/state/judgment-provenance/2026-01-01.jsonl' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
  });

  it('GET /api/files/download on the hog decision store → 403', async () => {
    const res = await request(app).get('/api/files/download').query({ path: '.instar/state/external-hog-decisions.json' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
  });

  it('GET /api/files/list on the provenance dir → 403', async () => {
    const res = await request(app).get('/api/files/list').query({ path: '.instar/state/judgment-provenance' });
    expect(res.status).toBe(403);
  });

  it('POST /api/files/save targeting a provenance row → 403 (never-editable by construction)', async () => {
    const res = await request(app)
      .post('/api/files/save')
      .set(CSRF)
      .send({ path: '.instar/state/judgment-provenance/2026-01-01.jsonl', content: 'poisoned row\n' });
    expect(res.status).toBe(403);
    // The row on disk is untouched — the deny fired before any write.
    const onDisk = fs.readFileSync(path.join(jpDir(), '2026-01-01.jsonl'), 'utf-8');
    expect(onDisk).toContain('"jp-1"');
    expect(onDisk).not.toContain('poisoned');
  });

  it('POST /api/files/save targeting the hog decision store → 403 (grading ground truth stays unwritable)', async () => {
    const res = await request(app)
      .post('/api/files/save')
      .set(CSRF)
      .send({ path: '.instar/state/external-hog-decisions.json', content: '{"decisions":{}}\n' });
    expect(res.status).toBe(403);
    const onDisk = fs.readFileSync(hogStore(), 'utf-8');
    expect(onDisk).toContain('"hog-1"');
  });

  it('GET /api/files/link on a never-served path → 403 (both stores)', async () => {
    for (const p of ['.instar/state/judgment-provenance/x.jsonl', '.instar/state/external-hog-decisions.json']) {
      const res = await request(app).get('/api/files/link').query({ path: p });
      expect(res.status, p).toBe(403);
    }
  });

  it('SYMLINK EVASION: an allowed-path symlink dereferencing into the prefix → 403 (Layer 5e)', async () => {
    // The requested path is clean (docs/alias.jsonl passes Layer 3b); only the
    // post-realpath re-check (Layer 5e) can catch the dereference.
    const res = await request(app).get('/api/files/read').query({ path: 'docs/alias.jsonl' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
    expect(JSON.stringify(res.body)).not.toContain('machine-local');
  });

  it('SYMLINK EVASION: a symlink dereferencing into the hog store → 403 (Layer 5e)', async () => {
    const res = await request(app).get('/api/files/read').query({ path: 'docs/hog-alias.json' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
    expect(JSON.stringify(res.body)).not.toContain('verdict');
  });

  it('a NORMAL file still reads 200 (no over-block)', async () => {
    const res = await request(app).get('/api/files/read').query({ path: 'docs/readme.md' });
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('hello docs');
  });

  it('PATCH /api/files/config refuses editablePaths carrying a never-served prefix (400, config-immune)', async () => {
    for (const p of ['state/judgment-provenance/', '.instar/state/judgment-provenance/', '.instar/state/external-hog-decisions.json']) {
      const res = await request(app)
        .patch('/api/files/config')
        .set(CSRF)
        .send({ editablePaths: [p] });
      expect(res.status, p).toBe(400);
      expect(res.body.error, p).toContain('never editable');
    }
    // Nothing was persisted.
    expect(liveConfigCalls.filter((c) => c.path.includes('editablePaths'))).toEqual([]);
  });
});

describe('GET /api/files/link — the explicit isNeverServed guard (allowedPaths include the parents)', () => {
  // The link route validates allowedPaths by literal prefix (it does not treat
  // './' as project root), so pinning ITS never-served guard needs a config
  // whose allowedPaths admit the parent prefixes.
  let projectDir: string;
  let app: express.Express;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'never-served-link-'));
    fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'docs', 'readme.md'), '# docs\n');
    const config = {
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      projectName: 'never-served-link-test',
      port: 0,
      dashboard: { fileViewer: { enabled: true, allowedPaths: ['.instar/', 'state/', 'docs/'], editablePaths: ['docs/'] } },
    } as unknown as InstarConfig;
    app = express();
    app.use(express.json());
    app.use(createFileRoutes({ config }));
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/fileRoutes-never-served.test.ts' });
  });

  it('403s a never-served path even when its parent IS in allowedPaths (both layouts + hog store)', async () => {
    for (const p of [
      '.instar/state/judgment-provenance/x.jsonl',
      '.instar/state/external-hog-decisions.json',
      'state/judgment-provenance/x.jsonl',
    ]) {
      const res = await request(app).get('/api/files/link').query({ path: p });
      expect(res.status, p).toBe(403);
      expect(res.body.error, p).toBe('Access to this path is not permitted');
    }
  });

  it('still links a normal allowed file (no over-block)', async () => {
    const res = await request(app).get('/api/files/link').query({ path: 'docs/readme.md' });
    expect(res.status).toBe(200);
    expect(res.body.relative).toContain('tab=files');
  });
});
