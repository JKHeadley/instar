/**
 * A failed (or refused) sign-in repair whose account is VERIFIED signed in again afterwards is no
 * longer the operator's to fix (2026-10-26, episode 07a2d827: the account was back at 20:28, the
 * held "repair ended in failed" notice still went out at 21:21 and its row stayed open until a
 * hand clear). Unit tier, both sides of the boundary:
 *   - still signed out → the condition is NOT reported over, the failure notice IS delivered;
 *   - verified signed in → the condition is reported over exactly once, the notice is never sent;
 *   - another repair for the same cell still running → nothing is reported over.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SubscriptionReloginOrchestrator } from '../../src/core/SubscriptionReloginOrchestrator.js';
import { SubscriptionReloginService } from '../../src/core/SubscriptionReloginService.js';
import { SubscriptionReloginStore, type SubscriptionReloginEpisode } from '../../src/core/SubscriptionReloginStore.js';
import {
  clearRecoveredReloginAttention,
  resolveSubscriptionReloginAttention,
} from '../../src/core/SubscriptionReloginAttention.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'relogin-recovered.test cleanup' });
});

function harness(opts: { terminal?: 'failed' | 'refused'; healthy?: boolean; liveSibling?: boolean } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-recovered-')); dirs.push(stateDir);
  let n = 0;
  let now = Date.parse('2026-10-26T20:00:00Z');
  const store = new SubscriptionReloginStore({ stateDir, now: () => now, idFactory: () => `repair-${++n}` });
  let ep = store.suggest({ sourceEpisodeId: 11, accountId: 'acct-1', machineId: 'machine-1', mode: 'unattended',
    inputDigest: DIGEST, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
  ep = store.approve(ep.id, { inputDigest: DIGEST });
  ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
  if (opts.terminal === 'refused') {
    ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'artifact-ready', eventClass: 'artifact-ready' });
    ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'browser-driving', eventClass: 'browser-drive-started' });
    ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'refused', eventClass: 'test-terminal', failureClass: 'unexpected-origin' });
  } else {
    ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'failed', eventClass: 'test-terminal', failureClass: 'repair-time-budget-exhausted' });
  }
  const failedId = ep.id;
  if (opts.liveSibling) {
    now += 60_000;
    let sib = store.suggest({ sourceEpisodeId: 12, accountId: 'acct-1', machineId: 'machine-1', mode: 'unattended',
      inputDigest: DIGEST, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    sib = store.approve(sib.id, { inputDigest: DIGEST });
    store.transition(sib.id, { expectedVersion: sib.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
  }
  let healthy = opts.healthy ?? false;
  const onTerminal = vi.fn(async () => undefined);
  const onConditionCleared = vi.fn(async (_episode: SubscriptionReloginEpisode) => undefined);
  const orchestrator = { tick: vi.fn(async () => ({ outcome: 'waiting' })) } as unknown as SubscriptionReloginOrchestrator;
  const service = new SubscriptionReloginService({ store, orchestrator, scanCandidates: async () => [],
    revalidate: async () => ({ admissible: false as const, reason: 'account-not-needs-reauth' }),
    // The source incident closed when the account recovered: no slow retry will follow.
    sourceIncidentOpen: () => !healthy,
    cellHealthy: (episode) => healthy && episode.machineId === 'machine-1',
    onTerminal, onConditionCleared, now: () => now, slowRetry: { enabled: false } });
  return { store, service, onTerminal, onConditionCleared, failedId, setHealthy: (v: boolean) => { healthy = v; } };
}

describe('a failed sign-in repair whose account is verified signed in again', () => {
  it('still signed out: the failure notice is delivered and the condition stays open', async () => {
    const h = harness({ healthy: false });
    await h.service.tick();
    expect(h.onTerminal).toHaveBeenCalledTimes(1);
    expect(h.onConditionCleared).not.toHaveBeenCalled();
  });

  it('verified signed in: the failure notice is never sent and the condition is reported over once', async () => {
    const h = harness({ healthy: true });
    await h.service.tick();
    await h.service.tick();
    expect(h.onTerminal).not.toHaveBeenCalled();
    expect(h.onConditionCleared).toHaveBeenCalledTimes(1);
    expect(h.onConditionCleared.mock.calls[0][0]).toMatchObject({ id: h.failedId, accountId: 'acct-1', machineId: 'machine-1' });
    // The episode itself is history and stays failed: nothing rewrites it.
    expect(h.store.get(h.failedId)).toMatchObject({ state: 'failed', failureClass: 'repair-time-budget-exhausted' });
  });

  it('a notice already delivered while signed out: the row is closed once the account is verified back', async () => {
    const h = harness({ healthy: false });
    await h.service.tick();
    expect(h.onTerminal).toHaveBeenCalledTimes(1);
    expect(h.onConditionCleared).not.toHaveBeenCalled();
    h.setHealthy(true);
    await h.service.tick();
    expect(h.onConditionCleared).toHaveBeenCalledTimes(1);
  });

  it('a refused repair on a verified-healthy cell is also over', async () => {
    const h = harness({ terminal: 'refused', healthy: true });
    await h.service.tick();
    expect(h.onTerminal).not.toHaveBeenCalled();
    expect(h.onConditionCleared).toHaveBeenCalledTimes(1);
  });

  it('another repair for the same cell still running: nothing is reported over, the notice is delivered', async () => {
    const h = harness({ healthy: true, liveSibling: true });
    await h.service.tick();
    expect(h.onConditionCleared).not.toHaveBeenCalled();
    expect(h.onTerminal).toHaveBeenCalledTimes(1);
  });

  it('a failing clear is retried on the next tick, not recorded as done', async () => {
    const h = harness({ healthy: true });
    h.onConditionCleared.mockRejectedValueOnce(new Error('store busy'));
    await h.service.tick(); // drain: clear throws → notice re-queued
    await h.service.tick();
    expect(h.onConditionCleared.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.onTerminal).not.toHaveBeenCalled();
  });
});

describe('a notice delivered after an earlier recovery report', () => {
  it('is closed again when the account is verified back a second time', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-recovered-')); dirs.push(stateDir);
    let now = new Date(2026, 9, 26, 12, 0, 0, 0).getTime();
    const store = new SubscriptionReloginStore({ stateDir, now: () => now, idFactory: () => 'repair-1' });
    let ep = store.suggest({ sourceEpisodeId: 11, accountId: 'acct-1', machineId: 'machine-1', mode: 'unattended',
      inputDigest: DIGEST, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    ep = store.approve(ep.id, { inputDigest: DIGEST });
    ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    store.transition(ep.id, { expectedVersion: ep.version, to: 'failed', eventClass: 'test-terminal', failureClass: 'repair-time-budget-exhausted' });
    let healthy = false; let incidentOpen = true;
    const onTerminal = vi.fn(async () => undefined);
    const onConditionCleared = vi.fn(async () => undefined);
    const service = new SubscriptionReloginService({ store,
      orchestrator: { tick: vi.fn(async () => ({ outcome: 'waiting' })) } as unknown as SubscriptionReloginOrchestrator,
      scanCandidates: async () => [], revalidate: async () => ({ admissible: false as const, reason: 'x' }),
      sourceIncidentOpen: () => incidentOpen, cellHealthy: () => healthy,
      onTerminal, onConditionCleared, now: () => now });
    await service.tick(); // signed out, retry expected → notice held
    expect(onTerminal).not.toHaveBeenCalled();
    healthy = true;
    await service.tick(); // verified back → reported over once (the held notice is not yet due)
    expect(onConditionCleared).toHaveBeenCalledTimes(1);
    healthy = false; incidentOpen = false; now += 8 * 60 * 60_000;
    await service.tick(); // dipped again, hold ended, no retry → the notice IS delivered (a row now exists)
    expect(onTerminal).toHaveBeenCalledTimes(1);
    healthy = true;
    await service.tick(); // verified back again → that row is closed too
    expect(onConditionCleared).toHaveBeenCalledTimes(2);
  });
});

describe('clearRecoveredReloginAttention', () => {
  it('closes the conditionKey row and any legacy id-prefixed row for that episode, with an honest resolution', () => {
    const clear = vi.fn((match: { conditionKey?: string; idPrefix?: string }) => ({ closed: match.conditionKey ? 1 : 0 }));
    const closed = clearRecoveredReloginAttention({ id: 'ep-1', accountId: 'acct-1', machineId: 'machine-1', framework: 'claude-code' }, clear);
    expect(closed).toBe(1);
    expect(clear).toHaveBeenCalledWith({ conditionKey: 'subscription-relogin:acct-1:machine-1' }, expect.stringContaining('signed in again (verified'));
    expect(clear).toHaveBeenCalledWith({ idPrefix: 'subscription-relogin-ep-1-' }, expect.any(String));
  });
});

describe('the hourly resolver reads verified health, both sides', () => {
  const failed = { id: 'e', accountId: 'acct-1', machineId: 'machine-1', state: 'failed', failureClass: 'repair-time-budget-exhausted' } as SubscriptionReloginEpisode;
  const deps = (healthy: boolean) => ({ getEpisode: () => failed, listEpisodes: () => [failed], localMachineId: 'machine-1', localCellHealthy: () => healthy });
  it('failed + not verified healthy → active (stays open)', () => {
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: 'subscription-relogin:acct-1:machine-1' }, deps(false))).toBe('active');
  });
  it('failed + verified healthy → cleared', () => {
    expect(resolveSubscriptionReloginAttention({ id: 'x', conditionKey: 'subscription-relogin:acct-1:machine-1' }, deps(true))).toBe('cleared');
  });
});
