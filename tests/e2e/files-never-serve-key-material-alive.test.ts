// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * E2E "feature is alive" — key material is never served by the production
 * file routes (docs/specs/a2a-single-agent-identity.md §5, AC7; Tier 3).
 *
 * Tests the complete PRODUCTION path:
 *   1. The REAL AgentServer boots the way server.ts does (createFileRoutes is
 *      mounted by AgentServer itself — nothing injected).
 *   2. The dashboard file routes answer through the real auth middleware:
 *      an allowed file is 200 (the surface is ALIVE, not 404/503) while
 *      `.instar/identity.json` — present on disk, bearing a private key — is
 *      403 on read, download, link, and omitted from the listing.
 *   3. Migration parity: PostUpdateMigrator adds the §5.1 gitignore entries to
 *      an EXISTING agent (project + internal repo) and the "Never served" row
 *      to an existing CLAUDE.md — once, and idempotently on a second run.
 *
 * WHY THIS TEST EXISTS:
 * The unit and integration tiers mount createFileRoutes by hand. That proves
 * the deny works IF the routes are wired. This boots the production server and
 * proves the deny is live behind the real middleware, and that an agent
 * updating in place receives the same floor.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { KEY_MATERIAL_GITIGNORE_PROJECT, KEY_MATERIAL_GITIGNORE_STATE } from '../../src/core/keyMaterialPaths.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

const PRIVATE_KEY_MARKER = 'E2E-PRIVATE-KEY-BYTES-MUST-NEVER-LEAVE';

describe('Files never serve key material — E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-files-never-serve';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-never-serve-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    // The agent identity, as the single writer leaves it (0600, private key inside).
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({ version: 1, publicKey: 'pub', privateKey: PRIVATE_KEY_MARKER }), { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, 'threadline', 'conversations.json'), '{"conversations":[]}\n');
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'readme.md'), '# e2e docs\n');

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/files-never-serve-key-material-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('the file routes are ALIVE on the production path (an allowed file reads 200, not 404/503)', async () => {
    const res = await request(app).get('/api/files/read').query({ path: 'docs/readme.md' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# e2e docs\n');
  });

  it('`.instar/identity.json` is refused by read, download and link behind the real middleware (403, no key bytes)', async () => {
    for (const route of ['/api/files/read', '/api/files/download', '/api/files/link']) {
      const res = await request(app).get(route).query({ path: '.instar/identity.json' }).set(auth());
      expect(res.status, route).toBe(403);
      expect(res.text ?? '', route).not.toContain(PRIVATE_KEY_MARKER);
    }
  });

  it('`.instar/identity.json` is omitted from the production listing; the audit surface beside it still serves', async () => {
    const list = await request(app).get('/api/files/list').query({ path: '.instar' }).set(auth());
    expect(list.status).toBe(200);
    expect(list.body.entries.map((e: { name: string }) => e.name)).not.toContain('identity.json');
    const conv = await request(app).get('/api/files/read').query({ path: '.instar/threadline/conversations.json' }).set(auth());
    expect(conv.status).toBe(200);
  });

  it('a fresh CLAUDE.md template carries the "Never served" row (Agent Awareness)', () => {
    const md = generateClaudeMd({ projectName: 'e2e', port: 4042 } as never);
    expect(md).toContain('**Never served**');
    expect(md).toContain('A 403 there is correct');
  });

  it('PostUpdateMigrator gives an EXISTING agent the §5.1 gitignore entries and the CLAUDE.md row — once, idempotently (Migration Parity)', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-never-serve-migrate-'));
    try {
      const migStateDir = path.join(projectDir, '.instar');
      fs.mkdirSync(path.join(migStateDir, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(migStateDir, 'config.json'), JSON.stringify({ port: 4042, projectName: 'mig' }));
      // A pre-§5 project .gitignore and internal .instar/.gitignore.
      fs.writeFileSync(path.join(projectDir, '.gitignore'), '.instar/machine/signing-key.pem\n.instar/secrets/\n');
      fs.writeFileSync(path.join(migStateDir, '.gitignore'), 'secrets/\n');
      // A pre-§5 CLAUDE.md that already carries the File Viewer section WITHOUT the row.
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), [
        '# CLAUDE.md',
        '',
        '**Dashboard** — Visual web interface.',
        '',
        '**File Viewer (Dashboard Tab)** — Browse and edit project files from any device via the Files tab.',
        '- **Browse files**: Files tab in the dashboard shows configured directories',
        '- **Never editable**: `.claude/hooks/`, `.claude/scripts/`, `node_modules/` are always read-only regardless of config.',
        '',
        '### Coherence Gate (Pre-Action Verification)',
        '',
      ].join('\n'));

      const run = () => new PostUpdateMigrator({ projectDir, stateDir: migStateDir, port: 4042, hasTelegram: false, projectName: 'mig' }).migrate();
      const first = run();
      expect(first.errors).toEqual([]);

      const projectIgnore = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
      const stateIgnore = fs.readFileSync(path.join(migStateDir, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
      for (const e of KEY_MATERIAL_GITIGNORE_PROJECT) expect(projectIgnore.filter((l) => l === e).length, `project ${e}`).toBe(1);
      for (const e of KEY_MATERIAL_GITIGNORE_STATE) expect(stateIgnore.filter((l) => l === e).length, `.instar ${e}`).toBe(1);

      const md = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
      expect(md.split('**Never served**').length - 1).toBe(1);
      // Inserted directly after the "Never editable" row, inside the File Viewer section.
      const editableIdx = md.indexOf('- **Never editable**');
      const servedIdx = md.indexOf('- **Never served**');
      const coherenceIdx = md.indexOf('### Coherence Gate');
      expect(servedIdx).toBeGreaterThan(editableIdx);
      expect(servedIdx).toBeLessThan(coherenceIdx);
      expect(first.upgraded).toContain('CLAUDE.md: added File Viewer "Never served" row');

      // Second run: nothing added twice.
      const second = run();
      expect(second.errors).toEqual([]);
      const projectIgnore2 = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
      for (const e of KEY_MATERIAL_GITIGNORE_PROJECT) expect(projectIgnore2.filter((l) => l === e).length, `project ${e} (2nd run)`).toBe(1);
      const md2 = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
      expect(md2.split('**Never served**').length - 1).toBe(1);
      expect(second.upgraded).not.toContain('CLAUDE.md: added File Viewer "Never served" row');
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/files-never-serve-key-material-alive.test.ts' });
    }
  });
});
