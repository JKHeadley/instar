import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionReloginOrchestrator } from '../../src/core/SubscriptionReloginOrchestrator.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true, operation: 'subscription-relogin-orchestrator.test cleanup',
  });
});

function fixture() {
  let now = Date.parse('2026-08-28T08:00:00.000Z');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-orchestrator-'));
  dirs.push(stateDir);
  const store = new SubscriptionReloginStore({ stateDir, now: () => now, idFactory: () => 'repair-1' });
  const suggested = store.suggest({ sourceEpisodeId: 7, accountId: 'acct-1', machineId: 'machine-1',
    mode: 'approval', inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1',
    framework: 'claude-code', provider: 'anthropic' });
  const approved = store.approve(suggested.id, { inputDigest: suggested.inputDigest });
  let sourceOpen = true;
  let active = false;
  const ports = {
    store,
    authorityReady: vi.fn(() => true),
    sourceIncidentOpen: vi.fn(() => sourceOpen),
    recoverUncertain: vi.fn(async () => 'credential-ready' as const),
    startOrRecoverLogin: vi.fn(async () => ({ attemptId: 'attempt-1', kind: 'url-code-paste' as const,
      expiresAt: new Date(now + 600_000).toISOString(), reissueCount: 0 })),
    driveBrowser: vi.fn(async () => ({ outcome: 'approved' as const, pasteCode: 'one-time-code' })),
    finishCli: vi.fn(async () => 'complete' as const),
    verifyIdentity: vi.fn(async () => 'match' as const),
    verifyAuthenticatedUse: vi.fn(async () => true),
    finalizeSuccess: vi.fn(async () => { sourceOpen = false; active = true; }),
    accountActive: vi.fn(() => active),
    now: () => now,
    retryBaseMs: 1_000,
    maxAttempts: 3,
  };
  return { store, approved, ports, advance: (ms: number) => { now += ms; } };
}

