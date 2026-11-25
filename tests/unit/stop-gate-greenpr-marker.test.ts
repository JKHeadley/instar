/**
 * SEC-131: the stop-gate router's one-shot green-PR block keeps its marker in the agent's own
 * state dir, created exclusively, never in the shared temp dir. Renders the REAL hook via
 * PostUpdateMigrator.getHookContent and runs it as a subprocess against a tiny local server
 * that answers the hot-path read with a greenPrBlock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function renderHook(port: number): string {
  const m = new PostUpdateMigrator({ projectDir: '/tmp/sec131-render', stateDir: '/tmp/sec131-render/.instar', hasTelegram: false, port });
  return m.getHookContent('stop-gate-router');
}

function runHook(hookPath: string, projectDir: string, input: object): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [hookPath], { env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, INSTAR_AUTH_TOKEN: 'test' } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    const t = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout }); });
    child.stdin.end(JSON.stringify(input));
  });
}

describe('SEC-131: stop-gate green-PR marker', () => {
  let tmp: string; let projectDir: string; let hookPath: string; let server: http.Server; const sessionId = `sec131-${process.pid}-${Date.now()}`;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec131-'));
    projectDir = path.join(tmp, 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if ((req.url || '').startsWith('/internal/stop-gate/hot-path')) {
        res.end(JSON.stringify({ mode: 'off', killSwitch: false, compactionInFlight: false, greenPrBlock: { pr: 4242, message: 'PR 4242 is green' } }));
      } else res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify({ port, authToken: 'test' }));
    hookPath = path.join(tmp, 'stop-gate-router.js');
    fs.writeFileSync(hookPath, renderHook(port), { mode: 0o755 });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/stop-gate-greenpr-marker.test.ts' });
  });

  it('blocks once, keeps the marker under .instar/state (0600), never in the shared temp dir, then lets the stop through', async () => {
    const input = { session_id: sessionId, last_assistant_message: 'All done.' };
    const first = await runHook(hookPath, projectDir, input);
    expect(first.code).toBe(2);
    expect(first.stdout).toContain('STOP-GATE (green-pr)');
    const markerDir = path.join(projectDir, '.instar', 'state', 'stop-gate-markers');
    const files = fs.readdirSync(markerDir);
    expect(files).toEqual([`greenpr-block-${encodeURIComponent(sessionId)}-4242`]);
    expect(fs.statSync(path.join(markerDir, files[0])).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(os.tmpdir()).some((f) => f.startsWith(`instar-greenpr-block-${encodeURIComponent(sessionId)}`))).toBe(false);

    const second = await runHook(hookPath, projectDir, input);
    expect(second.stdout).not.toContain('STOP-GATE (green-pr)');
  });

  it('a pre-existing link at the marker name is never written through and counts as already fired', async () => {
    const markerDir = path.join(projectDir, '.instar', 'state', 'stop-gate-markers');
    fs.mkdirSync(markerDir, { recursive: true });
    const victim = path.join(tmp, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    fs.symlinkSync(victim, path.join(markerDir, `greenpr-block-${encodeURIComponent(sessionId)}-4242`));
    const r = await runHook(hookPath, projectDir, { session_id: sessionId, last_assistant_message: 'All done.' });
    expect(r.stdout).not.toContain('STOP-GATE (green-pr)');
    expect(fs.readFileSync(victim, 'utf-8')).toBe('original');
  });

  it('a dangling link at the marker name is not followed to create a file', async () => {
    const markerDir = path.join(projectDir, '.instar', 'state', 'stop-gate-markers');
    fs.mkdirSync(markerDir, { recursive: true });
    const target = path.join(tmp, 'would-be-created.txt');
    fs.symlinkSync(target, path.join(markerDir, `greenpr-block-${encodeURIComponent(sessionId)}-4242`));
    const r = await runHook(hookPath, projectDir, { session_id: sessionId, last_assistant_message: 'All done.' });
    expect(r.stdout).not.toContain('STOP-GATE (green-pr)');
    expect(fs.existsSync(target)).toBe(false);
  });
});
