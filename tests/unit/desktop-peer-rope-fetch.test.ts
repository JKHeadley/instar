import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DESKTOP_CHECK_FAILURE_RE,
  desktopOwnCheckReason,
  desktopPeerCheckReason,
  desktopPeerRopes,
  fetchDesktopPeerOverRopes,
  isConnectClassFailure,
  tcpConnectCheck,
  type DesktopRope,
} from '../../src/server/desktopPeerRopeFetch.js';
import { DesktopMeshBroker } from '../../src/server/DesktopMeshBroker.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';

const MACHINE = `m_${'e'.repeat(32)}`;
const TAILSCALE: DesktopRope = { url: 'http://100.101.95.10:4040', kind: 'tailscale' };
const LAN: DesktopRope = { url: 'http://172.22.96.135:4040', kind: 'lan' };
const TUNNEL: DesktopRope = { url: 'https://stale.trycloudflare.com', kind: 'cloudflare' };

function connectRefused(): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}

const base = {
  machineId: MACHINE, path: '/api/desktop/setup',
  init: { method: 'POST', body: '{}', redirect: 'manual' as const },
  budgetMs: 8_000, connectCheckCapMs: 2_000, allowed: async () => true,
};

describe('desktopPeerRopes', () => {
  it('uses the full rope list in order when wired', () => {
    expect(desktopPeerRopes({ machineId: MACHINE, ...LAN, ropes: [TAILSCALE, LAN, TUNNEL] }))
      .toEqual([TAILSCALE, LAN, TUNNEL]);
  });

  it('puts the refused (higher-ranked) ropes ahead of the selection when no full list exists', () => {
    expect(desktopPeerRopes({ machineId: MACHINE, ...LAN, ropeRefusals: [TAILSCALE] })).toEqual([TAILSCALE, LAN]);
    expect(desktopPeerRopes({ machineId: MACHINE, ...LAN })).toEqual([LAN]);
  });
});

