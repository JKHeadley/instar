/**
 * takeover-ready-pool R1 — HttpLeaseTransport's `responded` outcome: each lease pull is
 * recorded as a signed answer, an unsigned Instar answer (the marker on a Tailscale or
 * named-tunnel endpoint, any status but the tunnel edge's), or silence. Today every non-2xx
 * collapsed to {confirmed:false}; the boot hold needs the difference.
 */
import { describe, it, expect } from 'vitest';
import { HttpLeaseTransport, instarMachineMarker, type LeasePeer } from '../../src/core/HttpLeaseTransport.js';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { signLeaseAck, type LeaseAck } from '../../src/server/machineAuth.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';
import type { MeshEndpoint } from '../../src/core/types.js';

const PEER = 'm_studio';
const keys = generateSigningKeyPair();
const TS: MeshEndpoint = { kind: 'tailscale', url: 'http://100.64.0.9:4042' };
const NAMED: MeshEndpoint = { kind: 'cloudflare', url: 'https://studio.example.dev' };
const QUICK: MeshEndpoint = { kind: 'cloudflare', url: 'https://abc-def.trycloudflare.com' };
const LAN: MeshEndpoint = { kind: 'lan', url: 'http://192.168.1.9:4042' };

type Reply = { status: number; marker?: string | null; signed?: boolean } | 'throw';

function fetchWith(reply: (url: string) => Reply) {
  return (async (url: string, init?: RequestInit) => {
    const r = reply(url);
    if (r === 'throw') throw new Error('ECONNREFUSED');
    const headers = new Headers();
    if (r.marker) headers.set('X-Instar-Machine', r.marker);
    let body: unknown = { error: 'starting' };
    if (r.signed) {
      const reqNonce = JSON.parse(String(init?.body ?? '{}')).reqNonce as string;
      const ack: LeaseAck = { machineId: PEER, reqNonce, observedEpoch: 0 };
      body = { ok: true, lease: null, ack, sig: signLeaseAck(ack, keys.privateKey) };
    }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

function transport(endpoints: MeshEndpoint[], reply: (url: string) => Reply, opts: { mesh?: boolean; ackCapable?: boolean } = {}) {
  let now = 1_000;
  const peer: LeasePeer = { machineId: PEER, url: endpoints[0]?.url ?? 'http://x', endpoints, publicKeyPem: keys.publicKey, meshAckCapable: opts.ackCapable ?? true };
  const t = new HttpLeaseTransport({
    selfMachineId: 'm_laptop',
    signingKeyPem: generateSigningKeyPair().privateKey,
    peers: () => [peer],
    nextSequence: () => 1,
    fetchImpl: fetchWith(reply),
    resolver: new PeerEndpointResolver({ config: { enabled: true, hedgeDelayMs: 5, priorityTailscale: 10, priorityLan: 20, priorityCloudflare: 30, tailscaleEnabled: true, lanSubnetGate: false, unhealthyAfterFailures: 3, endpointEvictionMs: 3_600_000, maxProbeBackoffMs: 300_000, requestTimeoutMs: 30_000 } }),
    meshTransportEnabled: () => opts.mesh ?? true,
    hedgeDelayMs: 5,
    now: () => now,
  });
  return { t, tick: (ms: number) => { now += ms; } };
}
const mark = instarMachineMarker(PEER);
const lastAnswer = (t: HttpLeaseTransport) => t.probeHistory().get(PEER)!.probes.at(-1)!.answer;

describe('instarMachineMarker', () => {
  it('is a stable per-machine fingerprint that does not disclose the id', () => {
    expect(instarMachineMarker(PEER)).toBe(mark);
    expect(mark).toMatch(/^[0-9a-f]{16}$/);
    expect(mark).not.toContain('studio');
    expect(instarMachineMarker('m_other')).not.toBe(mark);
  });
});

describe('lease-pull probe classification', () => {
  it('a verified accept-ack is a signed answer', async () => {
    const { t } = transport([TS], () => ({ status: 200, signed: true, marker: mark }));
    await t.pullAllPeers();
    expect(lastAnswer(t)).toBe('signed');
  });
  it('a 503 while starting with this peer\'s marker over Tailscale is an unsigned answer', async () => {
    const { t } = transport([TS], () => ({ status: 503, marker: mark }));
    await t.pullAllPeers();
    expect(lastAnswer(t)).toBe('unsigned');
    expect(t.probeHistory().get(PEER)!.unsignedSinceMs).toBe(1_000);
  });
  it('the same over a named tunnel counts; over a quick tunnel or the LAN it does not', async () => {
    for (const [ep, want] of [[NAMED, 'unsigned'], [QUICK, 'silent'], [LAN, 'silent']] as const) {
      const { t } = transport([ep], () => ({ status: 503, marker: mark }));
      await t.pullAllPeers();
      expect(lastAnswer(t)).toBe(want);
    }
  });
  it('a dead origin behind the tunnel (530 / 52x from the edge) is silence, marker or not', async () => {
    for (const status of [530, 522, 524]) {
      const { t } = transport([NAMED], () => ({ status, marker: mark }));
      await t.pullAllPeers();
      expect(lastAnswer(t)).toBe('silent');
    }
  });
  it('a reply without the marker, or another machine\'s marker, is silence', async () => {
    for (const marker of [null, instarMachineMarker('m_someone_else')]) {
      const { t } = transport([TS], () => ({ status: 503, marker }));
      await t.pullAllPeers();
      expect(lastAnswer(t)).toBe('silent');
    }
  });
  it('a network error is silence', async () => {
    const { t } = transport([TS], () => 'throw');
    await t.pullAllPeers();
    expect(lastAnswer(t)).toBe('silent');
  });
  it('a 200 from a peer that cannot sign acks is only an unsigned answer', async () => {
    const { t } = transport([TS], () => ({ status: 200, marker: mark }), { ackCapable: false });
    await t.pullAllPeers();
    expect(lastAnswer(t)).toBe('unsigned');
  });
  it('a legacy dial (no endpoint kind) counts only signed replies, so it is silence', async () => {
    const { t } = transport([TS], () => ({ status: 200, marker: mark, signed: true }), { mesh: false });
    await t.pullAllPeers();
    expect(lastAnswer(t)).toBe('silent');
  });
  it('the best rope wins: one rope silent, the other answering unsigned', async () => {
    const { t } = transport([TS, NAMED], (url) => (url.startsWith(TS.url) ? 'throw' : { status: 503, marker: mark }));
    await t.pullAllPeers();
    expect(lastAnswer(t)).toBe('unsigned');
  });
  it('a signed answer resets the unsigned run; the record is bounded', async () => {
    let signed = false;
    const { t, tick } = transport([TS], () => ({ status: signed ? 200 : 503, marker: mark, signed }));
    await t.pullAllPeers();
    tick(5_000);
    signed = true;
    await t.pullAllPeers();
    expect(t.probeHistory().get(PEER)!.unsignedSinceMs).toBeNull();
    signed = false;
    for (let i = 0; i < 50; i++) { tick(5_000); await t.pullAllPeers(); }
    expect(t.probeHistory().get(PEER)!.probes.length).toBeLessThanOrEqual(32);
    expect(t.knownPeerIds()).toEqual([PEER]);
  });
});
