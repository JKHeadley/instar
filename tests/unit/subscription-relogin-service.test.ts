import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SubscriptionReloginOrchestrator } from '../../src/core/SubscriptionReloginOrchestrator.js';
import { SubscriptionReloginService } from '../../src/core/SubscriptionReloginService.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true, operation: 'subscription-relogin-service.test cleanup',
  });
});

describe('SubscriptionReloginService', () => {
  it('refuses approval in observe mode before revalidation or orchestration', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-service-observe-')); dirs.push(stateDir);
    const store = new SubscriptionReloginStore({ stateDir, idFactory: () => 'repair-observe' });
    const episode = store.suggest({ sourceEpisodeId: 2, accountId: 'acct-1', machineId: 'machine-1',
      mode: 'observe', inputDigest: `sha256:${'b'.repeat(64)}`, profileId: 'profile-1',
      framework: 'claude-code', provider: 'anthropic' });
    const revalidate = vi.fn(async () => ({ admissible: true, inputDigest: episode.inputDigest }));
    const orchestrator = { tick: vi.fn() } as unknown as SubscriptionReloginOrchestrator;
    const service = new SubscriptionReloginService({ store, orchestrator, scanCandidates: async () => [], revalidate });
    await expect(service.approve(episode.id)).rejects.toThrow('relogin-observe-only');
    expect(revalidate).not.toHaveBeenCalled();
    expect(orchestrator.tick).not.toHaveBeenCalled();
    store.close();
  });

  it('retries a failed notification after restart with the same delivery key', async () => {
    let now = Date.parse('2026-08-28T09:00:00.000Z');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-service-')); dirs.push(stateDir);
    const store = new SubscriptionReloginStore({ stateDir, now: () => now, idFactory: () => 'repair-1' });
    const candidate = { sourceEpisodeId: 1, accountId: 'acct-1', machineId: 'machine-1', mode: 'approval' as const,
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' };
    const first = vi.fn(async () => { throw new Error('delivery unavailable'); });
    const inert = { tick: vi.fn() } as unknown as SubscriptionReloginOrchestrator;
    const service = new SubscriptionReloginService({ store, orchestrator: inert,
      scanCandidates: async () => [candidate], revalidate: async () => ({ admissible: true, inputDigest: candidate.inputDigest }),
      onSuggested: first, now: () => now });
    await service.tick();
    expect(first).toHaveBeenCalledOnce();
    const key = first.mock.calls[0]?.[1];
    now += 5_000;
    const delivered = vi.fn(async () => undefined);
    const restarted = new SubscriptionReloginService({ store, orchestrator: inert,
      scanCandidates: async () => [candidate], revalidate: async () => ({ admissible: true, inputDigest: candidate.inputDigest }),
      onSuggested: delivered, now: () => now });
    await restarted.tick();
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ id: 'repair-1' }), key);
    await restarted.tick();
    expect(delivered).toHaveBeenCalledOnce();
    store.close();
  });

  it('auto-approves an unattended candidate with a distinct non-operator audit event', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-service-unattended-')); dirs.push(stateDir);
    const store = new SubscriptionReloginStore({ stateDir, idFactory: () => 'repair-auto' });
    const candidate = { sourceEpisodeId: 3, accountId: 'acct-1', machineId: 'machine-1', mode: 'unattended' as const,
      inputDigest: `sha256:${'c'.repeat(64)}`, profileId: 'profile-1', framework: 'codex-cli', provider: 'openai' };
    const orchestrator = { tick: vi.fn(async () => ({ outcome: 'waiting' })) } as unknown as SubscriptionReloginOrchestrator;
    const service = new SubscriptionReloginService({ store, orchestrator,
      scanCandidates: async () => [candidate],
      revalidate: async () => ({ admissible: true, inputDigest: candidate.inputDigest }) });
    await service.tick();
    expect(store.get('repair-auto')?.state).toBe('approved');
    expect(store.listEvents('repair-auto').map((event) => event.eventClass))
      .toEqual(['unattended-policy-approved', 'candidate-admitted']);
    store.close();
  });

  it('tick starts runnable episodes DETACHED so a long helper drive never blocks scanning or notices (spec skill-driven-signin-repair)', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-service-detached-')); dirs.push(stateDir);
    const store = new SubscriptionReloginStore({ stateDir, idFactory: () => 'repair-detached' });
    const ep = store.suggest({ sourceEpisodeId: 4, accountId: 'acct-1', machineId: 'machine-1', mode: 'approval',
      inputDigest: `sha256:${'d'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    store.approve(ep.id, { inputDigest: ep.inputDigest });
    let release!: () => void;
    const tick = vi.fn(() => new Promise<{ outcome: string }>((resolve) => { release = () => resolve({ outcome: 'waiting' }); }));
    const onSuggested = vi.fn();
    const service = new SubscriptionReloginService({ store, orchestrator: { tick } as unknown as SubscriptionReloginOrchestrator,
      scanCandidates: async () => [], revalidate: async () => ({ admissible: true, inputDigest: ep.inputDigest }), onSuggested });
    await service.tick(); // returns although the episode's drive has not finished
    expect(tick).toHaveBeenCalledTimes(1);
    expect(onSuggested).toHaveBeenCalledTimes(1); // notices still delivered
    await service.tick(); // in-flight: no double start
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    store.close();
  });

  it('delivers a phone-tap notice through its own handler, not the terminal one', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-service-phone-')); dirs.push(stateDir);
    const store = new SubscriptionReloginStore({ stateDir, idFactory: () => 'repair-phone' });
    const ep = store.suggest({ sourceEpisodeId: 5, accountId: 'acct-1', machineId: 'machine-1', mode: 'observe',
      inputDigest: `sha256:${'e'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    store.enqueuePhoneTap(ep.id);
    const onPhoneTap = vi.fn(); const onTerminal = vi.fn();
    const service = new SubscriptionReloginService({ store, orchestrator: { tick: vi.fn() } as unknown as SubscriptionReloginOrchestrator,
      scanCandidates: async () => [], revalidate: async () => ({ admissible: true, inputDigest: ep.inputDigest }), onPhoneTap, onTerminal });
    await service.flushNotifications();
    expect(onPhoneTap).toHaveBeenCalledWith(expect.objectContaining({ id: ep.id }), `subscription-relogin:${ep.id}:phone-tap:0`);
    expect(onTerminal).not.toHaveBeenCalled();
    store.close();
  });

  it('closes an open repair as resolved-elsewhere once the server verifies its cell healthy (the 2026-09-25 Laptop case)', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-service-resolved-')); dirs.push(stateDir);
    let n = 0;
    const store = new SubscriptionReloginStore({ stateDir, idFactory: () => `repair-r${++n}` });
    const open = (source: number, account: string) => {
      const ep = store.suggest({ sourceEpisodeId: source, accountId: account, machineId: 'machine-1', mode: 'approval',
        inputDigest: `sha256:${'f'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
      const approved = store.approve(ep.id, { inputDigest: ep.inputDigest });
      return store.transition(approved.id, { expectedVersion: approved.version, to: 'waiting-operator-only',
        eventClass: 'operator-only-challenge', failureClass: 'permission-expansion' });
    };
    const healthyEp = open(6, 'acct-healthy');
    const stillBroken = open(7, 'acct-broken');
    const healthy = new Set(['acct-healthy']);
    const service = new SubscriptionReloginService({ store, orchestrator: { tick: vi.fn() } as unknown as SubscriptionReloginOrchestrator,
      scanCandidates: async () => [], revalidate: async () => ({ admissible: true, inputDigest: healthyEp.inputDigest }),
      cellHealthy: (episode) => healthy.has(episode.accountId) });
    await service.tick();
    expect(store.get(healthyEp.id)).toMatchObject({ state: 'cancelled', failureClass: 'resolved-elsewhere' });
    expect(store.listEvents(healthyEp.id)[0]).toMatchObject({ eventClass: 'resolved-elsewhere', fromState: 'waiting-operator-only', toState: 'cancelled' });
    expect(store.get(stillBroken.id)?.state).toBe('waiting-operator-only'); // unverified cell stays open
    // Neither a repair success (graduation evidence) nor a failure (breaker).
    expect(store.getUnattendedEvidence('acct-healthy', 'machine-1', 'anthropic', 'claude-code').successfulRepairs).toBe(0);
    expect(store.isBreakerOpen('acct-healthy', 'anthropic')).toBe(false);
    await service.tick(); // idempotent on a terminal row
    expect(store.listEvents(healthyEp.id).filter((e) => e.eventClass === 'resolved-elsewhere')).toHaveLength(1);
    store.close();
  });

  it('never closes an episode this process is actively driving', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-service-inflight-')); dirs.push(stateDir);
    const store = new SubscriptionReloginStore({ stateDir, idFactory: () => 'repair-inflight' });
    const ep = store.suggest({ sourceEpisodeId: 8, accountId: 'acct-1', machineId: 'machine-1', mode: 'approval',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    const tick = vi.fn(() => new Promise(() => {})); // a drive that is still running
    const service = new SubscriptionReloginService({ store, orchestrator: { tick } as unknown as SubscriptionReloginOrchestrator,
      scanCandidates: async () => [], revalidate: async () => ({ admissible: true, inputDigest: ep.inputDigest }),
      cellHealthy: () => false });
    await service.approve(ep.id);
    // The cell now reads healthy, but this same service is still driving the episode: leave it to its arbiter.
    (service as unknown as { deps: { cellHealthy: () => boolean } }).deps.cellHealthy = () => true;
    await service.tick();
    expect(store.get(ep.id)?.state).toBe('approved');
    store.close();
  });

  it('never closes a mid-repair episode (e.g. auth-verifying waiting on authority closure) — its own success must stand', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-service-midrepair-')); dirs.push(stateDir);
    const store = new SubscriptionReloginStore({ stateDir, idFactory: () => 'repair-mid' });
    let ep = store.suggest({ sourceEpisodeId: 9, accountId: 'acct-1', machineId: 'machine-1', mode: 'approval',
      inputDigest: `sha256:${'b'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    ep = store.approve(ep.id, { inputDigest: ep.inputDigest });
    for (const to of ['cli-starting', 'artifact-ready', 'browser-driving', 'cli-finishing', 'identity-verifying', 'auth-verifying'] as const) {
      ep = store.transition(ep.id, { expectedVersion: ep.version, to, eventClass: to, incrementAttempt: to === 'cli-starting' });
    }
    // The repair's own finalizeSuccess made the pool active + loginCheck ok; the tick must not close it.
    const tick = vi.fn(async () => ({ outcome: 'waiting', reason: 'authority-closure-pending' }));
    const service = new SubscriptionReloginService({ store, orchestrator: { tick } as unknown as SubscriptionReloginOrchestrator,
      scanCandidates: async () => [], revalidate: async () => ({ admissible: true, inputDigest: ep.inputDigest }), cellHealthy: () => true });
    await service.tick();
    await vi.waitFor(() => expect(tick).toHaveBeenCalled());
    expect(store.get(ep.id)?.state).toBe('auth-verifying');
    expect(store.listEvents(ep.id).some((e) => e.eventClass === 'resolved-elsewhere')).toBe(false);
    store.close();
  });
});
