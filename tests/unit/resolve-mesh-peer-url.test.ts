import { describe, expect, it, vi } from 'vitest';
import { resolveMeshPeerUrl } from '../../src/core/resolveMeshPeerUrl.js';

describe('resolveMeshPeerUrl', () => {
  it('falls back to the legacy registry URL when mesh bootstrap did not produce a resolver', () => {
    expect(resolveMeshPeerUrl(undefined, 'm-peer', undefined, 'http://peer:4042')).toBe('http://peer:4042');
  });

  it('returns null when neither mesh nor legacy routing is available', () => {
    expect(resolveMeshPeerUrl(undefined, 'm-peer', undefined, undefined)).toBeNull();
  });

  it('prefers the shared resolver when it is available', () => {
    const resolve = vi.fn(() => [{ url: 'https://mesh-peer', kind: 'tailscale' }]);
    const resolver = { resolve } as never;
    expect(resolveMeshPeerUrl(resolver, 'm-peer', [], 'http://legacy-peer')).toBe('https://mesh-peer');
    expect(resolve).toHaveBeenCalledWith('m-peer', [], 'http://legacy-peer');
  });
});
