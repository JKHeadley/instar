// safe-git-allow: test fixture cleanup uses fs.rmSync on per-test tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on per-test tmp dirs only.
/**
 * B1 (multimachine-lease-poll-robustness, Decisions 5/6) — the cross-process
 * poll-intent file: integrity (PID/ts freshness) + atomic round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writePollIntent, readPollIntent, effectivePollIntent, pollIntentPath,
  writePollActive, readPollActive, pidAlive,
  type PollIntentRecord,
} from '../../src/core/pollIntent.js';

const NOW = 1_000_000_000;
const rec = (over: Partial<PollIntentRecord> = {}): PollIntentRecord => ({
  shouldPoll: true, leaseEpoch: 5, role: 'awake', serverPid: 123, bootId: 'boot-1', ts: NOW, ...over,
});

describe('B1 pollIntent — integrity + freshness', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pollintent-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes + reads back a record atomically', () => {
    writePollIntent(dir, rec());
    const back = readPollIntent(dir);
    expect(back).toMatchObject({ shouldPoll: true, role: 'awake', serverPid: 123 });
  });

  it('missing file → null (no opinion)', () => {
    expect(readPollIntent(dir)).toBeNull();
  });

  it('corrupt/partial JSON → null (treated as no opinion, never trusted)', () => {
    writeFileSync(pollIntentPath(dir), '{ this is not json', 'utf8');
    expect(readPollIntent(dir)).toBeNull();
    writeFileSync(pollIntentPath(dir), JSON.stringify({ role: 'awake' }), 'utf8'); // missing shouldPoll
    expect(readPollIntent(dir)).toBeNull();
  });

  describe('effectivePollIntent (the freshness/trust gate)', () => {
    const fresh = { nowMs: NOW, maxStaleMs: 60_000, serverPidAlive: true };

    it('fresh + live writer → the record shouldPoll', () => {
      expect(effectivePollIntent(rec({ shouldPoll: true }), fresh)).toBe(true);
      expect(effectivePollIntent(rec({ shouldPoll: false }), fresh)).toBe(false);
    });

    it('null record → null (no opinion)', () => {
      expect(effectivePollIntent(null, fresh)).toBeNull();
    });

    it('STALE record (older than maxStaleMs) → null — a stale shouldPoll:true can NOT resurrect a poller', () => {
      const stale = effectivePollIntent(rec({ shouldPoll: true, ts: NOW - 120_000 }), { ...fresh });
      expect(stale).toBeNull();
    });

    it('DEAD writer pid → null — a crashed server\'s opinion is not trusted', () => {
      expect(effectivePollIntent(rec({ shouldPoll: true }), { ...fresh, serverPidAlive: false })).toBeNull();
    });

    it('fresh shouldPoll:false from a live writer → false (a real mute, honored)', () => {
      expect(effectivePollIntent(rec({ shouldPoll: false }), fresh)).toBe(false);
    });
  });

  describe('lifeline-poll-active (B5 truth source) + pidAlive', () => {
    it('writes + reads the real poll state', () => {
      writePollActive(dir, true);
      expect(readPollActive(dir)).toMatchObject({ pollingActive: true, pid: process.pid });
      writePollActive(dir, false);
      expect(readPollActive(dir)?.pollingActive).toBe(false);
    });
    it('missing / corrupt poll-active → null', () => {
      expect(readPollActive(dir)).toBeNull();
      writeFileSync(join(dir, 'lifeline-poll-active.json'), 'nope', 'utf8');
      expect(readPollActive(dir)).toBeNull();
    });
    it('pidAlive: this process is alive; a bogus pid is not; invalid → false', () => {
      expect(pidAlive(process.pid)).toBe(true);
      expect(pidAlive(2_147_483_646)).toBe(false); // almost-certainly-unused high pid
      expect(pidAlive(0)).toBe(false);
      expect(pidAlive(-1)).toBe(false);
    });
  });
});
