/**
 * Tests for the messaging reply scripts that ship with every instar agent:
 *   src/templates/scripts/telegram-reply.sh
 *   src/templates/scripts/slack-reply.sh
 *   src/templates/scripts/whatsapp-reply.sh
 *
 * These scripts are the agent's transport to the outbound messaging routes.
 * Their HTTP-code handling defines what the agent "sees" and drives whether
 * it retries. Getting it wrong causes the duplicate-send cascade:
 *   server times out at 30s (408) while tone gate + Telegram API complete
 *   → agent sees non-zero exit + "Failed" message → agent regenerates and retries
 *   → message ships twice.
 *
 * The rule: HTTP 408 on an outbound messaging route means "ambiguous" — the
 * send may have completed server-side. The script must NOT report this as a
 * hard failure (exit 1) or the agent will retry blindly. Instead it exits 0
 * with a loud stderr warning instructing the agent to verify before retrying.
 *
 * HTTP 422 (tone gate block) remains a hard client error — the message truly
 * was not sent. HTTP 5xx and connection failures likewise remain hard errors.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT_DIR = path.join(process.cwd(), 'src/templates/scripts');

interface MockServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
  setResponse: (status: number, body: unknown) => void;
  requestCount: () => number;
  lastRequest: () => { url?: string; body?: Record<string, unknown> };
}

async function startMockServer(): Promise<MockServer> {
  let currentStatus = 200;
  let currentBody: unknown = { ok: true };
  let requests = 0;
  let lastUrl: string | undefined;
  let lastBody: Record<string, unknown> | undefined;

  const server = createServer((req, res) => {
    requests += 1;
    lastUrl = req.url;
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { lastBody = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch { lastBody = undefined; }
      res.statusCode = currentStatus;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(currentBody));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Unexpected server address shape');
  const port = addr.port;

  return {
    server,
    port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    setResponse(status: number, body: unknown) {
      currentStatus = status;
      currentBody = body;
    },
    requestCount() {
      return requests;
    },
    lastRequest() {
      return { url: lastUrl, body: lastBody };
    },
  };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Async spawn so the mock server on the same event loop can respond.
// spawnSync would block the loop and cause the in-process server to hang.
async function runScript(script: string, args: string[], port: number, stdin?: string): Promise<RunResult> {
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-script-test-'));
  try {
    return await new Promise<RunResult>((resolve, reject) => {
      const proc = spawn('bash', [path.join(SCRIPT_DIR, script), ...args], {
        cwd: tmpCwd,
        env: { ...process.env, INSTAR_PORT: String(port), INSTAR_AUTH_TOKEN: '', PATH: process.env.PATH }, // hermetic vs live-session env
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', status => resolve({ status, stdout, stderr }));

      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Script ${script} hung for >10s`));
      }, 10_000);
      proc.on('close', () => clearTimeout(killTimer));

      if (stdin !== undefined) {
        proc.stdin.write(stdin);
      }
      proc.stdin.end();
    });
  } finally {
    SafeFsExecutor.safeRmSync(tmpCwd, { recursive: true, force: true, operation: 'tests/unit/reply-scripts.test.ts:116' });
  }
}

describe('reply scripts — HTTP 408 handling (ambiguous-outcome)', () => {
  let mock: MockServer;

  beforeAll(async () => { mock = await startMockServer(); });
  afterAll(async () => { await mock.close(); });

  for (const script of ['telegram-reply.sh', 'slack-reply.sh', 'whatsapp-reply.sh']) {
    describe(script, () => {
      it('classifies 408 as ambiguous and never invites blind retry', async () => {
        mock.setResponse(408, { error: 'Request timeout', timeoutMs: 30000 });
        const target = script.startsWith('whatsapp') ? '12345@s.whatsapp.net' : '42';
        const result = await runScript(script, [target], mock.port, 'hello from test\n');

        expect(result.status).toBe(script === 'slack-reply.sh' ? 1 : 0);
        // stderr must loudly warn — the agent reads this to decide whether to retry.
        expect(result.stderr.toLowerCase()).toMatch(/ambiguous|timeout|do not retry|verify/);
      });

      it('emits stdout marker distinct from the success "Sent X chars" message', async () => {
        mock.setResponse(408, { error: 'Request timeout', timeoutMs: 30000 });
        const target = script.startsWith('whatsapp') ? '12345@s.whatsapp.net' : '42';
        const result = await runScript(script, [target], mock.port, 'hello from test\n');

        // The success path prints "Sent N chars …". The 408 path must NOT
        // print that — otherwise a shell pipeline that greps for "Sent" would
        // misclassify the ambiguous outcome as success.
        expect(result.stdout.toLowerCase()).not.toMatch(/^sent \d+ chars/m);
        // It must still produce *some* stdout marker so the agent's tool-use
        // path doesn't see "empty output" and retry.
        expect(result.stdout.length).toBeGreaterThan(0);
      });
    });
  }
});

describe('reply scripts — existing contract preserved (200, 422, 5xx)', () => {
  let mock: MockServer;

  beforeAll(async () => { mock = await startMockServer(); });
  afterAll(async () => { await mock.close(); });

  for (const script of ['telegram-reply.sh', 'slack-reply.sh', 'whatsapp-reply.sh']) {
    describe(script, () => {
      it('exits 0 and prints "Sent" on HTTP 200', async () => {
        mock.setResponse(200, { ok: true });
        const target = script.startsWith('whatsapp') ? '12345@s.whatsapp.net' : '42';
        const result = await runScript(script, [target], mock.port, 'hello from test\n');

        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Sent \d+ chars/);
      });

      it('exits 1 on HTTP 422 with BLOCKED stderr (tone gate still blocks hard)', async () => {
        mock.setResponse(422, {
          error: 'tone-gate-blocked',
          rule: 'B2_FILE_PATH',
          issue: "Literal file paths: 'server.ts'",
          suggestion: 'Describe the location conceptually.',
        });
        const target = script.startsWith('whatsapp') ? '12345@s.whatsapp.net' : '42';
        const result = await runScript(script, [target], mock.port, 'hello from test\n');

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/BLOCKED/);
      });

      it('exits 1 on HTTP 500 (genuine server failure remains a hard failure)', async () => {
        mock.setResponse(500, { error: 'boom' });
        const target = script.startsWith('whatsapp') ? '12345@s.whatsapp.net' : '42';
        const result = await runScript(script, [target], mock.port, 'hello from test\n');

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/HTTP 500|Failed/);
      });
    });
  }
});

describe('slack-reply.sh — thread_ts 2nd-positional argument (threads-as-sessions §5.3)', () => {
  let mock: MockServer;
  beforeAll(async () => { mock = await startMockServer(); });
  afterAll(async () => { await mock.close(); });

  it('posts to the channel route and includes thread_ts when a thread id is passed', async () => {
    mock.setResponse(200, { ok: true });
    const result = await runScript('slack-reply.sh', ['C123', '1700000000.000100'], mock.port, 'reply in thread\n');
    expect(result.status).toBe(0);
    const req = mock.lastRequest();
    expect(req.url).toBe('/slack/reply/C123');
    expect(req.body?.text).toContain('reply in thread');
    expect(req.body?.thread_ts).toBe('1700000000.000100');
  });

  it('omits thread_ts for a channel-level reply (no 2nd positional) — today\'s default unchanged', async () => {
    mock.setResponse(200, { ok: true });
    const result = await runScript('slack-reply.sh', ['C123'], mock.port, 'channel reply\n');
    expect(result.status).toBe(0);
    const req = mock.lastRequest();
    expect(req.url).toBe('/slack/reply/C123');
    expect(req.body?.text).toContain('channel reply');
    expect(req.body?.thread_ts).toBeUndefined();
  });

  it('a plain message word as the 2nd arg is NOT mistaken for a thread id (backward-compat)', async () => {
    // The old 1-arg form `slack-reply.sh CHANNEL "two words"` must still treat
    // everything after the channel as the message — a word like "hello" is not a
    // Slack timestamp, so it stays part of the text, never thread_ts.
    mock.setResponse(200, { ok: true });
    const result = await runScript('slack-reply.sh', ['C123', 'hello', 'there'], mock.port);
    expect(result.status).toBe(0);
    const req = mock.lastRequest();
    expect(String(req.body?.text).trim()).toBe('hello there');
    expect(req.body?.thread_ts).toBeUndefined();
  });
});
