/**
 * U4.3 R-r2-1 — the REQUIRED transport fix: hedge-abort neutrality
 * (docs/specs/u4-3-breaker-recovery-probe.md §2).
 *
 * Arm two of hedge starvation: when the hedge WINNER confirms, `finish()` aborts
 * the loser attempts — and the attempt catch used to UNCONDITIONALLY record
 * `recordResult(false)`, so a recovering rope dialed as a hedge loser had its
 * recoveryStreak reset perpetually by its healthy sibling's win (the week-long
 * presumed-dead Tailscale rope). Both sides:
 *   - an AbortError-after-winner records NEUTRALLY (no health mutation);
 *   - a REAL dial failure still records failure.
 */
import { describe, it, expect } from 'vitest';
import { HttpLeaseTransport, isAbortShapedError, type LeasePeer } from '../../src/core/HttpLeaseTransport.js';
import { PeerEndpointResolver, type PeerEndpointResolverConfig } from '../../src/core/PeerEndpointResolver.js';
import { signLeaseAck, type LeaseAck } from '../../src/server/machineAuth.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';
import type { LeaseRecord, MeshEndpoint } from '../../src/core/types.js';

const PEER_ID = 'm_peer';
const peerKeys = generateSigningKeyPair();

const TS: MeshEndpoint = { kind: 'tailscale', url: 'http://100.64.0.9:4042' };
const CF: MeshEndpoint = { kind: 'cloudflare', url: 'https://peer.dawn-tunnel.dev' };

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

/** A confirming signed-ack response for the ack-capable peer. */
function ackResponse(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const ack: LeaseAck = { machineId: PEER_ID, reqNonce: body.reqNonce as string, observedEpoch: 7 };
  const sig = signLeaseAck(ack, peerKeys.privateKey);
  return { ok: true, status: 200, json: async () => ({ ok: true, ack, sig }) } as unknown as Response;
}

function abortError(): Error {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

/**
 * Fetch double: cloudflare (the last-known-good winner) confirms after `winnerMs`;
 * tailscale behaves per `loserMode`: 'hang-until-abort' rejects with AbortError
 * when the hedge controller aborts it (the winner's finish()), 'refuse' rejects
 * immediately with a REAL network error.
 */
function mkFetch(loserMode: 'hang-until-abort' | 'refuse', winnerMs = 40) {
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes('peer.dawn-tunnel.dev')) {
      await new Promise((r) => setTimeout(r, winnerMs));
      return ackResponse(init);
    }
    // tailscale — the hedge loser
    if (loserMode === 'refuse') throw Object.assign(new Error('connect ECONNREFUSED 100.64.0.9:4042'), { code: 'ECONNREFUSED' });
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (!signal) return; // never settles (test would time out — signals must be wired)
      if (signal.aborted) return reject(abortError());
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function mkHarness(loserMode: 'hang-until-abort' | 'refuse') {
  const resolver = new PeerEndpointResolver({ config: resolverCfg() });
  // Cloudflare is last-known-good (sorts FIRST — endpoints[0], the hedge winner);
  // tailscale is the RECOVERING rope: it went dead, then one probe success cleared
  // the dead flag (recoveryStreak 1) — the exact rope the old catch poisoned.
  for (let i = 0; i < 3; i++) resolver.recordResult(PEER_ID, 'cloudflare', true, 20);
  for (let i = 0; i < 3; i++) resolver.recordResult(PEER_ID, 'tailscale', false, 20);
  resolver.recordResult(PEER_ID, 'tailscale', true, 20); // recovery underway: streak 1
  const { fn, calls } = mkFetch(loserMode);
  const peer: LeasePeer = { machineId: PEER_ID, url: CF.url, endpoints: [TS, CF], publicKeyPem: peerKeys.publicKey, meshAckCapable: true };
  const transport = new HttpLeaseTransport({
    selfMachineId: 'm_self',
    signingKeyPem: generateSigningKeyPair().privateKey,
    peers: () => [peer],
    nextSequence: () => 1,
    fetchImpl: fn,
    resolver,
    meshTransportEnabled: () => true,
    hedgeDelayMs: 10,
    requestTimeoutMs: 30_000,
  });
  return { resolver, transport, calls };
}

describe('HttpLeaseTransport — hedge-abort neutrality (R-r2-1)', () => {
  it('an AbortError caused by the winner does NOT record failure — the recovering streak survives', async () => {
    const h = mkHarness('hang-until-abort');
    const before = h.resolver.healthOf(PEER_ID, 'tailscale')!;
    expect(before.recoveryStreak).toBe(1);
    expect(before.consecutiveFailures).toBe(0);

    expect(await h.transport.broadcast(mkLease(7))).toBe(true);
    // Both ropes were dialed (the recovering loser was genuinely fired)…
    expect(h.calls.some((u) => u.includes('100.64.0.9'))).toBe(true);
    expect(h.calls.some((u) => u.includes('peer.dawn-tunnel.dev'))).toBe(true);

    // …but the winner-abort recorded NEUTRALLY: streak preserved, no failure.
    const after = h.resolver.healthOf(PEER_ID, 'tailscale')!;
    expect(after.recoveryStreak).toBe(1);
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastFailAt).toBe(before.lastFailAt);
  });

  it('a REAL dial failure still records failure (the other side of the boundary)', async () => {
    const h = mkHarness('refuse');
    const before = h.resolver.healthOf(PEER_ID, 'tailscale')!;
    expect(before.recoveryStreak).toBe(1);

    expect(await h.transport.broadcast(mkLease(7))).toBe(true);
    const after = h.resolver.healthOf(PEER_ID, 'tailscale')!;
    // ECONNREFUSED is a genuine dial failure: streak reset, failure recorded.
    expect(after.recoveryStreak).toBe(0);
    expect(after.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(after.lastFailAt).toBeGreaterThan(0);
  });
});

describe('isAbortShapedError', () => {
  it('recognizes AbortError / ABORT_ERR shapes; rejects real failures + timeouts', () => {
    expect(isAbortShapedError(abortError())).toBe(true);
    expect(isAbortShapedError(Object.assign(new Error('x'), { code: 'ABORT_ERR' }))).toBe(true);
    expect(isAbortShapedError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(false);
    // AbortSignal.timeout rejects with a TimeoutError — a REAL per-attempt failure.
    expect(isAbortShapedError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(false);
    expect(isAbortShapedError(null)).toBe(false);
    expect(isAbortShapedError('AbortError')).toBe(false);
  });
});
