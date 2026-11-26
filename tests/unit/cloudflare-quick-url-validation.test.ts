/**
 * Unit tests for CloudflareQuickProvider.isAssignedQuickTunnelUrl.
 *
 * Why this exists: on 2026-10-21 the quick tunnel was rate-limited by
 * Cloudflare, and the cloudflared wrapper emitted the API BASE it had been
 * talking to — `https://api.trycloudflare.com` — on its 'url' event. The
 * provider accepted that as the tunnel URL, so TunnelManager reported
 * `running: true, state: active` while holding an address that answers 405 to
 * every request. Two operator links in a row were built on it, one of them a
 * Secret Drop form for a payment card. The operator would have tapped a dead
 * link to hand over a credential.
 *
 * The guard is therefore about honest state, not cosmetics: a tunnel that was
 * refused must not be able to present itself as healthy. Rejecting the URL
 * lets the existing lifecycle classify the failure and fall back.
 */
import { describe, it, expect } from 'vitest';
import { CloudflareQuickProvider } from '../../src/tunnel/CloudflareQuickProvider.js';

const ok = CloudflareQuickProvider.isAssignedQuickTunnelUrl;

describe('isAssignedQuickTunnelUrl', () => {
  it('accepts a real assigned quick-tunnel hostname', () => {
    expect(ok('https://brave-lion-rapid-meadow.trycloudflare.com')).toBe(true);
  });

  it('accepts one with a trailing slash', () => {
    expect(ok('https://brave-lion-rapid-meadow.trycloudflare.com/')).toBe(true);
  });

  // The regression itself.
  it('rejects the API base emitted under rate-limiting', () => {
    expect(ok('https://api.trycloudflare.com')).toBe(false);
  });

  it('rejects the apex with no assigned label', () => {
    expect(ok('https://trycloudflare.com')).toBe(false);
  });

  it('rejects a multi-label host, which is never an assigned quick tunnel', () => {
    expect(ok('https://a.b.trycloudflare.com')).toBe(false);
  });

  // Look-alikes: the whole point is that this cannot be fooled by a suffix.
  it('rejects a look-alike domain that merely ends in the same string', () => {
    expect(ok('https://evil-trycloudflare.com')).toBe(false);
    expect(ok('https://trycloudflare.com.attacker.test')).toBe(false);
  });

  it('rejects plaintext http', () => {
    expect(ok('http://brave-lion.trycloudflare.com')).toBe(false);
  });

  it('rejects junk that is not a URL at all', () => {
    expect(ok('')).toBe(false);
    expect(ok('not a url')).toBe(false);
    expect(ok('429 Too Many Requests')).toBe(false);
  });

  it('is case-insensitive about the host', () => {
    expect(ok('https://Brave-Lion.TryCloudflare.com')).toBe(true);
    expect(ok('https://API.trycloudflare.com')).toBe(false);
  });
});
