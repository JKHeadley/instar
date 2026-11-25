import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IdleNativeProcessRow } from '../../src/core/IdleNativeProcessSampler.js';

describe.skipIf(process.platform !== 'darwin')('macOS native process snapshot fixture', () => {
  let scratch: string;
  let binary: string;

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-process-identity-'));
    binary = path.join(scratch, 'instar-process-identity');
    const build = spawnSync('/usr/bin/xcrun', [
      'clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
      'src/native/process-identity/macos/InstarProcessIdentity.c', '-o', binary,
    ], { encoding: 'utf8', timeout: 30_000 });
    expect(build.status, build.stderr || build.error?.message).toBe(0);
  }, 40_000);

  afterAll(() => {
    if (scratch) SafeFsExecutor.safeRmSync(scratch, { recursive: true, force: true, operation: 'test-native-process-identity-cleanup' });
  });

  const run = (args: string[]) => spawnSync(binary, args, { encoding: 'utf8', timeout: 5_000 });
  const sample = (...pids: number[]): IdleNativeProcessRow[] => {
    const result = run(pids.map(String));
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    return JSON.parse(result.stdout) as IdleNativeProcessRow[];
  };

  it('rejects malformed, repeated and oversized PID requests before returning data', () => {
    for (const args of [[], ['0'], ['-1'], ['1 '], ['1e3'], ['2147483648'], ['1', '1'],
      Array.from({ length: 65 }, (_, i) => String(i + 1))]) {
      const result = run(args);
      expect(result.status).toBe(64);
      expect(result.stdout).toBe('');
    }
  });

  it('preserves control characters and Unicode in the kernel executable path', async () => {
    const executable = path.join(scratch, 'sleep ☕ "with\nnewline"');
    fs.copyFileSync('/bin/sleep', executable);
    fs.chmodSync(executable, 0o700);
    const child = spawn(executable, ['30']);
    const exit = once(child, 'exit');
    try {
      await once(child, 'spawn');
      expect(sample(child.pid!)[0]?.executable).toBe(fs.realpathSync(executable));
    } finally {
      child.kill();
      await exit;
    }
  });

  it('returns exact and stable process generations for disposable children and omits a departed child', async () => {
    const children = [spawn('/bin/sleep', ['30']), spawn('/bin/sleep', ['30'])];
    const exits = children.map(child => once(child, 'exit'));
    try {
      await Promise.all(children.map(child => once(child, 'spawn')));
      const [first, second] = children.map(child => child.pid!);
      const actual = sample(first, second);
      expect(actual).toEqual([first, second].map(pid => ({
        pid,
        parentPid: process.pid,
        kernelStartToken: expect.stringMatching(/^\d+\.\d{6}$/),
        executable: fs.realpathSync('/bin/sleep'),
      })));
      expect(sample(first, second)).toEqual(actual);
      children[0].kill();
      await exits[0];
      expect(sample(first, second)).toEqual([actual[1]]);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(exits);
    }
  });
});
