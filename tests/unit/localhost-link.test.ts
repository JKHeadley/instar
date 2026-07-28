/**
 * Unit tests for the localhost-link detector — the deterministic guard
 * behind the operator-mandated rule (2026-06-05): never send a
 * machine-local clickable link to a user.
 */

import { describe, it, expect } from 'vitest';
import { detectLocalhostLink } from '../../src/core/localhost-link.js';

describe('detectLocalhostLink', () => {
  describe('detects machine-local links', () => {
    it.each([
      ['http://localhost:4042/dashboard', 'http://localhost:4042/dashboard'],
      ['https://localhost/view/abc', 'https://localhost/view/abc'],
      ['http://127.0.0.1:4040/dashboard', 'http://127.0.0.1:4040/dashboard'],
      ['http://127.1.2.3/x', 'http://127.1.2.3/x'],
      ['http://0.0.0.0:8080/', 'http://0.0.0.0:8080/'],
      ['http://[::1]:3000/app', 'http://[::1]:3000/app'],
      ['HTTP://LOCALHOST:4042/Dashboard', 'HTTP://LOCALHOST:4042/Dashboard'],
    ])('flags %s', (input, expectedMatch) => {
      const r = detectLocalhostLink(`Open this: ${input} and click around`);
      expect(r.detected).toBe(true);
      expect(r.match).toBe(expectedMatch);
    });

    it('flags a bare localhost link with no port or path', () => {
      const r = detectLocalhostLink('go to http://localhost now');
      expect(r.detected).toBe(true);
      expect(r.match).toBe('http://localhost');
    });

    it('flags the real incident message shape (markdown-adjacent)', () => {
      const r = detectLocalhostLink(
        'Dashboard (on your machine): http://localhost:4040/dashboard — PIN: 123456',
      );
      expect(r.detected).toBe(true);
      expect(r.match).toBe('http://localhost:4040/dashboard');
    });

    it('does not swallow trailing markdown/punctuation into the match', () => {
      const r = detectLocalhostLink('see (http://localhost:4042/dashboard) for details');
      expect(r.detected).toBe(true);
      expect(r.match).toBe('http://localhost:4042/dashboard');
    });
  });

  describe('allows everything else', () => {
    it.each([
      'Dashboard from your phone: https://echo.dawn-tunnel.dev/dashboard',
      'The tunnel is at https://abc123.trycloudflare.com/dashboard',
      'my server listens on port 4042',
      'the localhost config is unchanged', // prose mention, not a link
      'curl http://example.com/localhost-docs', // localhost in a path, not the host
      'bind address 127.0.0.1 stays internal', // bare IP, not a clickable link
      'ssh://localhost is a different scheme we do not police',
      '',
      'plain message with no links at all',
    ])('passes %s', (input) => {
      expect(detectLocalhostLink(input).detected).toBe(false);
    });

    it('does not flag loopback-prefixed PUBLIC hosts', () => {
      // 127.x must be a complete IPv4, not a prefix of a hostname.
      expect(detectLocalhostLink('https://localhost.example.com/page').detected).toBe(false);
    });
  });
});
