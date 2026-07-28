import { describe, it, expect } from 'vitest';
import { HttpLeaseTransport, type LeasePeer } from '../../src/core/HttpLeaseTransport.js';
import { PeerEndpointResolver, type PeerEndpointResolverConfig } from '../../src/core/PeerEndpointResolver.js';
import { signLeaseAck, type LeaseAck } from '../../src/server/machineAuth.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';
import type { LeaseRecord, MeshEndpoint } from '../../src/core/types.js';

const PEER_ID = 'm_peer';
const peerKeys = generateSigningKeyPair();

function mkLease(epoch = 7): LeaseRecord {
  return { holder: 'm_self', epoch, acquiredAt: '2026-06-20T00:00:00Z', expiresAt: '2026-06-20T00:01:00Z', nonce: epoch } as LeaseRecord;
}

function resolverCfg(): PeerEndpointResolverConfig {
  return {
    enabled: true,
    hedgeDelayMs: 10,
    priorityTailscale: 10,
    priorityLan: 20,
    priorityCloudflare: 30,
    tailscaleEnabled: true,
    lanSubnetGate: false,
    unhealthyAfterFailures: 3,
    endpointEvictionMs: 3_600_000,
    maxProbeBackoffMs: 300_000,
    requestTimeoutMs: 30_000,
  };
}

/**
 * Build a mock fetch that simulates ack-capable receivers per-URL. `behavior(url)`
 * returns 'ok' (signed ack confirming), 'higher' (signed ack at epoch+1), 'bare'
 * (200 with no ack), 'stranger' (200 ack signed by a DIFFERENT key), 'fail'
 * (network error), or 'down' (non-2xx).
 */
