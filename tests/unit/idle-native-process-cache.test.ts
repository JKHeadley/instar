import { describe, expect, it } from 'vitest';
import { IdleNativeProcessCache, type IdleNativeBinding } from '../../src/core/IdleNativeProcessCache.js';

const binding: IdleNativeBinding = {
  sessionId: 'session-1', topicKey: 'topic-1', ownerMachineId: 'local',
  ownerEpoch: 'owner-1', paneId: '%9', launchId: 'launch-1',
};
const native = { pid: 10, kernelStartToken: 'process-1' };

describe('idle native process cache', () => {
  it('returns exact monitor proof until expiry and recovers no proof on a cold read', () => {
    const cache = new IdleNativeProcessCache(20);
    expect(cache.read(binding, 0)).toBeNull();
    expect(cache.observe(cache.begin(binding, 0)!, binding, [native], 1)).toBe(true);
    expect(cache.read(binding, 19)).not.toBeNull();
    expect(cache.read(binding, 20)).toBeNull();
    expect(cache.read(binding, -1)).toBeNull();
  });

  it.each(['ownerMachineId', 'ownerEpoch', 'paneId', 'launchId', 'topicKey', 'sessionId'] as const)(
    'refuses shifted %s during sampling and after a sample',
    field => {
      const cache = new IdleNativeProcessCache(20);
      const changed = { ...binding, [field]: 'different' };
      expect(cache.observe(cache.begin(binding, 0)!, binding, [native], 0)).toBe(true);
      expect(cache.read(changed, 1)).toBeNull();
      expect(cache.observe(cache.begin(binding, 1)!, changed, [native], 1)).toBe(false);
      expect(cache.read(binding, 2)).toBeNull();
    },
  );

  it('separates process generations even when the OS reuses the PID', () => {
    const cache = new IdleNativeProcessCache(20);
    cache.observe(cache.begin(binding, 0)!, binding, [native], 0);
    const first = cache.read(binding, 1);
    cache.observe(cache.begin(binding, 2)!, binding, [{ ...native, kernelStartToken: 'process-2' }], 2);
    expect(cache.read(binding, 3)).not.toBe(first);
  });

  it('rejects older callbacks even when the newer sample invalidates proof at the same clock tick', () => {
    const cache = new IdleNativeProcessCache(20);
    const older = cache.begin(binding, 1)!;
    const newer = cache.begin(binding, 1)!;
    expect(cache.observe(newer, null, [native], 1)).toBe(false);
    expect(cache.observe(older, binding, [native], 1)).toBe(false);
    expect(cache.observe(newer, binding, [native], 1)).toBe(false);
    expect(cache.read(binding, 2)).toBeNull();
  });

  it('rejects old launch callbacks after retirement and does not retire a different binding', () => {
    const cache = new IdleNativeProcessCache(20);
    const old = cache.begin(binding, 1)!;
    cache.retire(binding);
    const next = { ...binding, launchId: 'next' };
    const current = cache.begin(next, 2)!;
    cache.retire(binding);
    expect(cache.observe(old, binding, [native], 3)).toBe(false);
    expect(cache.observe(current, next, [native], 3)).toBe(true);
    expect(cache.read(next, 3)).not.toBeNull();
  });

  it('rejects expired samples, missing process proofs and ambiguous native descendants', () => {
    const cache = new IdleNativeProcessCache(20);
    expect(cache.observe(cache.begin(binding, 0)!, binding, [native], 20)).toBe(false);
    expect(cache.observe(cache.begin(binding, 20)!, binding, [native, { ...native, pid: 12 }], 21)).toBe(false);
    expect(cache.observe(cache.begin(binding, 21)!, binding, [{ ...native, kernelStartToken: '' }], 21)).toBe(false);
    expect(cache.read(binding, 22)).toBeNull();
  });
});
