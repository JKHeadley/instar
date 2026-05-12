/**
 * Unit tests for ProjectRoundLock.
 *
 * Covers:
 *   - Acquire on a free lock succeeds; second acquire by an alive PID is rejected.
 *   - Release returns true on a held lock, false on an absent one.
 *   - Stale-PID sweep: acquire succeeds when the previous holder PID is dead.
 *   - read() returns null when the file is absent or malformed.
 *   - isAlive() helper handles the edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRoundLock, isAlive } from '../../src/core/ProjectRoundLock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'round-lock-'));
}

describe('ProjectRoundLock', () => {
  let dir: string;
  beforeEach(() => { dir = makeStateDir(); });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundLock.test.ts:afterEach' }); } catch { /* ignore */ }
  });

  it('acquire succeeds on a free lock', () => {
    const l = new ProjectRoundLock({ stateDir: dir });
    const r = l.acquire('proj-a', 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.projectId).toBe('proj-a');
      expect(r.payload.roundIndex).toBe(0);
      expect(r.payload.pid).toBe(process.pid);
    }
  });

  it('acquire is rejected when the lock is held by an alive PID', () => {
    const l = new ProjectRoundLock({ stateDir: dir });
    const first = l.acquire('proj-a', 0);
    expect(first.ok).toBe(true);
    const second = l.acquire('proj-b', 1);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('held');
      expect(second.currentHolder.projectId).toBe('proj-a');
    }
  });

  it('acquire succeeds when the lock is held by a dead PID (stale sweep)', () => {
    // Write a lock file with a definitely-dead PID directly.
    const localDir = path.join(dir, 'local');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(
      path.join(localDir, 'round-runner.lock'),
      JSON.stringify({ pid: 999999, projectId: 'ghost', roundIndex: 0, acquiredAt: new Date().toISOString() })
    );
    const l = new ProjectRoundLock({ stateDir: dir });
    const r = l.acquire('proj-a', 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.projectId).toBe('proj-a');
  });

  it('release returns true on a held lock, false on an absent lock', () => {
    const l = new ProjectRoundLock({ stateDir: dir });
    expect(l.release()).toBe(false);
    l.acquire('proj-a', 0);
    expect(l.release()).toBe(true);
    expect(l.release()).toBe(false);
  });

  it('read returns null when no lock file exists', () => {
    const l = new ProjectRoundLock({ stateDir: dir });
    expect(l.read()).toBe(null);
  });

  it('read returns null when the lock file is malformed', () => {
    const localDir = path.join(dir, 'local');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'round-runner.lock'), 'not json');
    const l = new ProjectRoundLock({ stateDir: dir });
    expect(l.read()).toBe(null);
  });
});

describe('isAlive', () => {
  it('returns true for the current process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });
  it('returns false for a definitely-dead PID', () => {
    expect(isAlive(999999)).toBe(false);
  });
  it('returns false for invalid input', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(Number.NaN)).toBe(false);
  });
});
