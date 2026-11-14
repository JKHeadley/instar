// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { realDiagnosisSeams } from '../../../src/localVerify/diagnosisSeams.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, {
  recursive: true, force: true, operation: 'diagnosisProcessGroup.test.ts' }); });

describe('real detached diagnosis process group', () => {
  it.skipIf(spawnSync('tmux', ['-V']).status !== 0)('keeps a real tmux socket short with a production-length agent path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-diagnosis-group-'));
    roots.push(root);
    const attemptId = crypto.randomBytes(16).toString('hex');
    const attemptRoot = path.join(root, 'a-very-long-agent-home-path-like-the-production-echo-agent', '.worktrees', '.verify', 'diagnosis', attemptId);
    fs.mkdirSync(attemptRoot, { recursive: true });
    roots.push(path.join('/tmp', `lv-${attemptId}`));
    const seams = realDiagnosisSeams(() => {}, root, attemptRoot, new AbortController().signal);
    const tmuxDir = seams.fs.mkdtemp('lv-diagnosis-tmux-');
    const env = { ...process.env, TMUX_TMPDIR: tmuxDir };
    const socket = `diagnosis-proof-${attemptId.slice(0, 8)}`;
    const started = spawnSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'proof', 'true'], { env, encoding: 'utf8' });
    spawnSync('tmux', ['-L', socket, 'kill-server'], { env });
    expect(started.status, started.stderr).toBe(0);
    await expect(seams.fs.removeTree(tmuxDir)).resolves.toBeUndefined();
  });

  it('recognizes an exited command as quiescent despite its own ps probe', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-diagnosis-group-'));
    roots.push(root);
    const attemptId = crypto.randomBytes(16).toString('hex');
    const attemptRoot = path.join(root, attemptId);
    fs.mkdirSync(attemptRoot);
    roots.push(path.join('/tmp', `lv-${attemptId}`));
    const entry = path.resolve(__dirname, '../../../dist/localVerify/diagnosisSeams.js');
    expect(fs.existsSync(entry)).toBe(true);
    const script = path.join(root, 'probe.mjs');
    fs.writeFileSync(script, `import { realDiagnosisSeams } from ${JSON.stringify(pathToFileURL(entry).href)};\n`
      + `const s = realDiagnosisSeams(() => {}, ${JSON.stringify(root)}, ${JSON.stringify(attemptRoot)}, new AbortController().signal);\n`
      + `const r = await s.exec(process.execPath, ['-e', 'process.exit(0)'], { cwd: ${JSON.stringify(root)}, env: process.env, deadlineMs: 5000, isolatedGroup: true });\n`
      + `process.stdout.write(JSON.stringify({ status: r.status, quiescent: r.quiescent, aborted: r.aborted ?? false }));\n`);
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += String(d); });
      child.stderr.on('data', (d) => { stderr += String(d); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    expect(output).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(output.stdout)).toEqual({ status: 0, quiescent: true, aborted: false });
  }, 15_000);
});
