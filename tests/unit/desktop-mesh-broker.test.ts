import { describe, expect, it, vi } from 'vitest';
import { DesktopMeshBroker } from '../../src/server/DesktopMeshBroker.js';
import { generateSigningKeyPair, verify } from '../../src/core/MachineIdentity.js';
import { canonicalDesktopOperatorAssertion } from '../../src/core/DesktopOperatorAssertion.js';

const SELF = `m_${'a'.repeat(32)}`;
const TARGET = `m_${'b'.repeat(32)}`;
const OTHER = `m_${'c'.repeat(32)}`;

describe('DesktopMeshBroker', () => {
  it('reserves three remote slots during concurrent admission and quarantines a restarted front', async () => {
    const keys = generateSigningKeyPair();
    let now = 1_800_000_000_000;
    const pending: Array<(response: Response) => void> = [];
    const broker = new DesktopMeshBroker({ selfMachineId: SELF, signingKeyPem: keys.privateKey,
      peers: () => [{ machineId: TARGET, url: 'https://echo-mini.dawn-tunnel.dev', kind: 'cloudflare' }],
      verifyFrontSession: () => true, now: () => now,
      fetch: (() => new Promise<Response>(resolve => pending.push(resolve))) as typeof fetch,
    });
    const input = { machineId: TARGET, browserPublicKey: 'browser-key',
      browserEcdhPublicKey: 'ecdh-key', browserNonce: '0123456789abcdef' };
    await expect(broker.begin('front-pin', input)).rejects.toThrow('target unavailable');
    now += 25_000;
    const begins = [broker.begin('front-pin', input), broker.begin('front-pin', input),
      broker.begin('front-pin', input)];
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    await expect(broker.begin('front-pin', input)).rejects.toThrow('target unavailable');
    pending.forEach((resolve, index) => resolve(Response.json({
      requestId: `12345678-1234-1234-1234-${String(index + 1).padStart(12, '0')}`,
      targetSessionToken: 'T'.repeat(43),
    })));
    await Promise.all(begins);
    await expect(broker.begin('front-pin', input)).rejects.toThrow('target unavailable');
    broker.close();
  });

  it('cannot resurrect a target grant or heartbeat after front shutdown during begin', async () => {
    const keys = generateSigningKeyPair();
    let answer!: (response: Response) => void;
    const beginReply = new Promise<Response>(resolve => { answer = resolve; });
    let signalFetch!: () => void;
    const fetchStarted = new Promise<void>(resolve => { signalFetch = resolve; });
    const broker = new DesktopMeshBroker({ selfMachineId: SELF, signingKeyPem: keys.privateKey,
      peers: () => [{ machineId: TARGET, url: 'https://echo-mini.dawn-tunnel.dev', kind: 'cloudflare' }],
      verifyFrontSession: () => true, startupQuarantineMs: 0,
      fetch: (() => { signalFetch(); return beginReply; }) as typeof fetch,
    });
    const started = broker.begin('front-pin', { machineId: TARGET, browserPublicKey: 'browser-key',
      browserEcdhPublicKey: 'ecdh-key', browserNonce: '0123456789abcdef' });
    await fetchStarted;
    broker.close();
    answer(Response.json({ requestId: '12345678-1234-1234-1234-123456789abc',
      targetSessionToken: 'T'.repeat(43) }));
    await expect(started).rejects.toThrow('desktop front closed');
    expect(broker.hasRequest('12345678-1234-1234-1234-123456789abc')).toBe(false);
    await expect(broker.begin('front-pin', { machineId: TARGET, browserPublicKey: 'browser-key',
      browserEcdhPublicKey: 'ecdh-key', browserNonce: '0123456789abcdef' }))
      .rejects.toThrow('target unavailable');
  });

  it('attests the exact target and browser only after a live front PIN session', async () => {
    const keys = generateSigningKeyPair();
    let pinValid = false;
    const requests: Array<Record<string, unknown>> = [];
    const send = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      return Response.json({ requestId: '12345678-1234-1234-1234-123456789abc', targetSessionToken: 'T'.repeat(43) }, { status: 201 });
    });
    const broker = new DesktopMeshBroker({ selfMachineId: SELF, signingKeyPem: keys.privateKey,
      peers: () => [{ machineId: TARGET, url: 'https://echo-mini.dawn-tunnel.dev', kind: 'cloudflare' }],
      verifyFrontSession: token => pinValid && token === 'front-pin', fetch: send as typeof fetch,
      now: () => 1_800_000_000_000, startupQuarantineMs: 0 });
    const input = { machineId: TARGET, browserPublicKey: 'browser-key', browserEcdhPublicKey: 'ecdh-key',
      browserNonce: '0123456789abcdef' };
    await expect(broker.begin('front-pin', input)).rejects.toThrow('PIN');
    expect(send).not.toHaveBeenCalled();
    pinValid = true;
    await expect(broker.begin('front-pin', { ...input, machineId: OTHER })).rejects.toThrow('target unavailable');
    expect(send).not.toHaveBeenCalled();
    const begun = await broker.begin('front-pin', input);
    expect(begun.requestId).toBe('12345678-1234-1234-1234-123456789abc');
    const assertion = requests[0].assertion as Record<string, unknown>;
    expect(assertion.issuerMachineId).toBe(SELF);
    expect(assertion.targetMachineId).toBe(TARGET);
    const { signature, ...unsigned } = assertion;
    expect(verify(canonicalDesktopOperatorAssertion(unsigned as never), String(signature), keys.publicKey)).toBe(true);
    pinValid = false;
    await expect(broker.control('front-pin', begun.requestId, 'status')).rejects.toThrow('request unavailable');
    expect(send).toHaveBeenCalledTimes(1);
    await (broker as unknown as { refresh(id: string, token: string): Promise<void> })
      .refresh(begun.requestId, 'front-pin');
    expect(requests[1]).toEqual(expect.objectContaining({
      requestId: begun.requestId, operation: 'revoke', targetSessionToken: 'T'.repeat(43),
    }));
    expect(broker.hasRequest(begun.requestId)).toBe(false);
    broker.close();
  });

  it('routes only one short-lived ticket to its matching target', async () => {
    const keys = generateSigningKeyPair();
    const requestId = '12345678-1234-1234-1234-123456789abc';
    const ticket = 'K'.repeat(43);
    let now = 1_800_000_000_000;
    const send = vi.fn(async (url: string) => Response.json(url.endsWith('operator-begin')
      ? { requestId, targetSessionToken: 'T'.repeat(43) }
      : { machineId: TARGET, label: 'Mac Mini', ticket }));
    const broker = new DesktopMeshBroker({ selfMachineId: SELF, signingKeyPem: keys.privateKey,
      peers: () => [{ machineId: TARGET, url: 'https://echo-mini.dawn-tunnel.dev', kind: 'cloudflare' }],
      verifyFrontSession: () => true, fetch: send as typeof fetch, now: () => now,
      startupQuarantineMs: 0 });
    await broker.begin('front-pin', { machineId: TARGET, browserPublicKey: 'browser-key',
      browserEcdhPublicKey: 'ecdh-key', browserNonce: '0123456789abcdef' });
    await broker.control('front-pin', requestId, 'ticket', { connectionNonce: 'nonce', signature: 'proof' });
    expect(broker.consumeTicket(ticket)).toEqual({ requestId, url: 'https://echo-mini.dawn-tunnel.dev' });
    expect(broker.consumeTicket(ticket)).toBeNull();
    now += 20_000;
    broker.close();
  });

  it('stops locally before peer lookup and refuses another session without disconnecting', async () => {
    const keys = generateSigningKeyPair();
    const requestId = '12345678-1234-1234-1234-123456789abc';
    let peerOnline = true;
    const forgotten: string[] = [];
    const send = vi.fn(async () => Response.json({ requestId, targetSessionToken: 'T'.repeat(43) }));
    const broker = new DesktopMeshBroker({ selfMachineId: SELF, signingKeyPem: keys.privateKey,
      peers: () => peerOnline ? [{ machineId: TARGET, url: 'https://echo-mini.dawn-tunnel.dev', kind: 'cloudflare' }] : [],
      verifyFrontSession: () => true, fetch: send as typeof fetch,
      startupQuarantineMs: 0, onForget: id => forgotten.push(id) });
    await broker.begin('owner', { machineId: TARGET, browserPublicKey: 'key',
      browserEcdhPublicKey: 'ecdh', browserNonce: '0123456789abcdef' });
    await expect(broker.control('other', requestId, 'revoke')).rejects.toThrow('request unavailable');
    expect(broker.hasRequest(requestId)).toBe(true);
    expect(forgotten).toEqual([]);
    peerOnline = false;
    expect(await broker.control('owner', requestId, 'revoke')).toEqual({ revoked: true });
    expect(broker.hasRequest(requestId)).toBe(false);
    expect(forgotten).toEqual([requestId]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not issue a ticket when Stop overtakes an in-flight command', async () => {
    const keys = generateSigningKeyPair();
    const requestId = '12345678-1234-1234-1234-123456789abc';
    const ticket = 'K'.repeat(43);
    let answer!: (response: Response) => void;
    let ticketSignal: AbortSignal | undefined;
    let signalCommand!: () => void;
    const commandStarted = new Promise<void>(resolve => { signalCommand = resolve; });
    const send = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('operator-begin')) return Response.json({ requestId, targetSessionToken: 'T'.repeat(43) });
      if (url.endsWith('operator-command')) {
        if (JSON.parse(String(init?.body)).operation === 'revoke') return Response.json({ revoked: true });
        ticketSignal = init?.signal ?? undefined;
        signalCommand();
        return new Promise<Response>(resolve => { answer = resolve; });
      }
      return Response.json({});
    });
    const broker = new DesktopMeshBroker({ selfMachineId: SELF, signingKeyPem: keys.privateKey,
      peers: () => [{ machineId: TARGET, url: 'https://echo-mini.dawn-tunnel.dev', kind: 'cloudflare' }],
      verifyFrontSession: () => true, fetch: send as typeof fetch, startupQuarantineMs: 0 });
    await broker.begin('owner', { machineId: TARGET, browserPublicKey: 'key',
      browserEcdhPublicKey: 'ecdh', browserNonce: '0123456789abcdef' });
    const pending = broker.control('owner', requestId, 'ticket');
    await commandStarted;
    const stop = broker.control('owner', requestId, 'revoke');
    expect(ticketSignal?.aborted).toBe(true);
    answer(Response.json({ machineId: TARGET, ticket }));
    await expect(pending).rejects.toThrow('request unavailable');
    expect(broker.consumeTicket(ticket)).toBeNull();
    await stop;
  });

  it('relays the screen list read to the target', async () => {
    const keys = generateSigningKeyPair();
    const requestId = '12345678-1234-1234-1234-123456789abc';
    const bodies: Array<Record<string, unknown>> = [];
    const send = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('operator-begin')) return Response.json({ requestId, targetSessionToken: 'T'.repeat(43) });
      if (url.endsWith('operator-command')) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ supported: true, platform: 'macos', displays: [], currentDisplayId: null, canShowAll: false });
      }
      return Response.json({});
    });
    const broker = new DesktopMeshBroker({ selfMachineId: SELF, signingKeyPem: keys.privateKey,
      peers: () => [{ machineId: TARGET, url: 'https://echo-mini.dawn-tunnel.dev', kind: 'cloudflare' }],
      verifyFrontSession: () => true, fetch: send as typeof fetch, startupQuarantineMs: 0 });
    await broker.begin('owner', { machineId: TARGET, browserPublicKey: 'key',
      browserEcdhPublicKey: 'ecdh', browserNonce: '0123456789abcdef' });
    expect(await broker.control('owner', requestId, 'displays')).toMatchObject({ supported: true, platform: 'macos' });
    expect(bodies.at(-1)).toMatchObject({ operation: 'displays', requestId });
    broker.close();
  });

  it('feeds the shared rope health authority only for transport failures', async () => {
    const keys = generateSigningKeyPair();
    const results: boolean[] = [];
    let transportFails = false;
    const broker = new DesktopMeshBroker({ selfMachineId: SELF, signingKeyPem: keys.privateKey,
      peers: () => [{ machineId: TARGET, url: 'https://echo-mini.dawn-tunnel.dev', kind: 'cloudflare' }],
      verifyFrontSession: () => true,
      startupQuarantineMs: 0,
      recordRopeResult: (_id, _kind, ok) => { results.push(ok); },
      fetch: (async () => {
        if (transportFails) throw new Error('offline');
        return Response.json({ error: 'desktop dark' }, { status: 503 });
      }) as typeof fetch,
    });
    const input = { machineId: TARGET, browserPublicKey: 'browser-key',
      browserEcdhPublicKey: 'ecdh-key', browserNonce: '0123456789abcdef' };
    await expect(broker.begin('front-pin', input)).rejects.toThrow('unavailable');
    transportFails = true;
    await expect(broker.begin('front-pin', input)).rejects.toThrow('offline');
    expect(results).toEqual([true, false]);
  });
});
