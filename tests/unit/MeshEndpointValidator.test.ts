/**
 * Unit — MeshEndpointValidator (mesh-endpoint-http-propagation, ingest validation).
 *
 * Defense-in-depth, NOT authority: validates an UNTRUSTED advertised endpoint set
 * BEFORE it is recorded into the registry, sharing the SAME per-kind host helpers
 * the resolver uses at dial time (so ingest + resolve can never diverge). Covers:
 * per-kind valid/invalid, oversized url, over-batch rejection, cap, normalization,
 * and order-independent equality (the idempotency comparator).
 */
import { describe, it, expect } from 'vitest';
import {
  validateMeshEndpoints,
  isValidMeshEndpointShape,
  normalizeEndpointUrl,
  meshEndpointsEqual,
  MAX_ENDPOINTS_BATCH,
  MAX_ENDPOINT_URL_LEN,
} from '../../src/core/MeshEndpointValidator.js';
import { MAX_ENDPOINTS } from '../../src/core/PeerEndpointResolver.js';
import type { MeshEndpoint } from '../../src/core/types.js';

const TS: MeshEndpoint = { kind: 'tailscale', url: 'http://100.64.0.9:4042' };
const LAN: MeshEndpoint = { kind: 'lan', url: 'http://192.168.87.60:4042' };
const CF: MeshEndpoint = { kind: 'cloudflare', url: 'https://peer.dawn-tunnel.dev' };

describe('isValidMeshEndpointShape — per-kind host rules', () => {
  it('accepts a well-formed tailscale (CGNAT 100.64/10), lan (RFC-1918), cloudflare (public https)', () => {
    expect(isValidMeshEndpointShape(TS)).toBe(true);
    expect(isValidMeshEndpointShape(LAN)).toBe(true);
    expect(isValidMeshEndpointShape(CF)).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(isValidMeshEndpointShape({ kind: 'wireguard', url: 'http://100.64.0.9:4042' })).toBe(false);
  });

  it('rejects a tailscale NOT in 100.64/10', () => {
    expect(isValidMeshEndpointShape({ kind: 'tailscale', url: 'http://10.0.0.1:4042' })).toBe(false);
  });

  it('rejects a lan NOT in RFC-1918', () => {
    expect(isValidMeshEndpointShape({ kind: 'lan', url: 'http://8.8.8.8:4042' })).toBe(false);
  });

  it('rejects a cloudflare that is not https', () => {
    expect(isValidMeshEndpointShape({ kind: 'cloudflare', url: 'http://peer.dawn-tunnel.dev' })).toBe(false);
  });

  it('rejects a loopback / link-local / cloud-metadata host', () => {
    expect(isValidMeshEndpointShape({ kind: 'lan', url: 'http://127.0.0.1:4042' })).toBe(false);
    expect(isValidMeshEndpointShape({ kind: 'lan', url: 'http://169.254.169.254:4042' })).toBe(false);
    expect(isValidMeshEndpointShape({ kind: 'cloudflare', url: 'https://169.254.169.254' })).toBe(false);
  });

  it('rejects a missing/oversized url and a non-object', () => {
    expect(isValidMeshEndpointShape({ kind: 'lan' })).toBe(false);
    expect(isValidMeshEndpointShape({ kind: 'cloudflare', url: 'https://x.dev/' + 'a'.repeat(MAX_ENDPOINT_URL_LEN) })).toBe(false);
    expect(isValidMeshEndpointShape(null)).toBe(false);
    expect(isValidMeshEndpointShape('string')).toBe(false);
  });
});

describe('validateMeshEndpoints — batch behavior', () => {
  it('returns a clean copy of a valid set', () => {
    const out = validateMeshEndpoints([TS, LAN, CF]);
    expect(out).toHaveLength(3);
    expect(out).toEqual([TS, LAN, CF]);
  });

  it('drops invalid ELEMENTS while keeping valid ones', () => {
    const out = validateMeshEndpoints([TS, { kind: 'lan', url: 'http://8.8.8.8:4042' }, CF]);
    expect(out).toEqual([TS, CF]);
  });

  it('a fully-invalid set returns [] (treated as absence ⇒ no-op, never a wipe)', () => {
    const out = validateMeshEndpoints([{ kind: 'lan', url: 'http://8.8.8.8' }, { kind: 'bad', url: 'x' }]);
    expect(out).toEqual([]);
  });

  it('a non-array returns []', () => {
    expect(validateMeshEndpoints(undefined)).toEqual([]);
    expect(validateMeshEndpoints(null)).toEqual([]);
    expect(validateMeshEndpoints('nope')).toEqual([]);
    expect(validateMeshEndpoints({})).toEqual([]);
  });

  it('rejects the WHOLE batch when length > MAX_ENDPOINTS_BATCH (malformed)', () => {
    const big = Array.from({ length: MAX_ENDPOINTS_BATCH + 1 }, () => TS);
    expect(validateMeshEndpoints(big)).toEqual([]);
  });

  it('caps the kept set to MAX_ENDPOINTS even with more valid (within-batch) elements', () => {
    // distinct valid elements within batch cap
    const within: MeshEndpoint[] = [
      { kind: 'tailscale', url: 'http://100.64.0.1:4042' },
      { kind: 'tailscale', url: 'http://100.64.0.2:4042' },
      { kind: 'lan', url: 'http://192.168.1.1:4042' },
      { kind: 'lan', url: 'http://192.168.1.2:4042' },
      { kind: 'cloudflare', url: 'https://a.dawn-tunnel.dev' },
    ];
    expect(within.length).toBeGreaterThan(MAX_ENDPOINTS);
    expect(within.length).toBeLessThanOrEqual(MAX_ENDPOINTS_BATCH);
    expect(validateMeshEndpoints(within).length).toBe(MAX_ENDPOINTS);
  });
});

describe('normalizeEndpointUrl + meshEndpointsEqual — idempotency comparator', () => {
  it('normalizes host case and trailing slash', () => {
    expect(normalizeEndpointUrl('https://PEER.dawn-tunnel.dev/')).toBe('https://peer.dawn-tunnel.dev');
    expect(normalizeEndpointUrl('http://192.168.87.60:4042')).toBe('http://192.168.87.60:4042');
  });

  it('equal sets compare equal regardless of order and cosmetic url differences', () => {
    const a = [CF, TS];
    const b = [{ kind: 'tailscale', url: 'http://100.64.0.9:4042' }, { kind: 'cloudflare', url: 'https://PEER.dawn-tunnel.dev/' }] as MeshEndpoint[];
    expect(meshEndpointsEqual(a, b)).toBe(true);
  });

  it('different sets compare unequal', () => {
    expect(meshEndpointsEqual([TS], [TS, CF])).toBe(false);
    expect(meshEndpointsEqual([TS], [LAN])).toBe(false);
    expect(meshEndpointsEqual(undefined, [TS])).toBe(false);
    expect(meshEndpointsEqual(undefined, undefined)).toBe(true);
  });
});
