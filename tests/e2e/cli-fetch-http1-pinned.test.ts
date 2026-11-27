/**
 * E2E (production entry): every instar process starts through dist/cli.js, and that entry
 * must pin Node's global fetch to HTTP/1.1 before any command runs (2026-11-20 post-mortem A3:
 * Node 26's default HTTP/2 fetch ballooned the agent server to 10-37 GB).
 *
 * A probe preloaded with --import reports, at process exit, whether the pin marker is set and
 * which dispatcher class now sits in Node's fetch slot.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROBE = `
process.on('exit', () => {
  const g = globalThis;
  const slot = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')].find((s) => g[s] != null);
  process.stderr.write('A3PROBE ' + JSON.stringify({ pinned: g[Symbol.for('instar.fetchHttp1Pinned')] === true, dispatcher: slot ? g[slot].constructor.name : null }) + '\\n');
});
`;

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const cli = path.join(process.cwd(), 'dist', 'cli.js');
  expect(fs.existsSync(cli), 'dist/cli.js must be built before the e2e lane').toBe(true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a3probe-'));
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probe, PROBE);
  try {
    const r = spawnSync(process.execPath, ['--import', probe, cli, ...args], {
      cwd: process.cwd(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
      env: { ...process.env, ...env },
    });
    const line = (r.stderr || '').split('\n').find((l) => l.startsWith('A3PROBE '));
    return { status: r.status, probe: line ? JSON.parse(line.slice(8)) as { pinned: boolean; dispatcher: string | null } : null };
  } finally {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/cli-fetch-http1-pinned.test.ts' });
  }
}

describe('instar CLI entry keeps fetch on HTTP/1.1', () => {
  it('pins before running a command', () => {
    const r = runCli(['help']);
    expect(r.status).toBe(0);
    expect(r.probe).toEqual({ pinned: true, dispatcher: 'Agent' });
  });

  it('INSTAR_ALLOW_FETCH_HTTP2=1 leaves Node\'s default alone', () => {
    const r = runCli(['help'], { INSTAR_ALLOW_FETCH_HTTP2: '1' });
    expect(r.status).toBe(0);
    expect(r.probe?.pinned).toBe(false);
  });
});
