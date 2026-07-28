/**
 * StateManager.listSessions read-cache — the fix for the systemic CPU hot-loop
 * where listSessions re-read + re-parsed EVERY session file on EVERY call (it's
 * called each tick by the reaper + sentinels via listRunningSessions). The cache
 * collapses sub-second redundant calls into one disk read, and is invalidated on
 * any session write so spawns/terminations stay instantly visible.
 *
 * Both sides of every boundary: cache HIT within TTL, MISS after TTL, immediate
 * invalidation on saveSession/removeSession, filter correctness, copy-safety.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mkSession = (over?: Partial<Session>): Session => ({
  id: 'a', name: 'sess', status: 'running', tmuxSession: 'tmux-a',
  startedAt: new Date(0).toISOString(), ...over,
});

describe('StateManager.listSessions cache', () => {
  let tmpDir: string;
  let clock: number;
  let sm: StateManager;
  const sessionsDir = () => path.join(tmpDir, 'state', 'sessions');
  // Write a session file DIRECTLY (bypassing saveSession) to simulate a disk
  // change the in-memory cache has NOT been told about.
  const writeDirect = (s: Session) =>
    fs.writeFileSync(path.join(sessionsDir(), `${s.id}.json`), JSON.stringify(s));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-smcache-'));
    fs.mkdirSync(sessionsDir(), { recursive: true });
    clock = 1_000_000;
    sm = new StateManager(tmpDir, { now: () => clock });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/state-manager-listsessions-cache.test.ts' });
  });

  it('serves a cache HIT within the TTL (a direct disk add is NOT seen until TTL elapses)', () => {
    sm.saveSession(mkSession({ id: 'a' }));
    expect(sm.listSessions().map(s => s.id).sort()).toEqual(['a']); // primes the cache
    writeDirect(mkSession({ id: 'b' }));                            // disk changed, cache stale
    expect(sm.listSessions().map(s => s.id).sort()).toEqual(['a']); // HIT — 'b' not seen
    clock += 1100;                                                  // past the 1000ms TTL
    expect(sm.listSessions().map(s => s.id).sort()).toEqual(['a', 'b']); // MISS — re-read
  });

  it('saveSession invalidates immediately (a spawn is visible on the very next call, no TTL wait)', () => {
    sm.saveSession(mkSession({ id: 'a' }));
    sm.listSessions(); // prime
    sm.saveSession(mkSession({ id: 'c' })); // write through the funnel
    expect(sm.listSessions().map(s => s.id).sort()).toEqual(['a', 'c']); // same clock instant
  });

  it('removeSession invalidates immediately (a termination is gone on the next call)', () => {
    sm.saveSession(mkSession({ id: 'a' }));
    sm.saveSession(mkSession({ id: 'b' }));
    sm.listSessions(); // prime
    sm.removeSession('a');
    expect(sm.listSessions().map(s => s.id).sort()).toEqual(['b']); // same clock instant
  });

  it('applies the status filter to the cached list', () => {
    // Distinct tmux names: two RUNNING records sharing one name would now be
    // collapsed by the ghost-record supersession invariant (saveSession).
    sm.saveSession(mkSession({ id: 'a', status: 'running', tmuxSession: 'tmux-a' }));
    sm.saveSession(mkSession({ id: 'b', status: 'completed', tmuxSession: 'tmux-b' }));
    sm.saveSession(mkSession({ id: 'c', status: 'running', tmuxSession: 'tmux-c' }));
    expect(sm.listSessions({ status: 'running' }).map(s => s.id).sort()).toEqual(['a', 'c']);
    // second call (cache hit) returns the same filtered result
    expect(sm.listSessions({ status: 'completed' }).map(s => s.id)).toEqual(['b']);
  });

  it('returns copies — mutating a result cannot corrupt the shared cache', () => {
    sm.saveSession(mkSession({ id: 'a', status: 'running' }));
    const first = sm.listSessions();
    first[0].status = 'completed'; // mutate the returned object
    const second = sm.listSessions(); // cache hit
    expect(second[0].status).toBe('running'); // cache untouched
  });

  it('still returns correct data + survives a corrupt session file (skips it)', () => {
    sm.saveSession(mkSession({ id: 'a' }));
    fs.writeFileSync(path.join(sessionsDir(), 'bad.json'), '{ not json');
    clock += 1100; // force a fresh read so the corrupt file is encountered
    expect(sm.listSessions().map(s => s.id)).toEqual(['a']); // corrupt skipped, valid kept
  });
});
