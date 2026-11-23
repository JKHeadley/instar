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

type Reply = { status: number; marker?: string | null; signed?: boolean } | 'throw' | { throwCode: string };

function fetchWith(reply: (url: string) => Reply) {
  return (async (url: string, init?: RequestInit) => {
    const r = reply(url);
    if (r === 'throw') throw new Error('ECONNREFUSED');
    if ('throwCode' in r) { const e = new TypeError('fetch failed'); (e as { cause?: unknown }).cause = Object.assign(new Error(r.throwCode), { code: r.throwCode }); throw e; }
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
  it('a legacy dial whose reply carries an identity ack bound to our request nonce is a signed answer (planned-restart-keeps-lead: a mesh-off pool no longer reads its answering peers as silent)', async () => {
    const { t } = transport([TS], () => ({ status: 200, marker: mark, signed: true }), { mesh: false });
    await t.pullAllPeers();
    expect(lastAnswer(t)).toBe('signed');
    expect(t.verifiedAnswers().get(PEER)).toMatchObject({ lease: null, round: 1 });
    expect(t.currentPullRound()).toEqual({ round: 1, startedAtMs: 1_000 });
  });
  it('a legacy dial answered 2xx without a verifiable ack is still silence for the boot hold (the 2xx still confirms the pull as today)', async () => {
    const { t } = transport([TS], () => ({ status: 200, marker: mark }), { mesh: false });
    await t.pullAllPeers();
    expect(lastAnswer(t)).toBe('silent');
    expect(t.verifiedAnswers().size).toBe(0);
  });
  it('probe listeners are told of every landed probe with its round, and a listener fault never breaks the pull', async () => {
    const { t } = transport([TS], () => ({ status: 200, marker: mark, signed: true }));
    const seen: Array<[string, string, number]> = [];
    t.attachProbeListener(() => { throw new Error('listener fault'); });
    const detach = t.attachProbeListener((p, a, r) => { seen.push([p, a, r]); });
    await t.pullAllPeers();
    expect(seen).toEqual([[PEER, 'signed', 1]]);
    detach();
    await t.pullAllPeers();
    expect(seen).toHaveLength(1);
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

describe('why a probe was silent (planned-restart-keeps-lead §2: a refused dial is not a dead peer)', () => {
  const lastProbe = (t: HttpLeaseTransport) => t.probeHistory().get(PEER)!.probes.at(-1)!;
  it('every route failing on this machine\'s side (EHOSTUNREACH: macOS Local Network permission, no route) is silence WITH a cause', async () => {
    const { t } = transport([LAN, TS], () => ({ throwCode: 'EHOSTUNREACH' }));
    await t.pullAllPeers();
    expect(lastProbe(t)).toMatchObject({ answer: 'silent', cause: 'local-refusal' });
  });
  it('EPERM, ENETUNREACH and a dual-stack AggregateError of them count the same; ECONNREFUSED (the far side answered) does not', async () => {
    for (const code of ['EPERM', 'ENETUNREACH', 'ENETDOWN']) {
      const { t } = transport([LAN], () => ({ throwCode: code }));
      await t.pullAllPeers();
      expect(lastProbe(t), code).toMatchObject({ answer: 'silent', cause: 'local-refusal' });
    }
    const { t: refused } = transport([LAN], () => 'throw'); // connection refused: a host that answered "no server here"
    await refused.pullAllPeers();
    expect(lastProbe(refused).answer).toBe('silent');
    expect(lastProbe(refused).cause).toBeUndefined();
  });
  it('the LAN rope refused here while the Tailscale rope answers: a signed answer, no cause (every route is dialed)', async () => {
    const { t } = transport([LAN, TS], (url) => (url.startsWith(LAN.url) ? { throwCode: 'EHOSTUNREACH' } : { status: 200, signed: true, marker: mark }));
    await t.pullAllPeers();
    expect(lastProbe(t)).toMatchObject({ answer: 'signed' });
    expect(lastProbe(t).cause).toBeUndefined();
  });
  it('a LAN rope refused here while the tunnel edge answers 530 (origin dark): plain silence, because a byte came back', async () => {
    const { t } = transport([LAN, QUICK], (url) => (url.startsWith(LAN.url) ? { throwCode: 'EHOSTUNREACH' } : { status: 530, marker: null }));
    await t.pullAllPeers();
    expect(lastProbe(t).answer).toBe('silent');
    expect(lastProbe(t).cause).toBeUndefined();
  });
  it('the legacy single-url dial records the cause too', async () => {
    const { t } = transport([LAN], () => ({ throwCode: 'EHOSTUNREACH' }), { mesh: false });
    await t.pullAllPeers();
    expect(lastProbe(t)).toMatchObject({ answer: 'silent', cause: 'local-refusal' });
  });
  it('a peer advertising nothing this machine may dial is silence with cause no-route', async () => {
    const { t } = transport([{ kind: 'lan', url: 'http://8.8.8.8:4042' }], () => ({ status: 200, signed: true, marker: mark })); // not RFC1918: dropped by the resolver
    await t.pullAllPeers();
    expect(lastProbe(t)).toMatchObject({ answer: 'silent', cause: 'no-route' });
  });
});
