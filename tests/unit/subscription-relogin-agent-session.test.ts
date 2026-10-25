/**
 * Orchestrator + store behavior added by skill-driven sign-in repair (spec
 * skill-driven-signin-repair): the pre-attempt check (lease, capacity, helper account) that
 * runs BEFORE an attempt is counted, the approval that survives queueing (capped at 60 min),
 * the `no-healthy-seat` hand-off, the per-attempt notices, and the breaker scope.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionReloginOrchestrator, type ReloginPreAttemptVerdict } from '../../src/core/SubscriptionReloginOrchestrator.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';
import { resolveReloginNavigation } from '../../src/core/SubscriptionReloginRuntime.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'relogin-agent-session.test cleanup' }); });

function fixture(verdicts: ReloginPreAttemptVerdict[] = [{ kind: 'ok' }]) {
  let now = Date.parse('2026-09-25T18:00:00.000Z');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-agent-session-')); dirs.push(stateDir);
  const store = new SubscriptionReloginStore({ stateDir, now: () => now, idFactory: () => 'repair-1' });
  const suggested = store.suggest({ sourceEpisodeId: 7, accountId: 'acct-1', machineId: 'machine-1', mode: 'approval',
    inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
  const approved = store.approve(suggested.id, { inputDigest: suggested.inputDigest });
  let sourceOpen = true; let active = false;
  const preAttempt = vi.fn(async () => verdicts.length > 1 ? verdicts.shift()! : verdicts[0]!);
  const releaseAttempt = vi.fn();
  const ports = {
    store, authorityReady: () => true, sourceIncidentOpen: () => sourceOpen,
    recoverUncertain: vi.fn(async () => 'credential-ready' as const),
    startOrRecoverLogin: vi.fn(async () => ({ attemptId: 'a', kind: 'url-code-paste' as const,
      expiresAt: new Date(now + 600_000).toISOString(), reissueCount: 0 })),
    driveBrowser: vi.fn(async () => ({ outcome: 'approved' as const, pasteCode: 'code-1' })),
    finishCli: vi.fn(async () => 'complete' as const),
    verifyIdentity: vi.fn(async () => 'match' as const),
    quarantineIdentityMismatch: vi.fn(async () => undefined),
    verifyAuthenticatedUse: vi.fn(async () => true),
    finalizeSuccess: vi.fn(async () => { sourceOpen = false; active = true; }),
    accountActive: () => active, preAttempt, releaseAttempt, now: () => now, retryBaseMs: 1_000, maxAttempts: 3,
  };
  return { store, approved, ports, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('agent-session pre-attempt check (orchestrator)', () => {
  it('waits WITHOUT counting an attempt and keeps the approval alive while the seat is busy', async () => {
    const f = fixture([{ kind: 'wait', reason: 'helper-seat-lease-held' }]);
    const orchestrator = new SubscriptionReloginOrchestrator(f.ports);
    const before = Date.parse(f.approved.approvalExpiresAt!);
    f.advance(14 * 60_000); // nearly the 15-minute default approval
    const result = await orchestrator.tick(f.approved.id);
    expect(result).toMatchObject({ outcome: 'waiting', reason: 'helper-seat-lease-held' });
    expect(result.episode.attemptCount).toBe(0);
    expect(result.episode.state).toBe('approved');
    expect(Date.parse(result.episode.approvalExpiresAt!)).toBeGreaterThan(before);
    expect(f.ports.startOrRecoverLogin).not.toHaveBeenCalled();
    expect(f.ports.releaseAttempt).not.toHaveBeenCalled(); // nothing was acquired
    f.store.close();
  });

  it('a queued approval still dies at the 60-minute cap (approval-expired), never lives forever', async () => {
    const f = fixture([{ kind: 'wait', reason: 'session-capacity-full' }]);
    const orchestrator = new SubscriptionReloginOrchestrator(f.ports);
    let result = await orchestrator.tick(f.approved.id);
    for (let i = 0; i < 20 && result.episode.state === 'approved'; i++) {
      f.advance(4 * 60_000);
      result = await orchestrator.tick(f.approved.id);
    }
    expect(result.episode.state).toBe('failed');
    expect(f.store.listEvents(f.approved.id).map((e) => e.eventClass)).toContain('approval-expired');
    expect(f.now() - Date.parse(f.approved.approvedAt!)).toBeGreaterThanOrEqual(60 * 60_000);
    f.store.close();
  });

  it('no healthy helper account ⇒ approved → waiting-operator-only / no-healthy-seat with one operator-only notice', async () => {
    const f = fixture([{ kind: 'no-healthy-seat' }]);
    const result = await new SubscriptionReloginOrchestrator(f.ports).tick(f.approved.id);
    expect(result).toMatchObject({ outcome: 'waiting', reason: 'no-healthy-seat' });
    expect(result.episode).toMatchObject({ state: 'waiting-operator-only', failureClass: 'no-healthy-seat', attemptCount: 0 });
    expect(f.store.claimNotifications(10).map((n) => n.kind)).toContain('operator-only');
    f.store.close();
  });

  it('an approval that already lapsed (e.g. across downtime) is never revived by a waiting tick', async () => {
    const f = fixture([{ kind: 'wait', reason: 'helper-seat-lease-held' }]);
    f.advance(16 * 60_000); // past the 15-minute approval, never extended
    const result = await new SubscriptionReloginOrchestrator(f.ports).tick(f.approved.id);
    expect(result.episode.state).toBe('failed');
    expect(f.store.listEvents(f.approved.id)[0]!.eventClass).toBe('approval-expired');
    f.store.close();
  });

  it('ok ⇒ the attempt runs and releaseAttempt fires exactly once when the tick ends', async () => {
    const f = fixture([{ kind: 'ok' }]);
    const result = await new SubscriptionReloginOrchestrator(f.ports).tick(f.approved.id);
    expect(result.episode.state).toBe('succeeded');
    expect(f.ports.releaseAttempt).toHaveBeenCalledTimes(1);
    f.store.close();
  });

  it('agent-sign-in-unfinished ends FAILED (not refused) and does not open the 24-hour breaker', async () => {
    const f = fixture([{ kind: 'ok' }]);
    f.ports.driveBrowser.mockResolvedValue({ outcome: 'refused', failureClass: 'agent-sign-in-unfinished', reason: 'agent-helper-exited' } as never);
    const result = await new SubscriptionReloginOrchestrator(f.ports).tick(f.approved.id);
    expect(result.episode).toMatchObject({ state: 'failed', failureClass: 'agent-sign-in-unfinished' });
    const events = f.store.listEvents(f.approved.id);
    expect(events[0]).toMatchObject({ eventClass: 'agent-sign-in-unfinished', reason: 'agent-helper-exited' });
    expect(f.store.isBreakerOpen('acct-1', 'anthropic')).toBe(false); // one failure < threshold 3
    f.store.close();
  });

  it('a server-verified wrong-identity still opens the breaker on this path', async () => {
    const f = fixture([{ kind: 'ok' }]);
    f.ports.verifyIdentity.mockResolvedValue('mismatch' as never);
    const result = await new SubscriptionReloginOrchestrator(f.ports).tick(f.approved.id);
    expect(result.episode).toMatchObject({ state: 'refused', failureClass: 'wrong-identity' });
    expect(f.store.isBreakerOpen('acct-1', 'anthropic')).toBe(true);
    f.store.close();
  });

  it('without preAttempt the orchestrator behaves exactly as before (no extension, expiry first)', async () => {
    const f = fixture();
    const { preAttempt: _p, releaseAttempt: _r, ...ports } = f.ports;
    f.advance(16 * 60_000);
    const result = await new SubscriptionReloginOrchestrator(ports).tick(f.approved.id);
    expect(result.episode.state).toBe('failed');
    f.store.close();
  });
});

describe('store additions', () => {
  it('extendApproval is version-checked, only extends, and caps at 60 minutes after approval', () => {
    const f = fixture();
    const ep = f.store.get(f.approved.id)!;
    const extended = f.store.extendApproval(ep.id, ep.version, new Date(f.now() + 30 * 60_000).toISOString());
    expect(Date.parse(extended.approvalExpiresAt!)).toBe(f.now() + 30 * 60_000);
    expect(() => f.store.extendApproval(ep.id, ep.version, new Date(f.now() + 40 * 60_000).toISOString())).toThrow('episode-version-conflict');
    const capped = f.store.extendApproval(extended.id, extended.version, new Date(f.now() + 5 * 60 * 60_000).toISOString());
    expect(Date.parse(capped.approvalExpiresAt!)).toBe(Date.parse(capped.approvedAt!) + 60 * 60_000);
    const noShrink = f.store.extendApproval(capped.id, capped.version, new Date(f.now()).toISOString());
    expect(noShrink.version).toBe(capped.version);
    f.store.close();
  });

  it('each attempt gets its own phone-tap / operator-only notice (attempt number in the delivery key)', () => {
    const f = fixture();
    const store = f.store;
    let ep = store.transition(f.approved.id, { expectedVersion: f.approved.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    store.enqueuePhoneTap(ep.id);
    store.enqueuePhoneTap(ep.id); // idempotent within an attempt
    ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'waiting-operator-only', eventClass: 'x', failureClass: 'automation-permission' });
    const first = store.claimNotifications(10);
    expect(first.map((n) => n.deliveryKey).sort()).toEqual([
      'subscription-relogin:repair-1:operator-only:1', 'subscription-relogin:repair-1:phone-tap:1',
      'subscription-relogin:repair-1:suggested:0',
    ].sort());
    for (const n of first) store.completeNotification(n.id);
    ep = store.approve(ep.id, { inputDigest: ep.inputDigest });
    ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    store.enqueuePhoneTap(ep.id);
    store.transition(ep.id, { expectedVersion: ep.version, to: 'waiting-operator-only', eventClass: 'x', failureClass: 'no-healthy-seat' });
    expect(store.claimNotifications(10).map((n) => n.deliveryKey).sort()).toEqual([
      'subscription-relogin:repair-1:operator-only:2', 'subscription-relogin:repair-1:phone-tap:2',
    ]);
    store.close();
  });

  it('a second operator-only reason within ONE attempt gets its own notice (never silently dropped)', () => {
    const f = fixture();
    const store = f.store;
    let ep = store.transition(f.approved.id, { expectedVersion: f.approved.version, to: 'waiting-operator-only',
      eventClass: 'no-healthy-seat', failureClass: 'no-healthy-seat' });
    const first = store.claimNotifications(10).filter((n) => n.kind === 'operator-only');
    expect(first.map((n) => n.deliveryKey)).toEqual(['subscription-relogin:repair-1:operator-only:0']);
    for (const n of first) store.completeNotification(n.id);
    ep = store.approve(ep.id, { inputDigest: ep.inputDigest });
    store.transition(ep.id, { expectedVersion: ep.version, to: 'waiting-operator-only', eventClass: 'no-healthy-seat', failureClass: 'no-healthy-seat' });
    const second = store.claimNotifications(10).filter((n) => n.kind === 'operator-only');
    expect(second.map((n) => n.deliveryKey)).toEqual(['subscription-relogin:repair-1:operator-only:0.2']);
    store.close();
  });

  it('accepts the two new failure classes and the approved → waiting-operator-only transition', () => {
    const f = fixture();
    const ep = f.store.transition(f.approved.id, { expectedVersion: f.approved.version, to: 'waiting-operator-only',
      eventClass: 'no-healthy-seat', failureClass: 'no-healthy-seat' });
    expect(ep.state).toBe('waiting-operator-only');
    expect(f.store.cancel(ep.id).state).toBe('cancelled');
    f.store.close();
  });
});

describe('resolveReloginNavigation', () => {
  it('honors agent-session on macOS only; omitted ⇒ agent-session on a macOS development agent', () => {
    expect(resolveReloginNavigation('agent-session', {}, 'darwin')).toBe('agent-session');
    expect(resolveReloginNavigation(undefined, { developmentAgent: true }, 'darwin')).toBe('agent-session');
    expect(resolveReloginNavigation(undefined, { developmentAgent: false }, 'darwin')).toBe('closed');
    // Off macOS: the existing driver, exactly as before.
    expect(resolveReloginNavigation('agent-session', { developmentAgent: true }, 'linux')).toBe('agent');
    expect(resolveReloginNavigation('agent-session', { developmentAgent: false }, 'linux')).toBe('closed');
    expect(resolveReloginNavigation(undefined, { developmentAgent: true }, 'linux')).toBe('agent');
    // An explicit legacy value always wins (rollback lever).
    expect(resolveReloginNavigation('closed', { developmentAgent: true }, 'darwin')).toBe('closed');
    expect(resolveReloginNavigation('agent', { developmentAgent: true }, 'darwin')).toBe('agent');
  });
});
