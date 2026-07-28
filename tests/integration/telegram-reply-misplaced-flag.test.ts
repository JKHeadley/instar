/**
 * Integration test — a flag placed AFTER the topic id was silently sent to the
 * user as message text.
 *
 * `telegram-reply.sh` parses flags in a loop that BREAKS at the first non-flag
 * argument — the topic id. Everything after that becomes the message via
 * `MSG="$*"`. So `telegram-reply.sh 29723 --tone-ack B15 --tone-reason "why"`
 * did two wrong things at once, both silently:
 *
 *   1. It sent the literal text `--tone-ack B15 --tone-reason why` to the user.
 *   2. The tone-advisory override never reached the server, so the gate
 *      re-reviewed the send as an ordinary message.
 *
 * That is not hypothetical. It happened on 2026-07-26: the flags were swallowed,
 * the resulting verdict was misread as absurd, and a CORRECT tone-gate check was
 * graded `wrong` in the decision-quality data. The grading record is durable.
 * The cause was argument order.
 *
 * The asymmetry was the defect: a flag-shaped token BEFORE the topic id is fatal
 * ("Unknown flag"), while after it the script was maximally permissive. The fix
 * refuses `--*` in both positions — which also catches a TYPO'd flag, the
 * realistic case, equally silent before.
 *
 * These tests run the REAL template against a stub of `/telegram/reply/:topicId`
 * that records exactly what arrived, so "was it sent as text?" is answered by
 * the received payload rather than by reading the script.
 *
 * The first test runs the PRE-FIX template (captured verbatim as a fixture at
 * the SHA recorded in PostUpdateMigrator's shipped-SHA allowlist) so the defect
 * is demonstrated, not just asserted-against.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXED_TEMPLATE = path.resolve(HERE, '../../src/templates/scripts/telegram-reply.sh');
const PRE_FIX_TEMPLATE = path.resolve(
  HERE,
  '../fixtures/telegram-reply-pre-flag-position-guard.sh',
);

interface Hit {
  topicId: string;
  text: string;
  metadata: Record<string, unknown> | undefined;
}

let projectDir: string;
let server: http.Server;
let port: number;
let hits: Hit[];

function scriptPath(which: 'fixed' | 'pre-fix'): string {
  return path.join(projectDir, `${which}.sh`);
}

async function run(
  which: 'fixed' | 'pre-fix',
  args: string[],
  stdin?: string,
): Promise<{ exit: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [scriptPath(which), ...args], {
      cwd: projectDir,
      env: {
        ...process.env,
        INSTAR_PORT: String(port),
        INSTAR_AUTH_TOKEN: 'test-token',
        INSTAR_AGENT_HOME: projectDir,
      },
    });
    // The script reads the message from stdin when no message argument is given
    // (`MSG="$(cat)"`), so stdin must always be closed or the child hangs.
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();

    let stderr = '';
    child.stdout.on('data', () => {
      /* swallow */
    });
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    child.on('close', (code) => resolve({ exit: code ?? 1, stderr }));
    child.on('error', (err) => resolve({ exit: 1, stderr: String(err) }));
  });
}

beforeAll(async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-flag-pos-'));
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  for (const [which, src] of [
    ['fixed', FIXED_TEMPLATE],
    ['pre-fix', PRE_FIX_TEMPLATE],
  ] as const) {
    fs.copyFileSync(src, scriptPath(which));
    fs.chmodSync(scriptPath(which), 0o755);
  }

  hits = [];
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.post('/telegram/reply/:topicId', (req, res) => {
    const body = req.body as { text?: string; metadata?: Record<string, unknown> };
    hits.push({
      topicId: String(req.params.topicId),
      text: String(body?.text ?? ''),
      metadata: body?.metadata,
    });
    res.status(200).type('application/json').send('{"ok":true}');
  });
  // Any other endpoint the script may probe (delivery-failed, advisory) — accept.
  app.use((_req, res) => res.status(200).type('application/json').send('{"ok":true}'));

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr !== 'object' || !addr) throw new Error('no addr');
      port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/telegram-reply-misplaced-flag.test.ts:cleanup',
    });
  } catch {
    /* @silent-fallback-ok: best-effort tmpdir cleanup */
  }
});

describe('telegram-reply.sh — a flag after the topic id', () => {
  it('PRE-FIX (the defect, demonstrated): the flag was SENT to the user as message text, and the override never applied', async () => {
    hits.length = 0;
    const res = await run('pre-fix', ['4242', '--tone-ack', 'B15', '--tone-reason', 'because']);

    // It "succeeded" — which is the whole problem.
    expect(res.exit).toBe(0);
    expect(hits).toHaveLength(1);

    // 1. The flags became the visible message body.
    expect(hits[0].text).toContain('--tone-ack');
    expect(hits[0].text).toContain('--tone-reason');

    // 2. And the override they were meant to carry never reached the server.
    expect(hits[0].metadata?.toneAdvisoryAck).toBeUndefined();
  });

  it('FIXED: the same invocation is refused, and NOTHING is sent', async () => {
    hits.length = 0;
    const res = await run('fixed', ['4242', '--tone-ack', 'B15', '--tone-reason', 'because']);

    expect(res.exit).toBe(1);
    expect(hits).toHaveLength(0); // the load-bearing assertion: no message reached the user
    expect(res.stderr).toContain('--tone-ack');
    expect(res.stderr).toContain('AFTER the topic id');
    // The refusal must be actionable, not just a rejection.
    expect(res.stderr).toContain('Correct:');
  });

  it('FIXED: a TYPO’d flag after the topic id is refused too (it was equally silent before)', async () => {
    hits.length = 0;
    const res = await run('fixed', ['4242', '--tone-akc', 'B15']);

    expect(res.exit).toBe(1);
    expect(hits).toHaveLength(0);
    expect(res.stderr).toContain('--tone-akc');
  });

  it('FIXED: correctly-ordered flags still work — message clean, override applied', async () => {
    hits.length = 0;
    const res = await run('fixed', [
      '--tone-ack',
      'B15',
      '--tone-reason',
      'because',
      '4242',
      'the actual message',
    ]);

    expect(res.exit).toBe(0);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('the actual message');
    expect(hits[0].text).not.toContain('--tone-ack');
    expect(hits[0].metadata?.toneAdvisoryAck).toBe('B15');
    expect(hits[0].metadata?.toneAdvisoryAckReason).toBe('because');
  });

  it('FIXED: stdin is the escape hatch — text containing a flag-shaped token sends verbatim', async () => {
    hits.length = 0;
    const res = await run('fixed', ['4242'], 'I had to pass --tone-ack B15 to send that.\n');

    expect(res.exit).toBe(0);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('--tone-ack B15');
  });

  it('unchanged: an unknown flag BEFORE the topic id is still fatal', async () => {
    hits.length = 0;
    const res = await run('fixed', ['--bogus', '4242', 'msg']);

    expect(res.exit).toBe(1);
    expect(hits).toHaveLength(0);
    expect(res.stderr).toContain('Unknown flag');
  });
});
