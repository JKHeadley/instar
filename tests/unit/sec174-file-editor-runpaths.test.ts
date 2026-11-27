/**
 * SEC-174: the file editor never saves files a program runs without an execute bit: anything in a development
 * checkout under `.worktrees/`, the boot wrapper in every extension, and `package.json` / `.npmrc` at any depth.
 * Driven through the real save route; files are written without an execute bit so the SEC-173 check is not
 * what refuses them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createFileRoutes, isNeverEditable, hasNeverEditableName } from '../../src/server/fileRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir = '';
let app: express.Express;

const put = (rel: string, body: string) => {
  const abs = path.join(projectDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, { mode: 0o644 });
  return abs;
};
const save = (p: string, content: string) =>
  request(app).post('/api/files/save').set('x-instar-request', '1').send({ path: p, content });

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec174-'));
  app = express();
  app.use(express.json());
  app.use(createFileRoutes({ config: { projectDir, stateDir: path.join(projectDir, '.instar'), projectName: 't', port: 0 } as never }));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/sec174-file-editor-runpaths.test.ts' });
});

describe('SEC-174: run paths without an execute bit are never saved', () => {
  for (const rel of [
    '.worktrees/feature-x/scripts/lint.mjs',
    '.worktrees/feature-x/src/index.ts',
    '.instar/instar-boot.cjs',
    '.instar/instar-boot.sh',
    'package.json',
    'tools/app/package.json',
    '.npmrc',
    'tools/app/.npmrc',
  ]) {
    it(`refuses ${rel} and leaves it unchanged`, async () => {
      const abs = put(rel, 'original');
      const res = await save(rel, 'changed');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('never editable');
      expect(fs.readFileSync(abs, 'utf8')).toBe('original');
    });
  }

  it('the name match holds in any case and with Windows separators', () => {
    for (const p of ['PACKAGE.JSON', 'Tools\\App\\Package.json', '.NPMRC', '.Worktrees/X/a.js', '.instar/INSTAR-BOOT.CJS']) {
      expect(isNeverEditable(p), p).toBe(true);
    }
  });

  it('CONTROL: names that only resemble a fenced one stay editable', async () => {
    for (const p of ['package-lock.json', 'my-package.json', 'docs/package.json.md', '.npmrc.example', 'worktrees/notes.md', '.instar/instar-boot-notes.md']) {
      expect(isNeverEditable(p), p).toBe(false);
    }
    expect(hasNeverEditableName('docs/package.json/readme.md')).toBe(false);
    const abs = put('docs/notes.md', 'old');
    const res = await save('docs/notes.md', 'new');
    expect(res.status).toBe(200);
    expect(fs.readFileSync(abs, 'utf8')).toBe('new');
  });

  it('a link under another name that resolves onto a fenced file is refused too', async () => {
    if (process.platform === 'win32') return;
    const manifest = put('tools/app/package.json', 'original');
    const script = put('.worktrees/feature-x/scripts/lint.mjs', 'original');
    fs.symlinkSync(manifest, path.join(projectDir, 'notes-a.md'));
    fs.symlinkSync(script, path.join(projectDir, 'notes-b.md'));
    expect((await save('notes-a.md', 'changed')).status).toBe(403);
    expect((await save('notes-b.md', 'changed')).status).toBe(403);
    expect(fs.readFileSync(manifest, 'utf8')).toBe('original');
    expect(fs.readFileSync(script, 'utf8')).toBe('original');
  });

  it('the read route shows a fenced file as not editable', async () => {
    put('package.json', '{}');
    const read = await request(app).get('/api/files/read').query({ path: 'package.json' });
    expect(read.status).toBe(200);
    expect(read.body.editable).toBe(false);
  });
});
