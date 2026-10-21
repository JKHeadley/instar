/**
 * Restart holds: the AutoUpdater holds an update restart while in-flight work a restart would
 * LOSE exists (a pairing invite waiting for approval: its secret is in memory only), through the
 * same durable deferral record and retry timer as session deferral, bounded by each hold's own
 * end time (docs/specs/a2a-pairing-invite-link.md §8; live walk 2026-10-20).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import { UpdateGate, type RestartHold } from '../../src/core/UpdateGate.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { PairingInviteStore } from '../../src/threadline/PairingInviteStore.js';
import { PairingInviteFlow } from '../../src/threadline/PairingInviteFlow.js';
import { MarkedPairingInviteFlow, PairingPendingAcceptMarkers } from '../../src/threadline/PairingPendingAcceptMarkers.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';

const checker = () => ({
  getInstalledVersion: vi.fn().mockReturnValue('0.9.8'),
  check: vi.fn(), applyUpdate: vi.fn(), getLastCheck: vi.fn().mockReturnValue(null),
} as unknown as UpdateChecker);
const state = () => ({ get: vi.fn().mockReturnValue(997), set: vi.fn() } as unknown as StateManager);

describe('AutoUpdater restart holds', () => {
  let tmpDir: string;
  let log: ReturnType<typeof vi.spyOn>;
  const restartFile = () => path.join(tmpDir, 'state', 'restart-requested.json');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-updater-holds-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    log = vi.spyOn(console, 'log');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/AutoUpdater-restart-holds.test.ts' });
  });

  function updater(holds: () => RestartHold[]) {
    const u = new AutoUpdater(checker(), state(), tmpDir, { preRestartDelaySecs: 0 });
    u.setSessionDeps({ listRunningSessions: () => [] });
    u.setRestartHold('pairing-invite', holds);
    return u;
  }
  const gated = (u: AutoUpdater, bypass = false) => (u as unknown as { gatedRestart(v: string, b?: boolean): Promise<void> }).gatedRestart('0.9.9', bypass);

  it('holds while an invite waits, logs why, and records it on the existing durable deferral', async () => {
    const until = Date.now() + 40 * 60_000;
    const u = updater(() => [{ name: 'pairing-invite:abcd1234', until, reason: 'a pairing invite from "Scout" is waiting for the operator\'s approval' }]);
    await gated(u);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fs.existsSync(restartFile())).toBe(false);
    const d = u.getStatus().restartDeferral!;
    expect(d).toMatchObject({ active: true, targetVersion: '0.9.9', currentBlockers: ['pairing-invite:abcd1234'] });
    expect(d.reason).toContain('held for in-flight work: a pairing invite from "Scout"');
    expect(d.reason).toContain(new Date(until).toISOString());
    // Re-checked at the normal 5-minute cadence, not only at the invite's expiry.
    expect(Date.parse(d.nextRetryAt!) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(log.mock.calls.some((c) => String(c[0]).includes('[AutoUpdater] Restart deferred for v0.9.9: held for in-flight work'))).toBe(true);
    // Durable: the same row the session deferral uses.
    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'auto-updater.json'), 'utf8'));
    expect(persisted.restartDeferral.currentBlockers).toEqual(['pairing-invite:abcd1234']);
    u.stop();
  });

  it('releases once the accept finishes (the hold is gone at the next re-check)', async () => {
    let holds: RestartHold[] = [{ name: 'pairing-invite:abcd1234', until: Date.now() + 40 * 60_000, reason: 'invite waiting' }];
    const u = updater(() => holds);
    await gated(u);
    holds = []; // approved or declined
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 3_000);
    expect(fs.existsSync(restartFile())).toBe(true);
    expect(u.getStatus().restartDeferral).toBeNull();
    u.stop();
  });

  it('is bounded by the invite\'s expiry: a hold past its end holds nothing, and the retry fires at the end', async () => {
    const until = Date.now() + 2 * 60_000;
    // A provider that keeps reporting the hold (as a stale one would) cannot extend it.
    const u = updater(() => [{ name: 'pairing-invite:abcd1234', until, reason: 'invite waiting' }]);
    await gated(u);
    expect(Date.parse(u.getStatus().restartDeferral!.nextRetryAt!)).toBeLessThanOrEqual(until + 1_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fs.existsSync(restartFile())).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000 + 4_000);
    expect(fs.existsSync(restartFile())).toBe(true);
    u.stop();
  });

  it('respects maxDeferralHours (4 h): a hold that would last 20 h stops holding after 4 h', async () => {
    const u = updater(() => [{ name: 'pairing-invite:abcd1234', until: Date.now() + 20 * 3_600_000, reason: 'invite waiting' }]);
    await gated(u);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000 + 50 * 60_000);
    expect(fs.existsSync(restartFile())).toBe(false);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fs.existsSync(restartFile())).toBe(true);
    expect(log.mock.calls.some((c) => String(c[0]).includes('Restart holds for v0.9.9 ignored: max deferral (4h) reached'))).toBe(true);
    u.stop();
  });

  it('the max-deferral clock is the durable first deferral: a server restart does not reset it', async () => {
    const holds = () => [{ name: 'pairing-invite:abcd1234', until: Date.now() + 20 * 3_600_000, reason: 'invite waiting' }];
    fs.writeFileSync(path.join(tmpDir, 'state', 'auto-updater.json'), JSON.stringify({
      restartDeferral: {
        active: true, targetVersion: '0.9.9', firstDeferredAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
        reason: 'held', currentBlockers: ['pairing-invite:abcd1234'], nextRetryAt: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: new Date().toISOString(),
      },
    }));
    const u = updater(holds);
    await gated(u);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fs.existsSync(restartFile())).toBe(true);
    u.stop();
  });

  it('near the max-deferral ceiling the re-check lands at the ceiling, not a full 5 minutes later', async () => {
    const holds = () => [{ name: 'pairing-invite:abcd1234', until: Date.now() + 20 * 3_600_000, reason: 'invite waiting' }];
    const first = Date.now() - (4 * 3_600_000 - 2 * 60_000); // ceiling in 2 min
    fs.writeFileSync(path.join(tmpDir, 'state', 'auto-updater.json'), JSON.stringify({
      restartDeferral: {
        active: true, targetVersion: '0.9.9', firstDeferredAt: new Date(first).toISOString(),
        reason: 'held', currentBlockers: ['pairing-invite:abcd1234'], nextRetryAt: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: new Date().toISOString(),
      },
    }));
    const u = updater(holds);
    await gated(u);
    expect(Date.parse(u.getStatus().restartDeferral!.nextRetryAt!)).toBeLessThanOrEqual(first + 4 * 3_600_000 + 1_000);
    u.stop();
  });

  it('a manual apply (operator act) is not held', async () => {
    const u = updater(() => [{ name: 'pairing-invite:abcd1234', until: Date.now() + 40 * 60_000, reason: 'invite waiting' }]);
    await gated(u, true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fs.existsSync(restartFile())).toBe(true);
    u.stop();
  });

  it('no holds: restarts as before', async () => {
    const u = updater(() => []);
    await gated(u);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fs.existsSync(restartFile())).toBe(true);
    u.stop();
  });

  it('with the real invite engine: held while an invite waits, released after it is declined', async () => {
    const kpA = generateIdentityKeyPair();
    const kpB = generateIdentityKeyPair();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'holds-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'holds-b-'));
    const base = (dir: string, kp: { publicKey: Buffer; privateKey: Buffer }, name: string) => ({
      store: new PairingInviteStore(dir), trust: new AgentTrustManager({ stateDir: dir }),
      identity: () => ({ fp: kp.publicKey.toString('hex').slice(0, 32), publicKeyHex: kp.publicKey.toString('hex'), privateKey: kp.privateKey }),
      relayKeyFor: async () => null, sendPlaintext: () => {}, sendToKey: () => {}, notify: () => {},
      ownName: () => ({ owner: `${name}-owner`, agent: name }), schedule: (fn: () => void) => fn(),
    });
    const inv = new PairingInviteFlow(base(dirA, kpA, 'Scout')).createInvite() as { ok: true; iid: string; message: string };
    const flow = new MarkedPairingInviteFlow(base(dirB, kpB, 'Carl'), new PairingPendingAcceptMarkers(dirB));
    const u = updater(() => flow.restartHolds());
    await flow.receiveInvite(inv.message);
    await gated(u);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fs.existsSync(restartFile())).toBe(false);
    expect(u.getStatus().restartDeferral?.reason).toContain('"Scout"');
    flow.declineAccept(inv.iid);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 3_000);
    expect(fs.existsSync(restartFile())).toBe(true);
    u.stop();
  });
});

describe('UpdateGate.getActiveHolds', () => {
  it('returns only holds still in force, soonest first; a throwing provider holds nothing', () => {
    const g = new UpdateGate();
    const now = 1_000_000;
    g.setRestartHoldProvider('a', () => [{ name: 'late', until: now + 50, reason: 'r' }, { name: 'gone', until: now, reason: 'r' }]);
    g.setRestartHoldProvider('b', () => [{ name: 'soon', until: now + 10, reason: 'r' }, { name: 'nan', until: Number.NaN, reason: 'r' }]);
    g.setRestartHoldProvider('c', () => { throw new Error('boom'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(g.getActiveHolds(now).map((h) => h.name)).toEqual(['soon', 'late']);
  });

  it('a provider registered again under the same key replaces the old one', () => {
    const g = new UpdateGate();
    g.setRestartHoldProvider('k', () => [{ name: 'old', until: 10, reason: 'r' }]);
    g.setRestartHoldProvider('k', () => []);
    expect(g.getActiveHolds(0)).toEqual([]);
  });
});
