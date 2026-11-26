import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  plannedRestartVerifyState,
  readPlannedRestartVerifyState,
  markPlannedRestartDeferred,
  recentlyRequestedPlannedRestart,
  PLANNED_RESTART_DELIVERY_MS,
  PEER_RESTART_HOLD_MS,
  VERIFY_RESTART_HOLD_MS,
  peerHoldPath,
  plannedRestartBypassesHolds,
  mergeHoldPath,
  MERGE_HANDOFF_RESTART_HOLD_MS,
  MERGE_SETTLE_RESTART_HOLD_MS,
  EXIT_SETTLE_RESTART_HOLD_MS,
  exitSeenPath,
} from '../../src/core/PlannedRestartVerifyGuard.js';
import { ForegroundRestartWatcher } from '../../src/core/ForegroundRestartWatcher.js';
import { PEER_LIMITS } from '../../src/localVerify/peer.js';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('planned restart / local verify coordination', () => {
  let dir: string;
  const flag = (now: number, plannedRestart = true) => ({
    requestedAt: new Date(now).toISOString(), requestedBy: 'setting-change', plannedRestart,
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
  });
  const flagPath = () => path.join(dir, 'state', 'restart-requested.json');
  const markerPath = () => path.join(dir, 'state', 'local-verify', 'inflight.json');
  const marker = (startedAt: number, pid: number | null = process.pid) => {
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
    fs.writeFileSync(markerPath(), JSON.stringify({ pr: 1, headSha: 'a'.repeat(40), attemptToken: 'token', startedAt, pid, pgid: pid }));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planned-restart-verify-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  });
  afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'planned-restart-verify-guard.test.ts' }); });

  it('holds only a live, bounded verification and preserves the planned request', () => {
    const now = Date.now();
    marker(now - 10_000);
    fs.writeFileSync(flagPath(), JSON.stringify(flag(now)));
    expect(readPlannedRestartVerifyState(dir, now)).toMatchObject({ pending: true, hold: true, pendingSinceMs: now });
    expect(plannedRestartVerifyState(dir, flag(now, false), now).hold).toBe(false);
    expect(plannedRestartVerifyState(dir, { ...flag(now), bypassHolds: true }, now)).toMatchObject({ pending: true, hold: false });
    expect(plannedRestartVerifyState(dir, flag(now - VERIFY_RESTART_HOLD_MS), now).hold).toBe(false);
    marker(now - VERIFY_RESTART_HOLD_MS);
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(false);
    fs.writeFileSync(flagPath(), 'null');
    expect(readPlannedRestartVerifyState(dir, now).pending).toBe(false);
    expect(recentlyRequestedPlannedRestart(dir, null, now)).toBe(false);
  });

  describe('the exit gap: the child is gone and the server has not handled its exit yet (2026-11-19: a finished 39.6-minute run was cancelled)', () => {
    const gone = () => false;
    const alive = () => true;
    const seen = () => JSON.parse(fs.readFileSync(exitSeenPath(dir), 'utf8')) as { v: number; attemptToken: string; seenAt: number };

    it('a live pid holds for the run bound and writes no sighting (unchanged)', () => {
      const now = Date.now();
      marker(now - 10_000, 4242);
      expect(plannedRestartVerifyState(dir, flag(now), now, alive)).toMatchObject({ hold: true, holdUntilMs: now - 10_000 + VERIFY_RESTART_HOLD_MS });
      expect(fs.existsSync(exitSeenPath(dir))).toBe(false);
    });

    it('pid gone with the marker still present holds for the settle window, counted from the first sighting', () => {
      const now = Date.now();
      marker(now - 40 * 60_000, 4242);
      expect(plannedRestartVerifyState(dir, flag(now), now, gone)).toMatchObject({ pending: true, hold: true, holdUntilMs: now + EXIT_SETTLE_RESTART_HOLD_MS });
      expect(seen()).toEqual({ v: 1, attemptToken: 'token', seenAt: now });
      // A later look (the other consumer, another process) reads the same sighting: the window is not renewed.
      expect(plannedRestartVerifyState(dir, flag(now), now + 30_000, gone)).toMatchObject({ hold: true, holdUntilMs: now + EXIT_SETTLE_RESTART_HOLD_MS });
      expect(seen().seenAt).toBe(now);
    });

    it('the window ends at its bound: one millisecond before holds, the bound itself does not', () => {
      const now = Date.now();
      marker(now - 40 * 60_000, 4242);
      expect(plannedRestartVerifyState(dir, flag(now), now, gone).hold).toBe(true);
      expect(plannedRestartVerifyState(dir, flag(now), now + EXIT_SETTLE_RESTART_HOLD_MS - 1, gone).hold).toBe(true);
      expect(plannedRestartVerifyState(dir, flag(now), now + EXIT_SETTLE_RESTART_HOLD_MS, gone).hold).toBe(false);
      expect(plannedRestartVerifyState(dir, flag(now), now + 10 * EXIT_SETTLE_RESTART_HOLD_MS, gone).hold).toBe(false);
    });

    it('a stale marker left by a server that died stops holding at the bound and never starts a second window', () => {
      const now = Date.now();
      marker(now - 2 * 60 * 60_000, 4242); // the server died two hours ago; nothing will ever clear this marker
      const request = flag(now);
      expect(plannedRestartVerifyState(dir, request, now, gone).hold).toBe(true);
      for (const later of [EXIT_SETTLE_RESTART_HOLD_MS, EXIT_SETTLE_RESTART_HOLD_MS + 10_000, 5 * 60_000, 30 * 60_000]) {
        expect(plannedRestartVerifyState(dir, request, now + later, gone).hold, String(later)).toBe(false);
      }
      // A second request half an hour later meets the same marker: the sighting is spent, it is not held at all.
      expect(plannedRestartVerifyState(dir, flag(now + 30 * 60_000), now + 30 * 60_000, gone).hold).toBe(false);
    });

    it('the marker being cleared ends the hold at once, inside the window', () => {
      const now = Date.now();
      marker(now - 40 * 60_000, 4242);
      expect(plannedRestartVerifyState(dir, flag(now), now, gone).hold).toBe(true);
      SafeFsExecutor.safeUnlinkSync(markerPath(), { operation: 'planned-restart-verify-guard.test.ts:exit-gap-clear' });
      expect(plannedRestartVerifyState(dir, flag(now), now + 1, gone).hold).toBe(false);
    });

    it('once the marker is cleared the settling merge hold takes over, and nothing holds without it', () => {
      const now = Date.now();
      marker(now - 40 * 60_000, 4242);
      expect(plannedRestartVerifyState(dir, flag(now), now, gone).hold).toBe(true);
      // What the exit handler does: the settling marker first, then the in-flight marker goes.
      fs.writeFileSync(mergeHoldPath(dir), JSON.stringify({ v: 1, phase: 'settling', since: now + 200 }));
      SafeFsExecutor.safeUnlinkSync(markerPath(), { operation: 'planned-restart-verify-guard.test.ts:exit-gap-settling' });
      expect(plannedRestartVerifyState(dir, flag(now), now + 300, gone)).toMatchObject({ hold: true, holdUntilMs: now + 200 + MERGE_SETTLE_RESTART_HOLD_MS });
    });

    it('bypassHolds skips the settle window and writes no sighting', () => {
      const now = Date.now();
      marker(now - 40 * 60_000, 4242);
      expect(plannedRestartVerifyState(dir, { ...flag(now), bypassHolds: true }, now, gone)).toMatchObject({ pending: true, hold: false });
      expect(fs.existsSync(exitSeenPath(dir))).toBe(false);
    });

    it('a request that is not a planned restart, or is three hours old, never waits for it', () => {
      const now = Date.now();
      marker(now - 40 * 60_000, 4242);
      expect(plannedRestartVerifyState(dir, flag(now, false), now, gone).hold).toBe(false);
      expect(plannedRestartVerifyState(dir, flag(now - VERIFY_RESTART_HOLD_MS), now, gone).hold).toBe(false);
      expect(fs.existsSync(exitSeenPath(dir))).toBe(false);
      // One millisecond younger than three hours still waits.
      expect(plannedRestartVerifyState(dir, flag(now - VERIFY_RESTART_HOLD_MS + 1), now, gone).hold).toBe(true);
    });

    it('the window never reaches past the run\'s own three-hour bound, and a marker past it does not hold', () => {
      const now = Date.now();
      const startedAt = now - VERIFY_RESTART_HOLD_MS + 20_000;
      marker(startedAt, 4242);
      expect(plannedRestartVerifyState(dir, flag(now), now, gone)).toMatchObject({ hold: true, holdUntilMs: startedAt + VERIFY_RESTART_HOLD_MS });
      marker(now - VERIFY_RESTART_HOLD_MS, 4242);
      expect(plannedRestartVerifyState(dir, flag(now), now, gone).hold).toBe(false);
    });

    it('a sighting belongs to one run: the next run\'s exit gets its own window', () => {
      const now = Date.now();
      marker(now - 40 * 60_000, 4242);
      expect(plannedRestartVerifyState(dir, flag(now), now, gone).hold).toBe(true);
      const later = now + 30 * 60_000;
      fs.writeFileSync(markerPath(), JSON.stringify({ pr: 2, headSha: 'c'.repeat(40), attemptToken: 'token-2', startedAt: later - 25 * 60_000, pid: 4343, pgid: 4343 }));
      expect(plannedRestartVerifyState(dir, flag(later), later, gone)).toMatchObject({ hold: true, holdUntilMs: later + EXIT_SETTLE_RESTART_HOLD_MS });
      expect(seen()).toEqual({ v: 1, attemptToken: 'token-2', seenAt: later });
    });

    it('a sighting that cannot be written does not hold (an unrecorded window would restart at every poll)', () => {
      const now = Date.now();
      marker(now - 40 * 60_000, 4242);
      vi.spyOn(SafeFsExecutor, 'atomicWriteJsonSync').mockImplementation(() => { throw new Error('disk unavailable'); });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(plannedRestartVerifyState(dir, flag(now), now, gone).hold).toBe(false);
      expect(warning).toHaveBeenCalledWith('[PlannedRestartVerifyGuard] Could not record the exit sighting; not holding the restart for the settle window');
    });

    it('a sighting for this run with an unusable time does not hold', () => {
      const now = Date.now();
      marker(now - 40 * 60_000, 4242);
      for (const seenAt of [now + 60_000, 'soon', null]) {
        fs.writeFileSync(exitSeenPath(dir), JSON.stringify({ v: 1, attemptToken: 'token', seenAt }));
        expect(plannedRestartVerifyState(dir, flag(now), now, gone).hold, String(seenAt)).toBe(false);
      }
    });

    it('a pre-spawn marker (no pid yet) keeps its own 30-second rule and gets no settle window', () => {
      const now = Date.now();
      marker(now - 31_000, null);
      expect(plannedRestartVerifyState(dir, flag(now), now, gone).hold).toBe(false);
      expect(fs.existsSync(exitSeenPath(dir))).toBe(false);
    });

    // A pid that no process has: the largest pid is far below this on macOS and Linux.
    const DEAD_PID = 2_000_000_000;

    it('foreground watcher does not consume the request in the gap, and consumes it once the marker is cleared', async () => {
      const now = Date.now();
      marker(now - 40 * 60_000, DEAD_PID);
      fs.writeFileSync(flagPath(), JSON.stringify(flag(now)));
      const watcher = new ForegroundRestartWatcher({ stateDir: dir, exitOnRestart: false });
      const detected = vi.fn();
      watcher.on('restartDetected', detected);
      const check = () => (watcher as unknown as { check(): Promise<void> }).check();
      await check();
      await check();
      expect(detected).not.toHaveBeenCalled();
      expect(fs.existsSync(flagPath())).toBe(true);
      SafeFsExecutor.safeUnlinkSync(markerPath(), { operation: 'planned-restart-verify-guard.test.ts:gap-foreground' });
      await check();
      expect(detected).toHaveBeenCalledOnce();
      expect(fs.existsSync(flagPath())).toBe(false);
    });

    it('foreground watcher consumes the request when the window has run out on a marker nobody cleared', async () => {
      const now = Date.now();
      marker(now - 40 * 60_000, DEAD_PID);
      fs.writeFileSync(exitSeenPath(dir), JSON.stringify({ v: 1, attemptToken: 'token', seenAt: now - EXIT_SETTLE_RESTART_HOLD_MS - 1 }));
      fs.writeFileSync(flagPath(), JSON.stringify(flag(now)));
      const watcher = new ForegroundRestartWatcher({ stateDir: dir, exitOnRestart: false });
      const detected = vi.fn();
      watcher.on('restartDetected', detected);
      await (watcher as unknown as { check(): Promise<void> }).check();
      expect(detected).toHaveBeenCalledOnce();
      expect(fs.existsSync(flagPath())).toBe(false);
    });

    it('supervisor does not restart in the gap, sees the sighting the watcher wrote, and restarts once the marker is cleared', async () => {
      const now = Date.now();
      marker(now - 40 * 60_000, DEAD_PID);
      fs.writeFileSync(flagPath(), JSON.stringify(flag(now)));
      // The server's own watcher looks first and writes the sighting; the supervisor is another process reading the same file.
      const watcher = new ForegroundRestartWatcher({ stateDir: dir, exitOnRestart: false });
      await (watcher as unknown as { check(): Promise<void> }).check();
      const first = seen().seenAt;
      const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir: dir });
      const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
      const check = () => (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
      check();
      expect(restart).not.toHaveBeenCalled();
      expect(fs.existsSync(flagPath())).toBe(true);
      expect(seen().seenAt).toBe(first);
      SafeFsExecutor.safeUnlinkSync(markerPath(), { operation: 'planned-restart-verify-guard.test.ts:gap-supervisor' });
      check();
      expect(restart).toHaveBeenCalledOnce();
      expect(fs.existsSync(flagPath())).toBe(false);
    });

    it('supervisor restarts through a bypassed request in the gap', () => {
      const now = Date.now();
      marker(now - 40 * 60_000, DEAD_PID);
      fs.writeFileSync(flagPath(), JSON.stringify({ ...flag(now), bypassHolds: true }));
      const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir: dir });
      const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
      (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
      expect(restart).toHaveBeenCalledOnce();
    });
  });

  it('protects the pre-spawn intent briefly, then releases an orphan with no child', () => {
    const now = Date.now();
    marker(now - 10_000, null);
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(true);
    marker(now - 31_000, null);
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(false);
    fs.writeFileSync(markerPath(), '{broken');
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(false);
    fs.writeFileSync(markerPath(), 'null');
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(false);
  });

  it('keeps a planned request deliverable after the hold ceiling, not forever', () => {
    const now = Date.now();
    const requested = now - VERIFY_RESTART_HOLD_MS - 1;
    expect(recentlyRequestedPlannedRestart(dir, flag(now - 2 * 60 * 60_000), now)).toBe(false);
    marker(requested);
    expect(markPlannedRestartDeferred(dir, flag(requested), requested + 1000)).toBe(true);
    expect(recentlyRequestedPlannedRestart(dir, flag(requested), now)).toBe(true);
    expect(recentlyRequestedPlannedRestart(dir, flag(now - PLANNED_RESTART_DELIVERY_MS - 1), now)).toBe(false);
    expect(recentlyRequestedPlannedRestart(dir, flag(now, false), now)).toBe(false);
    expect(recentlyRequestedPlannedRestart(dir, null, now)).toBe(false);
  });

  it('lets maintenance proceed when deferred-request proof cannot be persisted', () => {
    const now = Date.now();
    marker(now - 10_000);
    const write = vi.spyOn(SafeFsExecutor, 'atomicWriteJsonSync').mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(markPlannedRestartDeferred(dir, flag(now), now)).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('[PlannedRestartVerifyGuard] Could not persist restart deferral; proceeding with restart');
    expect(recentlyRequestedPlannedRestart(dir, flag(now), now)).toBe(false);
  });

  it('foreground watcher leaves the flag intact during the run and consumes it after', async () => {
    const now = Date.now();
    marker(now - 10_000);
    fs.writeFileSync(flagPath(), JSON.stringify(flag(now)));
    const watcher = new ForegroundRestartWatcher({ stateDir: dir, exitOnRestart: false });
    const detected = vi.fn();
    watcher.on('restartDetected', detected);
    await (watcher as unknown as { check(): Promise<void> }).check();
    expect(fs.existsSync(flagPath())).toBe(true);
    expect(detected).not.toHaveBeenCalled();
    SafeFsExecutor.safeUnlinkSync(markerPath(), { operation: 'planned-restart-verify-guard.test.ts:foreground-marker' });
    await (watcher as unknown as { check(): Promise<void> }).check();
    expect(fs.existsSync(flagPath())).toBe(false);
    expect(detected).toHaveBeenCalledOnce();
  });

  it('supervisor defers without spending a restart count, then performs it once', () => {
    const now = Date.now();
    marker(now - 10_000);
    fs.writeFileSync(flagPath(), JSON.stringify({ ...flag(now), targetVersion: '1.3.9999' }));
    const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir: dir });
    const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
    const check = () => (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
    check();
    expect(restart).not.toHaveBeenCalled();
    expect(fs.existsSync(flagPath())).toBe(true);
    expect(fs.existsSync(path.join(dir, 'state', 'restart-version-count.json'))).toBe(false);
    SafeFsExecutor.safeUnlinkSync(markerPath(), { operation: 'planned-restart-verify-guard.test.ts:supervisor-marker' });
    check();
    expect(restart).toHaveBeenCalledOnce();
    expect(fs.existsSync(flagPath())).toBe(false);
  });

  it('supervisor restarts at the three-hour ceiling instead of discarding the expired flag', () => {
    const now = Date.now();
    const started = now - VERIFY_RESTART_HOLD_MS - 1;
    marker(started);
    fs.writeFileSync(flagPath(), JSON.stringify(flag(started)));
    expect(markPlannedRestartDeferred(dir, flag(started), started + 1000)).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir: dir });
    const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
    (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
    expect(restart).toHaveBeenCalledOnce();
    expect(fs.existsSync(flagPath())).toBe(false);
  });

  it('supervisor discards an expired planned request beyond the delivery window', () => {
    const now = Date.now();
    const stale = now - PLANNED_RESTART_DELIVERY_MS - 1;
    marker(stale);
    fs.writeFileSync(flagPath(), JSON.stringify(flag(stale)));
    expect(markPlannedRestartDeferred(dir, flag(stale), stale + 1000)).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir: dir });
    const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
    (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
    expect(restart).not.toHaveBeenCalled();
    expect(fs.existsSync(flagPath())).toBe(false);
  });

  it('a fresh verify cannot retroactively revive a never-deferred expired request', () => {
    const now = Date.now();
    const requested = now - 2 * 60 * 60_000;
    marker(now - 10_000);
    fs.writeFileSync(flagPath(), JSON.stringify(flag(requested)));
    expect(markPlannedRestartDeferred(dir, flag(requested), now)).toBe(false);
    expect(recentlyRequestedPlannedRestart(dir, flag(requested), now)).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir: dir });
    const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
    (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
    expect(restart).not.toHaveBeenCalled();
    expect(fs.existsSync(flagPath())).toBe(false);
  });
});

