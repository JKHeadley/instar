import { describe, it, expect } from 'vitest';
import { evaluateOutboundGrounding } from '../../../src/threadline/ThreadlineGroundingGate.js';

describe('ThreadlineGroundingGate — Ground Before You Assert (outbound URL provenance)', () => {
  it('allows a message with no URLs', () => {
    const r = evaluateOutboundGrounding('Confirmed on my side — channel is up.');
    expect(r.allow).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('allows a known/infra domain', () => {
    const r = evaluateOutboundGrounding('See https://github.com/JKHeadley/instar/pull/642');
    expect(r.allow).toBe(true);
  });

  it('allows a subdomain of a known domain', () => {
    const r = evaluateOutboundGrounding('raw at https://raw.githubusercontent.com/x/y/z.md');
    expect(r.allow).toBe(true);
  });

  it('FLAGS a scheme-qualified URL to an unfamiliar host', () => {
    const r = evaluateOutboundGrounding('The endpoint is https://the-portal.vercel.app/api/instar/read');
    expect(r.allow).toBe(false);
    expect(r.issues[0].kind).toBe('ungrounded-url');
    expect(r.issues[0].detail).toContain('the-portal.vercel.app');
  });

  it('EXEMPTS a URL the agent has verified this session', () => {
    const r = evaluateOutboundGrounding('Live: https://dawn.bot-me.ai/api/instar/read returns 401', {
      verifiedUrls: ['https://dawn.bot-me.ai/api/instar/read'],
    });
    expect(r.allow).toBe(true);
  });

  it('does NOT flag a BARE host (no scheme) — same info without asserting a live endpoint', () => {
    const r = evaluateOutboundGrounding('The live endpoint is dawn.bot-me.ai/api/instar/read (401 = real auth)');
    expect(r.allow).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('honors a caller-supplied knownDomains allowlist', () => {
    const r = evaluateOutboundGrounding('Endpoint https://dawn.bot-me.ai/x', { knownDomains: ['bot-me.ai'] });
    expect(r.allow).toBe(true);
  });

  it('flags only the unfamiliar URL among several', () => {
    const r = evaluateOutboundGrounding(
      'PR https://github.com/x/y/pull/1 and endpoint https://sketchy.example.io/v1',
    );
    expect(r.allow).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].detail).toContain('sketchy.example.io');
  });

  it('trims trailing punctuation before host extraction', () => {
    const r = evaluateOutboundGrounding('see https://sketchy.example.io/v1.', { verifiedUrls: ['https://sketchy.example.io/v1'] });
    expect(r.allow).toBe(true); // trailing "." trimmed → matches the verified URL
  });
});
