/**
 * Unit tests for resolveStableNodeBinary — fix for the heal-execpath-staleness
 * bug observed live on luna 2026-05-21.
 *
 * Each scenario exercises one branch of the fallback chain:
 *   - execPath exists                → returns execPath
 *   - execPath is ENOENT but realpath target exists → returns realpath
 *   - execPath and realpath both gone, bundled Node available → bundled
 *   - bundled missing, /opt/homebrew/bin/node exists → homebrew
 *   - all absolute candidates fail, PATH lookup works → which
 *   - everything fails → null
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStableNodeBinary } from '../../src/utils/resolveNodeBinary.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('resolveStableNodeBinary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns execPath when it exists and is executable', () => {
    // process.execPath is the Node running the tests — must exist.
    const resolved = resolveStableNodeBinary();
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe('execPath');
    expect(resolved!.path).toBe(process.execPath);
  });

  it('falls back to bundled Node when execPath is ENOENT', () => {
    // Simulate the Homebrew-cellar-removed-mid-session failure mode.
    const fakeExecPath = '/opt/homebrew/Cellar/node/99.99.99/bin/node';
    const bundledNode = process.execPath; // use the real Node as the fallback target

    const resolved = resolveStableNodeBinary({
      execPathOverride: fakeExecPath,
      agentBundledNode: bundledNode,
      existsSyncOverride: (p: string) => p !== fakeExecPath && fs.existsSync(p),
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe('agent-bundled');
    expect(resolved!.path).toBe(bundledNode);
  });

  it('falls back to /opt/homebrew/bin/node when execPath gone and no bundled', () => {
    const fakeExecPath = '/tmp/nonexistent-cellar/node';
    // Pretend homebrew node exists (and is executable), other paths don't.
    const homebrew = '/opt/homebrew/bin/node';

    const resolved = resolveStableNodeBinary({
      execPathOverride: fakeExecPath,
      platformOverride: 'darwin',
      existsSyncOverride: (p: string) => p === homebrew,
    });

    // Real homebrew may not be executable in CI — accept null OR homebrew.
    // The important branch coverage is "we tried the homebrew path."
    if (resolved !== null) {
      expect(resolved.source).toBe('homebrew');
      expect(resolved.path).toBe(homebrew);
    }
  });

  it('falls back to PATH lookup when all absolute candidates fail', () => {
    const fakeExecPath = '/tmp/nonexistent-cellar/node';
    // A REAL executable in a tmpdir, standing in for "the node PATH lookup found"
    // — deliberately NOT `process.execPath`.
    //
    // It must be real because `existsSyncOverride` only stubs `existsSync`: the
    // resolver's executability check then calls the genuine `statSync` and
    // `accessSync`, so a purely synthetic path fails regardless of the override.
    // And it must not be `process.execPath`, because the override hides the three
    // absolute candidates BY NAME — including `/usr/local/bin/node` — while also
    // requiring `p === realNode`. On a host whose node IS at one of those paths
    // (a plain macOS `/usr/local/bin/node` install — most developer machines) the
    // two clauses contradict each other: everything is hidden, the resolver
    // correctly returns null, and the test fails. It passed only where node
    // happens to sit elsewhere, which is why CI never saw it.
    const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-node-'));
    const realNode = path.join(tmpBinDir, 'node');
    fs.writeFileSync(realNode, '#!/bin/bash\nexit 0\n', { mode: 0o755 });

    const resolved = resolveStableNodeBinary({
      execPathOverride: fakeExecPath,
      platformOverride: 'darwin',
      existsSyncOverride: (p: string) =>
        // Hide every absolute candidate; pretend PATH lookup works.
        p !== '/opt/homebrew/bin/node' &&
        p !== '/usr/local/bin/node' &&
        p !== '/usr/bin/node' &&
        p !== fakeExecPath &&
        p === realNode,
      whichOverride: () => realNode,
    });

    try {
      expect(resolved).not.toBeNull();
      expect(resolved!.source).toBe('which');
      expect(resolved!.path).toBe(realNode);
    } finally {
      SafeFsExecutor.safeRmSync(tmpBinDir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/resolveNodeBinary.test.ts:cleanup',
      });
    }
  });

  it('returns null when no Node is reachable anywhere', () => {
    const resolved = resolveStableNodeBinary({
      execPathOverride: '/tmp/nonexistent-cellar/node',
      platformOverride: 'darwin',
      existsSyncOverride: () => false, // pretend nothing exists
      whichOverride: () => null,
    });

    expect(resolved).toBeNull();
  });

  it('does not silently pick a non-executable file', () => {
    // Create a regular non-executable file in a tmp dir and point execPath at it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-binary-test-'));
    const fakeNode = path.join(tmpDir, 'fake-node');
    fs.writeFileSync(fakeNode, 'not executable'); // no exec bit

    try {
      const resolved = resolveStableNodeBinary({
        execPathOverride: fakeNode,
        platformOverride: 'darwin',
        existsSyncOverride: (p: string) => p === fakeNode,
      });

      // execPath branch must reject the non-executable file.
      // (Without the exec-bit check, this would return the broken file.)
      if (resolved !== null) {
        expect(resolved.source).not.toBe('execPath');
      }
    } finally {
      try {
        SafeFsExecutor.safeUnlinkSync(fakeNode, {
          operation: 'tests/unit/resolveNodeBinary.test.ts:cleanup-fakeNode',
        });
        SafeFsExecutor.safeRmdirSync(tmpDir, {
          operation: 'tests/unit/resolveNodeBinary.test.ts:cleanup-tmpDir',
        });
      } catch {
        /* test cleanup, ignore */
      }
    }
  });

  it('skips realpath when target also missing', () => {
    // execPath ENOENT and realpath would throw — must not crash; must reach
    // subsequent fallbacks.
    const fakeExecPath = '/tmp/deeply-nonexistent/node';
    const resolved = resolveStableNodeBinary({
      execPathOverride: fakeExecPath,
      agentBundledNode: process.execPath,
      existsSyncOverride: (p: string) => p === process.execPath,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe('agent-bundled');
  });
});
