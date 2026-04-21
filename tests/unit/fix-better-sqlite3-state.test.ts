/**
 * Unit tests for the attempt-tracking state in scripts/fix-better-sqlite3.cjs.
 * Protects the loop-breaker guarantee: once a tuple has exhausted both
 * prebuild AND source, the next invocation must short-circuit instead of
 * re-downloading the same broken prebuild on every launchd respawn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Load the .cjs via createRequire so ESM doesn't choke on the non-module format.
const fixModule: {
  tupleKey: (v: string) => string;
  readState: (dir: string) => unknown;
  writeState: (dir: string, state: unknown) => void;
  recordAttempt: (
    dir: string,
    existing: unknown,
    version: string,
    step: string,
    result: string,
  ) => { key: string; attempts: Array<{ step: string; result: string }>; lastResult: string };
} = require('../../scripts/fix-better-sqlite3.cjs');

let tmpPkg: string;

beforeEach(() => {
  tmpPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-bs3-'));
});

afterEach(() => {
  try {
    if (fs.existsSync(tmpPkg)) fs.rmSync(tmpPkg, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe('fix-better-sqlite3 state machine', () => {
  it('tupleKey includes version, moduleVersion, platform, and arch', () => {
    const key = fixModule.tupleKey('11.3.0');
    // Should not be empty and must contain the version.
    expect(key).toContain('11.3.0');
    expect(key.split('|')).toHaveLength(4);
  });

  it('readState returns null when no state file exists', () => {
    expect(fixModule.readState(tmpPkg)).toBeNull();
  });

  it('readState returns null on corrupt JSON', () => {
    fs.writeFileSync(path.join(tmpPkg, '.instar-fix-state.json'), '{not: valid');
    expect(fixModule.readState(tmpPkg)).toBeNull();
  });

  it('recordAttempt creates a new state with the correct tuple key', () => {
    const state = fixModule.recordAttempt(tmpPkg, null, '11.3.0', 'prebuild', 'prebuild-ok');
    expect(state.key).toBe(fixModule.tupleKey('11.3.0'));
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0].step).toBe('prebuild');
    expect(state.attempts[0].result).toBe('prebuild-ok');
    expect(state.lastResult).toBe('prebuild-ok');
  });

  it('recordAttempt appends to existing state when the tuple key matches', () => {
    const first = fixModule.recordAttempt(tmpPkg, null, '11.3.0', 'prebuild', 'prebuild-failed');
    const second = fixModule.recordAttempt(tmpPkg, first, '11.3.0', 'source', 'source-ok');
    expect(second.attempts).toHaveLength(2);
    expect(second.lastResult).toBe('source-ok');
    // Persisted to disk.
    const onDisk = fixModule.readState(tmpPkg) as typeof second;
    expect(onDisk.attempts).toHaveLength(2);
  });

  it('recordAttempt resets the attempt log when the tuple key changes', () => {
    const first = fixModule.recordAttempt(tmpPkg, null, '11.3.0', 'prebuild', 'prebuild-failed');
    expect(first.attempts).toHaveLength(1);
    // Simulate a different tuple (e.g., bumping better-sqlite3 version) —
    // caller passes `first` as existing, but the key won't match, so recordAttempt
    // must start fresh.
    const second = fixModule.recordAttempt(tmpPkg, first, '11.4.0', 'prebuild', 'prebuild-ok');
    expect(second.key).not.toBe(first.key);
    expect(second.attempts).toHaveLength(1);
    expect(second.lastResult).toBe('prebuild-ok');
  });

  it('state persists across readState/writeState roundtrip with attempt history intact', () => {
    const written = fixModule.recordAttempt(tmpPkg, null, '11.3.0', 'prebuild', 'prebuild-failed');
    const appended = fixModule.recordAttempt(tmpPkg, written, '11.3.0', 'source', 'source-failed');
    const reloaded = fixModule.readState(tmpPkg) as {
      key: string;
      lastResult: string;
      attempts: Array<{ step: string; result: string }>;
    };
    expect(reloaded.key).toBe(appended.key);
    expect(reloaded.lastResult).toBe('source-failed');
    expect(reloaded.attempts.map((a) => `${a.step}:${a.result}`)).toEqual([
      'prebuild:prebuild-failed',
      'source:source-failed',
    ]);
  });

  it('writeState tolerates an unwritable state-file path without throwing', () => {
    // Point at a directory the caller cannot write to; writeState is best-effort.
    const unwritable = '/dev/null/blocked';
    expect(() => fixModule.writeState(unwritable, { key: 'x', attempts: [] })).not.toThrow();
  });
});
