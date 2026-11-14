/**
 * slack-reply.sh in a bound Slack session: a channel id passed out of habit is dropped, never
 * sent as the message (2026-11-04 nimbus drill: two restarted sessions posted their channel id
 * and one person's held messages were never answered).
 *
 * Runs the real shipped template under bash with a fake `curl` that records the request body.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve(__dirname, '../../src/templates/scripts/slack-reply.sh');

let dir: string;
let curlLog: string;

function shim(): string {
  const shimDir = path.join(dir, 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'curl'), `#!/bin/bash
for a in "$@"; do printf 'ARG:%s\\n' "$a" >> "${curlLog}"; done
printf '%s\\n%s' '{"ok":true,"ts":"1.1"}' '200'
`, { mode: 0o755 });
  return shimDir;
}

function run(args: string[], stdin: string | null, session: boolean): Promise<{ code: number }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${shim()}:${process.env.PATH}`,
    INSTAR_PORT: '4099',
    INSTAR_AUTH_TOKEN: 'tok',
    INSTAR_AGENT_ID: 'echo',
  };
  delete env.INSTAR_SESSION_NAME;
  if (session) { env.INSTAR_CONVERSATION_ID = '-42'; env.INSTAR_BIND_TOKEN = 'bind'; }
  else { delete env.INSTAR_CONVERSATION_ID; delete env.INSTAR_BIND_TOKEN; }
  const cmd = stdin === null
    ? execFileAsync('bash', [SCRIPT, ...args], { cwd: dir, env })
    : new Promise<unknown>((resolve, reject) => {
      const child = execFile('bash', [SCRIPT, ...args], { cwd: dir, env }, (err) => (err ? reject(err) : resolve(null)));
      child.stdin!.end(stdin);
    });
  return cmd.then(() => ({ code: 0 }), (e: { code?: number }) => ({ code: e.code ?? 1 }));
}

function sent(): { url: string; body: { text?: string; conversationId?: number } } {
  const args = fs.readFileSync(curlLog, 'utf8').split('\n').filter((l) => l.startsWith('ARG:')).map((l) => l.slice(4));
  const url = args.find((a) => a.startsWith('http://'))!;
  const body = JSON.parse(args[args.indexOf('-d') + 1] ?? args.find((a) => a.startsWith('{'))!);
  return { url, body };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-reply-arg-'));
  curlLog = path.join(dir, 'curl.log');
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ projectName: 'echo', port: 4099, authToken: 'tok' }));
});

describe('slack-reply.sh in a bound session', () => {
  it('drops a habitual channel id and sends the piped reply', async () => {
    expect((await run(['C0AQ9NS0E9W'], 'DAWN-ONE answered\n', true)).code).toBe(0);
    const { url, body } = sent();
    expect(url).toContain('/slack/session-reply');
    expect(body.text).toContain('DAWN-ONE answered');
    expect(body.text).not.toContain('C0AQ9NS0E9W');
    expect(body.conversationId).toBe(-42);
  });

  it('drops a channel id and thread id given before inline text', async () => {
    expect((await run(['C0AQ9NS0E9W', '1699999999.000100', 'hello', 'there'], null, true)).code).toBe(0);
    expect(sent().body.text?.trim()).toBe('hello there');
  });

  it('keeps an ordinary first word that is not a channel id', async () => {
    expect((await run(['Cool,', 'done'], null, true)).code).toBe(0);
    expect(sent().body.text?.trim()).toBe('Cool, done');
  });

  it('an all-capital first word is kept: an id has a digit', async () => {
    expect((await run(['CONFIRMED', 'and', 'shipped'], null, true)).code).toBe(0);
    expect(sent().body.text?.trim()).toBe('CONFIRMED and shipped');
  });

  it('outside a session the channel id is still the destination', async () => {
    expect((await run(['C0AQ9NS0E9W'], 'plain\n', false)).code).toBe(0);
    const { url, body } = sent();
    expect(url).toContain('/slack/reply/C0AQ9NS0E9W');
    expect(body.text).toContain('plain');
  });
});
