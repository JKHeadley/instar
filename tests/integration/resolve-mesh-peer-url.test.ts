import { describe, expect, it } from 'vitest';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { resolveMeshPeerUrl } from '../../src/core/resolveMeshPeerUrl.js';

describe('mesh peer URL integration', () => {
  it('uses a live resolver when mesh initialized and preserves legacy reachability when it did not', () => {
    const resolver = new PeerEndpointResolver({
      config: {
        enabled: true,
        hedgeDelayMs: 10,
        priorityTailscale: 10,
        priorityLan: 20,
        priorityCloudflare: 30,
        tailscaleEnabled: true,
        lanSubnetGate: false,
        unhealthyAfterFailures: 3,
        endpointEvictionMs: 60_000,
        maxProbeBackoffMs: 60_000,
        requestTimeoutMs: 5_000,
      },
      ownCidrs: () => [],
    });
    const endpoints = [{ kind: 'tailscale' as const, url: 'http://100.64.1.2:4042', priority: 10, observedAt: new Date().toISOString() }];

    expect(resolveMeshPeerUrl(resolver, 'm-peer', endpoints, 'http://legacy-peer')).toBe('http://100.64.1.2:4042');
    expect(resolveMeshPeerUrl(undefined, 'm-peer', endpoints, 'http://legacy-peer')).toBe('http://legacy-peer');
  });
});
