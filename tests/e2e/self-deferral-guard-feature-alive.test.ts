/**
 * Tier-3 feature-alive — Turn-End Self-Deferral Guard (Phase A / shadow).
 * Spec: turn-end-self-deferral-guard.md §7 (Tier 3).
 *
 * Runs the REAL generated stop-gate-router.js hook as a subprocess against a
 * fixture transcript, with a stub server in shadow mode. Proves the DEPLOYED
 * artifact is alive: the hook performs the bounded transcript tail-read and
 * flows the parsed user turns into the evaluate route's recentTurns — and
 * blocks NOTHING (exit 0). Models tests/unit/stop-gate-router-hook.test.ts.
 */

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
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/self-deferral-guard-feature-alive.test.ts:cleanup' });
  }
});

function makeProject(port: number): { dir: string; hookPath: string; transcriptPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-deferral-alive-'));
  created.push(dir);
  fs.mkdirSync(path.join(dir, '.instar', 'hooks', 'instar'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ port, authToken: 'test-token' }));
  const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port, hasTelegram: false, projectName: 'sd-alive' });
  const hookPath = path.join(dir, '.instar', 'hooks', 'instar', 'stop-gate-router.js');
  fs.writeFileSync(hookPath, migrator.getHookContent('stop-gate-router'), { mode: 0o755 });

  // A real Claude Code transcript with two user turns + tool_result noise.
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(
    transcriptPath,
    [
      { type: 'user', message: { role: 'user', content: 'build the self-deferral guard shadow' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'user', message: { role: 'user', content: 'now wire the route' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ].map(l => JSON.stringify(l)).join('\n') + '\n',
  );
  return { dir, hookPath, transcriptPath };
}

function startShadowServer(selfDeferralGuardOn = true) {
  const calls: Array<{ url: string; body?: any }> = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url ?? '' });
    if (req.url?.startsWith('/internal/stop-gate/hot-path')) {
      res.setHeader('Content-Type', 'application/json');
      // selfDeferralGuardOn = the dev-gate; when true the hook performs the
      // transcript tail-read for user-turn context, when false it skips it.
      res.end(JSON.stringify({ mode: 'shadow', killSwitch: false, compactionInFlight: false, sessionStartTs: null, selfDeferralGuardOn }));
      return;
    }
    if (req.url === '/internal/stop-gate/evaluate' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        calls[calls.length - 1].body = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ decision: 'allow', rule: 'U_SELF_DEFERRAL', reminder: '' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise<{ port: number; close: () => Promise<void>; calls: typeof calls }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port, calls, close: () => new Promise<void>(done => server.close(() => done())) });
    });
  });
}

function runHook(hookPath: string, cwd: string, payload: unknown): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { INSTAR_AUTH_TOKEN: _stripped, ...childEnv } = process.env;
    const child = spawn(process.execPath, [hookPath], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hook timed out')); }, 5000);
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('self-deferral guard — feature alive (deployed hook flows transcript context, blocks nothing)', () => {
  it('the generated hook reads the transcript and passes user turns to evaluate; exit 0', async () => {
    const srv = await startShadowServer();
    try {
      const { dir, hookPath, transcriptPath } = makeProject(srv.port);
      const proc = await runHook(hookPath, dir, {
        session_id: 'sess-alive',
        transcript_path: transcriptPath,
        last_assistant_message: "I'm stopping the build here — want me to line that up, or steer me elsewhere?",
      });

      // Phase A blocks NOTHING.
      expect(proc.status, JSON.stringify({ stderr: proc.stderr, stdout: proc.stdout })).toBe(0);
      expect(proc.stdout).toBe('');

      const evalCall = srv.calls.find(c => c.url === '/internal/stop-gate/evaluate');
      expect(evalCall, JSON.stringify(srv.calls)).toBeTruthy();
      const recentTurns = evalCall!.body.untrustedContent.recentTurns as Array<{ source: string; text: string }>;
      const userTurns = recentTurns.filter(t => t.source === 'user');
      // The two real user turns are recovered (tool_result-only entry filtered),
      // in chronological order, followed by the agent's final message.
      expect(userTurns.map(t => t.text)).toEqual(['build the self-deferral guard shadow', 'now wire the route']);
      expect(recentTurns[recentTurns.length - 1].source).toBe('agent');
    } finally {
      await srv.close();
    }
  });

  it('guard OFF (dark fleet) — the hook does NOT read the transcript; no user turns sent', async () => {
    const srv = await startShadowServer(false); // selfDeferralGuardOn:false
    try {
      const { dir, hookPath, transcriptPath } = makeProject(srv.port);
      const proc = await runHook(hookPath, dir, {
        session_id: 'sess-off',
        transcript_path: transcriptPath, // present, but must NOT be read
        last_assistant_message: 'stopping here on purpose',
      });
      expect(proc.status).toBe(0);
      const evalCall = srv.calls.find(c => c.url === '/internal/stop-gate/evaluate');
      const recentTurns = evalCall!.body.untrustedContent.recentTurns as Array<{ source: string }>;
      // OFF: only the agent turn (if any) — zero user turns despite a real transcript.
      expect(recentTurns.filter(t => t.source === 'user')).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it('a missing transcript degrades to zero user turns (context-blind), still exit 0', async () => {
    const srv = await startShadowServer();
    try {
      const { dir, hookPath } = makeProject(srv.port);
      const proc = await runHook(hookPath, dir, {
        session_id: 'sess-blind',
        transcript_path: '/no/such/transcript.jsonl',
        last_assistant_message: 'stopping here on purpose',
      });
      expect(proc.status).toBe(0);
      const evalCall = srv.calls.find(c => c.url === '/internal/stop-gate/evaluate');
      const recentTurns = evalCall!.body.untrustedContent.recentTurns as Array<{ source: string }>;
      expect(recentTurns.filter(t => t.source === 'user')).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });
});
