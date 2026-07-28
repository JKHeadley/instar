/**
 * telegram-reply.sh — behavioral tests for the outbound-advisory preflight
 * (spec outbound-jargon-filepath-gap §2.4, §6).
 *
 * Runs the REAL shipped template under bash with a fake `curl` shim on PATH
 * that records every invocation and serves canned responses, so the full
 * script-side contract is proven without a server:
 *
 *  1. flagged automated send → NOT delivered, literal first line
 *     `NOT SENT — advisory (…)`, exit 0;
 *  2. clean text → delivers; body carries metadata.messageKind/senderClass/jobSlug;
 *  3. --ack-advisory → delivers unchanged; body carries advisoryAck + codes;
 *  4. fail-open: preflight 500 / preflight network-fail → DELIVERS;
 *  5. conversational session (no kind env) → NO preflight call, legacy body;
 *  6. script-class sender → NO preflight call, kind metadata still rides;
 *  7. curl --max-time is SECONDS within the [1,10] clamp (ms→s ceil);
 *  8. a definitive recoverable HTTP failure queues the row WITH metadata;
 *  9. a transport-ambiguous failure does not queue or invite a blind retry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve(__dirname, '../../src/templates/scripts/telegram-reply.sh');

let dir: string;
let curlLog: string;

function writeFakeCurl(opts: {
  preflightBody?: string;
  preflightExit?: number;
  sendHttpCode?: string;
  sendExit?: number;
}) {
  const shimDir = path.join(dir, 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  const fake = `#!/bin/bash
# fake curl — records argv, serves canned responses by URL.
printf '%s\\n' "CURL_CALL_BEGIN" >> "${curlLog}"
for a in "$@"; do printf 'ARG:%s\\n' "$a" >> "${curlLog}"; done
printf '%s\\n' "CURL_CALL_END" >> "${curlLog}"
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  */messaging/preflight)
    ${opts.preflightExit ? `exit ${opts.preflightExit}` : `printf '%s' '${(opts.preflightBody ?? '{"advisories":[]}').replace(/'/g, "'\\''")}'`}
    ;;
  */telegram/reply/*)
    ${opts.sendExit ? `printf '\\n000'; exit ${opts.sendExit}` : `printf '{"ok":true,"messageId":7}\\n${opts.sendHttpCode ?? '200'}'`}
    ;;
  *)
    printf ''
    ;;
esac
`;
  fs.writeFileSync(path.join(shimDir, 'curl'), fake, { mode: 0o755 });
  return shimDir;
}

function runScript(opts: {
  env?: Record<string, string>;
  args?: string[];
  text?: string;
  curl: Parameters<typeof writeFakeCurl>[0];
}) {
  const shimDir = writeFakeCurl(opts.curl);
  return execFileAsync(
    'bash',
    [SCRIPT, ...(opts.args ?? []), '12476', opts.text ?? 'hello world'],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        INSTAR_PORT: '4099',
        INSTAR_AUTH_TOKEN: 'tok',
        ...(opts.env ?? {}),
      },
    },
  );
}

function curlCalls(): string[][] {
  if (!fs.existsSync(curlLog)) return [];
  const lines = fs.readFileSync(curlLog, 'utf8').split('\n');
  const calls: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === 'CURL_CALL_BEGIN') current = [];
    else if (line === 'CURL_CALL_END') {
      if (current) calls.push(current);
      current = null;
    } else if (current && line.startsWith('ARG:')) current.push(line.slice(4));
  }
  return calls;
}

function callsTo(pathPart: string): string[][] {
  return curlCalls().filter((args) => args.some((a) => a.includes(pathPart)));
}

const AUTOMATED_ENV = {
  INSTAR_MESSAGE_KIND: 'automated',
  INSTAR_SENDER_CLASS: 'llm-session',
  INSTAR_JOB_SLUG: 'evolution-overdue-check',
};

const ADVISED_RESPONSE = JSON.stringify({
  advisories: [
    {
      code: 'RAW_FILE_PATH',
      match: '/Users/justin/overdue.md',
      guidance: 'Describe the file conceptually, or publish a private view and send the link instead.',
    },
  ],
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-script-'));
  curlLog = path.join(dir, 'curl.log');
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.instar', 'config.json'),
    JSON.stringify({ projectName: 'echo', port: 4099, authToken: 'tok' }),
  );
});

describe('advisory preflight — the inform-only loop', () => {
  it('flagged automated send: NOT delivered, literal first line, exit 0', async () => {
    const { stdout } = await runScript({
      env: AUTOMATED_ENV,
      text: 'see /Users/justin/overdue.md now',
      curl: { preflightBody: ADVISED_RESPONSE },
    });
    expect(stdout.split('\n')[0]).toBe(
      'NOT SENT — advisory (fix and re-run, or re-run with --ack-advisory to send unchanged)',
    );
    expect(stdout).toContain('RAW_FILE_PATH');
    expect(stdout).toContain('detected: "/Users/justin/overdue.md"');
    // Fix path listed BEFORE ack path (default-bias toward fixing).
    expect(stdout.indexOf('FIX:')).toBeLessThan(stdout.indexOf('SEND AS-IS:'));
    // The send was withheld — no /telegram/reply call.
    expect(callsTo('/telegram/reply/')).toHaveLength(0);
  });

  it('clean automated text delivers and the body carries the kind metadata', async () => {
    const { stdout } = await runScript({
      env: AUTOMATED_ENV,
      text: 'Your weekly check finished — all clear.',
      curl: { preflightBody: '{"advisories":[]}' },
    });
    expect(stdout).toContain('Sent');
    const send = callsTo('/telegram/reply/')[0];
    const body = JSON.parse(send.find((a) => a.startsWith('{'))!);
    expect(body.metadata.messageKind).toBe('automated');
    expect(body.metadata.senderClass).toBe('llm-session');
    expect(body.metadata.jobSlug).toBe('evolution-overdue-check');
    expect(body.metadata.advisoryAck).toBeUndefined();
  });

  it('--ack-advisory delivers the ORIGINAL text and annotates the override', async () => {
    const { stdout } = await runScript({
      env: AUTOMATED_ENV,
      args: ['--ack-advisory'],
      text: 'see /Users/justin/overdue.md now',
      curl: { preflightBody: ADVISED_RESPONSE },
    });
    expect(stdout).toContain('Sent');
    // The preflight STILL ran (the override is audited)…
    expect(callsTo('/messaging/preflight')).toHaveLength(1);
    // …and the send carries the REQUIRED ack annotation with codes.
    const body = JSON.parse(callsTo('/telegram/reply/')[0].find((a) => a.startsWith('{'))!);
    expect(body.metadata.advisoryAck).toBe(true);
    expect(body.metadata.advisoryCodes).toEqual(['RAW_FILE_PATH']);
  });

  it('fail-open: preflight network failure → the send DELIVERS', async () => {
    const { stdout } = await runScript({
      env: AUTOMATED_ENV,
      text: 'see /Users/justin/overdue.md now',
      curl: { preflightExit: 7 },
    });
    expect(stdout).toContain('Sent');
    expect(callsTo('/telegram/reply/')).toHaveLength(1);
  });

  it('fail-open: malformed preflight JSON → the send DELIVERS', async () => {
    const { stdout } = await runScript({
      env: AUTOMATED_ENV,
      text: 'see /Users/justin/overdue.md now',
      curl: { preflightBody: 'not json at all <<<' },
    });
    expect(stdout).toContain('Sent');
  });

  it('conversational session (no kind env): preflight runs as kind "reply" (TIME_CLAIM path), legacy body shape', async () => {
    // Since the TIME_CLAIM template (operator mandate 2026-06-12), every
    // non-script sender runs the preflight — an unstamped interactive session
    // defaults to kind "reply", where the server applies ONLY the session-clock
    // check (no jargon/path detectors). The send body stays legacy-shaped.
    const { stdout } = await runScript({
      text: 'just a normal reply',
      curl: {},
    });
    expect(stdout).toContain('Sent');
    const preflights = callsTo('/messaging/preflight');
    expect(preflights).toHaveLength(1);
    const pfBody = JSON.parse(preflights[0].find((a) => a.startsWith('{'))!);
    expect(pfBody.messageKind).toBe('reply');
    const body = JSON.parse(callsTo('/telegram/reply/')[0].find((a) => a.startsWith('{'))!);
    expect(body).toEqual({ text: 'just a normal reply' });
  });

  it('unstamped sender flagged with TIME_CLAIM: NOT delivered, literal first line, exit 0', async () => {
    // The founding-incident path (operator mandate 2026-06-12): an interactive
    // session running an autonomous job reports a wrong elapsed time — the
    // preflight returns TIME_CLAIM and the send is withheld exactly like any
    // other advisory.
    const { stdout } = await runScript({
      text: 'AUTONOMOUS PROGRESS: ~7h elapsed / 24h total.',
      curl: {
        preflightBody: JSON.stringify({
          advisories: [
            {
              code: 'TIME_CLAIM',
              match: 'claimed "~7h elapsed"; live clock: 1h 54m elapsed',
              guidance: 'Never estimate time — read GET /session/clock and quote its numbers exactly.',
            },
          ],
        }),
      },
    });
    expect(stdout.split('\n')[0]).toBe(
      'NOT SENT — advisory (fix and re-run, or re-run with --ack-advisory to send unchanged)',
    );
    expect(stdout).toContain('TIME_CLAIM');
    expect(callsTo('/telegram/reply/')).toHaveLength(0);
  });

  it('unstamped sender --ack-advisory annotates the override (acked must resolve the advised episode)', async () => {
    // Second-pass concern 2: without this annotation a conversational
    // session's ack never records 'acked' server-side, the advised episodes
    // never resolve, and the ignore-escalation false-fires on delivered
    // messages.
    const { stdout } = await runScript({
      args: ['--ack-advisory'],
      text: 'AUTONOMOUS PROGRESS: ~7h elapsed / 24h total.',
      curl: {
        preflightBody: JSON.stringify({
          advisories: [{ code: 'TIME_CLAIM', guidance: 'read the clock' }],
        }),
      },
    });
    expect(stdout).toContain('Sent');
    const body = JSON.parse(callsTo('/telegram/reply/')[0].find((a) => a.startsWith('{'))!);
    expect(body.metadata.advisoryAck).toBe(true);
    expect(body.metadata.advisoryCodes).toEqual(['TIME_CLAIM']);
    expect(body.metadata.messageKind).toBeUndefined();
  });

  it('script-class sender skips the preflight; kind metadata still rides', async () => {
    const { stdout } = await runScript({
      env: { ...AUTOMATED_ENV, INSTAR_SENDER_CLASS: 'script' },
      text: 'see /Users/justin/overdue.md now',
      curl: {},
    });
    expect(stdout).toContain('Sent');
    expect(callsTo('/messaging/preflight')).toHaveLength(0);
    const body = JSON.parse(callsTo('/telegram/reply/')[0].find((a) => a.startsWith('{'))!);
    expect(body.metadata.messageKind).toBe('automated');
    expect(body.metadata.senderClass).toBe('script');
  });

  it('an invalid kind env value forwards nothing (enum validation) — preflight degrades to "reply"', async () => {
    await runScript({
      env: { INSTAR_MESSAGE_KIND: 'evil; rm -rf /', INSTAR_SENDER_CLASS: 'llm-session' },
      text: 'hello',
      curl: {},
    });
    // The injection-shaped value never reaches any wire surface: the enum
    // rejects it, the preflight (which still runs — llm-session sender) is
    // keyed to the safe default "reply", and the send metadata omits the kind.
    const preflights = callsTo('/messaging/preflight');
    expect(preflights).toHaveLength(1);
    const pfBody = JSON.parse(preflights[0].find((a) => a.startsWith('{'))!);
    expect(pfBody.messageKind).toBe('reply');
    const body = JSON.parse(callsTo('/telegram/reply/')[0].find((a) => a.startsWith('{'))!);
    expect(body.metadata?.messageKind).toBeUndefined();
  });
});

describe('curl --max-time clamp (ms→s ceil, [1,10])', () => {
  async function maxTimeFor(timeoutMs: number | undefined): Promise<string | undefined> {
    if (timeoutMs !== undefined) {
      fs.writeFileSync(
        path.join(dir, '.instar', 'config.json'),
        JSON.stringify({
          projectName: 'echo',
          port: 4099,
          authToken: 'tok',
          messaging: { outboundAdvisory: { timeoutMs } },
        }),
      );
    }
    await runScript({ env: AUTOMATED_ENV, text: 'clean text', curl: { preflightBody: '{"advisories":[]}' } });
    const pf = callsTo('/messaging/preflight')[0];
    const idx = pf.indexOf('--max-time');
    return idx >= 0 ? pf[idx + 1] : undefined;
  }

  it('default 2000ms → 2 seconds', async () => {
    expect(await maxTimeFor(undefined)).toBe('2');
  });

  it('500ms → ceil to 1 second (never 0 = no timeout)', async () => {
    expect(await maxTimeFor(500)).toBe('1');
  });

  it('50000ms → clamped to 10 seconds (never a fail-HANG)', async () => {
    expect(await maxTimeFor(50000)).toBe('10');
  });
});

describe('send failure outcome contract', () => {
  it('HTTP 500 → queue row carries message_metadata', async () => {
    await expect(
      runScript({
        env: AUTOMATED_ENV,
        text: 'Your weekly check finished — all clear.',
        curl: { preflightBody: '{"advisories":[]}', sendHttpCode: '500' },
      }),
    ).rejects.toMatchObject({ code: 1 });
    const dbPath = path.join(dir, '.instar', 'state', 'pending-relay.echo.sqlite');
    expect(fs.existsSync(dbPath)).toBe(true);
    const { stdout: metadataJson } = await execFileAsync('python3', [
      '-c',
      `import sqlite3, json; c = sqlite3.connect('${dbPath}'); print(c.execute('select message_metadata from entries').fetchone()[0])`,
    ]);
    const meta = JSON.parse(metadataJson.trim());
    expect(meta.messageKind).toBe('automated');
    expect(meta.senderClass).toBe('llm-session');
    expect(meta.jobSlug).toBe('evolution-overdue-check');
  });

  it('curl failure / HTTP 000 → exits 0 with AMBIGUOUS and does not enqueue', async () => {
    const { stdout, stderr } = await runScript({
      env: AUTOMATED_ENV,
      text: 'Your weekly check finished — all clear.',
      curl: { preflightBody: '{"advisories":[]}', sendExit: 7 },
    });
    expect(stdout).toContain('AMBIGUOUS: no HTTP outcome — verify delivery before retrying');
    expect(stderr).toContain('AMBIGUOUS: Telegram relay transport ended without an HTTP outcome (curl 7).');
    const dbPath = path.join(dir, '.instar', 'state', 'pending-relay.echo.sqlite');
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
