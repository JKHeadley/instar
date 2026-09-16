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
});
