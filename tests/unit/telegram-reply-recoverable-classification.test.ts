/**
 * Layer 2b tests — script-side recoverable-class detection in
 * telegram-reply.sh.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § Layer 2b.
 *
 * The classification table — reproduced from the spec — is the script's
 * entire decision matrix. We invoke the deployed template in a tmp
 * project, point it at a one-shot HTTP server that returns a chosen
 * status code, and assert the script either enqueues into the local
 * SQLite queue (recoverable) or does not (terminal).
 *
 * Cases covered:
 *   - 503 (5xx)            → recoverable, enqueued
 *   - 502 (5xx)            → recoverable, enqueued
 *   - 403 agent_id_mismatch (structured) → recoverable, enqueued
 *   - 403 rate_limited (structured)      → recoverable, enqueued
 *   - 403 revoked (structured)           → terminal, NOT enqueued
 *   - 403 unstructured                    → terminal, NOT enqueued (default-deny)
 *   - 400                  → terminal
 *   - 422                  → terminal (tone gate)
 *   - 408                  → terminal-ambiguous (script exits 0, no queue)
 *
 * The script also POSTs /events/delivery-failed to the same port. Our
 * test server responds 200 to that endpoint so we exercise the full
 * round-trip; the queue presence is the assertion target.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const TEMPLATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/templates/scripts/telegram-reply.sh',
);

interface FakeServerHandle {
  port: number;
  close: () => Promise<void>;
  /** Request log — index 0 is the /telegram/reply hit, 1+ are /events/delivery-failed. */
  requests: Array<{ path: string; body: string; status: number }>;
}

function startFakeServer(opts: {
  replyStatus: number;
  replyBody: string;
}): Promise<FakeServerHandle> {
  return new Promise((resolve) => {
    const requests: Array<{ path: string; body: string; status: number }> = [];
    const server = http.createServer((req, res) => {
      let chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (req.url?.startsWith('/telegram/reply')) {
          requests.push({ path: req.url, body, status: opts.replyStatus });
          res.writeHead(opts.replyStatus, { 'Content-Type': 'application/json' });
          res.end(opts.replyBody);
        } else if (req.url === '/events/delivery-failed') {
          requests.push({ path: req.url, body, status: 202 });
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr !== 'object' || !addr) throw new Error('no addr');
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
        requests,
      });
    });
  });
}

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reply-classify-'));
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude', 'scripts'), { recursive: true });
  // Copy the template script into the fake project so the script's
  // CONFIG_PATH-relative resolution works.
  const scriptDest = path.join(projectDir, '.claude', 'scripts', 'telegram-reply.sh');
  fs.copyFileSync(TEMPLATE_PATH, scriptDest);
  fs.chmodSync(scriptDest, 0o755);
});

afterAll(() => {
  // Cleanup happens per-test via the tmp dir prefix; just nudge here.
});

function writeConfig(port: number, agentId = 'echo', token = 'tok-123') {
  fs.writeFileSync(
    path.join(projectDir, '.instar', 'config.json'),
    JSON.stringify({ port, projectName: agentId, authToken: token }),
  );
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the script asynchronously — must NOT block the vitest event loop,
 * because the in-process fake server's request handler is dispatched on
 * the same loop. Synchronous `execFileSync` would deadlock against
 * curl waiting on the server.
 */
function runScript(topicId: number, message: string): Promise<RunResult> {
  const scriptPath = path.join(projectDir, '.claude', 'scripts', 'telegram-reply.sh');
  return new Promise((resolve) => {
    const child = spawn('bash', [scriptPath, String(topicId), message], {
      cwd: projectDir,
      env: { ...process.env, INSTAR_PORT: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: stderr + String(err) });
    });
  });
}

