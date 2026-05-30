import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/stop-gate-router-hook.test.ts:cleanup',
    });
  }
});

function makeProject(port: number): { dir: string; hookPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-hook-'));
  created.push(dir);
  fs.mkdirSync(path.join(dir, '.instar', 'hooks', 'instar'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.instar', 'config.json'),
    JSON.stringify({ port, authToken: 'test-token' }),
  );
  const migrator = new PostUpdateMigrator({
    projectDir: dir,
    stateDir: path.join(dir, '.instar'),
    port,
    hasTelegram: false,
    projectName: 'hook-test',
  });
  const hookPath = path.join(dir, '.instar', 'hooks', 'instar', 'stop-gate-router.js');
  fs.writeFileSync(hookPath, migrator.getHookContent('stop-gate-router'), { mode: 0o755 });
  return { dir, hookPath };
}

function startServer(mode: 'off' | 'shadow' | 'enforce', decision: string) {
  const calls: Array<{ url: string; body?: any; auth?: string }> = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url ?? '', auth: req.headers.authorization });
    if (req.url?.startsWith('/internal/stop-gate/hot-path')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        mode,
        killSwitch: false,
        compactionInFlight: false,
        sessionStartTs: null,
      }));
      return;
    }
    if (req.url === '/internal/stop-gate/evaluate' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        calls[calls.length - 1].body = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ decision, reminder: 'Continue from the plan.' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise<{ port: number; close: () => Promise<void>; calls: typeof calls }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function runHook(hookPath: string, cwd: string, payload: unknown): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    // Test isolation: the stop-gate-router hook resolves the auth token
    // env-first (INSTAR_AUTH_TOKEN) then config (the secret-externalization
    // resolver). A real agent's env carries INSTAR_AUTH_TOKEN, which would
    // override the fixture's config `authToken: 'test-token'` and make this test
    // fail outside CI. Strip it so the hook deterministically falls back to the
    // configured token regardless of the host environment.
    const { INSTAR_AUTH_TOKEN: _stripped, ...childEnv } = process.env;
    const child = spawn(process.execPath, [hookPath], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('stop-gate-router hook timed out'));
    }, 5000);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('stop-gate-router hook', () => {
  it('submits shadow-mode evaluations but never blocks', async () => {
    const srv = await startServer('shadow', 'continue');
    try {
      const { dir, hookPath } = makeProject(srv.port);
      const proc = await runHook(hookPath, dir, {
        session_id: 'sess-1',
        last_assistant_message: 'I should stop here because the context may compact.',
      });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toBe('');
      expect(
        srv.calls.some((c) => c.url === '/internal/stop-gate/evaluate'),
        JSON.stringify({ calls: srv.calls, stderr: proc.stderr }),
      ).toBe(true);
      const evalCall = srv.calls.find((c) => c.url === '/internal/stop-gate/evaluate')!;
      expect(evalCall.auth).toBe('Bearer test-token');
      expect(evalCall.body.sessionId).toBe('sess-1');
      expect(evalCall.body.evidenceMetadata.signals.mentionsContextLimit).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('blocks only when server mode is enforce and authority says continue', async () => {
    const srv = await startServer('enforce', 'continue');
    try {
      const { dir, hookPath } = makeProject(srv.port);
      const proc = await runHook(hookPath, dir, {
        session_id: 'sess-2',
        last_assistant_message: 'Stopping for a fresh session.',
      });
      expect(proc.status, JSON.stringify({ calls: srv.calls, stderr: proc.stderr, stdout: proc.stdout })).toBe(2);
      expect(JSON.parse(proc.stdout)).toEqual({
        decision: 'block',
        reason: 'Continue from the plan.',
      });
    } finally {
      await srv.close();
    }
  });
});
