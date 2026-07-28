// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only (see lint-no-direct-destructive.js:69).
/**
 * Tier 1 (unit) tests for resolveGhBinary.
 *
 * Regression context: the server runs under launchd with a minimal PATH that
 * omits /opt/homebrew/bin, so `execFileSync('gh', …)` died with a raw
 * `spawnSync gh ENOENT` and NO project item could be advanced to `merged`
 * (found 2026-07-25 closing convergence-towards-coherence Tier 1). These tests
 * pin the behaviour that matters: an explicit override wins, a missing binary
 * returns null rather than throwing, and the result is cached.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveGhBinary, __resetGhBinaryCacheForTests } from '../../src/core/resolveGhBinary.js';

let tmp: string;
const savedOverride = process.env.INSTAR_GH_PATH;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-gh-'));
  __resetGhBinaryCacheForTests();
  delete process.env.INSTAR_GH_PATH;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedOverride === undefined) delete process.env.INSTAR_GH_PATH;
  else process.env.INSTAR_GH_PATH = savedOverride;
  __resetGhBinaryCacheForTests();
});

describe('resolveGhBinary', () => {
  it('an explicit INSTAR_GH_PATH override wins over every other source', () => {
    const fake = path.join(tmp, 'gh');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    process.env.INSTAR_GH_PATH = fake;
    expect(resolveGhBinary()).toBe(fake);
  });

  it('ignores an override that does not exist rather than returning a bogus path', () => {
    process.env.INSTAR_GH_PATH = path.join(tmp, 'definitely-not-here');
    // Falls through to real resolution; must never hand back the missing path.
    expect(resolveGhBinary()).not.toBe(process.env.INSTAR_GH_PATH);
  });

  it('returns a string or null and NEVER throws — a missing binary is a normal negative answer', () => {
    const result = resolveGhBinary();
    expect(result === null || typeof result === 'string').toBe(true);
    if (typeof result === 'string') expect(fs.existsSync(result)).toBe(true);
  });

  it('caches the probe result across calls', () => {
    const first = resolveGhBinary();
    const second = resolveGhBinary();
    expect(second).toBe(first);
  });

  it('the override is re-read on every call, so it is not frozen by an earlier cache', () => {
    resolveGhBinary(); // prime the cache via the normal path
    const fake = path.join(tmp, 'gh-late');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    process.env.INSTAR_GH_PATH = fake;
    expect(resolveGhBinary()).toBe(fake);
  });
});
