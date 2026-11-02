/**
 * Pool reads fall through a dead rope (2026-11-02, Studio): a peer's Cloudflare
 * tunnel answered HTTP 530 on every pooled read while its Tailscale rope worked.
 * poolPeerFetch recorded the 530 as a healthy rope (any Response did), so the
 * tunnel was chosen again on every read and Home kept saying part of the list
 * could not be checked.
 */
import { describe, it, expect, vi } from 'vitest';
import { poolPeerFetch, isCloudflareEdgeFailure } from '../../src/server/poolPeerFetch.js';

const PEER = {
  machineId: 'm_e8c9b243c449b1337713bc29d47a6f3a',
  url: 'https://echo-mama.dawn-tunnel.dev', kind: 'cloudflare',
  ropes: [
    { url: 'https://echo-mama.dawn-tunnel.dev', kind: 'cloudflare' },
    { url: 'https://mama-pc.tail1234.ts.net', kind: 'tailscale' },
  ],
};
const res = (status: number) => new Response(JSON.stringify({ items: [] }), { status });
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const admitAll = () => true;

describe('a Cloudflare edge error is a dead rope, not a peer answer', () => {
  it('520-530 from a cloudflare rope only', () => {
    expect(isCloudflareEdgeFailure('cloudflare', 530)).toBe(true);
    expect(isCloudflareEdgeFailure('cloudflare', 522)).toBe(true);
    expect(isCloudflareEdgeFailure('cloudflare', 503)).toBe(false);
    expect(isCloudflareEdgeFailure('cloudflare', 502)).toBe(false);
    expect(isCloudflareEdgeFailure('tailscale', 530)).toBe(false);
  });

  it('records the 530 as a rope failure and falls through to the next rope on a GET', async () => {
    const record = vi.fn();
    const f = vi.fn(async (url: string) => (String(url).includes('dawn-tunnel') ? res(530) : res(200)));
    const r = await poolPeerFetch(record, PEER, '/attention', undefined, f as unknown as typeof fetch, admitAll);
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenNthCalledWith(1, PEER.machineId, 'cloudflare', false, expect.any(Number), PEER.ropes[0].url);
    expect(record).toHaveBeenNthCalledWith(2, PEER.machineId, 'tailscale', true, expect.any(Number), PEER.ropes[1].url);
  });

  it('falls through a refused dial on a GET', async () => {
    const f = vi.fn(async (url: string) => { if (String(url).includes('dawn-tunnel')) throw refused(); return res(200); });
    expect((await poolPeerFetch(undefined, PEER, '/sessions', undefined, f as unknown as typeof fetch, admitAll)).status).toBe(200);
  });
});

describe('what never falls through', () => {
  it('a real peer reply of any status is returned as-is (503 from a dark feature)', async () => {
    const f = vi.fn(async () => res(503));
    expect((await poolPeerFetch(undefined, PEER, '/x', undefined, f as unknown as typeof fetch, admitAll)).status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('a non-GET never tries a second rope', async () => {
    const f = vi.fn(async () => { throw refused(); });
    await expect(poolPeerFetch(undefined, PEER, '/x', { method: 'POST' }, f as unknown as typeof fetch, admitAll)).rejects.toThrow('fetch failed');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('an abort or timeout is not retried: the shared budget is spent', async () => {
    const f = vi.fn(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
    await expect(poolPeerFetch(undefined, PEER, '/x', undefined, f as unknown as typeof fetch, admitAll)).rejects.toThrow('timed out');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('a fallback rope the credential guard refuses is skipped; the edge reply is returned', async () => {
    const f = vi.fn(async () => res(530));
    const r = await poolPeerFetch(undefined, PEER, '/x', undefined, f as unknown as typeof fetch, () => false);
    expect(r.status).toBe(530);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('the default guard refuses plain-http Tailscale, so the token is never sent there', async () => {
    const peer = { ...PEER, ropes: [PEER.ropes[0], { url: 'http://100.70.1.2:4042', kind: 'tailscale' }] };
    const f = vi.fn(async () => res(530));
    const r = await poolPeerFetch(undefined, peer, '/x', undefined, f as unknown as typeof fetch);
    expect(r.status).toBe(530);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('with no ropes list, behaviour is the old single dial', async () => {
    const f = vi.fn(async () => res(530));
    const { ropes: _r, ...single } = PEER;
    expect((await poolPeerFetch(undefined, single, '/x', undefined, f as unknown as typeof fetch, admitAll)).status).toBe(530);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
