import { describe, it, expect } from 'vitest';
import { Redactor, type RedactionRule } from '../../src/monitoring/Redactor.js';

describe('Redactor — default rules', () => {
  it('redacts macOS home-directory paths', () => {
    const r = new Redactor();
    const result = r.redact('error reading /Users/justin/.instar/config.json');
    expect(result.text).toContain('<HOME>');
    expect(result.text).not.toContain('/Users/justin');
    expect(result.redactions).toEqual(expect.arrayContaining([{ category: 'path', count: 1 }]));
  });

  it('redacts Linux home-directory paths', () => {
    const r = new Redactor();
    const result = r.redact('error reading /home/alice/.instar/config.json');
    expect(result.text).toContain('<HOME>');
    expect(result.text).not.toContain('/home/alice');
  });

  it('redacts bearer tokens', () => {
    const r = new Redactor();
    const result = r.redact('Authorization: Bearer sk_live_abcdef1234567890abcdef');
    expect(result.text).toContain('Bearer <REDACTED>');
    expect(result.text).not.toContain('sk_live_abcdef1234567890abcdef');
    expect(result.redactions).toEqual(expect.arrayContaining([{ category: 'secret', count: 1 }]));
  });

  it('redacts Telegram bot tokens', () => {
    const r = new Redactor();
    const result = r.redact('bot token 1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_');
    expect(result.text).toContain('<TELEGRAM_TOKEN>');
    expect(result.text).not.toContain('1234567890:ABCDEFG');
  });

  it('redacts email addresses', () => {
    const r = new Redactor();
    const result = r.redact('contact alice@example.com for details');
    expect(result.text).toContain('<EMAIL>');
    expect(result.text).not.toContain('alice@example.com');
    expect(result.redactions).toEqual(expect.arrayContaining([{ category: 'pii', count: 1 }]));
  });

  it('redacts UUIDs', () => {
    const r = new Redactor();
    const result = r.redact('session 550e8400-e29b-41d4-a716-446655440000 failed');
    expect(result.text).toContain('<UUID>');
    expect(result.text).not.toContain('550e8400');
  });

  it('redacts long hex strings', () => {
    const r = new Redactor();
    // 40-char SHA-1
    const result = r.redact('commit da39a3ee5e6b4b0d3255bfef95601890afd80709 landed');
    expect(result.text).toContain('<HEX>');
    expect(result.text).not.toContain('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('redacts IPv4 addresses', () => {
    const r = new Redactor();
    const result = r.redact('connection to 192.168.1.42 refused');
    expect(result.text).toContain('<IP>');
    expect(result.text).not.toContain('192.168.1.42');
  });

  it('redacts IPv6 addresses', () => {
    const r = new Redactor();
    const result = r.redact('peer 2001:db8:85a3:0:0:8a2e:370:7334 closed');
    expect(result.text).toContain('<IP>');
    expect(result.text).not.toContain('2001:db8:85a3');
  });

  it('redacts long numeric IDs (≥ 6 digits)', () => {
    const r = new Redactor();
    const result = r.redact('user 1234567 not found');
    expect(result.text).toContain('<NUM>');
    expect(result.text).not.toContain('1234567');
  });

  it('does not redact short numbers (< 6 digits)', () => {
    const r = new Redactor();
    const result = r.redact('returned 42 records, retry in 30 seconds');
    expect(result.text).toBe('returned 42 records, retry in 30 seconds');
  });
});

describe('Redactor — composition', () => {
  it('applies multiple rules in a single pass', () => {
    const r = new Redactor();
    const result = r.redact(
      'user alice@example.com on session 550e8400-e29b-41d4-a716-446655440000 from 10.0.0.1',
    );
    expect(result.text).toContain('<EMAIL>');
    expect(result.text).toContain('<UUID>');
    expect(result.text).toContain('<IP>');
    expect(result.text).not.toContain('alice@example.com');
    expect(result.text).not.toContain('550e8400');
    expect(result.text).not.toContain('10.0.0.1');
  });

  it('reports redaction counts grouped by category', () => {
    const r = new Redactor();
    const result = r.redact('a@b.co and c@d.co both at /Users/justin/x');
    const pii = result.redactions.find((x) => x.category === 'pii');
    const path = result.redactions.find((x) => x.category === 'path');
    expect(pii?.count).toBe(2);
    expect(path?.count).toBe(1);
  });

  it('UUIDs are not eaten by the long-hex rule (UUID runs first)', () => {
    const r = new Redactor();
    const result = r.redact('id=550e8400-e29b-41d4-a716-446655440000');
    expect(result.text).toContain('<UUID>');
    expect(result.text).not.toContain('<HEX>');
  });

  it('returns empty redactions array when nothing matches', () => {
    const r = new Redactor();
    const result = r.redact('a plain sentence with no secrets');
    expect(result.text).toBe('a plain sentence with no secrets');
    expect(result.redactions).toEqual([]);
  });

  it('handles empty input gracefully', () => {
    const r = new Redactor();
    expect(r.redact('').text).toBe('');
    expect(r.redact('').redactions).toEqual([]);
  });
});

describe('Redactor — redactFields', () => {
  it('redacts only the specified fields', () => {
    const r = new Redactor();
    const event = {
      subsystem: 'TopicMemory',
      reason: 'failed at /Users/justin/.instar/db',
      stack: 'Error at /Users/justin/code/file.ts:42',
      retries: 3,
    } as const;

    const redacted = r.redactFields(event, ['reason']);
    expect(redacted.reason).toContain('<HOME>');
    // stack was NOT in the field list, so it stays unredacted
    expect(redacted.stack).toContain('/Users/justin');
    // non-string fields pass through
    expect(redacted.retries).toBe(3);
    // subsystem unchanged
    expect(redacted.subsystem).toBe('TopicMemory');
  });

  it('does not mutate the input object', () => {
    const r = new Redactor();
    const event = { reason: 'leak alice@example.com', other: 'x' };
    const before = event.reason;
    r.redactFields(event, ['reason']);
    expect(event.reason).toBe(before);
  });

  it('skips missing fields without throwing', () => {
    const r = new Redactor();
    const event = { reason: 'plain' } as Record<string, unknown>;
    const redacted = r.redactFields(event, ['reason', 'missing']);
    expect(redacted.reason).toBe('plain');
    expect(redacted.missing).toBeUndefined();
  });

  it('skips non-string fields without throwing', () => {
    const r = new Redactor();
    const event = { reason: 'alice@example.com', count: 42, nested: { inner: 'x' } };
    const redacted = r.redactFields(event, ['reason', 'count', 'nested']);
    expect(redacted.reason).toContain('<EMAIL>');
    expect(redacted.count).toBe(42);
    expect(redacted.nested).toEqual({ inner: 'x' });
  });
});

describe('Redactor — custom rules', () => {
  it('applies extraRules in addition to defaults', () => {
    const extra: RedactionRule = {
      pattern: /\bsecret-[a-z]+\b/g,
      replacement: '<CUSTOM>',
      category: 'custom',
    };
    const r = new Redactor({ extraRules: [extra] });
    const result = r.redact('value secret-foo and alice@example.com');
    expect(result.text).toContain('<CUSTOM>');
    expect(result.text).toContain('<EMAIL>');
    expect(result.redactions).toEqual(expect.arrayContaining([{ category: 'custom', count: 1 }]));
  });

  it('extraRules with non-global pattern still match all occurrences', () => {
    const extra: RedactionRule = {
      pattern: /badword/,
      replacement: '<BAD>',
      category: 'custom',
    };
    const r = new Redactor({ extraRules: [extra] });
    const result = r.redact('badword and badword again');
    expect(result.text).toBe('<BAD> and <BAD> again');
    expect(result.redactions).toEqual(expect.arrayContaining([{ category: 'custom', count: 2 }]));
  });
});

describe('Redactor — home-path toggle', () => {
  it('redactHomePath:false disables home-dir redaction', () => {
    const r = new Redactor({ redactHomePath: false });
    const result = r.redact('error at /Users/justin/.instar/db');
    expect(result.text).toContain('/Users/justin');
    expect(result.text).not.toContain('<HOME>');
  });

  it('redactHomePath:true (default) redacts home dir', () => {
    const r = new Redactor({ redactHomePath: true });
    const result = r.redact('error at /Users/justin/.instar/db');
    expect(result.text).toContain('<HOME>');
  });

  it('other rules still fire when home-path is disabled', () => {
    const r = new Redactor({ redactHomePath: false });
    const result = r.redact('email alice@example.com path /Users/justin');
    expect(result.text).toContain('<EMAIL>');
    expect(result.text).toContain('/Users/justin');
  });
});
