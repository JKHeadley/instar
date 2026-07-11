/**
 * Never-served path deny in the file-viewer routes
 * (ownership-gated-spawn-and-judgment-within-floors spec §3.5).
 *
 * `state/judgment-provenance/` holds machine-local judgment-call decision
 * context (full-fidelity rows). The HTTP read surface for that data is
 * GET /judgment-provenance (redacted rows only) — the FILES must never be
 * served: not read, not downloaded, not linked, not edited, and not reachable
 * through a symlink that dereferences into the prefix (Layer 5e re-runs the
 * deny on the FULLY-RESOLVED project-relative path). The deny is HARDCODED
 * and config-immune — PATCH /api/files/config cannot whitelist it.
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
  it('the prefix list carries the provenance dir', () => {
    expect(NEVER_SERVED_PREFIXES).toContain('state/judgment-provenance/');
  });

  it('matches paths under the prefix and the bare dir itself', () => {
    expect(isNeverServed('state/judgment-provenance/x')).toBe(true);
    expect(isNeverServed('state/judgment-provenance/2026-01-01.jsonl')).toBe(true);
    expect(isNeverServed('state/judgment-provenance')).toBe(true); // bare dir (list target)
    expect(isNeverServed('state/judgment-provenance/')).toBe(true);
  });

  it('does NOT over-match a sibling name sharing the prefix characters', () => {
    expect(isNeverServed('state/judgment-provenanceX')).toBe(false);
    expect(isNeverServed('state/judgment-provenanceX/y.jsonl')).toBe(false);
    expect(isNeverServed('docs/readme.md')).toBe(false);
  });

  it('normalizes traversal spellings before matching', () => {
    expect(isNeverServed('docs/../state/judgment-provenance/x.jsonl')).toBe(true);
    expect(isNeverServed('./state/judgment-provenance/x.jsonl')).toBe(true);
  });
});

describe('file routes deny never-served paths (default config, allowedPaths ["./"])', () => {
  let projectDir: string;
  let app: express.Express;
  const liveConfigCalls: Array<{ path: string; value: unknown }> = [];

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'never-served-'));
    // The provenance files EXIST so a 403 proves the deny, never a 404.
    fs.mkdirSync(path.join(projectDir, 'state', 'judgment-provenance'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'state', 'judgment-provenance', '2026-01-01.jsonl'),
      '{"id":"jp-1","contextFull":{"secret":"machine-local"}}\n',
    );
    fs.writeFileSync(
      path.join(projectDir, 'state', 'judgment-provenance', 'secret.jsonl'),
      '{"id":"jp-2","contextFull":{"secret":"machine-local"}}\n',
    );
    // A normal file that must stay servable (no over-block).
    fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'docs', 'readme.md'), '# hello docs\n');
    // SYMLINK EVASION: an allowed-path alias dereferencing INTO the prefix.
    fs.symlinkSync(
      path.join('..', 'state', 'judgment-provenance', 'secret.jsonl'),
      path.join(projectDir, 'docs', 'alias.jsonl'),
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

  it('GET /api/files/read on a provenance row file → 403 (the deny, not a 404)', async () => {
    const res = await request(app).get('/api/files/read').query({ path: 'state/judgment-provenance/2026-01-01.jsonl' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
    expect(JSON.stringify(res.body)).not.toContain('machine-local');
  });

  it('GET /api/files/download on a provenance row file → 403', async () => {
    const res = await request(app).get('/api/files/download').query({ path: 'state/judgment-provenance/2026-01-01.jsonl' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
  });

  it('GET /api/files/list on the provenance dir → 403', async () => {
    const res = await request(app).get('/api/files/list').query({ path: 'state/judgment-provenance' });
    expect(res.status).toBe(403);
  });

  it('POST /api/files/save targeting a never-served path → 403 (never-editable by construction)', async () => {
    const res = await request(app)
      .post('/api/files/save')
      .set(CSRF)
      .send({ path: 'state/judgment-provenance/2026-01-01.jsonl', content: 'poisoned row\n' });
    expect(res.status).toBe(403);
    // The row on disk is untouched — the deny fired before any write.
    const onDisk = fs.readFileSync(path.join(projectDir, 'state', 'judgment-provenance', '2026-01-01.jsonl'), 'utf-8');
    expect(onDisk).toContain('"jp-1"');
    expect(onDisk).not.toContain('poisoned');
  });

  it('GET /api/files/link on a never-served path → 403', async () => {
    const res = await request(app).get('/api/files/link').query({ path: 'state/judgment-provenance/x.jsonl' });
    expect(res.status).toBe(403);
  });

  it('SYMLINK EVASION: an allowed-path symlink dereferencing into the prefix → 403 (Layer 5e)', async () => {
    // The requested path is clean (docs/alias.jsonl passes Layer 3b); only the
    // post-realpath re-check (Layer 5e) can catch the dereference.
    const res = await request(app).get('/api/files/read').query({ path: 'docs/alias.jsonl' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
    expect(JSON.stringify(res.body)).not.toContain('machine-local');
  });

  it('a NORMAL file still reads 200 (no over-block)', async () => {
    const res = await request(app).get('/api/files/read').query({ path: 'docs/readme.md' });
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('hello docs');
  });

  it('PATCH /api/files/config refuses editablePaths carrying the never-served prefix (400, config-immune)', async () => {
    const res = await request(app)
      .patch('/api/files/config')
      .set(CSRF)
      .send({ editablePaths: ['state/judgment-provenance/'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('never editable');
    // Nothing was persisted.
    expect(liveConfigCalls.filter((c) => c.path.includes('editablePaths'))).toEqual([]);
  });
});

describe('GET /api/files/link — the explicit isNeverServed guard (allowedPaths include state/)', () => {
  // The link route validates allowedPaths by literal prefix (it does not treat
  // './' as project root), so pinning ITS never-served guard needs a config
  // whose allowedPaths admit the state/ prefix.
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
      dashboard: { fileViewer: { enabled: true, allowedPaths: ['state/', 'docs/'], editablePaths: ['docs/'] } },
    } as unknown as InstarConfig;
    app = express();
    app.use(express.json());
    app.use(createFileRoutes({ config }));
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/fileRoutes-never-served.test.ts' });
  });

  it('403s a never-served path even when its parent IS in allowedPaths', async () => {
    const res = await request(app).get('/api/files/link').query({ path: 'state/judgment-provenance/x.jsonl' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access to this path is not permitted');
  });

  it('still links a normal allowed file (no over-block)', async () => {
    const res = await request(app).get('/api/files/link').query({ path: 'docs/readme.md' });
    expect(res.status).toBe(200);
    expect(res.body.relative).toContain('tab=files');
  });
});
