/**
 * The feedback arm of the pool-read selection fix.
 *
 * The selection fix alone chooses the highest-priority ADMISSIBLE rope. On
 * 2026-10-22, measured against the live registry from the WSL machine, that was
 * the Mac Studio's LAN address — which answers `HTTP 000` from there, while the
 * same peer answers `HTTP 200` on its tunnel. Nothing reported that failure, so
 * every later read chose the dead rope again: the original defect in a new
 * costume. These tests pin the loop that closes it.
 *
 * The convergence test is the one that matters. It uses the REAL incident
 * addresses, because a synthetic pair of hostnames would have passed against
 * the broken code too.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { resolveMeshPeerPreferredSelection } from '../../src/core/resolveMeshPeerUrl.js';
import { poolPeerFetch } from '../../src/server/poolPeerFetch.js';

/** The Mac Studio's real advertised ropes on 2026-10-22. */
const STUDIO = 'm_03b30f5b32c6ef3eb0afd3ca7054e252';
const STUDIO_ROPES = [
  { kind: 'tailscale' as const, url: 'http://100.124.55.70:4042' },
  { kind: 'lan' as const, url: 'http://192.168.87.47:4042' },
  { kind: 'cloudflare' as const, url: 'https://echo-studio.dawn-tunnel.dev' },
];

/**
 * Production's own resolver config (src/commands/server.ts mesh block), not a
 * bare `{}`. With an empty config `unhealthyAfterFailures` is undefined, so
 * `consecutiveFailures >= undefined` is always false and NOTHING is ever marked
 * dead — a convergence test built on that would pass while proving nothing.
 */
function resolver(ownCidrs: string[] = []) {
  return new PeerEndpointResolver({
    ownCidrs: () => ownCidrs,
    config: {
      enabled: true,
      hedgeDelayMs: 1500,
      priorityTailscale: 10,
      priorityLan: 20,
      priorityCloudflare: 30,
      tailscaleEnabled: true,
      lanSubnetGate: true,
      unhealthyAfterFailures: 3,
      endpointEvictionMs: 3_600_000,
      maxProbeBackoffMs: 300_000,
      requestTimeoutMs: 30_000,
    },
  });
}

describe('pool rope-health feedback — a dead-but-admissible rope demotes itself', () => {
  /**
   * The reader must be ON the peer's LAN subnet for the LAN rope to be a
   * candidate at all: the resolver's subnet gate drops a peer LAN address that
   * is not on a subnet we share. That gate is also why the live symptom was
   * already fixed by selection alone from the WSL box (different subnet ⇒ LAN
   * never considered ⇒ the tunnel is chosen). Feedback is what the SAME-subnet
   * case needs, which is the case two machines on one desk are in.
   */
  const SAME_SUBNET = ['192.168.87.30/24'];

  it('selection alone picks the same-subnet LAN rope — correct, and the reason feedback is needed', () => {
    const r = resolver(SAME_SUBNET);
    for (let i = 0; i < 3; i++) {
      const sel = resolveMeshPeerPreferredSelection(r, STUDIO, STUDIO_ROPES, undefined);
      expect(sel?.selection.kind).toBe('lan');
    }
  });

  it('from a DIFFERENT subnet the LAN rope is never a candidate, so the tunnel is chosen outright', () => {
    // The live topology on 2026-10-22: reader on 172.22.x, peer LAN on 192.168.87.x.
    const sel = resolveMeshPeerPreferredSelection(resolver(['172.22.96.135/20']), STUDIO, STUDIO_ROPES, undefined);
    expect(sel?.selection.kind).toBe('cloudflare');
    expect(sel?.refusals.map((x) => `${x.kind}=${x.reason}`)).toContain('tailscale=cgnat-plaintext-unsupported');
  });

  it('CONVERGENCE: a same-subnet LAN rope that keeps failing stops being selected', () => {
    const r = resolver(SAME_SUBNET);
    expect(resolveMeshPeerPreferredSelection(r, STUDIO, STUDIO_ROPES, undefined)?.selection.kind).toBe('lan');

    // What a real dial to a dead host does: it fails. Past the unhealthy
    // threshold the rope is dead AND inside its probe backoff, so it sorts last.
    for (let i = 0; i < 4; i++) {
      r.recordResult(STUDIO, 'lan', false, 12_000, 'http://192.168.87.47:4042');
    }

    const next = resolveMeshPeerPreferredSelection(r, STUDIO, STUDIO_ROPES, undefined);
    // Tailscale stays refused by the credential guard, so the remaining
    // admissible rope is the one that actually answers.
    expect(next?.selection.kind).toBe('cloudflare');
    expect(next?.selection.url).toBe('https://echo-studio.dawn-tunnel.dev');
  });

  it('a recovered rope is selectable again — the demotion is not a one-way door', () => {
    const r = resolver(SAME_SUBNET);
    for (let i = 0; i < 4; i++) r.recordResult(STUDIO, 'lan', false, 12_000, 'http://192.168.87.47:4042');
    expect(resolveMeshPeerPreferredSelection(r, STUDIO, STUDIO_ROPES, undefined)?.selection.kind).toBe('cloudflare');
    for (let i = 0; i < 10; i++) r.recordResult(STUDIO, 'lan', true, 8, 'http://192.168.87.47:4042');
    expect(resolveMeshPeerPreferredSelection(r, STUDIO, STUDIO_ROPES, undefined)?.selection.kind).toBe('lan');
  });
});

