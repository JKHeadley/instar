// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * Integration-grade: telegram-topic-context.sh injects topic history when
 * authToken has been externalized into the encrypted store and only
 * INSTAR_AUTH_TOKEN env is present.
 *
 * Regression test for the 2026-05-29 incident: SecretMigrator pairing moved
 * authToken out of plaintext config.json, the hook (which read config.json
 * directly) sent the `{ secret: true }` placeholder as a Bearer token, the
 * server 403'd, and topic history stopped being injected — leaving the
 * agent with no idea what the user had been saying after compaction.
 *
 * The test seeds the broken state on disk (config.json has the placeholder)
 * and asserts the new env-first resolver path still produces the injected
 * output. It exercises the CANONICAL migrator-emitted hook (the one written
 * by PostUpdateMigrator.getTelegramTopicContextHook()).
 *
 * Lives in tests/unit/ rather than tests/integration/ because the only
 * external moving piece is a per-test in-process stub HTTP server.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

describe('telegram-topic-context.sh: secret-externalization survivability', () => {
  let tmpDir: string;
  let stateDir: string;
  let hookPath: string;
  let port: number;
  let server: http.Server;
  let recordedHeaders: string[];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-secext-int-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    recordedHeaders = [];

    // Stub server that mimics the auth-gated /telegram/topics/N/messages route.
    await new Promise<void>(resolve => {
      server = http.createServer((req, res) => {
        recordedHeaders.push(req.headers['authorization'] ?? '');
        if (req.headers['authorization'] === 'Bearer THE_REAL_TOKEN'
          && (req.url ?? '').includes('/telegram/topics/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            messages: [
              { text: 'hello agent', fromUser: true, timestamp: '2026-05-29T15:00:00Z' },
              { text: 'hi user', fromUser: false, timestamp: '2026-05-29T15:01:00Z' },
            ],
          }));
          return;
        }
        // /topic-intent/briefing returns empty for both authed + unauthed
        // (no briefings tracked); the hook tolerates an empty body silently.
        if ((req.url ?? '').includes('/topic-intent/')) {
          res.writeHead(204);
          res.end();
          return;
        }
        // /health gate — without it the hook early-exits before fetching messages.
        if ((req.url ?? '') === '/health') {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid auth token' }));
      });
      // Bind to all interfaces. The hook uses `http://localhost:...` which
      // can resolve to ::1 on Node 25+ which prefers IPv6; a 127.0.0.1-only
      // bind silently refuses those connections and the test hangs until
      // execFileSync's timeout fires.
      server.listen(0, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });

    // Seed config.json in the externalized state — the placeholder is on disk.
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      projectName: 'test-secext',
      projectDir: tmpDir,
      stateDir,
      port,
      authToken: { secret: true },
    }));

    const migrator = new PostUpdateMigrator({
      stateDir,
      projectDir: tmpDir,
      port,
      sessions: { claudePath: 'claude' },
      hasTelegram: false,
    } as any);
    const hookContent = (migrator as any).getHookContent('telegram-topic-context');
    hookPath = path.join(tmpDir, 'telegram-topic-context.sh');
    fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* test cleanup */ } // safe-fs-allow
  });

  // Async exec is REQUIRED — execFileSync blocks Node's event loop, which
  // freezes the in-process stub HTTP server and the hook's curl /health
  // hangs forever. We need the server able to accept connections while the
  // subprocess runs.
  function runHook(env: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
    return new Promise(resolve => {
      const parentEnv = { ...process.env } as Record<string, string>;
      delete parentEnv.INSTAR_AUTH_TOKEN;
      const proc = spawn('bash', [hookPath], {
        env: { ...parentEnv, ...env, CLAUDE_PROJECT_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      proc.stdout.on('data', c => stdoutChunks.push(c));
      proc.stderr.on('data', c => stderrChunks.push(c));
      proc.on('close', () => resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      }));
      proc.stdin.write(JSON.stringify({ prompt: `[telegram:2169] hello?` }));
      proc.stdin.end();
      // Hard timeout backstop.
      setTimeout(() => proc.kill('SIGKILL'), 8000);
    });
  }

  it('injects topic history when INSTAR_AUTH_TOKEN env is set and config has the placeholder', async () => {
    const out = await runHook({ INSTAR_AUTH_TOKEN: 'THE_REAL_TOKEN' });
    expect(out.stdout).toContain('TOPIC 2169 RECENT HISTORY');
    expect(out.stdout).toContain('hello agent');
    expect(out.stdout).toContain('hi user');
    expect(recordedHeaders.some(h => h === 'Bearer THE_REAL_TOKEN')).toBe(true);
    expect(recordedHeaders.some(h => h.includes('secret') || h.includes('object') || h.includes('True'))).toBe(false);
  });

  it('never leaks the { secret: true } placeholder as a Bearer when env missing', async () => {
    const out = await runHook({ PATH: process.env.PATH ?? '' });
    expect(out.stdout).not.toContain('hello agent');
    // CRITICAL: the placeholder MUST NEVER reach the Authorization header.
    expect(recordedHeaders.some(h => h.includes('secret') || h.includes('object') || h.includes('True'))).toBe(false);
  });
});
