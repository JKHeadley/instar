/**
 * U4.3 — PeerEndpointResolver.snapshot(): the read seam over the ONE health
 * authority (docs/specs/u4-3-breaker-recovery-probe.md §3). The prober, the
 * authed /health ropeHealth field, and U4.5's RopeHealthMonitor all consume it.
 */
import { describe, it, expect } from 'vitest';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';

function mkResolver(now: () => number) {
  return new PeerEndpointResolver({
    config: {
      enabled: true,
      hedgeDelayMs: 1500,
      priorityTailscale: 10,
      priorityLan: 20,
      priorityCloudflare: 30,
      tailscaleEnabled: true,
      lanSubnetGate: false,
      unhealthyAfterFailures: 3,
      endpointEvictionMs: 3_600_000,
      maxProbeBackoffMs: 300_000,
      requestTimeoutMs: 30_000,
    },
    now,
  });
}

describe('PeerEndpointResolver.snapshot()', () => {
  it('returns one row per (peer, kind) with the live counters + derived dead flag', () => {
    let t = 1_000_000;
    const r = mkResolver(() => t);
    for (let i = 0; i < 3; i++) r.recordResult('peer-a', 'tailscale', false, 50);
    r.recordResult('peer-a', 'cloudflare', true, 30);
    t += 1000;
    r.recordResult('peer-b', 'lan', true, 5);

    const rows = r.snapshot();
    expect(rows).toHaveLength(3);
    const dead = rows.find((x) => x.peer === 'peer-a' && x.kind === 'tailscale')!;
    expect(dead.dead).toBe(true);
    expect(dead.consecutiveFailures).toBe(3);
    expect(dead.recoveryStreak).toBe(0);
    expect(dead.lastFailAt).toBe(1_000_000);
    const cf = rows.find((x) => x.peer === 'peer-a' && x.kind === 'cloudflare')!;
    expect(cf.dead).toBe(false);
    expect(cf.lastOkAt).toBe(1_000_000);
    const lanRow = rows.find((x) => x.peer === 'peer-b' && x.kind === 'lan')!;
    expect(lanRow.lastOkAt).toBe(1_001_000);
  });

  it('rows are COPIES — mutating a row cannot poison the health authority', () => {
    const r = mkResolver(() => 5);
    r.recordResult('peer-a', 'tailscale', false, 50);
    const row = r.snapshot()[0];
    row.consecutiveFailures = 999;
    expect(r.healthOf('peer-a', 'tailscale')!.consecutiveFailures).toBe(1);
    expect(r.snapshot()[0].consecutiveFailures).toBe(1);
  });

  it('carries NO endpoint URLs (content scrub — kind + counters only)', () => {
    const r = mkResolver(() => 5);
    r.resolve('peer-a', [{ kind: 'tailscale', url: 'http://100.64.0.9:4042' }], 'https://tunnel.example.dev');
    const json = JSON.stringify(r.snapshot());
    expect(json).not.toContain('100.64.0.9');
    expect(json).not.toContain('tunnel.example.dev');
    expect(json).not.toContain('url');
  });

  it('a peer with NO record simply has no row (absent ≠ down — U4.5 fails toward not-urgent)', () => {
    const r = mkResolver(() => 5);
    expect(r.snapshot()).toHaveLength(0);
  });
});
