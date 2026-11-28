import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesignPolicyGitRepo } from '../fixtures/designPolicyGitRepo.js';
const owned: ReturnType<typeof createDesignPolicyGitRepo>[] = [];
const fixture = () => { const f = createDesignPolicyGitRepo(); owned.push(f); return f; };
afterEach(async () => { for (const f of owned.splice(0)) await f.cleanup(); });
const cli = path.resolve('dist/cli.js');
async function invoke(root: string, base: string, head: string) {
 return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: os.tmpdir(), NODE_ENV: 'test', NO_COLOR: '1' };
  execFile(process.execPath, [cli, 'design:inspect', '--repo', root, '--base', base, '--head', head],
   { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== 'number') reject(error);
    else resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
   });
 });
}
describe('actual packaged CLI design inspection lifecycle', () => {
 it('runs the real CLI and packaged modules with no server or candidate execution', async () => {
  const f = fixture(); const r = await invoke(f.root, f.base, f.base);
  expect(r.code).toBe(0); const report = JSON.parse(r.stdout);
  expect(report).toMatchObject({ scope: 'manual-design-policy', mergeAuthority: false, status: 'structurally-valid', baseCommit: f.base, headCommit: f.base });
  expect(report.notEvaluated).toContain('merge-enforcement');
 });
 it('returns a finding for a new unregistered page through the actual production entry', async () => {
  const f = fixture(); const head = f.commit({ 'dashboard/new.html': '<html>New screen with invented test data</html>' });
  const r = await invoke(f.root, f.base, head); expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).findings).toContainEqual({ side: 'diff', code: 'screen-unregistered', path: 'dashboard/new.html' });
 });
 it('returns review-required for a real committed earned tolerance change', async () => {
  const f = fixture(); const head = f.commit({ 'docs/DESIGN-STANDARD.md': f.standard.replace('within 1 unit', 'within 10 units') });
  const r = await invoke(f.root, f.base, head); expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout)).toMatchObject({ status: 'review-required', mergeAuthority: false });
 });
 it('reports missing policy or unreadable refs as unavailable and exits two', async () => {
  const f = fixture(); const r = await invoke(f.root, 'not-a-real-ref', f.base); expect(r.code).toBe(2);
  expect(JSON.parse(r.stdout)).toMatchObject({ status: 'unavailable', code: 'git-read-failed', mergeAuthority: false });
 });
});
