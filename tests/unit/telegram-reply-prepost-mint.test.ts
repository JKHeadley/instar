/**
 * telegram-reply.sh — pre-POST delivery-id mint + 409 classification
 * (spec slack-outbound-robustness §2.6 round-3 C1 + R8-M1 Arm C).
 *
 * Runs the REAL shipped template under bash with a fake `curl` shim that
 * records every invocation and serves canned responses, proving the
 * script-side contract without a server:
 *
 *  1. the INITIAL /telegram/reply POST carries X-Instar-DeliveryId (the id is
 *     minted BEFORE the send, not at enqueue);
 *  2. a recoverable 5xx enqueues under the SAME pre-minted id (the event
 *     POST's delivery_id equals the initial send's header) — the double-post
 *     window is closed;
 *  3. a 409 `delivery-in-flight` is NON-LOSING → enqueued (event POST fired);
 *  4. an UNSTRUCTURED 409 is terminal → NO enqueue, non-zero exit.
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

function writeFakeCurl(sendHttpCode: string, sendBody: string) {
  const shimDir = path.join(dir, 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  const fake = `#!/bin/bash
printf '%s\\n' "CURL_CALL_BEGIN" >> "${curlLog}"
for a in "$@"; do printf 'ARG:%s\\n' "$a" >> "${curlLog}"; done
printf '%s\\n' "CURL_CALL_END" >> "${curlLog}"
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  */telegram/reply/*)
    printf '%s\\n%s' '${sendBody.replace(/'/g, "'\\''")}' '${sendHttpCode}'
    ;;
  */events/delivery-failed)
    printf '200'
    ;;
  *)
    printf ''
    ;;
esac
`;
  fs.writeFileSync(path.join(shimDir, 'curl'), fake, { mode: 0o755 });
  return shimDir;
}

function runScript(sendHttpCode: string, sendBody: string) {
  const shimDir = writeFakeCurl(sendHttpCode, sendBody);
  return execFileAsync('bash', [SCRIPT, '12476', 'hello world'], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      INSTAR_PORT: '4099',
      INSTAR_AUTH_TOKEN: 'tok',
      INSTAR_AGENT_ID: 'echo',
    },
  }).catch((e) => e); // non-zero exit rejects; we inspect it
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

function headerDeliveryId(sendCall: string[]): string | null {
  const h = sendCall.find((a) => a.startsWith('X-Instar-DeliveryId: '));
  return h ? h.slice('X-Instar-DeliveryId: '.length) : null;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-prepost-'));
  curlLog = path.join(dir, 'curl.log');
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.instar', 'config.json'),
    JSON.stringify({ projectName: 'echo', port: 4099, authToken: 'tok' }),
  );
});

describe('telegram-reply.sh — pre-POST mint + 409 classification', () => {
  it('sends X-Instar-DeliveryId on the INITIAL POST', async () => {
    await runScript('200', '{"ok":true,"messageId":7}');
    const send = callsTo('/telegram/reply/')[0];
    const id = headerDeliveryId(send);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('enqueues a recoverable 5xx under the SAME pre-minted id', async () => {
    await runScript('500', '{"error":"internal"}');
    const send = callsTo('/telegram/reply/')[0];
    const headerId = headerDeliveryId(send);
    expect(headerId).toBeTruthy();
    const event = callsTo('/events/delivery-failed')[0];
    expect(event).toBeTruthy();
    const body = JSON.parse(event.find((a) => a.startsWith('{'))!);
    // The enqueue reuses the pre-POST-minted id — NOT a fresh one.
    expect(body.delivery_id).toBe(headerId);
  });

  it('classifies a 409 delivery-in-flight as NON-LOSING (enqueues)', async () => {
    await runScript('409', '{"error":"delivery-in-flight"}');
    expect(callsTo('/events/delivery-failed')).toHaveLength(1);
  });

  it('treats an UNSTRUCTURED 409 as terminal (no enqueue)', async () => {
    const r = await runScript('409', '{"error":"conflict-something-else"}');
    expect(callsTo('/events/delivery-failed')).toHaveLength(0);
    // terminal → non-zero exit
    expect((r as { code?: number }).code).toBeGreaterThan(0);
  });
});
