/**
 * Unit tests for ReplyMarkerTransport — cross-machine reply_committed marker
 * propagation (spec §8 G3a). Injected fetch; no network.
 */

import { describe, it, expect, vi } from 'vitest';
import { ReplyMarkerTransport, type ReplyMarker } from '../../src/core/ReplyMarkerTransport.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';

const SIGNING_KEY = generateSigningKeyPair().privateKey;

const MARKER: ReplyMarker = {
  dedupeKey: 'telegram:13481:5000',
  platform: 'telegram',
  replyIdempotencyKey: 'abc123',
  epoch: 2,
  topic: '13481',
};

function transport(opts: {
  peers: () => { machineId: string; url: string }[];
  fetchImpl: typeof fetch;
}) {
  return new ReplyMarkerTransport({
    selfMachineId: 'machine-a',
    signingKeyPem: SIGNING_KEY,
    peers: opts.peers,
    nextSequence: () => 1,
    fetchImpl: opts.fetchImpl,
  });
}

describe('ReplyMarkerTransport', () => {
  it('no peers → reachable no-op (true), no fetch', async () => {
    const fetchSpy = vi.fn();
    const t = transport({ peers: () => [], fetchImpl: fetchSpy as unknown as typeof fetch });
    const ok = await t.broadcast(MARKER);
    expect(ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs a signed marker to each peer /api/message-marker; true if any accepts', async () => {
    const calls: Array<{ url: string; body: unknown; hasSig: boolean }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({
        url,
        body: JSON.parse(init.body),
        hasSig: !!(init.headers['X-Machine-Id'] || init.headers['x-machine-id'] || init.headers['X-Machine-Signature'] || init.headers['x-machine-signature']),
      });
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const t = transport({
      peers: () => [{ machineId: 'machine-b', url: 'http://mini:4050/' }],
      fetchImpl,
    });
    const ok = await t.broadcast(MARKER);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://mini:4050/api/message-marker');
    expect((calls[0].body as { marker: ReplyMarker }).marker.dedupeKey).toBe(MARKER.dedupeKey);
    expect(calls[0].hasSig).toBe(true); // rode the signed machine channel
  });

  it('false when every peer rejects; never throws on a peer error', async () => {
    const fetchImpl = (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch;
    const t = transport({
      peers: () => [{ machineId: 'machine-b', url: 'http://mini:4050' }],
      fetchImpl,
    });
    const ok = await t.broadcast(MARKER);
    expect(ok).toBe(false); // no peer accepted, but the call resolved (didn't throw)
  });
});
