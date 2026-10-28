/**
 * The held-reply branch of `src/templates/scripts/telegram-reply.sh`
 * (Echo Bugs topic 10000000967).
 *
 * The defect: a reply answered `409 telegram-origin-held` (reason
 * receipt-persistence-unavailable, outcome unknown) was printed as
 * "Failed (HTTP 409)", exit 1. The message had in fact reached the chat, the
 * session resent it, and the user got it twice. The script now asks the
 * server's outcome lookup once and prints what is known; only a
 * `not-delivered` verdict invites a resend.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT = path.resolve('src/templates/scripts/telegram-reply.sh');
const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'telegram-reply-held-outcome:test-cleanup' });
});

const OP = 'f659abab-6f46-4aae-abda-520623faccd9';
const held = (outcome: string, extra = '') =>
  `{"error":"telegram-origin-held","reason":"receipt-persistence-unavailable","outcome":"${outcome}","operationId":"${OP}","retryable":false${extra}}`;

function run(replyBody: string, outcomeBody: string | null): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-held-outcome-'));
  tmpDirs.push(dir);
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir); fs.mkdirSync(path.join(dir, '.instar'));
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ port: 49999, projectName: 'test-agent' }));
  fs.writeFileSync(path.join(dir, 'reply.json'), replyBody);
  if (outcomeBody !== null) fs.writeFileSync(path.join(dir, 'outcome.json'), outcomeBody);
  fs.writeFileSync(path.join(binDir, 'curl'), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    *"/telegram/reply/"*) cat '${dir}/reply.json'; printf '\\n409'; exit 0 ;;
    *"/outcome"*) [ -f '${dir}/outcome.json' ] && cat '${dir}/outcome.json' && exit 0; exit 7 ;;
  esac
done
exit 1
`);
  fs.chmodSync(path.join(binDir, 'curl'), 0o755);
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, '967', 'the reply'], { cwd: dir, env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`,
      INSTAR_SENDER_CLASS: 'script', INSTAR_PORT: '', INSTAR_AUTH_TOKEN: 'test-token' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

describe('telegram-reply.sh — held reply outcome', () => {
  it('says DELIVERED, do not resend, when the lookup confirms Telegram accepted it', async () => {
    const res = await run(held('accepted-unrecorded', ',"delivered":true,"messageId":"8812"'),
      `{"operationId":"${OP}","outcome":"delivered","safeToResend":false,"messageIds":["8812"],"detail":"Telegram accepted it."}`);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('DELIVERED');
    expect(res.stderr).toContain('message id 8812');
    expect(res.stderr).toContain('Do NOT resend');
    expect(res.stdout).not.toContain('Failed');
  });

  it('still says DELIVERED from the 409 body alone when the lookup is unreachable', async () => {
    const res = await run(held('accepted-unrecorded', ',"delivered":true,"messageId":"8812"'), null);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('DELIVERED');
  });

  it('says MAY ALREADY BE DELIVERED with the check command when the outcome is unknown', async () => {
    const res = await run(held('outcome-unknown'),
      `{"operationId":"${OP}","outcome":"unknown","safeToResend":false,"messageIds":[],"detail":"No answer was recorded."}`);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('MAY ALREADY BE DELIVERED');
    expect(res.stderr).toContain(`/telegram/origins/operations/${OP}/outcome`);
    expect(res.stderr).toContain('Do NOT resend');
    expect(res.stdout).toContain('AMBIGUOUS');
  });

  it('says HELD, do not resend, when the server still owns an undelivered message', async () => {
    const res = await run(held('held'), `{"operationId":"${OP}","outcome":"pending","safeToResend":false,"messageIds":[],"detail":"Not delivered yet."}`);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('HELD');
    expect(res.stderr).toContain('Do NOT resend');
  });

  it('a refused attempt with no lookup answer is NOT DELIVERED but never "safe to resend" (the server may retry)', async () => {
    const res = await run(`{"error":"telegram-origin-held","reason":"telegram-400","outcome":"known-failed","operationId":"${OP}","retryable":false}`, null);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('NOT DELIVERED');
    expect(res.stderr).not.toContain('MAY ALREADY BE DELIVERED');
    expect(res.stderr).not.toContain('safe to send it again');
    expect(res.stderr).toContain(`/telegram/origins/operations/${OP}/outcome`);
  });

  it('only a not-delivered verdict says a resend is safe', async () => {
    const res = await run(held('known-failed'), `{"operationId":"${OP}","outcome":"not-delivered","safeToResend":true,"messageIds":[],"detail":"It never reached Telegram."}`);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('NOT SENT');
    expect(res.stderr).toContain('safe to send it again');
  });
});
