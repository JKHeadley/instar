/**
 * SEC-178: the file editor never saves into `.instar/backups/`. A restore copies a snapshot's files back over
 * the live ones, fenced ones included, so an editable snapshot copy of `.instar/jobs.json` reached the fenced
 * jobs list at the next restore. Driven through the real save route and the real BackupManager.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createFileRoutes, isNeverEditable } from '../../src/server/fileRoutes.js';
import { BackupManager } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir = '';
let stateDir = '';
let app: express.Express;

const save = (p: string, content: string) =>
  request(app).post('/api/files/save').set('x-instar-request', '1').send({ path: p, content });

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec178-'));
  stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'jobs.json'), '{"jobs":[]}', { mode: 0o644 });
  app = express();
  app.use(express.json());
  app.use(createFileRoutes({ config: { projectDir, stateDir, projectName: 't', port: 0 } as never }));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/sec178-file-editor-backups-fence.test.ts' });
});

describe('SEC-178: backup snapshots are never saved through the editor', () => {
  it('an edited snapshot copy can no longer reach the fenced jobs list through a restore', async () => {
    const backups = new BackupManager(stateDir, undefined, () => false);
    const snap = backups.createSnapshot('manual');
    const rel = `.instar/backups/${snap.id}/jobs.json`;
    const copy = path.join(projectDir, rel);
    expect(fs.readFileSync(copy, 'utf8')).toBe('{"jobs":[]}');

    expect((await save('.instar/jobs.json', '{"jobs":["attacker"]}')).status).toBe(403);
    const res = await save(rel, '{"jobs":["attacker"]}');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('never editable');
    expect(fs.readFileSync(copy, 'utf8')).toBe('{"jobs":[]}');

    backups.restoreSnapshot(snap.id);
    expect(fs.readFileSync(path.join(stateDir, 'jobs.json'), 'utf8')).toBe('{"jobs":[]}');
  });

  it('refuses any file in a snapshot, such as a skill script copy, in any case', async () => {
    for (const p of ['.instar/backups/x/skills/a/scripts/run.mjs', '.instar/backups/x/users.json', '.INSTAR/Backups/x/jobs.json']) {
      expect(isNeverEditable(p), p).toBe(true);
    }
    const abs = path.join(projectDir, '.instar/backups/x/skills/a/scripts/run.mjs');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'original', { mode: 0o644 });
    const res = await save('.instar/backups/x/skills/a/scripts/run.mjs', 'changed');
    expect(res.status).toBe(403);
    expect(fs.readFileSync(abs, 'utf8')).toBe('original');
  });

  it('a snapshot stays viewable, shown as not editable', async () => {
    const snap = new BackupManager(stateDir, undefined, () => false).createSnapshot('manual');
    const read = await request(app).get('/api/files/read').query({ path: `.instar/backups/${snap.id}/jobs.json` });
    expect(read.status).toBe(200);
    expect(read.body.editable).toBe(false);
  });

  it('CONTROL: similar names elsewhere stay editable', () => {
    for (const p of ['docs/backups/notes.md', '.instar/backups-notes.md', 'backups.md']) {
      expect(isNeverEditable(p), p).toBe(false);
    }
  });
});