function mockFetch(behavior: (url: string) => string, foldEpoch = () => 7) {
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    const b = behavior(url);
    if (b === 'fail') throw new Error('ECONNREFUSED');
    if (b === 'down') return { ok: false, status: 502, json: async () => null } as unknown as Response;
    const body = JSON.parse(String(init?.body ?? '{}'));
    const reqNonce = body.reqNonce as string;
    const observedEpoch = b === 'higher' ? foldEpoch() + 1 : foldEpoch();
    if (b === 'bare') return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    const ack: LeaseAck = { machineId: PEER_ID, reqNonce, observedEpoch };
    const signer = b === 'stranger' ? generateSigningKeyPair().privateKey : peerKeys.privateKey;
    const sig = signLeaseAck(ack, signer);
    const lease = mkLease(observedEpoch);
    return { ok: true, status: 200, json: async () => ({ ok: true, ack, sig, lease }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function mkTransport(peer: LeasePeer, fetchImpl: typeof fetch, opts: { meshOn?: boolean } = {}) {
  const resolver = new PeerEndpointResolver({ config: resolverCfg() });
  return new HttpLeaseTransport({
    selfMachineId: 'm_self',
    signingKeyPem: generateSigningKeyPair().privateKey,
    peers: () => [peer],
    nextSequence: () => 1,
    fetchImpl,
    resolver,
    meshTransportEnabled: () => opts.meshOn ?? true,
    hedgeDelayMs: 10,
    requestTimeoutMs: 30_000,
  });
}

const TS: MeshEndpoint = { kind: 'tailscale', url: 'http://100.64.0.9:4042' };
const CF: MeshEndpoint = { kind: 'cloudflare', url: 'https://peer.dawn-tunnel.dev' };

describe('HttpLeaseTransport — hedged mesh broadcast (accept-ack)', () => {
  const ackPeer: LeasePeer = { machineId: PEER_ID, url: 'https://peer.dawn-tunnel.dev', endpoints: [TS, CF], publicKeyPem: peerKeys.publicKey, meshAckCapable: true };

  it('confirms over the best rope with a verified accept-ack', async () => {
    const { fn } = mockFetch(() => 'ok');
    const t = mkTransport(ackPeer, fn);
    expect(await t.broadcast(mkLease(7))).toBe(true);
  });

  it('a bare-200 (no ack) from an ack-capable peer is NOT confirmed (fail-closed)', async () => {
    const { fn } = mockFetch(() => 'bare');
    const t = mkTransport(ackPeer, fn);
    expect(await t.broadcast(mkLease(7))).toBe(false);
  });

  it('a stranger (ack signed by the wrong key) is NOT confirmed', async () => {
    const { fn } = mockFetch(() => 'stranger');
    const t = mkTransport(ackPeer, fn);
    expect(await t.broadcast(mkLease(7))).toBe(false);
  });

  it('a higher-epoch ack is NOT a renewal confirmation (takeover signal)', async () => {
    const { fn } = mockFetch(() => 'higher');
    const t = mkTransport(ackPeer, fn);
    expect(await t.broadcast(mkLease(7))).toBe(false);
  });

  it('fails over to the second rope when the first (tailscale) errors', async () => {
    const { fn, calls } = mockFetch((url) => (url.includes('100.64.0.9') ? 'fail' : 'ok'));
    const t = mkTransport(ackPeer, fn);
    expect(await t.broadcast(mkLease(7))).toBe(true);
    expect(calls.some((u) => u.includes('peer.dawn-tunnel.dev'))).toBe(true);
  });

  it('all ropes down ⇒ not reachable', async () => {
    const { fn } = mockFetch(() => 'down');
    const t = mkTransport(ackPeer, fn);
    expect(await t.broadcast(mkLease(7))).toBe(false);
    expect(t.isReachable()).toBe(false);
  });

  it('meshTransportEnabled=false ⇒ legacy single-url path (bare-200 confirms)', async () => {
    const { fn, calls } = mockFetch(() => 'bare');
    const t = mkTransport(ackPeer, fn, { meshOn: false });
    expect(await t.broadcast(mkLease(7))).toBe(true); // legacy 2xx accepted
    // legacy path hits the single url, not the tailscale rope
    expect(calls.every((u) => u.includes('peer.dawn-tunnel.dev'))).toBe(true);
  });
});

describe('HttpLeaseTransport — hedged mesh pull (identity ack)', () => {
  const ackPeer: LeasePeer = { machineId: PEER_ID, url: 'https://peer.dawn-tunnel.dev', endpoints: [TS, CF], publicKeyPem: peerKeys.publicKey, meshAckCapable: true };

  it('pull confirms via identity ack and folds the returned lease', async () => {
    const { fn } = mockFetch(() => 'ok', () => 9);
    const t = mkTransport(ackPeer, fn);
    const lease = await t.pullPeer(ackPeer);
    expect(lease?.epoch).toBe(9);
    expect(t.isReachable()).toBe(true);
  });

  it('pull from a stranger is rejected (no fold, not reachable)', async () => {
    const { fn } = mockFetch(() => 'stranger');
    const t = mkTransport(ackPeer, fn);
    expect(await t.pullPeer(ackPeer)).toBeNull();
  });
});

describe('HttpLeaseTransport — un-upgraded (non-ack-capable) peer back-compat', () => {
  it('a non-ack-capable peer is confirmed on a 2xx (rolling-deploy safety)', async () => {
    const legacyPeer: LeasePeer = { machineId: PEER_ID, url: 'https://peer.dawn-tunnel.dev', meshAckCapable: false };
    const { fn } = mockFetch(() => 'bare');
    const t = mkTransport(legacyPeer, fn);
    expect(await t.broadcast(mkLease(7))).toBe(true); // 2xx accepted (no ack required)
  });
});

// ── mesh-endpoint-http-propagation — sender body + pull-response recording ──

import { PeerEndpointRecorder } from '../../src/core/PeerEndpointRecorder.js';

const ackPeer: LeasePeer = { machineId: PEER_ID, url: 'https://peer.dawn-tunnel.dev', endpoints: [TS, CF], publicKeyPem: peerKeys.publicKey, meshAckCapable: true };
const SELF_EPS: MeshEndpoint[] = [{ kind: 'tailscale', url: 'http://100.64.165.27:4042' }, { kind: 'lan', url: 'http://192.168.87.60:4042' }];

/** A fetch that captures the bodies it was sent (to assert the signed self-endpoints field). */
function capturingFetch(behavior: (url: string) => string = () => 'ok') {
  const bodies: any[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    const b = behavior(url);
    if (b === 'down') return { ok: false, status: 502, json: async () => null } as unknown as Response;
    const body = JSON.parse(String(init?.body ?? '{}'));
    const ack: LeaseAck = { machineId: PEER_ID, reqNonce: body.reqNonce, observedEpoch: 7 };
    const sig = signLeaseAck(ack, peerKeys.privateKey);
    // The holder serves its OWN endpoints back in the pull RESPONSE.
    return { ok: true, status: 200, json: async () => ({ ok: true, ack, sig, lease: mkLease(7), endpoints: SELF_EPS }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

describe('HttpLeaseTransport — sender carries self-endpoints in the signed body', () => {
  function mkSendingTransport(fetchImpl: typeof fetch, selfEps?: MeshEndpoint[]) {
    const resolver = new PeerEndpointResolver({ config: resolverCfg() });
    return new HttpLeaseTransport({
      selfMachineId: 'm_self',
      signingKeyPem: generateSigningKeyPair().privateKey,
      peers: () => [ackPeer],
      nextSequence: () => 1,
      fetchImpl,
      resolver,
      meshTransportEnabled: () => true,
      hedgeDelayMs: 10,
      requestTimeoutMs: 30_000,
      getSelfEndpoints: () => selfEps,
    });
  }

  it('broadcast body includes this machine\'s self-endpoints', async () => {
    const { fn, bodies } = capturingFetch();
    const t = mkSendingTransport(fn, SELF_EPS);
    await t.broadcast(mkLease(7));
    expect(bodies[0].endpoints).toEqual(SELF_EPS);
  });

  it('pull request body includes this machine\'s self-endpoints', async () => {
    const { fn, bodies } = capturingFetch();
    const t = mkSendingTransport(fn, SELF_EPS);
    await t.pullPeer(ackPeer);
    expect(bodies[0].endpoints).toEqual(SELF_EPS);
  });

  it('an un-upgraded sender (no self-endpoints) OMITS the field', async () => {
    const { fn, bodies } = capturingFetch();
    const t = mkSendingTransport(fn, undefined);
    await t.broadcast(mkLease(7));
    expect('endpoints' in bodies[0]).toBe(false);
  });
});

describe('HttpLeaseTransport — pull RESPONSE records the holder endpoints (verified responder)', () => {
  function mkPullingTransport(fetchImpl: typeof fetch, recorder: PeerEndpointRecorder) {
    const resolver = new PeerEndpointResolver({ config: resolverCfg() });
    return new HttpLeaseTransport({
      selfMachineId: 'm_self',
      signingKeyPem: generateSigningKeyPair().privateKey,
      peers: () => [ackPeer],
      nextSequence: () => 1,
      fetchImpl,
      resolver,
      meshTransportEnabled: () => true,
      hedgeDelayMs: 10,
      requestTimeoutMs: 30_000,
      peerEndpointRecorder: recorder,
    });
  }

  it('records the holder\'s endpoints against the dialed peer on a confirmed pull', async () => {
    const store: Record<string, MeshEndpoint[]> = {};
    const recorder = new PeerEndpointRecorder({
      getPeerEndpoints: (id) => store[id],
      updateMachineEndpoints: (id, eps) => { store[id] = eps; },
      meshTransportEnabled: () => true,
    });
    const { fn } = capturingFetch();
    const t = mkPullingTransport(fn, recorder);
    await t.pullPeer(ackPeer);
    expect(store[PEER_ID]).toEqual(SELF_EPS);
  });

  it('does NOT record when the responder identity fails (stranger ack)', async () => {
    const store: Record<string, MeshEndpoint[]> = {};
    const recorder = new PeerEndpointRecorder({
      getPeerEndpoints: (id) => store[id],
      updateMachineEndpoints: (id, eps) => { store[id] = eps; },
      meshTransportEnabled: () => true,
    });
    // stranger: ack signed by a different key ⇒ interpretResponse returns unconfirmed ⇒ no record
    const strangerFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const ack: LeaseAck = { machineId: PEER_ID, reqNonce: body.reqNonce, observedEpoch: 7 };
      const sig = signLeaseAck(ack, generateSigningKeyPair().privateKey);
      return { ok: true, status: 200, json: async () => ({ ok: true, ack, sig, lease: mkLease(7), endpoints: SELF_EPS }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const t = mkPullingTransport(strangerFetch, recorder);
    expect(await t.pullPeer(ackPeer)).toBeNull();
    expect(store[PEER_ID]).toBeUndefined();
  });
});