describe('poolPeerFetch — what it reports, and what it refuses to invent', () => {
  const peer = { machineId: STUDIO, url: 'https://echo-studio.dawn-tunnel.dev', kind: 'cloudflare' as const };

  it('reports a rope success for any Response that came back, 500 included', async () => {
    const record = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    try {
      const res = await poolPeerFetch(record, peer, '/attention');
      expect(res.status).toBe(500);
    } finally {
      fetchSpy.mockRestore();
    }
    // The rope carried the traffic; the application disagreed. Demoting here
    // would demote a healthy rope every time a peer 503s a dark feature.
    expect(record).toHaveBeenCalledWith(STUDIO, 'cloudflare', true, expect.any(Number), peer.url);
  });

  it('reports a rope failure when the dial throws, and rethrows the original error', async () => {
    const record = vi.fn();
    const boom = new Error('connect ECONNREFUSED');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(boom);
    try {
      await expect(poolPeerFetch(record, peer, '/attention')).rejects.toThrow('connect ECONNREFUSED');
    } finally {
      fetchSpy.mockRestore();
    }
    expect(record).toHaveBeenCalledWith(STUDIO, 'cloudflare', false, expect.any(Number), peer.url);
  });

  it('records NOTHING for a last-known-url — it carries no rope identity to attribute', async () => {
    const record = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      await poolPeerFetch(record, { machineId: STUDIO, url: 'https://x.example', kind: 'last-known-url' }, '/x');
      await poolPeerFetch(record, { machineId: STUDIO, url: 'https://x.example', kind: null }, '/x');
      await poolPeerFetch(record, { machineId: STUDIO, url: 'https://x.example' }, '/x');
    } finally {
      fetchSpy.mockRestore();
    }
    expect(record).not.toHaveBeenCalled();
  });

  it('builds the URL as peer.url + path, and tolerates an absent recorder', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      await poolPeerFetch(undefined, peer, '/jobs?scope=pool');
      expect(fetchSpy).toHaveBeenCalledWith('https://echo-studio.dawn-tunnel.dev/jobs?scope=pool', undefined);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/**
 * Wiring integrity. The feedback arm is worth nothing if the recorder is null in
 * production or if a future fan-out site dials with a bare `fetch` and quietly
 * teaches rope health nothing. The first is a dependency-injection check; the
 * second is the structural guard, because "remember to use the helper" is a wish
 * and a failing test is a guarantee.
 */
describe('pool rope-health feedback — wired, and structurally hard to forget', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8');

  it('server.ts feeds the recorder from the SAME shared resolver the lease transport uses', () => {
    const src = read('src/commands/server.ts');
    // Assigned in the mesh block from meshResolver — not a fresh resolver, which
    // would be a second source of truth that neither side could converge on.
    expect(src).toContain('_recordRopeResult = (machineId, kind, ok, latencyMs, url) =>');
    expect(src).toContain('meshResolver.recordResult(machineId, kind, ok, latencyMs, url)');
    // And handed to the server, or the routes see nothing.
    expect(src).toContain('recordRopeResult: _recordRopeResult ?? undefined');
  });

  it('AgentServer forwards it into the RouteContext', () => {
    const src = read('src/server/AgentServer.ts');
    expect(src).toContain('recordRopeResult?: import(\'./poolPeerFetch.js\').RopeResultRecorder');
    expect(src).toContain('recordRopeResult: options.recordRopeResult ?? null');
  });

  it('NO pool fan-out site dials a peer with a bare fetch', () => {
    const src = read('src/server/routes.ts');
    // Matches `fetch(`${p.url}...` / `fetch(`${peer.url}...` — the two shapes every
    // pool fan-out uses. A new site written this way fails here instead of
    // silently costing rope health its feedback.
    const bare = [...src.matchAll(/(?<!pool)fetch\(`\$\{(?:p|peer)\.url\}/g)];
    expect(bare.map((m) => src.slice(Math.max(0, m.index - 70), m.index + 40))).toEqual([]);
  });

  it('every converted site passes the peer object, so the rope kind travels with the dial', () => {
    const src = read('src/server/routes.ts');
    const calls = [...src.matchAll(/poolPeerFetch\(ctx\.recordRopeResult \?\? undefined, (p|peer), `/g)];
    // 15 sites at the time of writing; the floor guards against a silent revert
    // of the conversion, while new sites only push it up.
    expect(calls.length).toBeGreaterThanOrEqual(15);
  });
});
