/**
 * GET /api/files/link honors the shared allowed-path policy
 * (docs/specs/files-link-allowed-paths.md).
 *
 * The regression this pins (found live 2026-07-23, Drive 11 cycle 24): the
 * link route carried its own INLINE duplicate of the Layer-4 allowedPaths
 * check, which drifted from validatePath — it never learned the '.'/'./'
 * project-root convention, so under the DEFAULT config
 * (`allowedPaths: ['./']`) EVERY link request 403'd "Path not in allowed
 * directories". The inline check also matched prefixes without a segment
 * boundary and skipped the absolute/traversal rejections.
 *
 * Fix: one exported pure pre-check (`checkRelativePathAllowed`) is the single
 * source of truth for Layers 1–4; both validatePath and the link route flow
 * through it. Both sides of every decision boundary covered below.
 *
 * Harness mirrors tests/unit/fileRoutes-never-served.test.ts (express app +
 * createFileRoutes + supertest).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createFileRoutes, checkRelativePathAllowed } from '../../src/server/fileRoutes.js';
import type { InstarConfig, FileViewerConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cfg = (allowedPaths: string[]): FileViewerConfig => ({
  enabled: true,
  allowedPaths,
  editablePaths: [],
  maxFileSize: 1_048_576,
  maxEditableFileSize: 204_800,
});

describe('checkRelativePathAllowed (unit — the shared Layer 1–4 pre-check)', () => {
  it("the './' project-root default allows any in-project relative path", () => {
    for (const p of ['.claude/CLAUDE.md', 'docs/readme.md', 'src/server/routes.ts']) {
      const r = checkRelativePathAllowed(p, cfg(['./']));
      expect(r.ok, p).toBe(true);
    }
  });

  it("the '.' spelling of project root behaves identically", () => {
    expect(checkRelativePathAllowed('.claude/CLAUDE.md', cfg(['.'])).ok).toBe(true);
  });

  it('a scoped allowed path matches itself and its children only', () => {
    expect(checkRelativePathAllowed('docs/readme.md', cfg(['docs/'])).ok).toBe(true);
    expect(checkRelativePathAllowed('docs', cfg(['docs/'])).ok).toBe(true);
    expect(checkRelativePathAllowed('src/index.ts', cfg(['docs/'])).ok).toBe(false);
  });

  it('prefix matching respects segment boundaries (docs must not admit docs-secret)', () => {
    const r = checkRelativePathAllowed('docs-secret/x.md', cfg(['docs']));
    expect(r.ok).toBe(false);
  });

  it('rejects absolute paths and traversal regardless of allowedPaths', () => {
    const abs = checkRelativePathAllowed('/etc/passwd', cfg(['./']));
    expect(abs.ok).toBe(false);
    if (!abs.ok) expect(abs.status).toBe(403);
    const trav = checkRelativePathAllowed('../outside.txt', cfg(['./']));
    expect(trav.ok).toBe(false);
    // The '.'-root convention must not admit traversal ('..' starts with '.').
    const travDot = checkRelativePathAllowed('../../secret', cfg(['.']));
    expect(travDot.ok).toBe(false);
  });

  it('never-served paths are denied even under the project-root default', () => {
    const r = checkRelativePathAllowed('.instar/state/judgment-provenance/x.jsonl', cfg(['./']));
    expect(r.ok).toBe(false);
  });

  it('returns the normalized path on success', () => {
    const r = checkRelativePathAllowed('docs/./readme.md', cfg(['./']));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('docs/readme.md');
  });
});

describe('GET /api/files/link under the DEFAULT config (the live regression)', () => {
  let projectDir: string;
  let app: express.Express;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-allowed-'));
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'CLAUDE.md'), '# hi\n');
    const config = {
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      projectName: 'link-allowed-test',
      port: 0,
      // No dashboard.fileViewer override → DEFAULT config (allowedPaths ['./']).
    } as unknown as InstarConfig;
    app = express();
    app.use(express.json());
    app.use(createFileRoutes({ config }));
  });
  afterAll(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/fileRoutes-link-allowed-paths.test.ts',
    });
  });

  it('generates a link for a project file under the default allowedPaths (was a blanket 403)', async () => {
    const res = await request(app).get('/api/files/link').query({ path: '.claude/CLAUDE.md' });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('.claude/CLAUDE.md');
    expect(res.body.relative).toContain('tab=files');
    expect(res.body.relative).toContain(encodeURIComponent('.claude/CLAUDE.md'));
  });

  it('still 403s traversal, absolute, and never-served paths', async () => {
    for (const bad of ['../outside.txt', '/etc/passwd', '.instar/state/judgment-provenance/x.jsonl']) {
      const res = await request(app).get('/api/files/link').query({ path: bad });
      expect(res.status, bad).toBe(403);
    }
  });

  it('still 400s a missing path parameter', async () => {
    const res = await request(app).get('/api/files/link');
    expect(res.status).toBe(400);
  });
});