function queueRowCount(): number {
  const dbPath = path.join(projectDir, '.instar', 'state', 'pending-relay.echo.sqlite');
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe('telegram-reply.sh — recoverable-class detection', () => {
  it('5xx → enqueues + exits 1', async () => {
    const fake = await startFakeServer({ replyStatus: 503, replyBody: '{"error":"upstream"}' });
    writeConfig(fake.port);
    const res = await runScript(50, 'hello world');
    await fake.close();
    expect(res.exitCode).toBe(1);
    expect(queueRowCount()).toBe(1);
    // /events/delivery-failed POST should also have hit the fake server.
    const eventReqs = fake.requests.filter((r) => r.path === '/events/delivery-failed');
    expect(eventReqs.length).toBe(1);
    const parsed = JSON.parse(eventReqs[0].body);
    expect(parsed.http_code).toBe(503);
    expect(parsed.attempted_port).toBe(fake.port);
  });

  it('502 → enqueues', async () => {
    const fake = await startFakeServer({ replyStatus: 502, replyBody: '{}' });
    writeConfig(fake.port);
    const res = await runScript(7, 'hi');
    await fake.close();
    expect(res.exitCode).toBe(1);
    expect(queueRowCount()).toBe(1);
  });

  it('403 with structured agent_id_mismatch → enqueues', async () => {
    const fake = await startFakeServer({
      replyStatus: 403,
      replyBody: JSON.stringify({ error: 'agent_id_mismatch', expected: 'cheryl' }),
    });
    writeConfig(fake.port);
    const res = await runScript(50, 'hi');
    await fake.close();
    expect(res.exitCode).toBe(1);
    expect(queueRowCount()).toBe(1);
  });

  it('403 with structured rate_limited → enqueues', async () => {
    const fake = await startFakeServer({
      replyStatus: 403,
      replyBody: JSON.stringify({ error: 'rate_limited', retryAfterMs: 1000 }),
    });
    writeConfig(fake.port);
    const res = await runScript(50, 'hi');
    await fake.close();
    expect(res.exitCode).toBe(1);
    expect(queueRowCount()).toBe(1);
  });

  it('403 with structured revoked → terminal, NOT enqueued', async () => {
    const fake = await startFakeServer({
      replyStatus: 403,
      replyBody: JSON.stringify({ error: 'revoked' }),
    });
    writeConfig(fake.port);
    const res = await runScript(50, 'hi');
    await fake.close();
    expect(res.exitCode).toBe(1);
    expect(queueRowCount()).toBe(0);
  });

  it('403 unstructured → terminal (default-deny)', async () => {
    const fake = await startFakeServer({
      replyStatus: 403,
      replyBody: 'forbidden',
    });
    writeConfig(fake.port);
    const res = await runScript(50, 'hi');
    await fake.close();
    expect(res.exitCode).toBe(1);
    expect(queueRowCount()).toBe(0);
  });

  it('400 → terminal, NOT enqueued', async () => {
    const fake = await startFakeServer({ replyStatus: 400, replyBody: '{"error":"bad"}' });
    writeConfig(fake.port);
    const res = await runScript(50, 'hi');
    await fake.close();
    expect(res.exitCode).toBe(1);
    expect(queueRowCount()).toBe(0);
  });

  it('422 → terminal (tone gate), NOT enqueued', async () => {
    const fake = await startFakeServer({
      replyStatus: 422,
      replyBody: JSON.stringify({ issue: 'cli-content' }),
    });
    writeConfig(fake.port);
    const res = await runScript(50, 'hi');
    await fake.close();
    expect(res.exitCode).toBe(1);
    expect(queueRowCount()).toBe(0);
  });

  it('408 → ambiguous, exits 0, NOT enqueued', async () => {
    const fake = await startFakeServer({ replyStatus: 408, replyBody: '{}' });
    writeConfig(fake.port);
    const res = await runScript(50, 'hi');
    await fake.close();
    expect(res.exitCode).toBe(0);
    expect(queueRowCount()).toBe(0);
  });
});

describe('telegram-reply.sh — dedup window', () => {
  it('a second 5xx with same (topic, text) within 5s does not insert a duplicate row', async () => {
    const fake = await startFakeServer({ replyStatus: 503, replyBody: '{}' });
    writeConfig(fake.port);
    await runScript(50, 'same payload');
    await runScript(50, 'same payload');
    await fake.close();
    expect(queueRowCount()).toBe(1);
  });
});
