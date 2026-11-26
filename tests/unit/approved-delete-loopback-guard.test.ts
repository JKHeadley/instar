/**
 * SEC-018 companion condition (a): the `/threadline/approved-delete` route refuses any
 * request that did not arrive on loopback — a non-loopback peer, an `Origin` header, or
 * Cloudflare/proxy forwarding headers (tunnel-arriving). evaluateLoopbackGuard is the
 * extracted loopback/Origin/forwarding portion of the local-MCP admission (no secret compare).
 */
import { describe, it, expect } from 'vitest';
import { evaluateLoopbackGuard } from '../../src/threadline/ThreadlineMcpHttpService.js';

const loopback = (headers: Record<string, unknown> = {}) =>
  ({ socket: { remoteAddress: '127.0.0.1' }, headers });

describe('evaluateLoopbackGuard (SEC-018 companion, condition a)', () => {
  it('admits a plain loopback request', () => {
    expect(evaluateLoopbackGuard(loopback())).toEqual({ ok: true });
    expect(evaluateLoopbackGuard({ socket: { remoteAddress: '::1' }, headers: {} })).toEqual({ ok: true });
  });

  it('refuses a NON-loopback peer (tunnel / LAN)', () => {
    const r = evaluateLoopbackGuard({ socket: { remoteAddress: '203.0.113.9' }, headers: {} });
    expect(r).toEqual({ ok: false, status: 403, error: 'threadline-mcp-loopback-only' });
    const none = evaluateLoopbackGuard({ socket: { remoteAddress: undefined }, headers: {} });
    expect(none.ok).toBe(false);
  });

  it('refuses when an Origin header is present (browser / cross-site)', () => {
    expect(evaluateLoopbackGuard(loopback({ origin: 'https://evil.example' }))).toEqual({
      ok: false, status: 403, error: 'threadline-mcp-origin-refused',
    });
  });

  it('refuses when cloudflared / proxy forwarding headers are present (tunnel)', () => {
    expect(evaluateLoopbackGuard(loopback({ 'cf-connecting-ip': '203.0.113.9' }))).toEqual({
      ok: false, status: 403, error: 'threadline-mcp-forwarded-refused',
    });
    expect(evaluateLoopbackGuard(loopback({ 'x-forwarded-for': '203.0.113.9' }))).toEqual({
      ok: false, status: 403, error: 'threadline-mcp-forwarded-refused',
    });
  });
});