describe('planned restart / accepted peer attempts', () => {
  let dir: string;
  const NOW = Date.parse('2026-11-05T18:00:00.000Z');
  const flag = (requestedAt = NOW) => ({
    requestedAt: new Date(requestedAt).toISOString(), requestedBy: 'update', plannedRestart: true,
    expiresAt: new Date(requestedAt + 60 * 60_000).toISOString(),
  });
  const beat = (o: { writtenAt?: unknown; sentAt?: unknown; raw?: string; v?: unknown; attempts?: unknown } = {}) => {
    fs.mkdirSync(path.dirname(peerHoldPath(dir)), { recursive: true });
    fs.writeFileSync(peerHoldPath(dir), o.raw ?? JSON.stringify({
      v: o.v ?? 1, writtenAt: 'writtenAt' in o ? o.writtenAt : NOW, leaseEpoch: 7,
      attempts: o.attempts ?? [{ attemptId: 'a', pr: 1, sentAt: 'sentAt' in o ? o.sentAt : NOW - 60_000, lastPollOkAt: NOW }],
    }));
  };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planned-restart-peer-')); fs.mkdirSync(path.join(dir, 'state'), { recursive: true }); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'planned-restart-verify-guard.test.ts' }); });

  it('holds until sentAt + the peer hold bound and not past it', () => {
    const sentAt = NOW - 5 * 60_000;
    beat({ sentAt });
    expect(plannedRestartVerifyState(dir, flag(), NOW)).toMatchObject({ hold: true, holdUntilMs: sentAt + PEER_RESTART_HOLD_MS });
    beat({ sentAt: NOW - PEER_RESTART_HOLD_MS });
    expect(plannedRestartVerifyState(dir, flag(), NOW).hold).toBe(false);
  });

  // 2026-11-15, PR 3198: the bound was 21 minutes while green peer runs took 22 to 25, so a waiting
  // restart fired just before the result was imported and the run was abandoned.
  it('still holds for a run that is longer than a typical run but inside the peer run ceiling', () => {
    for (const minutes of [22, 25, 40, 59]) {
      const sentAt = NOW - minutes * 60_000;
      beat({ sentAt });
      expect(plannedRestartVerifyState(dir, flag(), NOW), `${minutes} min`).toMatchObject({ hold: true, holdUntilMs: sentAt + PEER_RESTART_HOLD_MS });
    }
  });

  it('covers the whole peer run ceiling plus one poll, so the bound cannot drift below real run length', () => {
    expect(PEER_RESTART_HOLD_MS).toBeGreaterThanOrEqual(PEER_LIMITS.maxRunMs + PEER_LIMITS.pollMs);
  });

  it('a long-running attempt with a stale heartbeat does not hold', () => {
    beat({ sentAt: NOW - 22 * 60_000, writtenAt: NOW - 91_000 });
    expect(plannedRestartVerifyState(dir, flag(), NOW).hold).toBe(false);
  });

  it('takes the latest of several attempts', () => {
    beat({ attempts: [{ sentAt: NOW - 10 * 60_000 }, { sentAt: NOW - 60_000 }, { sentAt: 'nope' }, null] });
    expect(plannedRestartVerifyState(dir, flag(), NOW).holdUntilMs).toBe(NOW - 60_000 + PEER_RESTART_HOLD_MS);
  });

  it('trusts a heartbeat up to 90 seconds old and no further', () => {
    for (const [age, hold] of [[31_000, true], [89_000, true], [91_000, false]] as const) {
      beat({ writtenAt: NOW - age });
      expect(plannedRestartVerifyState(dir, flag(), NOW).hold).toBe(hold);
    }
  });

  it('a missing, malformed, future or wrong-version heartbeat never defers', () => {
    expect(plannedRestartVerifyState(dir, flag(), NOW).hold).toBe(false);
    for (const bad of [{ raw: '{not json' }, { raw: 'null' }, { writtenAt: NOW + 60_000 }, { writtenAt: 'soon' }, { v: 2 }, { attempts: [] }, { sentAt: NOW + 60_000 }]) {
      beat(bad);
      expect(plannedRestartVerifyState(dir, flag(), NOW).hold).toBe(false);
    }
  });

  it('an explicit bypass ignores the peer hold', () => {
    beat();
    expect(plannedRestartVerifyState(dir, { ...flag(), bypassHolds: true }, NOW)).toMatchObject({ pending: true, hold: false });
  });

  it('with a live local child the later bound wins, capped at the request ceiling', () => {
    const local = (startedAt: number) => {
      fs.writeFileSync(path.join(dir, 'state', 'local-verify', 'inflight.json'), JSON.stringify({ pr: 1, headSha: 'a'.repeat(40), attemptToken: 't', startedAt, pid: process.pid, pgid: process.pid }));
    };
    const sentAt = NOW - 60_000;
    beat({ sentAt });
    local(NOW - VERIFY_RESTART_HOLD_MS + 60_000); // local bound is one minute away, the peer's is later
    expect(plannedRestartVerifyState(dir, flag(), NOW).holdUntilMs).toBe(sentAt + PEER_RESTART_HOLD_MS);
    local(NOW - 1_000); // local bound is later, but the request only has its own three hours
    const requestedAt = NOW - 2 * 60 * 60_000;
    expect(plannedRestartVerifyState(dir, flag(requestedAt), NOW).holdUntilMs).toBe(requestedAt + VERIFY_RESTART_HOLD_MS);
  });

  it('a request that reaches its three-hour ceiling stops waiting, and a peer hold never outlasts it', () => {
    beat();
    expect(plannedRestartVerifyState(dir, flag(NOW - VERIFY_RESTART_HOLD_MS), NOW).hold).toBe(false);
    const requestedAt = NOW - VERIFY_RESTART_HOLD_MS + 60_000;
    expect(plannedRestartVerifyState(dir, flag(requestedAt), NOW).holdUntilMs).toBe(requestedAt + VERIFY_RESTART_HOLD_MS);
  });

  it('marks a peer-only hold as deferred so the request keeps its delivery window', () => {
    beat();
    expect(markPlannedRestartDeferred(dir, flag(), NOW)).toBe(true);
    expect(recentlyRequestedPlannedRestart(dir, flag(), NOW)).toBe(true);
  });

  it('reports an explicit bypass on the pending request', () => {
    expect(plannedRestartBypassesHolds(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'state', 'restart-requested.json'), JSON.stringify({ ...flag(), bypassHolds: true }));
    expect(plannedRestartBypassesHolds(dir)).toBe(true);
  });
});

