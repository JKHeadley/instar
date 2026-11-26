/**
 * SEC-124: the pre-auth capability pages (MCP approval, memory-privacy repair link,
 * Secret Drop) must not be framable, cacheable, or leak their URL via Referer.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { dashboardSecurityHeaders, PRE_AUTH_PAGE_PREFIXES } from '../../src/server/middleware.js';

function app() {
  const a = express();
  a.use(dashboardSecurityHeaders);
  a.get('/mcp/approve/:id', (_req, res) => { res.type('html').send('<script>1</script><p>approve</p>'); });
  a.post('/mcp/approve/:id', (_req, res) => { res.status(404).type('html').send('<p>gone</p>'); });
  a.get('/memory-privacy/fix/:token', (_req, res) => { res.type('html').send('<p>fix</p>'); });
  a.get('/secrets/drop/:token', (_req, res) => { res.setHeader('X-Frame-Options', 'DENY'); res.type('html').send('<form></form>'); });
  a.get('/mcp/approve', (_req, res) => { res.json({ ok: true }); });
  a.get('/health', (_req, res) => { res.json({ ok: true }); });
  return a;
}

function expectHardened(h: Record<string, string>) {
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['cache-control']).toContain('no-store');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-content-type-options']).toBe('nosniff');
}

describe('SEC-124 pre-auth page headers', () => {
  it('lists the three pre-auth page families', () => {
    expect([...PRE_AUTH_PAGE_PREFIXES].sort()).toEqual(['/mcp/approve/', '/memory-privacy/fix/', '/secrets/drop/']);
  });

  it('hardens the MCP approval page, including its error answers', async () => {
    expectHardened((await request(app()).get('/mcp/approve/req123')).headers);
    expectHardened((await request(app()).post('/mcp/approve/req123')).headers);
    expectHardened((await request(app()).get('/MCP/Approve/req123')).headers);
  });

  it('hardens the memory-privacy repair page and Secret Drop', async () => {
    expectHardened((await request(app()).get('/memory-privacy/fix/abc')).headers);
    expectHardened((await request(app()).get('/secrets/drop/tok')).headers);
  });

  it('restricts only framing, base and form targets, so the pages keep their inline script', async () => {
    const csp = (await request(app()).get('/mcp/approve/req123')).headers['content-security-policy'];
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('default-src');
  });

  it('leaves other routes alone (the agent-only /mcp/approve exact path, /health)', async () => {
    for (const p of ['/mcp/approve', '/health']) {
      const h = (await request(app()).get(p)).headers;
      expect(h['referrer-policy']).toBeUndefined();
      expect(h['content-security-policy']).toBeUndefined();
    }
  });
});
