/**
 * Unit tests for WS5.2 §5.1 peer-views fetcher (fetchPeerSubscriptionViews) — maps each online
 * peer's plain /subscription-pool into MachinePoolView[]; tolerant of dark/erroring peers.
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchPeerSubscriptionViews, type PeerRef } from '../../src/core/fetchPeerSubscriptionViews.js';

const ok = (accounts: unknown[]) => ({ ok: true, status: 200, json: async () => ({ accounts }) });

describe('fetchPeerSubscriptionViews (WS5.2 §5.1)', () => {
  it('maps a peer plain-pool response into a MachinePoolView (locallyHeld:true)', async () => {
    const peers: PeerRef[] = [{ machineId: 'mini', nickname: 'the Mini', url: 'http://mini:4042' }];
    const fetchImpl = vi.fn(async () => ok([{ id: 'a1', email: 'j@x.com', status: 'active' }]));
    const views = await fetchPeerSubscriptionViews({ peers: () => peers, fetchImpl: fetchImpl as never, authToken: 'tok' });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ machineId: 'mini', nickname: 'the Mini' });
    expect(views[0].accounts[0]).toMatchObject({ accountId: 'a1', email: 'j@x.com', status: 'active', locallyHeld: true });
    // sends the bearer token to the peer's PLAIN /subscription-pool (no scope=pool recursion)
    expect(fetchImpl).toHaveBeenCalledWith('http://mini:4042/subscription-pool', expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }));
  });

  it('TOLERATES a dark/erroring peer (skipped, never throws)', async () => {
    const peers: PeerRef[] = [
      { machineId: 'down', nickname: 'Down', url: 'http://down:4042' },
      { machineId: 'mini', nickname: 'the Mini', url: 'http://mini:4042' },
    ];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('down')) throw new Error('ECONNREFUSED');
      return ok([{ id: 'a1', status: 'active' }]);
    });
    const views = await fetchPeerSubscriptionViews({ peers: () => peers, fetchImpl: fetchImpl as never, authToken: 't' });
    expect(views.map((v) => v.machineId)).toEqual(['mini']); // down skipped, mini kept
  });

  it('skips a non-200 peer', async () => {
    const peers: PeerRef[] = [{ machineId: 'p', nickname: 'P', url: 'http://p:4042' }];
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const views = await fetchPeerSubscriptionViews({ peers: () => peers, fetchImpl: fetchImpl as never, authToken: 't' });
    expect(views).toEqual([]);
  });

  it('no peers → empty (single-machine no-op)', async () => {
    const views = await fetchPeerSubscriptionViews({ peers: () => [], fetchImpl: (async () => ok([])) as never, authToken: 't' });
    expect(views).toEqual([]);
  });

  it('defensively ignores malformed account rows', async () => {
    const peers: PeerRef[] = [{ machineId: 'p', nickname: 'P', url: 'http://p:4042' }];
    const fetchImpl = vi.fn(async () => ok([{ noId: true }, { id: 'good', status: 'warming' }]));
    const views = await fetchPeerSubscriptionViews({ peers: () => peers, fetchImpl: fetchImpl as never, authToken: 't' });
    expect(views[0].accounts).toHaveLength(1);
    expect(views[0].accounts[0].accountId).toBe('good');
  });
});
