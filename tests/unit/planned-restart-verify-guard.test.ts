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
} from '../../src/core/PlannedRestartVerifyGuard.js';
import { ForegroundRestartWatcher } from '../../src/core/ForegroundRestartWatcher.js';
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
    expect(plannedRestartVerifyState(dir, flag(now), now, () => false).hold).toBe(false);
    expect(plannedRestartVerifyState(dir, flag(now, false), now).hold).toBe(false);
    expect(plannedRestartVerifyState(dir, { ...flag(now), bypassHolds: true }, now)).toMatchObject({ pending: true, hold: false });
    expect(plannedRestartVerifyState(dir, flag(now - VERIFY_RESTART_HOLD_MS), now).hold).toBe(false);
    marker(now - VERIFY_RESTART_HOLD_MS);
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(false);
    fs.writeFileSync(flagPath(), 'null');
    expect(readPlannedRestartVerifyState(dir, now).pending).toBe(false);
    expect(recentlyRequestedPlannedRestart(dir, null, now)).toBe(false);
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

  it('holds until sentAt + 21 minutes and not past it', () => {
    const sentAt = NOW - 5 * 60_000;
    beat({ sentAt });
    expect(plannedRestartVerifyState(dir, flag(), NOW)).toMatchObject({ hold: true, holdUntilMs: sentAt + PEER_RESTART_HOLD_MS });
    beat({ sentAt: NOW - PEER_RESTART_HOLD_MS });
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
    fs.writeFileSync(peerHoldPath(dir), JSON.stringify({ v: 1, writtenAt: NOW, leaseEpoch: 7, attempts: [{ attemptId: 'a', pr: 1, sentAt: NOW - 20 * 60_000 }] }));
    expect(plannedRestartVerifyState(dir, flag(), NOW).holdUntilMs).toBe(NOW - 1_000 + MERGE_HANDOFF_RESTART_HOLD_MS);
    fs.writeFileSync(peerHoldPath(dir), JSON.stringify({ v: 1, writtenAt: NOW, leaseEpoch: 7, attempts: [{ attemptId: 'a', pr: 1, sentAt: NOW - 60_000 }] }));
    expect(plannedRestartVerifyState(dir, flag(), NOW).holdUntilMs).toBe(NOW - 60_000 + PEER_RESTART_HOLD_MS);
    expect(markPlannedRestartDeferred(dir, flag(), NOW)).toBe(true);
  });
});