describe('SubscriptionReloginOrchestrator', () => {
  it('runs the approved repair through identity and authenticated-use proof', async () => {
    const { store, approved, ports } = fixture();
    const result = await new SubscriptionReloginOrchestrator(ports).tick(approved.id);
    expect(result.episode.state).toBe('succeeded');
    expect(ports.finishCli).toHaveBeenCalledWith(
      expect.objectContaining({ id: approved.id }), 'one-time-code', expect.any(AbortSignal));
    expect(ports.verifyIdentity.mock.invocationCallOrder[0])
      .toBeLessThan(ports.verifyAuthenticatedUse.mock.invocationCallOrder[0]);
    expect(store.listEvents(approved.id).map((e) => e.eventClass)).toContain('authenticated-use-verified');
    store.close();
  });

  it('never reports success from a credential witness without authenticated use', async () => {
    const { store, approved, ports } = fixture();
    ports.verifyAuthenticatedUse.mockResolvedValue(false);
    const result = await new SubscriptionReloginOrchestrator(ports).tick(approved.id);
    expect(result).toMatchObject({ outcome: 'waiting', reason: 'verification-failed' });
    expect(result.episode).toMatchObject({ state: 'approved', failureClass: 'verification-failed', attemptCount: 1 });
    expect(ports.finalizeSuccess).not.toHaveBeenCalled();
    store.close();
  });

  it('does not report success until the pool is active and the exact source incident is closed', async () => {
    const { store, approved, ports } = fixture();
    ports.finalizeSuccess.mockImplementation(async () => undefined);
    const result = await new SubscriptionReloginOrchestrator(ports).tick(approved.id);
    expect(result).toMatchObject({ outcome: 'waiting', reason: 'authority-closure-pending',
      episode: { state: 'auth-verifying' } });
    expect(store.listEvents(approved.id).map((event) => event.eventClass))
      .not.toContain('authenticated-use-verified');
    store.close();
  });

  it('stops at a genuine operator-only provider challenge without pretending failure or success', async () => {
    const { store, approved, ports } = fixture();
    ports.driveBrowser.mockResolvedValue({ outcome: 'operator-only', failureClass: 'captcha' });
    const result = await new SubscriptionReloginOrchestrator(ports).tick(approved.id);
    expect(result).toMatchObject({ outcome: 'waiting', reason: 'captcha' });
    expect(result.episode).toMatchObject({ state: 'waiting-operator-only', failureClass: 'captcha' });
    expect(ports.finishCli).not.toHaveBeenCalled();
    store.close();
  });

  it('fails closed before external action when authority degrades or approval expires', async () => {
    const authority = fixture();
    authority.ports.authorityReady.mockReturnValue(false);
    const degraded = await new SubscriptionReloginOrchestrator(authority.ports).tick(authority.approved.id);
    expect(degraded.episode).toMatchObject({ state: 'failed', failureClass: 'authority-degraded' });
    expect(authority.ports.startOrRecoverLogin).not.toHaveBeenCalled();
    authority.store.close();

    const expired = fixture();
    expired.advance(900_001);
    const result = await new SubscriptionReloginOrchestrator(expired.ports).tick(expired.approved.id);
    expect(result.episode).toMatchObject({ state: 'failed', failureClass: 'provider-rejected' });
    expect(expired.ports.startOrRecoverLogin).not.toHaveBeenCalled();
    expired.store.close();
  });

  it('cancels when the source incident self-heals before repair', async () => {
    const { store, approved, ports } = fixture();
    ports.sourceIncidentOpen.mockReturnValue(false);
    const result = await new SubscriptionReloginOrchestrator(ports).tick(approved.id);
    expect(result.episode.state).toBe('cancelled');
    expect(ports.startOrRecoverLogin).not.toHaveBeenCalled();
    store.close();
  });

  it('uses bounded exponential retries and settles loudly at the attempt ceiling', async () => {
    const { store, approved, ports, advance } = fixture();
    ports.driveBrowser.mockResolvedValue({ outcome: 'transient', failureClass: 'provider-transient' });
    const orchestrator = new SubscriptionReloginOrchestrator(ports);
    let result = await orchestrator.tick(approved.id);
    expect(result).toMatchObject({ outcome: 'waiting', reason: 'provider-transient' });
    expect(result.episode.nextAttemptAt).toBe('2026-08-28T08:00:01.000Z');
    advance(1_000);
    result = await orchestrator.tick(approved.id);
    expect(result.episode.attemptCount).toBe(2);
    advance(2_000);
    result = await orchestrator.tick(approved.id);
    expect(result.episode).toMatchObject({ state: 'failed', failureClass: 'attempt-budget-exhausted', attemptCount: 3 });
    store.close();
  });

  it('refuses wrong identity as a non-retryable security terminal', async () => {
    const { store, approved, ports } = fixture();
    ports.driveBrowser.mockResolvedValue({ outcome: 'refused', failureClass: 'wrong-identity' });
    const result = await new SubscriptionReloginOrchestrator(ports).tick(approved.id);
    expect(result.episode).toMatchObject({ state: 'refused', failureClass: 'wrong-identity', attemptCount: 1 });
    store.close();
  });

  it('does not advance or schedule a retry after cancellation aborts an external action', async () => {
    const { store, approved, ports } = fixture();
    let release!: () => void;
    ports.driveBrowser.mockImplementation(async (_episode, _artifact, signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener('abort', resolve, { once: true });
      });
      const error = new Error('cancelled'); error.name = 'AbortError'; throw error;
    });
    const controller = new AbortController();
    const pending = new SubscriptionReloginOrchestrator(ports).tick(approved.id, controller.signal);
    await vi.waitFor(() => expect(ports.driveBrowser).toHaveBeenCalledOnce());
    controller.abort();
    const cancelled = store.cancel(approved.id);
    release();
    const result = await pending;
    expect(result).toMatchObject({ outcome: 'terminal', episode: { state: 'cancelled' } });
    expect(store.get(approved.id)?.version).toBe(cancelled.version);
    expect(store.listEvents(approved.id).map((event) => event.eventClass))
      .not.toContain('transient-retry-scheduled');
    store.close();
  });

  it('enforces the episode wall-clock budget across retries and restart-like ticks', async () => {
    const { store, approved, ports, advance } = fixture();
    ports.driveBrowser.mockResolvedValue({ outcome: 'transient', failureClass: 'provider-transient' });
    const orchestrator = new SubscriptionReloginOrchestrator({ ...ports, maxWallClockMs: 60_000 });
    await orchestrator.tick(approved.id);
    advance(60_000);
    const result = await orchestrator.tick(approved.id);
    expect(result).toMatchObject({ outcome: 'terminal', episode: {
      state: 'failed', failureClass: 'repair-time-budget-exhausted', attemptCount: 1,
    } });
    expect(ports.driveBrowser).toHaveBeenCalledOnce();
    store.close();
  });

  it('re-observes a crashed browser-driving boundary and never replays the browser action', async () => {
    const { store, approved, ports } = fixture();
    const starting = store.transition(approved.id, { expectedVersion: approved.version,
      to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    const ready = store.transition(starting.id, { expectedVersion: starting.version,
      to: 'artifact-ready', eventClass: 'artifact-ready' });
    store.transition(ready.id, { expectedVersion: ready.version,
      to: 'browser-driving', eventClass: 'browser-drive-started' });
    ports.recoverUncertain.mockResolvedValue('credential-ready');
    const result = await new SubscriptionReloginOrchestrator(ports).tick(approved.id);
    expect(result.episode.state).toBe('succeeded');
    expect(ports.recoverUncertain).toHaveBeenCalledOnce();
    expect(ports.driveBrowser).not.toHaveBeenCalled();
    expect(store.listEvents(approved.id).map((event) => event.eventClass))
      .toContain('restart-credential-observed');
    store.close();
  });

  it('parks an inconclusive crashed browser action for the operator instead of replaying it', async () => {
    const { store, approved, ports } = fixture();
    const starting = store.transition(approved.id, { expectedVersion: approved.version,
      to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    const ready = store.transition(starting.id, { expectedVersion: starting.version,
      to: 'artifact-ready', eventClass: 'artifact-ready' });
    store.transition(ready.id, { expectedVersion: ready.version,
      to: 'browser-driving', eventClass: 'browser-drive-started' });
    ports.recoverUncertain.mockResolvedValue('inconclusive');
    const result = await new SubscriptionReloginOrchestrator(ports).tick(approved.id);
    expect(result).toMatchObject({ outcome: 'waiting', reason: 'uncertain-external-outcome',
      episode: { state: 'waiting-operator-only', failureClass: 'uncertain-external-outcome' } });
    expect(ports.driveBrowser).not.toHaveBeenCalled();
    store.close();
  });

  it('durably accounts artifact reissues and refuses beyond the bounded budget', async () => {
    const { store, approved, ports } = fixture();
    ports.startOrRecoverLogin.mockResolvedValue({ attemptId: 'attempt-1', kind: 'url-code-paste',
      expiresAt: '2026-08-28T08:10:00.000Z', reissueCount: 3 });
    const result = await new SubscriptionReloginOrchestrator({ ...ports, maxReissues: 2 }).tick(approved.id);
    expect(result).toMatchObject({ outcome: 'terminal', episode: {
      state: 'failed', reissueCount: 3, failureClass: 'attempt-budget-exhausted',
    } });
    expect(ports.driveBrowser).not.toHaveBeenCalled();
    expect(store.listEvents(approved.id).map((event) => event.eventClass))
      .toContain('artifact-reissued');
    store.close();
  });
});
