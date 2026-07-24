import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { OUTBOUND_MESSAGING_TIMEOUT_MS } from '../../src/server/middleware.js';

const SCRIPT = path.resolve('src/templates/scripts/telegram-reply.sh');
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'telegram-reply-bounded-outcome:test-cleanup' });
  }
});

function runWithFailingCurl(): Promise<{ status: number | null; stdout: string; stderr: string; curlArgs: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-bounded-outcome-'));
  tmpDirs.push(dir);
  const binDir = path.join(dir, 'bin');
  const instarDir = path.join(dir, '.instar');
  fs.mkdirSync(binDir);
  fs.mkdirSync(instarDir);
  fs.writeFileSync(path.join(instarDir, 'config.json'), JSON.stringify({ port: 49999, projectName: 'test-agent' }));
  const argsPath = path.join(dir, 'curl-args.txt');
  const curlStub = path.join(binDir, 'curl');
  fs.writeFileSync(curlStub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\nexit 28\n`);
  fs.chmodSync(curlStub, 0o755);

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, '458', 'bounded outcome regression'], {
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
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({
      status,
      stdout,
      stderr,
      curlArgs: fs.readFileSync(argsPath, 'utf8'),
    }));
  });
}

describe('telegram-reply.sh bounded final outcome', () => {
  it('keeps the client window just beyond the server outbound budget', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const seconds = Number(source.match(/CURL_ARGS=\([\s\S]*?--max-time (\d+)\n  -H/)?.[1]);
    expect(seconds * 1000).toBe(OUTBOUND_MESSAGING_TIMEOUT_MS + 5_000);
  });

  it('bounds the final POST and renders transport ambiguity on both output channels', async () => {
    const result = await runWithFailingCurl();

    expect(result.status).toBe(0);
    expect(result.curlArgs).toContain('--connect-timeout\n3');
    expect(result.curlArgs).toContain('--max-time\n125');
    expect(result.stdout).toMatch(/AMBIGUOUS: no HTTP outcome/);
    expect(result.stderr).toMatch(/AMBIGUOUS: Telegram relay transport ended/);
    expect(result.stderr).toMatch(/Do NOT retry blindly/);
    expect(result.stderr).toMatch(/Delivery id:/);
  });
});
