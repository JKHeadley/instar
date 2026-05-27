/**
 * Wiring-integrity + behavior tests for G2 automated state sync.
 *
 * The headline test ("a simulated role change triggers a push") is the exact
 * Phase-0 failure this feature exists to close — it asserts the wiring is real,
 * not dead code. Per the "feature actually alive" lesson, the subscription seam
 * is verified, not assumed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireRegistrySync } from '../../src/core/wireRegistrySync.js';
import { RegistrySyncDebouncer } from '../../src/core/RegistrySyncDebouncer.js';

describe('wireRegistrySync (wiring integrity)', () => {
  it('reports the events it wires (real subscription, not dead code)', () => {
    const coord = new EventEmitter();
    const sink = { markRegistryDirty: vi.fn() };
    const wiring = wireRegistrySync(coord, sink);
    expect(wiring.wiredEvents).toContain('roleChange');
    expect(wiring.wiredEvents).toContain('leaseEpochChange');
  });

  it('emitting roleChange marks the registry dirty', () => {
    const coord = new EventEmitter();
    const sink = { markRegistryDirty: vi.fn() };
    wireRegistrySync(coord, sink);
    coord.emit('roleChange', 'standby', 'awake');
    expect(sink.markRegistryDirty).toHaveBeenCalledTimes(1);
    expect(sink.markRegistryDirty.mock.calls[0][0]).toContain('standby->awake');
  });

  it('emitting leaseEpochChange marks the registry dirty', () => {
    const coord = new EventEmitter();
    const sink = { markRegistryDirty: vi.fn() };
    wireRegistrySync(coord, sink);
    coord.emit('leaseEpochChange', 7);
    expect(sink.markRegistryDirty).toHaveBeenCalledTimes(1);
    expect(sink.markRegistryDirty.mock.calls[0][0]).toContain('7');
  });

  it('unwire detaches the subscriptions', () => {
    const coord = new EventEmitter();
    const sink = { markRegistryDirty: vi.fn() };
    const wiring = wireRegistrySync(coord, sink);
    wiring.unwire();
    coord.emit('roleChange', 'standby', 'awake');
    expect(sink.markRegistryDirty).not.toHaveBeenCalled();
  });
});

describe('RegistrySyncDebouncer (durable push behavior)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('THE PHASE-0 TEST: an authoritative role change triggers a debounced push of the registry', async () => {
    const commitAndPush = vi.fn().mockReturnValue(true);
    const deb = new RegistrySyncDebouncer({
      commitAndPush,
      registryAbsPath: '/tmp/agent/machines/registry.json',
      isAuthoritative: () => true,
      debounceMs: 100,
    });
    // Wire a real coordinator → real debouncer (full seam).
    const coord = new EventEmitter();
    wireRegistrySync(coord, deb);

    coord.emit('roleChange', 'standby', 'awake');
    expect(commitAndPush).not.toHaveBeenCalled(); // debounced, not yet

    await vi.advanceTimersByTimeAsync(100);
    expect(commitAndPush).toHaveBeenCalledTimes(1);
    const [message, paths] = commitAndPush.mock.calls[0];
    expect(message).toContain('registry sync');
    expect(paths).toEqual(['/tmp/agent/machines/registry.json']);
  });

  it('coalesces multiple rapid marks into one push', async () => {
    const commitAndPush = vi.fn().mockReturnValue(true);
    const deb = new RegistrySyncDebouncer({
      commitAndPush,
      registryAbsPath: '/tmp/r.json',
      isAuthoritative: () => true,
      debounceMs: 100,
    });
    deb.markRegistryDirty('a');
    deb.markRegistryDirty('b');
    deb.markRegistryDirty('c');
    await vi.advanceTimersByTimeAsync(100);
    expect(commitAndPush).toHaveBeenCalledTimes(1);
  });

  it('single-writer: a standby (non-authoritative) never pushes', async () => {
    const commitAndPush = vi.fn().mockReturnValue(true);
    const deb = new RegistrySyncDebouncer({
      commitAndPush,
      registryAbsPath: '/tmp/r.json',
      isAuthoritative: () => false, // standby
      debounceMs: 50,
    });
    deb.markRegistryDirty('role change while standby');
    await vi.advanceTimersByTimeAsync(50);
    expect(commitAndPush).not.toHaveBeenCalled();
  });

  it('repeated push failures flip the sync-health signal unhealthy at the threshold', async () => {
    const healthEvents: boolean[] = [];
    const commitAndPush = vi.fn(() => {
      throw new Error('non-fast-forward');
    });
    const deb = new RegistrySyncDebouncer({
      commitAndPush,
      registryAbsPath: '/tmp/r.json',
      isAuthoritative: () => true,
      debounceMs: 10,
      maxConsecutiveFailures: 3,
      onSyncHealth: (s) => healthEvents.push(s.healthy),
    });
    // Drive three flushes via direct flush() calls (each re-queues on failure).
    deb.markRegistryDirty('x');
    await deb.flush();
    await deb.flush();
    await deb.flush();
    expect(deb.getHealth().consecutiveFailures).toBe(3);
    expect(deb.getHealth().healthy).toBe(false);
    expect(healthEvents).toContain(false);
  });

  it('a successful push resets failure count + records lastPushAt', async () => {
    let fail = true;
    const commitAndPush = vi.fn(() => {
      if (fail) throw new Error('temporary');
      return true;
    });
    const deb = new RegistrySyncDebouncer({
      commitAndPush,
      registryAbsPath: '/tmp/r.json',
      isAuthoritative: () => true,
      debounceMs: 10,
    });
    deb.markRegistryDirty('x');
    await deb.flush(); // fails, re-queues
    expect(deb.getHealth().consecutiveFailures).toBe(1);
    fail = false;
    await deb.flush(); // succeeds
    expect(deb.getHealth().consecutiveFailures).toBe(0);
    expect(deb.getHealth().healthy).toBe(true);
    expect(deb.getHealth().lastPushAt).toBeTruthy();
  });
});
