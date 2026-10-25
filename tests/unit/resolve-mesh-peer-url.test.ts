import { describe, expect, it, vi } from 'vitest';
import {
  resolveMeshPeerUrl,
  resolveMeshPeerSelection,
  resolveMeshPeerPreferredSelection,
} from '../../src/core/resolveMeshPeerUrl.js';

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

  it('does not bypass an available resolver that rejects every candidate', () => {
    const resolver = { resolve: vi.fn(() => []) } as never;
    expect(resolveMeshPeerUrl(resolver, 'm-peer', [], 'http://legacy-peer')).toBeNull();
  });
});

/**
 * peer-credential-guard-tailscale-coherence — admission-aware SELECTION.
 *
 * The reported defect: `resolveMeshPeerUrl` takes `resolve(...)[0]`, so a pool
 * fan-out got the resolver's highest-ranked rope, found the credential guard
 * refused it, and gave up — even though the peer's other ropes were already
 * admissible. These are the live Studio ropes from the incident.
 */
describe('resolveMeshPeerSelection (admission-aware)', () => {
  const STUDIO_ROPES = [
    { url: 'http://100.124.55.70:4042', kind: 'tailscale' }, // guard-refused (CGNAT plaintext)
    { url: 'http://192.168.87.47:4042', kind: 'lan' }, // admitted
    { url: 'https://echo-studio.dawn-tunnel.dev', kind: 'cloudflare' }, // admitted
  ];
  const resolverFor = (ropes: unknown[]) => ({ resolve: vi.fn(() => ropes) }) as never;

  it('REGRESSION: skips the refused top-ranked rope and selects the best ADMISSIBLE one', () => {
    const result = resolveMeshPeerSelection(resolverFor(STUDIO_ROPES), 'm-studio', [], undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // The LAN rope is next in the resolver's order and is admissible.
    expect(result.selection).toEqual({ url: 'http://192.168.87.47:4042', kind: 'lan' });
  });

  it('reports the refused rope on the SUCCESS branch (observability the defect lacked)', () => {
    const result = resolveMeshPeerSelection(resolverFor(STUDIO_ROPES), 'm-studio', [], undefined);
    expect(result.refusals).toEqual([
      { url: 'http://100.124.55.70:4042', kind: 'tailscale', reason: 'cgnat-plaintext-unsupported' },
    ]);
  });

  it('EXACTLY ONE destination: a single selection, never a list to fan out over', () => {
    const result = resolveMeshPeerSelection(resolverFor(STUDIO_ROPES), 'm-studio', [], undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // The shape itself is the guarantee — there is no array of admitted ropes.
    expect(Object.keys(result.selection).sort()).toEqual(['kind', 'url']);
  });

  it('all ropes refused -> url-rejected WITH per-rope reasons (not a silent omission)', () => {
    const result = resolveMeshPeerSelection(
      resolverFor([
        { url: 'http://100.64.0.1:4042', kind: 'tailscale' },
        { url: 'http://8.8.8.8:4042', kind: 'lan' },
      ]),
      'm-peer',
      [],
      undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.outcome).toBe('url-rejected');
    expect(result.refusals.map((r) => r.reason)).toEqual([
      'cgnat-plaintext-unsupported',
      'scheme-not-allowed',
    ]);
  });

  it('no candidates at all -> no-known-url, DISTINCT from url-rejected', () => {
    const result = resolveMeshPeerSelection(resolverFor([]), 'm-peer', [], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.outcome).toBe('no-known-url');
    expect(result.refusals).toEqual([]);
  });

  it('a resolved endpoint with no kind is represented as last-known-url, never absent', () => {
    const result = resolveMeshPeerSelection(
      resolverFor([{ url: 'https://legacy.dawn-tunnel.dev' }]),
      'm-peer',
      [],
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.selection.kind).toBe('last-known-url');
  });

  it('ONE POLICY both ends: the operator suffix governs selection as well as admission', () => {
    const ropes = [{ url: 'https://mesh.acme-corp.io', kind: 'cloudflare' }];
    // Without the suffix the rope is refused...
    const without = resolveMeshPeerSelection(resolverFor(ropes), 'm-peer', [], undefined);
    expect(without.ok).toBe(false);
    // ...and with it, selection admits the same rope.
    const withSuffix = resolveMeshPeerSelection(resolverFor(ropes), 'm-peer', [], undefined, ['acme-corp.io']);
    expect(withSuffix.ok).toBe(true);
  });

  it('no resolver: the legacy lastKnownUrl is still admission-checked', () => {
    const ok = resolveMeshPeerSelection(undefined, 'm-peer', undefined, 'https://echo.dawn-tunnel.dev');
    expect(ok.ok).toBe(true);
    const refused = resolveMeshPeerSelection(undefined, 'm-peer', undefined, 'http://8.8.8.8:4042');
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.outcome).toBe('url-rejected');
  });
});

describe('resolveMeshPeerPreferredSelection', () => {
  const resolverFor = (ropes: unknown[]) => ({ resolve: vi.fn(() => ropes) }) as never;

  it('prefers the admissible rope (the fix) AND carries the skipped rope', () => {
    const result = resolveMeshPeerPreferredSelection(
      resolverFor([
        { url: 'http://100.124.55.70:4042', kind: 'tailscale' },
        { url: 'https://echo-studio.dawn-tunnel.dev', kind: 'cloudflare' },
      ]),
      'm-studio',
      [],
      undefined,
    );
    expect(result?.selection).toEqual({ url: 'https://echo-studio.dawn-tunnel.dev', kind: 'cloudflare' });
    // Refusals must survive the wrapper — a caller that only got the selection
    // could not report WHICH rope was skipped (second-pass finding).
    expect(result?.refusals).toEqual([
      { url: 'http://100.124.55.70:4042', kind: 'tailscale', reason: 'cgnat-plaintext-unsupported' },
    ]);
  });

  it('when NOTHING is admissible it still returns a rope, so the caller refuses it VISIBLY', () => {
    // Returning null here would turn a named `url-rejected` row into a silent
    // omission — the regression this branch exists to prevent.
    const result = resolveMeshPeerPreferredSelection(
      resolverFor([{ url: 'http://100.64.0.1:4042', kind: 'tailscale' }]),
      'm-peer',
      [],
      undefined,
    );
    expect(result?.selection).toEqual({ url: 'http://100.64.0.1:4042', kind: 'tailscale' });
    expect(result?.refusals).toHaveLength(1);
  });

  it('null ONLY when the peer advertised nothing at all', () => {
    expect(resolveMeshPeerPreferredSelection(resolverFor([]), 'm-peer', [], undefined)).toBeNull();
  });
});
