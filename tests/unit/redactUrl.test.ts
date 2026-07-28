import { describe, it, expect } from 'vitest';
import { redactUrl, redactUrlsInText } from '../../src/core/redactUrl.js';

describe('redactUrl', () => {
  describe('userinfo redaction', () => {
    it('redacts x-access-token GitHub clone URLs (the 2026-05-27 leak vector)', () => {
      const leaked = 'https://x-access-token:gho_EXAMPLEEXAMPLEEXAMPLEEXAMPLE00000000@github.com/JKHeadley/instar-mmtest2.git';
      const out = redactUrl(leaked);
      expect(out).not.toContain('gho_EXAMPLEEXAMPLEEXAMPLEEXAMPLE00000000');
      expect(out).not.toContain('x-access-token');
      expect(out).toContain('***');
      // Host + path preserved so logs stay useful.
      expect(out).toContain('github.com/JKHeadley/instar-mmtest2.git');
    });

    it('redacts basic-auth user:password@', () => {
      const out = redactUrl('https://alice:s3cret@example.com/path?q=1');
      expect(out).not.toContain('s3cret');
      expect(out).not.toContain('alice');
      expect(out).toContain('***:***@example.com/path?q=1');
    });

    it('redacts user-only userinfo', () => {
      const out = redactUrl('https://justtoken@example.com/');
      expect(out).not.toContain('justtoken');
      expect(out).toContain('***@example.com');
    });

    it('leaves credential-free URLs structurally intact (no userinfo)', () => {
      const clean = 'https://echo.dawn-tunnel.dev/view/abc?sig=deadbeef';
      // No userinfo → unchanged except token-pattern scrub (sig is not a known token shape)
      expect(redactUrl(clean)).toBe(clean);
    });

    it('is idempotent on already-redacted strings', () => {
      const once = redactUrl('https://x-access-token:gho_AAAAAAAAAAAAAAAAAAAAAA@github.com/x.git');
      const twice = redactUrl(once);
      expect(twice).toBe(once);
    });

    it('accepts a URL object', () => {
      const out = redactUrl(new URL('https://u:p@host.tld/'));
      expect(out).not.toContain('u:p@');
      expect(out).toContain('***');
    });
  });

  describe('standalone token scrubbing (tokens outside userinfo)', () => {
    it('scrubs a GitHub token sitting in a query string', () => {
      const out = redactUrl('https://api.example.com/pair?token=gho_ABCDEFGHIJKLMNOPQRSTUV');
      expect(out).not.toContain('gho_ABCDEFGHIJKLMNOPQRSTUV');
      expect(out).toContain('***');
    });

    it('scrubs a Telegram bot token shape', () => {
      const out = redactUrl('https://api.telegram.org/bot123456789:AAH8sQ3l2kZ_xQ9pZ0mNvW1rT5uY7iO3pLk/sendMessage');
      expect(out).not.toContain('123456789:AAH8sQ3l2kZ_xQ9pZ0mNvW1rT5uY7iO3pLk');
    });
  });

  describe('redactUrlsInText (error messages / sentences with embedded URLs)', () => {
    it('redacts the exact Node fetch error that leaked the token', () => {
      const errMsg = 'Request cannot be constructed from a URL that includes credentials: https://x-access-token:gho_EXAMPLEEXAMPLEEXAMPLEEXAMPLE00000000@github.com/JKHeadley/instar-mmtest2.git/api/pair';
      const out = redactUrlsInText(errMsg);
      expect(out).not.toContain('gho_EXAMPLEEXAMPLEEXAMPLEEXAMPLE00000000');
      expect(out).not.toMatch(/gho_[A-Za-z0-9_]{20,}/);
      // The surrounding prose is preserved.
      expect(out).toContain('Request cannot be constructed from a URL that includes credentials');
    });

    it('redacts multiple credentialed URLs in one string', () => {
      const text = 'tried https://a:b@h1.com/ then https://c:d@h2.com/';
      const out = redactUrlsInText(text);
      expect(out).not.toContain('a:b@');
      expect(out).not.toContain('c:d@');
      expect((out.match(/\*\*\*@/g) || []).length).toBe(2);
    });

    it('is a no-op on text with no URLs or tokens', () => {
      const text = 'Failed to contact server: connection refused';
      expect(redactUrlsInText(text)).toBe(text);
    });

    it('never throws on malformed input', () => {
      expect(() => redactUrlsInText('://::@@@ not a url gho_AAAAAAAAAAAAAAAAAAAAAA')).not.toThrow();
      const out = redactUrlsInText('://::@@@ not a url gho_AAAAAAAAAAAAAAAAAAAAAA');
      expect(out).not.toContain('gho_AAAAAAAAAAAAAAAAAAAAAA');
    });

    it('handles empty string', () => {
      expect(redactUrlsInText('')).toBe('');
    });
  });
});
