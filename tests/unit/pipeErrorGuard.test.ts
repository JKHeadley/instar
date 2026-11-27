/**
 * The guard must absorb a closed pipe and nothing else. The real-child case is
 * the failure itself: a child gone before its stdin write lands.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { guardChildStdin, guardProcessStdio, isClosedPipeError } from '../../src/core/pipeErrorGuard.js';

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
const other = () => Object.assign(new Error('write EIO'), { code: 'EIO' });

afterEach(() => vi.restoreAllMocks());

describe('isClosedPipeError', () => {
  it('matches only the EPIPE code', () => {
    expect(isClosedPipeError(epipe())).toBe(true);
    expect(isClosedPipeError(other())).toBe(false);
    expect(isClosedPipeError(new Error('write EPIPE'))).toBe(false);
    expect(isClosedPipeError(null)).toBe(false);
  });
});

describe('guardChildStdin', () => {
  it('absorbs a real closed pipe from a child that closed stdin before exiting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Node destroys child.stdin once it sees the exit, so the EPIPE window is the
    // gap before that: stdin closed, process not yet reaped.
    const script = "require('fs').closeSync(0); console.log('closed'); setTimeout(() => {}, 2000)";
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    guardChildStdin(child.stdin, 'test-child');
    await new Promise((resolve) => child.stdout.once('data', resolve));
    const writeError = await new Promise<Error | null | undefined>((resolve) => {
      child.stdin.write(Buffer.alloc(1024 * 1024), resolve);
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.kill('SIGKILL');
    expect((writeError as NodeJS.ErrnoException | null)?.code).toBe('EPIPE');
    expect(warn.mock.calls.flat().join(' ')).toContain('[pipe-guard] test-child');
  }, 15_000);

  it('rethrows any other stream error so the process policy still judges it', () => {
    const stream = new EventEmitter();
    guardChildStdin(stream as never, 'test-child');
    expect(() => stream.emit('error', other())).toThrow('write EIO');
  });

  it('tolerates a null stream and a stream double with no on()', () => {
    expect(() => guardChildStdin(null, 'x')).not.toThrow();
    expect(() => guardChildStdin(undefined, 'x')).not.toThrow();
    expect(() => guardChildStdin({}, 'x')).not.toThrow();
  });
});

describe('guardProcessStdio', () => {
  it('reports a lost reader once per stream and keeps going', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stderr = new EventEmitter();
    guardProcessStdio([['stderr', stderr as never]]);
    stderr.emit('error', epipe());
    stderr.emit('error', epipe());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('process stderr lost its reader');
  });

  it('rethrows any other stdio error', () => {
    const stdout = new EventEmitter();
    guardProcessStdio([['stdout', stdout as never]]);
    expect(() => stdout.emit('error', other())).toThrow('write EIO');
  });
});

describe('wiring', () => {
  const root = path.resolve(__dirname, '../..');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });

  it('server start installs the stdio guard right after the log tee', () => {
    const server = fs.readFileSync(path.join(root, 'src/commands/server.ts'), 'utf8');
    expect(server).toMatch(/setupServerLog\(config\.stateDir\);\s+guardProcessStdio\(\);/);
  });

  it('every source file that writes to a child stdin handles its error event', () => {
    const writes = /\bstdin[!?]?\.(write\(|end\([^)])/;
    const handled = /guardChildStdin\(|\bstdin[!?]?\.on\('error'/;
    // PostUpdateMigrator's matches are text inside shell and Python templates.
    const files = walk(path.join(root, 'src')).filter((file) => !file.endsWith('PostUpdateMigrator.ts'));
    const code = (file: string) => fs.readFileSync(file, 'utf8').split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line) && !line.includes('sys.stdin') && !line.includes('process.stdin'))
      .join('\n');
    const writers = files.filter((file) => writes.test(code(file)));
    expect(writers.length).toBeGreaterThan(5);
    expect(writers.filter((file) => !handled.test(code(file))).map((file) => path.relative(root, file))).toEqual([]);
  });
});
