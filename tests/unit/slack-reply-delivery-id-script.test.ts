/**
 * slack-reply.sh — pre-POST delivery-id mint + 409 classification
 * (spec slack-outbound-robustness §2.6 / §2.4 / R8-M1 Arm C).
 *
 * Runs the REAL shipped template under bash with a fake `curl` shim:
 *  1. the send carries X-Instar-DeliveryId (minted BEFORE the POST);
 *  2. a 409 delivery-in-flight is NON-LOSING → exit 0, no re-send;
 *  3. an UNSTRUCTURED 409 is terminal → exit 1;
 *  4. a normal 200 send still succeeds.
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

function writeFakeCurl(sendHttpCode: string, sendBody: string) {
  const shimDir = path.join(dir, 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  const fake = `#!/bin/bash
printf '%s\\n' "CURL_CALL_BEGIN" >> "${curlLog}"
for a in "$@"; do printf 'ARG:%s\\n' "$a" >> "${curlLog}"; done
printf '%s\\n' "CURL_CALL_END" >> "${curlLog}"
printf '%s\\n%s' '${sendBody.replace(/'/g, "'\\''")}' '${sendHttpCode}'
`;
  fs.writeFileSync(path.join(shimDir, 'curl'), fake, { mode: 0o755 });
  return shimDir;
}

function run(sendHttpCode: string, sendBody: string) {
  const shimDir = writeFakeCurl(sendHttpCode, sendBody);
  return execFileAsync('bash', [SCRIPT, 'C_MAIN', 'hello world'], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      INSTAR_PORT: '4099',
      INSTAR_AUTH_TOKEN: 'tok',
      INSTAR_AGENT_ID: 'echo',
    },
  }).then(
    (r) => ({ ...r, code: 0 }),
    (e) => e,
  );
}

function sendCall(): string[] | null {
  if (!fs.existsSync(curlLog)) return null;
  const lines = fs.readFileSync(curlLog, 'utf8').split('\n');
  const args: string[] = [];
  for (const line of lines) if (line.startsWith('ARG:')) args.push(line.slice(4));
  return args;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-reply-'));
  curlLog = path.join(dir, 'curl.log');
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.instar', 'config.json'),
    JSON.stringify({ projectName: 'echo', port: 4099, authToken: 'tok' }),
  );
});

describe('slack-reply.sh — delivery-id + 409', () => {
  it('sends X-Instar-DeliveryId on the POST', async () => {
    await run('200', '{"ok":true,"ts":"1.1"}');
    const header = sendCall()!.find((a) => a.startsWith('X-Instar-DeliveryId: '));
    expect(header).toBeTruthy();
    expect(header!.slice('X-Instar-DeliveryId: '.length)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('treats 409 delivery-in-flight as NON-LOSING (exit 0)', async () => {
    const r = await run('409', '{"error":"delivery-in-flight"}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('IN-FLIGHT (HTTP 409)');
  });

  it('treats an UNSTRUCTURED 409 as terminal (exit 1)', async () => {
    const r = await run('409', '{"error":"other-conflict"}');
    expect(r.code).toBeGreaterThan(0);
  });

  it('a normal 200 send succeeds', async () => {
    const r = await run('200', '{"ok":true,"ts":"1.1"}');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Sent');
  });
});
