/**
 * Boot must not run one blocking `node -e require(...)` per node candidate on the
 * server's main thread (docs/specs/main-loop-freeze-conversation-list.md; the
 * post-boot Echo Studio profile of 2026-11-21 had nodeCanLoadNativeModule under
 * startServer). probeNodeNativeCompat answers off the loop; ensureStableNodeSymlink
 * then uses those answers and spawns no probe of its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const probeCalls: string[][] = [];
const syncSpawns: string[] = [];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: (file: string, args?: readonly string[], options?: unknown) => {
      syncSpawns.push(file);
      if (Array.isArray(args) && args[0] === '-e') probeCalls.push([file, ...args]);
      return (real.execFileSync as (...a: unknown[]) => unknown)(file, args, options);
    },
  };
});

const { ensureStableNodeSymlink, probeNodeNativeCompat } = await import('../../src/commands/setup.js');
const { SafeFsExecutor } = await import('../../src/core/SafeFsExecutor.js');

let projectDir: string;

beforeEach(() => {
  probeCalls.length = 0;
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-probe-'));
  // A stand-in native module (an empty file: every probe answers false, which is still an answer).
  const nativeDir = path.join(projectDir, '.instar', 'shadow-install', 'node_modules', 'better-sqlite3', 'build', 'Release');
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, 'better_sqlite3.node'), '');
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/node-symlink-async-probe.test.ts' });
});

describe('node symlink ABI probe runs off the event loop', () => {
  it('probes every candidate asynchronously, then the symlink step spawns no sync probe', async () => {
    const probed = await probeNodeNativeCompat(projectDir);
    expect(probed.nativeCompat.size).toBeGreaterThan(0);
    expect(probed.candidates).toContain(process.execPath);
    expect(probeCalls).toHaveLength(0);
    const syncCallsBefore = syncSpawns.length;
    const link = ensureStableNodeSymlink(projectDir, undefined, { nativeCompat: probed.nativeCompat, candidates: probed.candidates });
    expect(fs.existsSync(link)).toBe(true);
    expect(probeCalls).toHaveLength(0);
    // No `brew --prefix node` on the main thread either: the candidates came from the async probe.
    expect(syncSpawns.slice(syncCallsBefore).filter((f) => f === 'brew')).toHaveLength(0);
  });

  it('without the probed answers it still probes synchronously (behavior unchanged for other callers)', () => {
    ensureStableNodeSymlink(projectDir);
    expect(probeCalls.length).toBeGreaterThan(0);
  });

  it('returns an empty map when there is no native module to probe', async () => {
    SafeFsExecutor.safeRmSync(path.join(projectDir, '.instar', 'shadow-install'), { recursive: true, force: true, operation: 'tests/unit/node-symlink-async-probe.test.ts' });
    const probed = await probeNodeNativeCompat(projectDir);
    expect(probed.nativeCompat.size).toBe(0);
    expect(probed.candidates).toContain(process.execPath);
  });
});
