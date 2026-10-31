/**
 * Shared harness for the built-in job script tests (docs/specs/job-cost-reduction.md
 * §5.2, §5.6.4). Each script is spawned with node, in canary mode, against a
 * loopback http stub on an ephemeral port, with a temp cwd and a temp HOME so a
 * test can prove the canary run wrote nothing.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

export const SCRIPTS_DIR = path.resolve(__dirname, '../../../src/scaffold/templates/jobs/instar/scripts');
export const REPO_ROOT = path.resolve(__dirname, '../../..');

export interface StubReply {
  status?: number;
  /** An object is sent as JSON; a string is sent raw (for malformed bodies). */
  body?: unknown;
  /** Never answer (the timeout fixture). */
  hang?: boolean;
}

export interface StubRequest { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

export interface Stub {
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

export type StubHandler = (req: StubRequest, nth: number) => StubReply;

export async function startStub(handler: StubHandler): Promise<Stub> {
  const requests: StubRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r: StubRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      requests.push(r);
      const reply = handler(r, requests.length);
      if (reply.hang) return;
      const status = reply.status ?? 200;
      const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

/** A port nothing listens on (bound then released). */
export async function deadPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const port = (s.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  resultLine: string;
  anomalies: string[];
  fields: Record<string, string>;
}

export interface RunOpts {
  /** Server URL passed with --server-url (canary mode). */
  serverUrl?: string;
  /** Full argv override (no automatic --canary / --server-url). */
  args?: string[];
  extraArgs?: string[];
  /** Set false to run outside canary mode (no INSTAR_SCRIPT_CANARY). */
  canaryEnv?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  home?: string;
}

export function runScript(slug: string, opts: RunOpts = {}): Promise<RunResult> {
  const file = path.join(SCRIPTS_DIR, `${slug}.mjs`);
  const args = opts.args ?? [
    '--canary',
    ...(opts.serverUrl ? ['--server-url', opts.serverUrl] : []),
    ...(opts.extraArgs ?? []),
  ];
  // The reduced allowlist the scheduler gives a script (spec §5.1).
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: opts.home ?? os.tmpdir(),
    INSTAR_AUTH_TOKEN: 'test-token',
    INSTAR_AGENT_ID: 'test-agent',
    INSTAR_JOB_SLUG: slug,
    INSTAR_MESSAGE_KIND: 'automated',
    INSTAR_SENDER_CLASS: 'script',
    ...(opts.canaryEnv === false ? {} : { INSTAR_SCRIPT_CANARY: '1' }),
    ...(opts.env ?? {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: opts.cwd ?? os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('error', reject);
    child.on('close', (exitCode) => {
      clearTimeout(killer);
      const lines = stdout.split('\n');
      const fields: Record<string, string> = {};
      for (const l of lines) {
        const m = /^JOB_FIELD (\S+) (\S+)$/.exec(l);
        if (m) fields[m[1]] = m[2];
      }
      resolve({
        exitCode,
        stdout,
        stderr,
        resultLine: lines.filter((l) => l.startsWith('JOB_RESULT ')).join('\n'),
        anomalies: lines.filter((l) => l.startsWith('JOB_ANOMALY ')),
        fields,
      });
    });
  });
}

/** Every file under `dir`, with its size and mtime, for a no-writes assertion. */
export function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = fs.statSync(p); out.push(`${path.relative(dir, p)}:${s.size}:${s.mtimeMs}`); }
    }
  };
  walk(dir);
  return out.sort();
}

export function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `job-script-${prefix}-`));
}

export function removeTmp(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-scripts/harness.ts:removeTmp' });
}

/** A stub prober that prints `stdout`/`stderr` and exits with `exitCode` (or sleeps). */
export function writeStubProber(dir: string, name: string, p: { exitCode?: number; stdout?: string; stderr?: string; sleepMs?: number }): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, [
    `process.stdout.write(${JSON.stringify(p.stdout ?? '')});`,
    `process.stderr.write(${JSON.stringify(p.stderr ?? '')});`,
    p.sleepMs ? `setTimeout(() => process.exit(${p.exitCode ?? 0}), ${p.sleepMs});` : `process.exitCode = ${p.exitCode ?? 0};`,
  ].join('\n'));
  return file;
}

/**
 * Cases every HTTP-triggering script shares: the CLI contract (flag refusal
 * outside canary mode, loopback-only URL), no server, a hanging server, and the
 * canary-writes-nothing rule.
 */
