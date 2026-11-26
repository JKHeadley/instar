/**
 * SEC-173: the file editor's never-editable list now covers the repository's git folder (and
 * `.gitmodules`), and the editor never saves a file with an execute bit. Driven through the real
 * save and read routes and a real `git` run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createFileRoutes, isNeverEditable, isExecutableFile } from '../../src/server/fileRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

let projectDir = '';
let app: express.Express;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec173-'));
  SafeGitExecutor.execSync(['init', '-q'], { cwd: projectDir, stdio: 'ignore', operation: 'tests/unit/sec173-file-editor-git-fence.test.ts:init' });
  app = express();
  app.use(express.json());
  app.use(createFileRoutes({ config: { projectDir, stateDir: path.join(projectDir, '.instar'), projectName: 't', port: 0 } as never }));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/sec173-file-editor-git-fence.test.ts' });
});

const save = (p: string, content: string) =>
  request(app).post('/api/files/save').set('x-instar-request', '1').send({ path: p, content });

describe('SEC-173: the git folder is never editable', () => {
  it('a save to .git/config is refused, the file is unchanged, and git runs nothing', async () => {
    const configPath = path.join(projectDir, '.git/config');
    const before = fs.readFileSync(configPath, 'utf8');
    const marker = path.join(projectDir, 'MARKER');
    const res = await save('.git/config', `${before}[core]\n\tfsmonitor = "touch ${marker}; false"\n`);
    expect(res.status).toBe(403);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    try { SafeGitExecutor.execSync(['status', '--short'], { cwd: projectDir, stdio: 'ignore', operation: 'tests/unit/sec173-file-editor-git-fence.test.ts:status' }); } catch { /* exit status is not the point */ }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('covers any case, a worktree pointer file, a nested copy and .gitmodules', () => {
    for (const p of ['.git/config', '.GIT/Config', '.git', '.git/hooks/pre-commit', '.worktrees/a/.git', '.worktrees/a/.git/config', '.gitmodules', 'sub/.gitmodules']) {
      expect(isNeverEditable(p), p).toBe(true);
    }
  });

  it('CONTROL: names that only start with .git stay editable', () => {
    for (const p of ['.github/workflows/ci.yml', '.gitignore', '.gitattributes', 'docs/.git-notes.md']) {
      expect(isNeverEditable(p), p).toBe(false);
    }
  });
});

describe('SEC-173: a file with an execute bit is never saved', () => {
  it('refuses the save, leaves the script as it was, and the reader shows it as not editable', async () => {
    const script = path.join(projectDir, 'helper.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho ok\n');
    fs.chmodSync(script, 0o755);
    const res = await save('helper.sh', '#!/bin/sh\necho changed\n');
    if (process.platform === 'win32') return;
    expect(res.status).toBe(403);
    expect(fs.readFileSync(script, 'utf8')).toBe('#!/bin/sh\necho ok\n');
    const read = await request(app).get('/api/files/read').query({ path: 'helper.sh' });
    expect(read.status).toBe(200);
    expect(read.body.editable).toBe(false);
  });

  it('a symlink to a script is refused too', async () => {
    if (process.platform === 'win32') return;
    const script = path.join(projectDir, 'tool.sh');
    fs.writeFileSync(script, '#!/bin/sh\n');
    fs.chmodSync(script, 0o700);
    fs.symlinkSync(script, path.join(projectDir, 'notes.md'));
    const res = await save('notes.md', 'text');
    expect(res.status).toBe(403);
    expect(fs.readFileSync(script, 'utf8')).toBe('#!/bin/sh\n');
  });

  it('CONTROL: an ordinary file still saves and reads as editable', async () => {
    fs.writeFileSync(path.join(projectDir, 'notes.md'), 'old');
    const res = await save('notes.md', 'new');
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(projectDir, 'notes.md'), 'utf8')).toBe('new');
    const read = await request(app).get('/api/files/read').query({ path: 'notes.md' });
    expect(read.body.editable).toBe(true);
  });

  it('the execute-bit check applies only where a mode carries one', () => {
    expect(isExecutableFile(0o100755, 'darwin')).toBe(true);
    expect(isExecutableFile(0o100744, 'linux')).toBe(true);
    expect(isExecutableFile(0o100644, 'darwin')).toBe(false);
    expect(isExecutableFile(0o100755, 'win32')).toBe(false);
  });
});