describe('planned restart / a green run whose merge is in progress', () => {
  let dir: string;
  const NOW = Date.parse('2026-11-12T20:24:42.000Z');
  const flag = (requestedAt = NOW - 60_000, extra: Record<string, unknown> = {}) => ({
    requestedAt: new Date(requestedAt).toISOString(), requestedBy: 'setting-change', plannedRestart: true,
    expiresAt: new Date(requestedAt + 60 * 60_000).toISOString(), ...extra,
  });
  const hold = (o: { phase?: unknown; since?: unknown; v?: unknown; raw?: string } = {}) => {
    fs.mkdirSync(path.dirname(mergeHoldPath(dir)), { recursive: true });
    fs.writeFileSync(mergeHoldPath(dir), o.raw ?? JSON.stringify({ v: o.v ?? 1, phase: o.phase ?? 'handoff', since: 'since' in o ? o.since : NOW - 1_000 }));
  };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planned-restart-merge-')); fs.mkdirSync(path.join(dir, 'state'), { recursive: true }); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'planned-restart-verify-guard.test.ts' }); });

  it('with no run child left, a hand-off in progress still holds the restart, for ten minutes and no longer', () => {
    hold({ since: NOW - 1_000 });
    expect(plannedRestartVerifyState(dir, flag(), NOW)).toMatchObject({ hold: true, holdUntilMs: NOW - 1_000 + MERGE_HANDOFF_RESTART_HOLD_MS });
    hold({ since: NOW - MERGE_HANDOFF_RESTART_HOLD_MS });
    expect(plannedRestartVerifyState(dir, flag(), NOW).hold).toBe(false);
  });

  it('the settling gap between the child exiting and the hand-off holds for one minute only', () => {
    hold({ phase: 'settling', since: NOW - 59_000 });
    expect(plannedRestartVerifyState(dir, flag(), NOW)).toMatchObject({ hold: true, holdUntilMs: NOW - 59_000 + MERGE_SETTLE_RESTART_HOLD_MS });
    hold({ phase: 'settling', since: NOW - 61_000 });
    expect(plannedRestartVerifyState(dir, flag(), NOW).hold).toBe(false);
  });

  it('a missing, malformed, future, wrong-version or unknown-phase marker never defers', () => {
    expect(plannedRestartVerifyState(dir, flag(), NOW).hold).toBe(false);
    for (const o of [{ raw: '{not json' }, { raw: 'null' }, { since: 'soon' }, { since: NOW + 60_000 }, { v: 2 }, { phase: 'merging' }]) {
      hold(o);
      expect(plannedRestartVerifyState(dir, flag(), NOW).hold).toBe(false);
    }
  });

  it('an explicit bypass ignores the merge hold, and the hold never outlasts the request ceiling', () => {
    hold();
    expect(plannedRestartVerifyState(dir, flag(NOW - 60_000, { bypassHolds: true }), NOW).hold).toBe(false);
    const requestedAt = NOW - VERIFY_RESTART_HOLD_MS + 30_000;
    expect(plannedRestartVerifyState(dir, flag(requestedAt), NOW)).toMatchObject({ hold: true, holdUntilMs: requestedAt + VERIFY_RESTART_HOLD_MS });
    expect(plannedRestartVerifyState(dir, flag(NOW - VERIFY_RESTART_HOLD_MS), NOW).hold).toBe(false);
  });

  it('takes the later of a peer attempt and a merge in progress, and marks the request deferred', () => {
    hold({ since: NOW - 1_000 });
    fs.writeFileSync(peerHoldPath(dir), JSON.stringify({ v: 1, writtenAt: NOW, leaseEpoch: 7, attempts: [{ attemptId: 'a', pr: 1, sentAt: NOW - PEER_RESTART_HOLD_MS + 60_000 }] })); // peer bound in 1 min, earlier than the merge bound
    expect(plannedRestartVerifyState(dir, flag(), NOW).holdUntilMs).toBe(NOW - 1_000 + MERGE_HANDOFF_RESTART_HOLD_MS);
    fs.writeFileSync(peerHoldPath(dir), JSON.stringify({ v: 1, writtenAt: NOW, leaseEpoch: 7, attempts: [{ attemptId: 'a', pr: 1, sentAt: NOW - 60_000 }] }));
    expect(plannedRestartVerifyState(dir, flag(), NOW).holdUntilMs).toBe(NOW - 60_000 + PEER_RESTART_HOLD_MS);
    expect(markPlannedRestartDeferred(dir, flag(), NOW)).toBe(true);
  });
});