describe('fetchDesktopPeerOverRopes', () => {
  it('first rope dead at connect → the second rope carries the request, failure recorded', async () => {
    const record = vi.fn();
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const { rope } = await fetchDesktopPeerOverRopes({
      ...base, ropes: [LAN, TAILSCALE], record, fetchImpl: fetchImpl as unknown as typeof fetch,
      connectCheck: async url => url !== LAN.url,
    });
    expect(rope).toEqual(TAILSCALE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://100.101.95.10:4040/api/desktop/setup');
    expect(record).toHaveBeenCalledWith(MACHINE, 'lan', false, expect.any(Number), LAN.url);
    expect(record).toHaveBeenCalledWith(MACHINE, 'tailscale', true, expect.any(Number), TAILSCALE.url);
  });

  it('a connect-class fetch failure moves on to the next rope', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(connectRefused())
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { rope } = await fetchDesktopPeerOverRopes({
      ...base, ropes: [LAN, TAILSCALE], fetchImpl: fetchImpl as unknown as typeof fetch,
      connectCheck: async () => true,
    });
    expect(rope).toEqual(TAILSCALE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('an HTTP error from the first rope is authoritative — no retry on another rope', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"code":"refused"}', { status: 409 }));
    const { response, rope } = await fetchDesktopPeerOverRopes({
      ...base, ropes: [TAILSCALE, LAN], fetchImpl: fetchImpl as unknown as typeof fetch,
      connectCheck: async () => true,
    });
    expect(response.status).toBe(409);
    expect(rope).toEqual(TAILSCALE);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an ambiguous failure (abort after connect) is rethrown, never retried elsewhere', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(fetchDesktopPeerOverRopes({
      ...base, ropes: [TAILSCALE, LAN], fetchImpl: fetchImpl as unknown as typeof fetch,
      connectCheck: async () => true,
    })).rejects.toThrow('timed out');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('every rope dead → desktop-peer-unreachable; the last rope is dialled and its failure surfaces', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchDesktopPeerOverRopes({
      ...base, ropes: [LAN, TAILSCALE], fetchImpl: fetchImpl as unknown as typeof fetch,
      allowed: async () => false,
    })).rejects.toThrow('desktop-peer-unreachable');
    expect(fetchImpl).not.toHaveBeenCalled();
    const lastOnly = vi.fn().mockRejectedValue(connectRefused());
    await expect(fetchDesktopPeerOverRopes({
      ...base, ropes: [LAN, TUNNEL, TAILSCALE], fetchImpl: lastOnly as unknown as typeof fetch,
      connectCheck: async () => false,
    })).rejects.toThrow('fetch failed');
    expect(lastOnly).toHaveBeenCalledTimes(1);
    const allRefused = vi.fn().mockRejectedValue(connectRefused());
    await expect(fetchDesktopPeerOverRopes({
      ...base, ropes: [LAN, TAILSCALE], fetchImpl: allRefused as unknown as typeof fetch,
      connectCheck: async () => true,
    })).rejects.toThrow('fetch failed');
    expect(allRefused).toHaveBeenCalledTimes(2);
  });

  it('skips ropes the desktop gate refuses', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const { rope } = await fetchDesktopPeerOverRopes({
      ...base, ropes: [TUNNEL, TAILSCALE], fetchImpl: fetchImpl as unknown as typeof fetch,
      allowed: async r => r.kind === 'tailscale', connectCheck: async () => { throw new Error('no check for a sole rope'); },
    });
    expect(rope).toEqual(TAILSCALE);
  });

  it('a single admissible rope is dialled without a connect check (unchanged behaviour)', async () => {
    const connectCheck = vi.fn(async () => true);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await fetchDesktopPeerOverRopes({ ...base, ropes: [TAILSCALE], fetchImpl: fetchImpl as unknown as typeof fetch, connectCheck });
    expect(connectCheck).not.toHaveBeenCalled();
  });

  it('keeps the connect check inside the remaining budget', async () => {
    let now = 0;
    const seen: number[] = [];
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await fetchDesktopPeerOverRopes({
      ...base, budgetMs: 3_000, connectCheckCapMs: 1_000, now: () => now,
      ropes: [LAN, TUNNEL, TAILSCALE], fetchImpl: fetchImpl as unknown as typeof fetch,
      connectCheck: async (_url, timeoutMs) => { seen.push(timeoutMs); now += timeoutMs; return false; },
    });
    expect(seen).toEqual([1_000, 1_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('isConnectClassFailure', () => {
  it('recognises connect-level codes only', () => {
    expect(isConnectClassFailure(connectRefused())).toBe(true);
    expect(isConnectClassFailure({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).toBe(true);
    expect(isConnectClassFailure({ cause: { code: 'ECONNRESET' } })).toBe(false);
    expect(isConnectClassFailure(new DOMException('aborted', 'AbortError'))).toBe(false);
  });
});

describe('tcpConnectCheck', () => {
  it('answers true for a listening port and false for a closed one', async () => {
    const server: Server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    expect(await tcpConnectCheck(`http://127.0.0.1:${port}`, 1_000)).toBe(true);
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await tcpConnectCheck(`http://127.0.0.1:${port}`, 1_000)).toBe(false);
  });
});

describe('DesktopMeshBroker rope fallback', () => {
  it('reaches the target over the next rope and relays the stream to the rope that answered', async () => {
    const keys = generateSigningKeyPair();
    const calls: string[] = [];
    const send = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://dead-mini.dawn-tunnel.dev')) throw connectRefused();
      if (url.endsWith('/operator-begin')) {
        return Response.json({ requestId: '12345678-1234-1234-1234-123456789abc', targetSessionToken: 'T'.repeat(43) });
      }
      return Response.json({ machineId: MACHINE, ticket: 't'.repeat(32) });
    });
    const broker = new DesktopMeshBroker({ selfMachineId: `m_${'a'.repeat(32)}`, signingKeyPem: keys.privateKey,
      peers: () => [{ machineId: MACHINE, url: 'https://dead-mini.dawn-tunnel.dev', kind: 'cloudflare',
        ropes: [{ url: 'https://dead-mini.dawn-tunnel.dev', kind: 'cloudflare' }, { url: 'https://live-mini.dawn-tunnel.dev', kind: 'cloudflare' }] }],
      verifyFrontSession: () => true, fetch: send as unknown as typeof fetch, startupQuarantineMs: 0,
      ropeConnectCheck: async url => url !== 'https://dead-mini.dawn-tunnel.dev' });
    const { requestId } = await broker.begin('pin', { machineId: MACHINE, browserPublicKey: 'k',
      browserEcdhPublicKey: 'e', browserNonce: '0123456789abcdef' });
    expect(calls).toEqual(['https://live-mini.dawn-tunnel.dev/api/desktop/operator-begin']);
    await broker.control('pin', requestId, 'ticket');
    expect(broker.consumeTicket('t'.repeat(32))?.url).toBe('https://live-mini.dawn-tunnel.dev');
    broker.close();
    expect(requestId).toBeDefined();
  });
});

describe('desktopPeerCheckReason', () => {
  it('names each failure with a fixed word and never the raw text', () => {
    expect(desktopPeerCheckReason(Object.assign(new Error('desktop-peer-unavailable'), { status: 401 }))).toBe('http-401');
    expect(desktopPeerCheckReason(new Error('desktop-peer-unavailable'))).toBe('unavailable');
    expect(desktopPeerCheckReason(new Error('desktop-peer-unreachable'))).toBe('unreachable');
    expect(desktopPeerCheckReason(new Error('desktop-peer-response-bound'))).toBe('response-bound');
    expect(desktopPeerCheckReason(new DOMException('The operation timed out.', 'TimeoutError'))).toBe('timeout');
    expect(desktopPeerCheckReason(new DOMException('This operation was aborted', 'AbortError'))).toBe('timeout');
    expect(desktopPeerCheckReason(connectRefused())).toBe('connect');
    expect(desktopPeerCheckReason(new Error('secret path /Users/someone/x'))).toBe('other');
    expect(desktopPeerCheckReason(Object.assign(new Error('desktop-peer-unavailable'), { status: 9999 }))).toBe('unavailable');
    expect(desktopPeerCheckReason(null)).toBe('other');
    expect(desktopPeerCheckReason(Object.assign(new Error('peer-starting'), { name: 'PoolPeerBootingError' }))).toBe('starting');
    expect(desktopPeerCheckReason(new SyntaxError('Unexpected token < in JSON'))).toBe('reply-invalid');
    expect(desktopPeerCheckReason(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' }) }))).toBe('reset');
  });
});

describe('desktopOwnCheckReason', () => {
  it('names a failed own-desktop check with a fixed word the front may log', () => {
    expect(desktopOwnCheckReason(new DOMException('This operation was aborted', 'AbortError'))).toBe('timeout');
    expect(desktopOwnCheckReason(new Error('windows-desktop-companion-refused'))).toBe('windows-desktop-companion-refused');
    expect(desktopOwnCheckReason(new Error('windows-desktop-probe-invalid'))).toBe('windows-desktop-probe-invalid');
    expect(desktopOwnCheckReason(connectRefused())).toBe('connect');
    expect(desktopOwnCheckReason(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) }))).toBe('reset');
    expect(desktopOwnCheckReason(new Error('helper said: user Alice at /Users/alice'))).toBe('other');
    expect(desktopOwnCheckReason(new Error('windows-desktop-Bad Text'))).toBe('other');
    expect(desktopOwnCheckReason(undefined)).toBe('other');
  });

  it('every word it can return passes the front check, and free text does not', () => {
    for (const word of ['timeout', 'connect', 'reset', 'other', 'windows-desktop-video-stalled']) {
      expect(DESKTOP_CHECK_FAILURE_RE.test(word)).toBe(true);
    }
    for (const bad of ['', 'Could not check', 'a b', 'x'.repeat(61), 'path/to', 'ÄÖ']) {
      expect(DESKTOP_CHECK_FAILURE_RE.test(bad)).toBe(false);
    }
  });
});
