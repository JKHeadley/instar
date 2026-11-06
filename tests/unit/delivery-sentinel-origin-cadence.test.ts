import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeliveryFailureSentinel } from '../../src/monitoring/delivery-failure-sentinel.js';
import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';

const running: DeliveryFailureSentinel[] = [];
afterEach(async () => { for (const sentinel of running.splice(0)) await sentinel.stop(); vi.useRealTimers(); });

function build(recoverOrigin?: () => Promise<{ processed: number; recovered: number }>) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-cadence-'));
  const sentinel = new DeliveryFailureSentinel({ store: PendingRelayStore.open('echo', stateDir), configPath: path.join(stateDir, 'config.json'),
    readConfig: () => ({ port: 1, authToken: 't', agentId: 'echo' }), bootId: 'boot', toneGate: null, recoverOrigin });
  running.push(sentinel);
  return sentinel;
}

describe('recovery cadence', () => {
  it('drives the origin outbox every 30 seconds, the first step a refused send is given', async () => {
    vi.useFakeTimers();
    const recoverOrigin = vi.fn(async () => ({ processed: 0, recovered: 0 }));
    await build(recoverOrigin).start();
    expect(recoverOrigin).toHaveBeenCalledTimes(1); // The startup drain.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(recoverOrigin).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(recoverOrigin).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(recoverOrigin).toHaveBeenCalledTimes(12);
  });
  it('keeps the 5-minute backstop on the legacy lane, which has no outbox fence', async () => {
    vi.useFakeTimers();
    const sentinel = build();
    const tick = vi.spyOn(sentinel, 'tick');
    await sentinel.start();
    tick.mockClear();
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
