// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
// Listen early (2026-11-16): the typed boot state (bootReadiness on /health) and
// the restart attribution record the next boot reads back.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  BootReadinessTracker, BOOT_SUBSYSTEMS, isPeerBooting, DEFAULT_RETRY_AFTER_S, MAX_RETRY_AFTER_S, MIN_RETRY_AFTER_S,
} from '../../src/server/BootReadiness.js';
import {
  describeRestartRequester, recordRestartRequest, readLastRestartRequest, restartRequestsLogPath, UNATTRIBUTED_RESTART_LABEL,
} from '../../src/core/restartRequestAttribution.js';

let stateDir: string;
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-readiness-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/boot-readiness.test.ts' }); });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('BootReadinessTracker', () => {
  it('starts "starting" with every subsystem pending and a retry estimate', () => {
    const c = clock();
    const t = new BootReadinessTracker(c.now, c.now());
    const s = t.snapshot();
    expect(s.state).toBe('starting');
    expect(s.readyAt).toBeNull();
    expect(s.retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_S);
    expect(Object.keys(s.subsystems)).toEqual([...BOOT_SUBSYSTEMS]);
    expect(Object.values(s.subsystems).every((v) => v === 'pending')).toBe(true);
    expect(s.phase).toBeNull();
  });

  it('marks subsystems in order and reports the last as the phase', () => {
    const c = clock();
    const t = new BootReadinessTracker(c.now, c.now());
    t.mark('config');
    t.mark('instance-lock');
    const s = t.snapshot();
    expect(s.subsystems.config).toBe('ready');
    expect(s.subsystems['instance-lock']).toBe('ready');
    expect(s.subsystems.messaging).toBe('pending');
    expect(s.phase).toBe('instance-lock');
  });

  it('ready: no retry hint, unmarked subsystems become not-started, and marks after ready are ignored', () => {
    const c = clock();
    const t = new BootReadinessTracker(c.now, c.now());
    t.mark('config');
    c.advance(4_000);
    t.markReady();
    t.mark('messaging');
    const s = t.snapshot();
    expect(s.state).toBe('ready');
    expect(s.retryAfterSeconds).toBeUndefined();
    expect(s.elapsedMs).toBe(4_000);
    expect(s.subsystems.http).toBe('ready');
    expect(s.subsystems.messaging).toBe('not-started');
    expect(s.phase).toBe('http');
  });

  it('persists the boot length and the next boot bases its Retry-After on it, bounded both ways', () => {
    const c = clock();
    const first = new BootReadinessTracker(c.now, c.now());
    first.init(stateDir);
    c.advance(90_000);
    first.markReady();

    const c2 = clock(5_000_000);
    const second = new BootReadinessTracker(c2.now, c2.now());
    second.init(stateDir);
    expect(second.snapshot().lastBootMs).toBe(90_000);
    // 90 s expected, 0 elapsed: capped at the maximum.
    expect(second.retryAfterSeconds()).toBe(MAX_RETRY_AFTER_S);
    c2.advance(80_000); // 10 s left
    expect(second.retryAfterSeconds()).toBe(10);
    c2.advance(9_500); // under the floor
    expect(second.retryAfterSeconds()).toBe(MIN_RETRY_AFTER_S);
    c2.advance(60_000); // overrun: still the floor, never negative
    expect(second.retryAfterSeconds()).toBe(MIN_RETRY_AFTER_S);
  });

  it('an unreadable boot record falls back to the default estimate', () => {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'boot-readiness.json'), '{not json');
    const c = clock();
    const t = new BootReadinessTracker(c.now, c.now());
    t.init(stateDir);
    expect(t.retryAfterSeconds()).toBe(DEFAULT_RETRY_AFTER_S);
  });

  it('reports the early listen and, only when asked, the restart that ended the last process', () => {
    recordRestartRequest(stateDir, { requestedAt: '2026-11-16T19:42:12Z', plannedRestart: true, reason: 'load a setting' }, 'supervisor');
    const c = clock();
    const t = new BootReadinessTracker(c.now, c.now());
    t.init(stateDir);
    t.markListeningEarly('0.0.0.0');
    t.markListeningEarly('127.0.0.1'); // first one wins
    expect(t.snapshot().earlyListen?.host).toBe('0.0.0.0');
    expect(t.snapshot().previousRestart).toBeUndefined();
    expect(t.snapshot({ includePreviousRestart: true }).previousRestart).toMatchObject({ attributed: false, requestedBy: null, reason: 'load a setting' });
  });

  it('without a recorded restart, previousRestart is null when asked for', () => {
    const t = new BootReadinessTracker();
    t.init(stateDir);
    expect(t.snapshot({ includePreviousRestart: true }).previousRestart).toBeNull();
  });
});

describe('restart request attribution', () => {
  it('names a requester only from a non-empty string requestedBy', () => {
    expect(describeRestartRequester({ requestedBy: 'auto-updater' })).toEqual({ attributed: true, label: 'auto-updater' });
    for (const by of [undefined, null, '', '   ', 42, {}]) {
      expect(describeRestartRequester({ requestedBy: by })).toEqual({ attributed: false, label: UNATTRIBUTED_RESTART_LABEL });
    }
    expect(describeRestartRequester(null).attributed).toBe(false);
  });

  it('flattens and bounds what it records', () => {
    const rec = recordRestartRequest(stateDir, { requestedBy: 'a\nb', reason: 'x'.repeat(500), pid: 123, targetVersion: '1.2.3' }, 'supervisor', new Date('2026-11-16T00:00:00Z'));
    expect(rec.requestedBy).toBe('a b');
    expect(rec.reason?.length).toBe(200);
    expect(rec.writerPid).toBe(123);
    expect(readLastRestartRequest(stateDir)).toEqual(rec);
  });

  it('reads the latest of several records and skips a torn line', () => {
    recordRestartRequest(stateDir, { requestedBy: 'first' }, 'supervisor');
    fs.appendFileSync(restartRequestsLogPath(stateDir), '{"torn":\n');
    recordRestartRequest(stateDir, { requestedBy: 'second' }, 'foreground-watcher');
    expect(readLastRestartRequest(stateDir)?.requestedBy).toBe('second');
  });

  it('keeps the log bounded', () => {
    const file = restartRequestsLogPath(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ at: 'x', attributed: true })}\n`.repeat(12000));
    expect(fs.statSync(file).size).toBeGreaterThan(256 * 1024);
    recordRestartRequest(stateDir, { requestedBy: 'after-trim' }, 'supervisor');
    expect(fs.statSync(file).size).toBeLessThan(200 * 1024);
    expect(readLastRestartRequest(stateDir)?.requestedBy).toBe('after-trim');
  });

  it('never throws when it cannot write', () => {
    const blocker = path.join(stateDir, 'logs');
    fs.writeFileSync(blocker, 'a file where the logs dir should be');
    expect(() => recordRestartRequest(stateDir, { requestedBy: 'x' }, 'supervisor')).not.toThrow();
    expect(readLastRestartRequest(stateDir)).toBeNull();
  });
});

describe('isPeerBooting', () => {
  const res = (status: number, headers: Record<string, string> = {}) => new Response('{}', { status, headers });
  it('is true only for a 503 carrying x-instar-boot-state: starting', () => {
    expect(isPeerBooting(res(503, { 'x-instar-boot-state': 'starting' }))).toBe(true);
    expect(isPeerBooting(res(503))).toBe(false); // feature off there, or any other 503
    expect(isPeerBooting(res(200, { 'x-instar-boot-state': 'starting' }))).toBe(false);
    expect(isPeerBooting({ status: 503, headers: null })).toBe(false);
  });
});
