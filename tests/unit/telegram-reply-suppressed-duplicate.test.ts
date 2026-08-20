/**
 * Tier-1 unit tests for the suppressed-duplicate honesty branch in
 * `src/templates/scripts/telegram-reply.sh`.
 *
 * The defect this covers: the server answers HTTP **200** with
 * `{ suppressedDuplicate: true }` when it drops an exact repeat of a message
 * already delivered to that topic recently (src/server/routes.ts). The relay
 * script read only the status line and discarded the body, so it printed
 * "Sent N chars" and exited 0 — reporting a message the user never saw as
 * delivered. An agent has no other way to learn the send was dropped, so it
 * moved on believing it had answered.
 *
 * The branch is a REPORTER, not an authority (docs/signal-vs-authority.md):
 * the suppression decision was already made by the server. These tests pin
 * both directions — it must speak up on a real suppression, and it must stay
 * silent on every other 200 — because a false "NOT SENT" would push an agent
 * into re-sending a message the user DID receive.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT = path.resolve('src/templates/scripts/telegram-reply.sh');
const TOPIC = '458';
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'telegram-reply-suppressed-duplicate:test-cleanup',
    });
  }
});

/**
 * Run the REAL relay script against a stubbed `curl` that returns `body` for
 * the outbound reply POST. The stub routes on the URL so the unrelated
 * advisory-preflight call cannot consume the canned response; that call is
 * failed deliberately, which the script treats as fail-open.
 */
function runWithReplyBody(
  body: string,
  httpCode = '200',
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-suppressed-dup-'));
  tmpDirs.push(dir);
  const binDir = path.join(dir, 'bin');
  const instarDir = path.join(dir, '.instar');
  fs.mkdirSync(binDir);
  fs.mkdirSync(instarDir);
  fs.writeFileSync(
    path.join(instarDir, 'config.json'),
    JSON.stringify({ port: 49999, projectName: 'test-agent' }),
  );

  // `printf '%s'` (not echo) so the body is emitted byte-exactly; the script
  // appends the status line via curl's -w, which the stub reproduces.
  const curlStub = path.join(binDir, 'curl');
  fs.writeFileSync(
    curlStub,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    *"/telegram/reply/"*)
      printf '%s\\n%s' '${body}' '${httpCode}'
      exit 0
      ;;
  esac
done
exit 1
`,
  );
  fs.chmodSync(curlStub, 0o755);

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, TOPIC, 'a message the user may or may not have seen'], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        INSTAR_SENDER_CLASS: 'script',
        INSTAR_PORT: '',
        INSTAR_AUTH_TOKEN: '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('telegram-reply.sh — suppressed-duplicate honesty', () => {
  it('reports NOT SENT and exits non-zero when the server suppressed the duplicate', async () => {
    const res = await runWithReplyBody('{"ok":true,"topicId":458,"suppressedDuplicate":true}');

    // Exit 1 is the load-bearing half: an agent that only checks the exit
    // status must not conclude the message was delivered.
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('NOT SENT');
    expect(res.stdout).toContain('suppressed duplicate for topic 458');
    // The old lie must be gone from this path entirely.
    expect(res.stdout).not.toMatch(/Sent \d+ chars/);
  });

  it('names the delivery id when the server supplied one', async () => {
    const res = await runWithReplyBody(
      '{"ok":true,"topicId":458,"suppressedDuplicate":true,"deliveryId":"dlv-abc123"}',
    );

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('delivery id dlv-abc123');
  });

  it('omits the delivery-id clause when the server supplied none', async () => {
    // The 200-with-suppression responses in routes.ts do NOT carry a
    // deliveryId, so this is the common shape, not an edge case.
    const res = await runWithReplyBody('{"ok":true,"topicId":458,"suppressedDuplicate":true}');

    expect(res.status).toBe(1);
    expect(res.stdout).not.toContain('delivery id');
    expect(res.stdout).toContain('an identical message was already delivered');
  });

  it('still reports a genuine send as sent (no regression on the normal path)', async () => {
    const res = await runWithReplyBody('{"ok":true,"topicId":458}');

    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Sent \d+ chars to topic 458/);
    expect(res.stdout).not.toContain('NOT SENT');
  });

  it('treats an explicit suppressedDuplicate:false as a genuine send', async () => {
    const res = await runWithReplyBody('{"ok":true,"topicId":458,"suppressedDuplicate":false}');

    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Sent \d+ chars/);
    expect(res.stdout).not.toContain('NOT SENT');
  });

  it('does not claim suppression on a truthy-but-not-true value', async () => {
    // The check is `is True`, not a truthiness test. A string "true" is not a
    // suppression verdict, and guessing that it is would strand a delivered
    // message as NOT SENT.
    const res = await runWithReplyBody('{"ok":true,"suppressedDuplicate":"true"}');

    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('NOT SENT');
  });

  it('fails toward the send report when the 200 body is not JSON', async () => {
    // Fail-open is the correct direction here: an unparseable body is not
    // evidence of suppression, and a false NOT SENT would provoke a re-send
    // of a message the user already received.
    const res = await runWithReplyBody('not json at all');

    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('NOT SENT');
  });

  it('does not hijack a non-200 outcome', async () => {
    // 408 has its own AMBIGUOUS branch; the suppression check lives strictly
    // inside the 200 arm and must not shadow it.
    const res = await runWithReplyBody('{"suppressedDuplicate":true}', '408');

    expect(res.stdout).not.toContain('NOT SENT — suppressed duplicate');
    expect(`${res.stdout}${res.stderr}`).toContain('AMBIGUOUS');
  });
});
