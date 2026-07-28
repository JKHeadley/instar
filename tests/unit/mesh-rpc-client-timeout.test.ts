/**
 * Tier-1 tests for the MeshRpcClient per-call timeout override
 * (live-matrix finding T1, 2026-06-06): heavy verbs (working-set-pull
 * 1MiB pages, owner-routed commitment forwards) need more than the 5s
 * per-attempt default, which was measured aborting on every cold tunnel
 * hop in production. `send(..., { timeoutMs })` must win over both the
 * constructor default and the hardcoded 5000.
 */
import { describe, it, expect } from 'vitest';

import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';

const PEER = { machineId: 'm_peer', url: 'http://peer.test' };

function makeClient(over: { timeoutMs?: number; fetchFn?: ConstructorParameters<typeof MeshRpcClient>[0]['fetchFn'] }) {
  return new MeshRpcClient({
    selfMachineId: 'm_self',
    sign: () => 'sig',
    nonce: () => `n-${Math.random()}`,
    ...over,
  });
}

/** A fetch that resolves after `delayMs` UNLESS the abort signal fires first. */
function slowFetch(delayMs: number): NonNullable<ConstructorParameters<typeof MeshRpcClient>[0]['fetchFn']> {
  return (_url, init) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ status: 200, json: async () => ({ result: 'late-but-fine' }) }), delayMs);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('This operation was aborted'));
      });
    });
}

describe('MeshRpcClient — per-call timeout override (T1)', () => {
  it('a slow peer aborts under the constructor default but succeeds with a per-call override', async () => {
    const client = makeClient({ timeoutMs: 50, fetchFn: slowFetch(150) });
    // Default (50ms) → the 150ms peer aborts.
    await expect(client.send(PEER, { type: 'noop' } as never, 0)).rejects.toThrow(/aborted/);
    // Per-call override (1s) → the same peer answers.
    const ok = await client.send(PEER, { type: 'noop' } as never, 0, { timeoutMs: 1000 });
    expect(ok.ok).toBe(true);
    expect(ok.result).toBe('late-but-fine');
  });

  it('the override can also TIGHTEN below the constructor default', async () => {
    const client = makeClient({ timeoutMs: 1000, fetchFn: slowFetch(150) });
    await expect(client.send(PEER, { type: 'noop' } as never, 0, { timeoutMs: 50 })).rejects.toThrow(/aborted/);
  });

  it('omitting opts preserves the existing behavior (constructor default applies)', async () => {
    const client = makeClient({ timeoutMs: 1000, fetchFn: slowFetch(150) });
    const ok = await client.send(PEER, { type: 'noop' } as never, 0);
    expect(ok.ok).toBe(true);
  });
});