export function sharedContractCases(slug: string, ok: StubHandler, opts: { timeoutResult?: RegExp } = {}): void {
  describe(`${slug}: shared script contract`, () => {
    let cwd: string;
    let home: string;
    beforeEach(() => { cwd = makeTmp('cwd'); home = makeTmp('home'); });
    afterEach(() => { removeTmp(cwd); removeTmp(home); });

    it('refuses --server-url outside canary mode (no env) with exit 2', async () => {
      const r = await runScript(slug, { args: ['--server-url', 'http://127.0.0.1:1'], canaryEnv: false, cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed flag-refused --server-url');
      expect(r.exitCode).toBe(2);
    });

    it('refuses --canary without INSTAR_SCRIPT_CANARY=1', async () => {
      const r = await runScript(slug, { args: ['--canary'], canaryEnv: false, cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed flag-refused --canary');
      expect(r.exitCode).toBe(2);
    });

    it('refuses --server-url without --canary even with the env set', async () => {
      const r = await runScript(slug, { args: ['--server-url', 'http://127.0.0.1:1'], cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed flag-refused --server-url');
      expect(r.exitCode).toBe(2);
    });

    it('refuses an unknown flag', async () => {
      const r = await runScript(slug, { args: ['--canary', '--bogus'], cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed flag-refused --bogus');
      expect(r.exitCode).toBe(2);
    });

    for (const bad of ['http://127.0.0.1@evil', 'http://127.0.0.1@evil.example:80', 'http://example.com', 'http://localhost:4042', 'file:///etc/passwd', 'http://user:pw@127.0.0.1:1']) {
      it(`refuses the non-loopback URL ${bad}`, async () => {
        const stub = await startStub(ok);
        try {
          const r = await runScript(slug, { serverUrl: bad, cwd });
          expect(r.resultLine).toBe('JOB_RESULT failed canary-url-refused');
          expect(r.exitCode).toBe(1);
          expect(stub.requests).toHaveLength(0);
        } finally { await stub.close(); }
      });
    }

    it('fails when nothing answers (server unreachable)', async () => {
      const r = await runScript(slug, { serverUrl: `http://127.0.0.1:${await deadPort()}`, cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed server-unreachable');
      expect(r.exitCode).toBe(1);
    });

    it('fails when the server never answers (bounded timeout)', async () => {
      const stub = await startStub(() => ({ hang: true }));
      try {
        const r = await runScript(slug, { serverUrl: stub.url, cwd, env: { INSTAR_SCRIPT_HTTP_TIMEOUT_MS: '300' } });
        expect(r.resultLine).toMatch(opts.timeoutResult ?? /^JOB_RESULT failed [a-z-]+-timeout$/);
        expect(r.exitCode).toBe(1);
      } finally { await stub.close(); }
    });

    it('accepts an IPv6 loopback URL', async () => {
      const r = await runScript(slug, { serverUrl: `http://[::1]:${await deadPort()}`, cwd });
      expect(r.resultLine).not.toContain('canary-url-refused');
    });

    it('sends the bearer token and agent id, and writes no file in canary mode', async () => {
      const stub = await startStub(ok);
      try {
        const before = [snapshot(cwd), snapshot(home)];
        const r = await runScript(slug, { serverUrl: stub.url, cwd, home });
        expect(r.resultLine).toMatch(/^JOB_RESULT (ok|skipped) /);
        expect(stub.requests.length).toBeGreaterThan(0);
        for (const q of stub.requests) {
          expect(q.headers.authorization).toBe('Bearer test-token');
          expect(q.headers['x-instar-agentid']).toBe('test-agent');
        }
        expect([snapshot(cwd), snapshot(home)]).toEqual(before);
      } finally { await stub.close(); }
    });
  });
}

/** Run a fixture: stub answers with `handler`, assert the exact result line and exit code. */
export async function expectFixture(slug: string, handler: StubHandler, result: string | RegExp, exitCode: number, env?: Record<string, string>, extraArgs?: string[]): Promise<RunResult & { requests: StubRequest[] }> {
  const stub = await startStub(handler);
  const cwd = makeTmp('fixture');
  try {
    const r = await runScript(slug, { serverUrl: stub.url, env, cwd, extraArgs });
    if (typeof result === 'string') expect(r.resultLine).toBe(result);
    else expect(r.resultLine).toMatch(result);
    expect(r.exitCode).toBe(exitCode);
    return { ...r, requests: stub.requests };
  } finally { await stub.close(); removeTmp(cwd); }
}

export { afterAll, describe, expect, it };

/**
 * Cases every prober-wrapping script shares: the flag contract, the exit-code
 * mapping fixtures common to all of them, and the canary-writes-nothing rule.
 * `proberName` is the prober's file name under scripts/.
 */
export function proberContractCases(slug: string, okStdout: string, ok: { stubCode?: string; env?: (dir: string) => Record<string, string> } = {}): void {
  describe(`${slug}: shared prober contract`, () => {
    let dir: string;
    let cwd: string;
    beforeEach(() => { dir = makeTmp('prober'); cwd = makeTmp('cwd'); });
    afterEach(() => { removeTmp(dir); removeTmp(cwd); });

    it('refuses --prober outside canary mode with exit 2', async () => {
      const r = await runScript(slug, { args: ['--prober', '/bin/true'], canaryEnv: false, cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed flag-refused --prober');
      expect(r.exitCode).toBe(2);
    });

    it('refuses a non-loopback --server-url', async () => {
      const r = await runScript(slug, { serverUrl: 'http://127.0.0.1@evil', cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed canary-url-refused');
    });

    it('an absent prober → skipped prober-absent (a non-source agent)', async () => {
      const r = await runScript(slug, { args: ['--canary', '--prober', `${dir}/missing.mjs`], cwd });
      expect(r.resultLine).toBe('JOB_RESULT skipped prober-absent');
      expect(r.exitCode).toBe(0);
    });

    it('without --prober in a cwd with no scripts/ → skipped prober-absent', async () => {
      const r = await runScript(slug, { args: [], canaryEnv: false, cwd });
      expect(r.resultLine).toBe('JOB_RESULT skipped prober-absent');
    });

    it('exit 1 → failed prober-exit-1', async () => {
      const p = writeStubProber(dir, 'p.mjs', { exitCode: 1, stderr: 'fatal: boom\n' });
      const r = await runScript(slug, { args: ['--canary', '--prober', p], cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed prober-exit-1 fatal: boom');
      expect(r.exitCode).toBe(1);
    });

    it('exit 3 → failed prober-exit-3', async () => {
      const p = writeStubProber(dir, 'p.mjs', { exitCode: 3 });
      const r = await runScript(slug, { args: ['--canary', '--prober', p], cwd });
      expect(r.resultLine).toBe('JOB_RESULT failed prober-exit-3');
      expect(r.exitCode).toBe(1);
    });

    it('a prober that never ends → failed prober-timeout', async () => {
      const p = writeStubProber(dir, 'p.mjs', { sleepMs: 30_000 });
      const r = await runScript(slug, { args: ['--canary', '--prober', p], cwd, env: { INSTAR_SCRIPT_PROBER_TIMEOUT_MS: '300' } });
      expect(r.resultLine).toBe('JOB_RESULT failed prober-timeout');
      expect(r.exitCode).toBe(1);
    });

    it('the prober gets only PATH, HOME and INSTAR_* and the script writes nothing in canary mode', async () => {
      const envDump = path.join(dir, 'env.json');
      const p = path.join(dir, 'p.mjs');
      // The stub prober is the one writer here, and only into its own temp dir.
      fs.writeFileSync(p, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(Object.keys(process.env))); ${ok.stubCode ?? ''} process.stdout.write(${JSON.stringify(okStdout)});`);
      const home = makeTmp('home');
      try {
        const before = [snapshot(cwd), snapshot(home)];
        const r = await runScript(slug, { args: ['--canary', '--prober', p], cwd, home, env: { SECRET_THING: 'x', ...(ok.env?.(dir) ?? {}) } as Record<string, string> });
        expect(r.resultLine).toMatch(/^JOB_RESULT ok /);
        const keys: string[] = JSON.parse(fs.readFileSync(envDump, 'utf8'));
        for (const k of keys) expect(k === 'PATH' || k === 'HOME' || k.startsWith('INSTAR_') || k === '__CF_USER_TEXT_ENCODING').toBe(true);
        expect(keys).not.toContain('SECRET_THING');
        expect([snapshot(cwd), snapshot(home)]).toEqual(before);
      } finally { removeTmp(home); }
    });
  });
}

/** Run the REAL prober through the script (non-canary) in a temp cwd whose scripts/ links to the repo's files, under the reduced env. */
export async function runRealProberReducedEnv(slug: string, links: string[]): Promise<RunResult> {
  const cwd = makeTmp('real');
  const home = makeTmp('home');
  try {
    fs.mkdirSync(path.join(cwd, 'scripts'));
    // Copied, not symlinked: each prober runs main() only when argv[1] is its own
    // real path. node_modules is linked so a prober's own imports resolve.
    for (const l of links) fs.copyFileSync(path.join(REPO_ROOT, 'scripts', l), path.join(cwd, 'scripts', l));
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(cwd, 'node_modules'));
    // INSTAR_STATE_DIR points the probers' state reads into the temp tree.
    return await runScript(slug, { args: [], canaryEnv: false, cwd, home, env: { INSTAR_STATE_DIR: path.join(cwd, '.instar') } });
  } finally { removeTmp(cwd); removeTmp(home); }
}
