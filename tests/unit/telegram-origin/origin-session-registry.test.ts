import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OriginSessionRegistry } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';

describe('OriginSessionRegistry scoped persistent verifiers', () => {
  let directory: string;
  const launch = { sessionId: 'session', harnessId: 'codex-cli' as const, projectDir: '/fixture', configuredModel: 'requested' };
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'origin-registry-')); });
  afterEach(async () => { await SafeFsExecutor.safeRm(directory, { recursive: true, force: true, operation: 'test:origin-session-registry:cleanup' }); });
  const create = (stateDir: string, machineId = 'host', isSessionLive: () => boolean = () => true) =>
    new OriginSessionRegistry({ stateDir, machineId, agentId: 'agent', isSessionLive });
  it('persists only a hash and restores the same live incarnation across main restart', async () => {
    const registry = create(directory); await registry.initialize();
    const token = await registry.issue(launch);
    const result = registry.verify(token);
    expect(result.ok).toBe(true);
    const contents = await readFile(path.join(directory, (await readdir(directory))[0]), 'utf8');
    expect(contents).not.toContain(token);
    const restarted = create(directory); await restarted.initialize();
    expect(restarted.verify(token)).toEqual(result);
  });
  it('replaces incarnations, revokes immediately and does not revive a revoked token', async () => {
    const registry = create(directory); await registry.initialize();
    const old = await registry.issue(launch);
    const current = await registry.issue(launch);
    expect(registry.verify(old).ok).toBe(false);
    expect(registry.verify(current).ok).toBe(true);
    const pending = registry.revoke(launch.sessionId);
    expect(registry.verify(current).ok).toBe(false);
    await pending;
    const restarted = create(directory); await restarted.initialize();
    expect(restarted.verify(current).ok).toBe(false);
  });
  it('rejects wrong host, missing lifecycle authority, ended sessions and arbitrary bearer tokens', async () => {
    const registry = create(directory); await registry.initialize();
    const token = await registry.issue(launch);
    const other = create(directory, 'other'); await other.initialize();
    expect(other.verify(token).ok).toBe(false);
    const ended = create(directory, 'host', () => false); await ended.initialize();
    expect(ended.verify(token)).toEqual({ ok: false, reason: 'session-not-live' });
    const unbound = new OriginSessionRegistry({ stateDir: directory, machineId: 'host', agentId: 'agent' }); await unbound.initialize();
    expect(unbound.verify(token)).toEqual({ ok: false, reason: 'session-liveness-unavailable' });
    expect(registry.verify('generic-agent-bearer').ok).toBe(false);
    expect(registry.verify(token.slice(0, -1) + '!').ok).toBe(false);
  });
  it('caps enrollment and never exposes mutable internal binding state', async () => {
    const registry = new OriginSessionRegistry({ stateDir: directory, machineId: 'host', agentId: 'agent', maxSessions: 1, isSessionLive: () => true });
    await registry.initialize(); const token = await registry.issue(launch);
    const result = registry.verify(token); if (result.ok) result.binding.machineId = 'forged';
    expect(registry.getBinding('session')?.machineId).toBe('host');
    await expect(registry.issue({ ...launch, sessionId: 'second' })).rejects.toThrow('capacity');
  });
});
