/**
 * The real reconcilePolling, driven with a controlled intent, clock and flush: the three
 * ways review found a held boot could end up deaf or with two pollers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramLifeline } from '../../src/lifeline/TelegramLifeline.js';
import { BOOT_POLL_HOLD_MAX_MS, RECENT_409_WINDOW_MS } from '../../src/lifeline/pollDecision.js';
import { writePollIntent } from '../../src/core/pollIntent.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Rig = {
  polling: boolean; bootPollHeldSinceMs: number; pollStartPending: boolean; pollStartGen: number; pollLoopId: number;
  pollIntentAwakeSinceMs: number; consecutive409s: number; last409AtMs: number; conflict409StartedAt: number | null; pollTimeout: null; projectConfig: unknown;
  flushStaleConnection: () => Promise<void>; poll: () => Promise<void>; reconcilePolling: () => void;
};

let dir: string; let flushes: Array<() => void>; let polls: number;
const tick = () => new Promise<void>((r) => setImmediate(r));
const intent = (shouldPoll: boolean) => writePollIntent(dir, { shouldPoll, leaseEpoch: 1, role: shouldPoll ? 'awake' : 'standby', serverPid: process.pid, bootId: 'b', ts: Date.now() });
const noIntent = () => SafeFsExecutor.safeRmSync(path.join(dir, 'state'), { recursive: true, force: true, operation: 'tests/unit/lifeline-poll-start.test.ts:noIntent' });
function rig(heldSince: number): Rig {
  const l = Object.create(TelegramLifeline.prototype) as Rig;
  Object.assign(l, {
    polling: false, bootPollHeldSinceMs: heldSince, pollStartPending: false, pollStartGen: 0, pollLoopId: 0,
    pollIntentAwakeSinceMs: 0, consecutive409s: 0, last409AtMs: 0, conflict409StartedAt: null, pollTimeout: null,
    projectConfig: { stateDir: dir, multiMachine: { pollFollowsLease: { enabled: true, dryRun: false } } },
    flushStaleConnection: () => new Promise<void>((r) => flushes.push(r)),
    poll: async () => { polls += 1; },
  });
  return l;
}
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-start-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  flushes = []; polls = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lifeline-poll-start.test.ts:cleanup' });
});

describe('a held boot', () => {
  it('stays quiet while the lease says standby', () => {
    const l = rig(Date.now());
    intent(false); l.reconcilePolling();
    expect(flushes).toHaveLength(0);
    expect(l.polling).toBe(false);
  });

  it('starts once the lease says awake, past the debounce', async () => {
    const l = rig(Date.now());
    intent(true); l.reconcilePolling();
    advance(21_000); intent(true); l.reconcilePolling();
    flushes[0](); await tick();
    expect(l.polling).toBe(true);
    expect(polls).toBe(1);
    expect(l.bootPollHeldSinceMs).toBe(0);
  });

  it('review 1: an opinion that disappears still reaches the bound, so the machine is not deaf', async () => {
    const l = rig(Date.now());
    intent(true); l.reconcilePolling();
    noIntent(); advance(BOOT_POLL_HOLD_MAX_MS - 1); l.reconcilePolling();
    expect(flushes).toHaveLength(0);
    advance(1); l.reconcilePolling();
    flushes[0](); await tick();
    expect(l.polling).toBe(true);
  });

  it('with no lease at all, polls at the bound', async () => {
    const l = rig(Date.now());
    l.reconcilePolling();
    advance(BOOT_POLL_HOLD_MAX_MS); l.reconcilePolling();
    flushes[0](); await tick();
    expect(polls).toBe(1);
  });
});

describe('starting a poll', () => {
  const pendingStart = () => {
    const l = rig(0);
    intent(true); l.reconcilePolling();
    advance(21_000); intent(true); l.reconcilePolling();
    expect(flushes).toHaveLength(1);
    return l;
  };

  it('review 2: a slow flush does not start a second loop', async () => {
    const l = pendingStart();
    advance(15_000); intent(true); l.reconcilePolling();
    advance(15_000); intent(true); l.reconcilePolling();
    expect(flushes).toHaveLength(1);
    flushes[0](); await tick();
    expect(polls).toBe(1);
  });

  it('review 3: losing the lease during the flush cancels the start', async () => {
    const l = pendingStart();
    advance(15_000); intent(false); l.reconcilePolling();
    flushes[0](); await tick();
    expect(l.polling).toBe(false);
    expect(polls).toBe(0);
  });

  it('review 3: a standby intent that lands after the last reconcile is read after the flush', async () => {
    const l = pendingStart();
    intent(false);
    flushes[0](); await tick();
    expect(l.polling).toBe(false);
    expect(polls).toBe(0);
  });

  it('a flush that fails lets the next reconcile try again', async () => {
    const l = pendingStart();
    l.flushStaleConnection = () => Promise.reject(new Error('network'));
    l.pollStartPending = false; l.pollStartGen += 1;
    advance(15_000); intent(true); l.reconcilePolling();
    await tick();
    expect(l.pollStartPending).toBe(false);
  });
});

describe('round 2 of review', () => {
  it('force-poll starts even with a standby intent', async () => {
    const l = rig(0);
    l.projectConfig = { stateDir: dir, multiMachine: { pollFollowsLease: { enabled: true, dryRun: false }, pollOverride: 'force-poll' } };
    intent(false); l.reconcilePolling();
    flushes[0](); await tick();
    expect(l.polling).toBe(true);
  });

  const realPoll = (l: Rig) => { delete (l as Partial<Rig>).poll; return l as Rig & { poll: (id?: number) => Promise<void>; getUpdates: () => Promise<never[]> }; };

  it('a retired loop whose read fails with 401 does not stop the newest loop', async () => {
    const l = realPoll(rig(0));
    let fail!: (e: Error) => void;
    l.getUpdates = () => new Promise((_, rej) => { fail = rej; });
    l.polling = true; l.pollLoopId = 1;
    const old = l.poll(1);
    l.pollLoopId = 2;
    fail(new Error('401 Unauthorized')); await old;
    expect(l.polling).toBe(true);
  });

  it('a fatal 401 cancels a pending start', async () => {
    const l = realPoll(rig(0));
    l.getUpdates = () => Promise.reject(new Error('401 Unauthorized'));
    l.pollStartPending = true; l.polling = true; l.pollLoopId = 1;
    const gen = l.pollStartGen;
    await l.poll(1);
    expect(l.pollStartPending).toBe(false);
    expect(l.pollStartGen).toBeGreaterThan(gen);
  });
});

describe('the poll loop', () => {
  it('a retired loop stops at its next turn', async () => {
    const l = rig(0) as Rig & { poll: (id?: number) => Promise<void>; getUpdates: () => Promise<never[]> };
    delete (l as Partial<Rig>).poll;
    let reads = 0;
    l.getUpdates = async () => { reads += 1; return []; };
    l.polling = true; l.pollLoopId = 2;
    await l.poll(1);
    expect(reads).toBe(0);
  });
});

describe('409s from an earlier poll do not block the next start (2026-11-06 drill)', () => {
  it('a machine that got 409s, lost the lease, then regained it starts polling once the 409s are stale', async () => {
    const l = rig(0);
    l.polling = true; l.consecutive409s = 7; l.last409AtMs = Date.now(); l.conflict409StartedAt = Date.now() - 400_000;
    intent(false); l.reconcilePolling();
    expect(l.polling).toBe(false);
    expect(l.conflict409StartedAt).toBeNull(); // a standby is not stuck in a 409 fight
    expect(l.consecutive409s).toBe(7);         // the evidence is kept, not thrown away
    advance(RECENT_409_WINDOW_MS); intent(true); l.reconcilePolling();
    advance(21_000); intent(true); l.reconcilePolling();
    expect(flushes).toHaveLength(1);
    flushes[0](); await tick();
    expect(l.polling).toBe(true);
  });

  it('a lease that flaps back within two minutes of a 409 still holds: never a second poller', () => {
    const l = rig(0);
    l.polling = true; l.consecutive409s = 2; l.last409AtMs = Date.now();
    intent(false); l.reconcilePolling();
    advance(5_000); intent(true); l.reconcilePolling();
    advance(21_000); intent(true); l.reconcilePolling();
    expect(flushes).toHaveLength(0);
    expect(l.polling).toBe(false);
  });

  it('a 409 count with no 409 for two minutes no longer holds the start', () => {
    const l = rig(0);
    l.consecutive409s = 3; l.last409AtMs = Date.now() - RECENT_409_WINDOW_MS - 1;
    intent(true); l.reconcilePolling();
    advance(21_000); intent(true); l.reconcilePolling();
    expect(flushes).toHaveLength(1);
  });

  it('a stale count left by a 401 stop lapses the same way', () => {
    const l = rig(0);
    l.consecutive409s = 4; l.last409AtMs = Date.now() - RECENT_409_WINDOW_MS; // polling ended by a 401 long ago
    intent(true); l.reconcilePolling();
    advance(21_000); intent(true); l.reconcilePolling();
    expect(flushes).toHaveLength(1);
  });

  it('a fresh 409 still holds the start: never a second poller', () => {
    const l = rig(0);
    l.consecutive409s = 1; l.last409AtMs = Date.now();
    intent(true); l.reconcilePolling();
    advance(21_000); intent(true); l.reconcilePolling();
    expect(flushes).toHaveLength(0);
    expect(l.polling).toBe(false);
  });
});

describe('the watchdog still times a new 409 fight', () => {
  it('a 409 after the stuck time was cleared starts it again', async () => {
    const l = Object.create(TelegramLifeline.prototype) as Rig & {
      getUpdates: () => Promise<never>; pollBackoffMs: number; config: object; consecutive429s: number; pollTimeout: ReturnType<typeof setTimeout> | null;
    };
    Object.assign(l, {
      polling: true, pollLoopId: 1, consecutive409s: 3, last409AtMs: 0, conflict409StartedAt: null, consecutive429s: 0,
      pollBackoffMs: 2000, config: {}, pollTimeout: null,
      getUpdates: () => Promise.reject(new Error('Telegram API error (409): Conflict: terminated by other getUpdates request')),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await (TelegramLifeline.prototype as unknown as { poll: (id: number) => Promise<void> }).poll.call(l, 1);
    warn.mockRestore();
    if (l.pollTimeout) clearTimeout(l.pollTimeout);
    expect(l.conflict409StartedAt).toBe(Date.now());
    expect(l.last409AtMs).toBe(Date.now());
    expect(l.consecutive409s).toBe(4);
  });
});
