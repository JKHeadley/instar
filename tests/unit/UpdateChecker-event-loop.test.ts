/**
 * The update path must not hold the server's event loop. A synchronous recursive xattr
 * blocked the server for 39.8s during a real update, then synchronous candidate checks
 * held it for about 13s more: health checks failed and the machine lease lapsed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Internals = {
  stripCandidateXattrs(dir: string): Promise<void>;
  validateCandidate(dir: string, version: string): Promise<string>;
};

/** Count timer ticks while `work` runs: a held event loop produces none. */
async function ticksDuring(work: () => Promise<unknown>): Promise<number> {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  try { await work(); } finally { clearInterval(timer); }
  return ticks;
}

describe('UpdateChecker keeps the event loop free', () => {
  let root: string;
  let checker: Internals;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-loop-'));
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    checker = new UpdateChecker(path.join(root, 'state')) as unknown as Internals;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/UpdateChecker-event-loop.test.ts:cleanup' });
  });

  function fakeXattr(body: string): string {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const script = path.join(bin, 'xattr');
    fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${originalPath}`;
    return bin;
  }

  it('lets timers run during a slow xattr pass, once per attribute', async () => {
    const log = path.join(root, 'calls.log');
    fakeXattr(`echo "$@" >> "${log}"\nsleep 0.3`);
    const ticks = await ticksDuring(() => checker.stripCandidateXattrs('/candidate'));
    expect(ticks).toBeGreaterThan(5);
    expect(fs.readFileSync(log, 'utf-8').trim().split('\n')).toEqual([
      '-rd com.apple.quarantine /candidate',
      '-rd com.apple.provenance /candidate',
    ]);
  });

  it('does not kill xattr when it prints more than a process output buffer holds', async () => {
    const done = path.join(root, 'done');
    // Per-file errors for a kernel-protected attribute can run to megabytes.
    fakeXattr(`i=0; while [ $i -lt 40 ]; do head -c 100000 /dev/zero | tr '\\0' 'x' >&2; i=$((i+1)); done\ntouch "${done}"`);
    await checker.stripCandidateXattrs('/candidate');
    expect(fs.existsSync(done)).toBe(true);
  });

  it('treats a failing or missing xattr as non-fatal', async () => {
    fakeXattr('exit 1');
    await expect(checker.stripCandidateXattrs('/candidate')).resolves.toBeUndefined();
    process.env.PATH = path.join(root, 'empty-bin');
    await expect(checker.stripCandidateXattrs('/candidate')).resolves.toBeUndefined();
  });

  function candidate(cli: string, version = '9.9.9'): string {
    const dir = path.join(root, 'candidate');
    const pkg = path.join(dir, 'node_modules', 'instar');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(pkg, 'dist', 'cli.js'), cli);
    const sqlite = path.join(dir, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(sqlite, { recursive: true });
    fs.writeFileSync(path.join(sqlite, 'index.js'), `module.exports = class { prepare() { return { get: () => ({ value: 1 }) }; } close() {} };`);
    return dir;
  }

  it('accepts a working candidate and lets timers run during its checks', async () => {
    const dir = candidate(`setTimeout(() => { console.log('9.9.9'); }, 250);`);
    let version = '';
    const ticks = await ticksDuring(async () => { version = await checker.validateCandidate(dir, '9.9.9'); });
    expect(version).toBe('9.9.9');
    expect(ticks).toBeGreaterThan(5);
  });

  it('still refuses a candidate that reports the wrong version', async () => {
    const dir = candidate(`console.log('1.0.0');`);
    await expect(checker.validateCandidate(dir, '9.9.9')).rejects.toThrow(/CLI startup reported 1\.0\.0/);
  });

  it('still refuses a candidate whose code does not parse', async () => {
    const dir = candidate('this is not javascript (');
    await expect(checker.validateCandidate(dir, '9.9.9')).rejects.toThrow();
  });

  it('still refuses a candidate installed at another version', async () => {
    const dir = candidate(`console.log('9.9.9');`, '1.2.3');
    await expect(checker.validateCandidate(dir, '9.9.9')).rejects.toThrow(/Installed version is 1\.2\.3/);
  });

  it('still refuses a candidate whose native module cannot be loaded', async () => {
    const dir = candidate(`console.log('9.9.9');`);
    fs.writeFileSync(path.join(dir, 'node_modules', 'better-sqlite3', 'index.js'), `throw new Error('no binding');`);
    await expect(checker.validateCandidate(dir, '9.9.9')).rejects.toThrow();
  });
});
