/**
 * docs/specs/backup-email-sending.md — the pure rules: the recipient address, the subject, the plain-text
 * converter, the closed set of reasons, delivery mapping for every Resend status and SMTP code, and the
 * credential the key route accepts (never a recipient, never a host).
 */
import { describe, it, expect } from 'vitest';
import {
  buildSubject, credentialVersion, cutToBytes, emailDay, fallbackLine, isCredentialRefusal, isResendRecipientRestriction,
  mapResendSend, mapResendStatus, mapSmtpCode, maskRecipient, normalizeRecipient, parseEmailCredential, providerCap,
  recipientHash, toPlainText, SMTP_PRESETS, RESEND_DAILY_CAP,
} from '../../src/email/emailCore.js';

describe('the owner-typed recipient', () => {
  it('accepts one bare address and lowercases it', () => {
    expect(normalizeRecipient('  Justin@Example.COM ')).toBe('justin@example.com');
    expect(normalizeRecipient('a.b+tag@sub.example.co.uk')).toBe('a.b+tag@sub.example.co.uk');
  });
  it('refuses a display name, a list, angle brackets, control characters and anything over 254 characters', () => {
    for (const bad of ['Justin <j@example.com>', 'a@example.com, b@example.com', '<a@example.com>', 'a@example.com\r\nBcc: x@y.com',
      'a@@example.com', '@example.com', 'a@', 'a@localhost', 'a..b@example.com', '.a@example.com', `${'a'.repeat(250)}@example.com`, 42, null, '']) {
      expect(normalizeRecipient(bad), String(bad)).toBeNull();
    }
  });
  it('hashes with a key, so the same address under another machine key differs', () => {
    const a = recipientHash('key-one', 'j@example.com');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(recipientHash('key-two', 'j@example.com')).not.toBe(a);
    expect(recipientHash('key-one', 'j@example.com')).toBe(a);
  });
  it('masks the address for status surfaces', () => {
    expect(maskRecipient('justin@example.com')).toBe('j***@example.com');
    expect(maskRecipient(null)).toBeNull();
  });
});

describe('the subject and the body', () => {
  it('prefixes the agent name, strips CR/LF and caps at 200 characters', () => {
    expect(buildSubject('Echo', 'Daily\r\nBcc: x@y.com report')).toBe('Echo: Daily Bcc: x@y.com report');
    expect(buildSubject('Echo', 'x'.repeat(500)).length).toBe(200);
    expect(buildSubject('', '')).toBe('Your agent: Report');
  });
  it('turns Telegram markdown into plain text with a fixed converter', () => {
    const md = '# Title\n\n*Job Complete: Daily*\nStatus: **Done**\n\n```\nline one\nline two\n```\nSee `npm test` and [the page](https://example.com).\n\n\n\n_quiet_ ~~old~~';
    expect(toPlainText(md)).toBe('Title\n\nJob Complete: Daily\nStatus: Done\n\nline one\nline two\nSee npm test and the page (https://example.com).\n\nquiet old');
  });
  it('cuts by bytes without splitting a character', () => {
    expect(Buffer.byteLength(cutToBytes('é'.repeat(100), 51))).toBeLessThanOrEqual(51);
    expect(cutToBytes('é'.repeat(100), 51).endsWith('�')).toBe(false);
  });
});

describe('delivery mapping', () => {
  it('maps every Resend last_event: only delivered (or later opened/clicked) is delivered', () => {
    expect(mapResendStatus('delivered')).toEqual({ delivery: 'delivered', reason: 'ok' });
    expect(mapResendStatus('opened')?.delivery).toBe('delivered');
    expect(mapResendStatus('clicked')?.delivery).toBe('delivered');
    expect(mapResendStatus('bounced')).toEqual({ delivery: 'failed', reason: 'bounced' });
    expect(mapResendStatus('complained')).toEqual({ delivery: 'failed', reason: 'complained' });
    for (const pending of ['sent', 'queued', 'scheduled', 'delivery_delayed', undefined, 'something-new']) expect(mapResendStatus(pending)).toBeNull();
  });
  it('maps Resend send answers, with the recipient-restriction 403 outside the credential breaker', () => {
    expect(mapResendSend(200, { id: 'abc' })).toEqual({ outcome: 'accepted', providerId: 'abc', reason: 'ok' });
    expect(mapResendSend(200, {})).toEqual({ outcome: 'unknown', reason: 'provider-error' });
    expect(mapResendSend(429, {})).toEqual({ outcome: 'refused', reason: 'provider-rate-limited' });
    expect(mapResendSend(401, {})).toEqual({ outcome: 'refused', reason: 'credential-refused' });
    const restriction = { name: 'validation_error', message: 'You can only send testing emails to your own email address (owner@example.com).' };
    expect(isResendRecipientRestriction(restriction)).toBe(true);
    expect(mapResendSend(403, restriction)).toEqual({ outcome: 'refused', reason: 'provider-recipient-refused' });
    expect(mapResendSend(403, { name: 'restricted_api_key', message: 'This key can only send' })).toEqual({ outcome: 'refused', reason: 'credential-refused' });
    expect(mapResendSend(422, {})).toEqual({ outcome: 'refused', reason: 'provider-error' });
    expect(mapResendSend(503, {})).toEqual({ outcome: 'unknown', reason: 'provider-error' });
    expect(isCredentialRefusal('provider-recipient-refused')).toBe(false);
    expect(isCredentialRefusal('credential-refused')).toBe(true);
    expect(isCredentialRefusal('budget-exhausted')).toBe(false);
  });
  it('maps SMTP codes: 250 is accepted (never delivered), 535 is a credential refusal', () => {
    expect(mapSmtpCode(250, 'send')).toEqual({ outcome: 'accepted', reason: 'ok' });
    expect(mapSmtpCode(535, 'send').reason).toBe('credential-refused');
    expect(mapSmtpCode(421, 'send').reason).toBe('provider-rate-limited');
    expect(mapSmtpCode(550, 'send')).toEqual({ outcome: 'refused', reason: 'provider-error' });
    expect(mapSmtpCode(undefined, 'send')).toEqual({ outcome: 'unknown', reason: 'network' });
  });
});

describe('the credential the key route accepts', () => {
  it('takes shape A as a Resend key, and splits off the account password', () => {
    const r = parseEmailCredential(JSON.stringify({ shape: 'A', transport: 'resend', secret: 're_123', providerAccountPassword: 'pw' }));
    expect(r).toEqual({ ok: true, credential: { shape: 'A', transport: 'resend', secret: 're_123' }, providerAccountPassword: 'pw' });
  });
  it('takes shapes B and C as SMTP presets, removing spaces from an app password', () => {
    const r = parseEmailCredential(JSON.stringify({ shape: 'B', transport: 'smtp', preset: 'gmail', username: 'Me@Gmail.com', secret: 'abcd efgh ijkl mnop' }));
    expect(r).toEqual({ ok: true, credential: { shape: 'B', transport: 'smtp', preset: 'gmail', username: 'me@gmail.com', secret: 'abcdefghijklmnop' } });
  });
  it('refuses a recipient, a host or port, an unknown field, and mismatched shapes', () => {
    const base = { shape: 'B', transport: 'smtp', preset: 'gmail', username: 'me@gmail.com', secret: 'x' };
    expect(parseEmailCredential(JSON.stringify({ ...base, recipient: 'other@example.com' }))).toEqual({ ok: false, error: 'recipient-not-accepted' });
    expect(parseEmailCredential(JSON.stringify({ ...base, to: 'other@example.com' }))).toEqual({ ok: false, error: 'recipient-not-accepted' });
    expect(parseEmailCredential(JSON.stringify({ ...base, host: 'evil.example.com' }))).toEqual({ ok: false, error: 'presets-only' });
    expect(parseEmailCredential(JSON.stringify({ ...base, cc: 'x' }))).toEqual({ ok: false, error: 'unknown-field' });
    expect(parseEmailCredential(JSON.stringify({ ...base, preset: 'outlook' }))).toEqual({ ok: false, error: 'invalid-preset' });
    expect(parseEmailCredential(JSON.stringify({ ...base, shape: 'A' }))).toEqual({ ok: false, error: 'shape-a-is-resend' });
    expect(parseEmailCredential(JSON.stringify({ shape: 'C', transport: 'resend', secret: 'x' }))).toEqual({ ok: false, error: 'shape-b-c-are-smtp' });
    expect(parseEmailCredential('not json')).toEqual({ ok: false, error: 'invalid-json' });
  });
  it('knows each provider’s published cap and the presets’ fixed hosts', () => {
    expect(providerCap({ shape: 'A', transport: 'resend', secret: 'x' })).toBe(RESEND_DAILY_CAP);
    expect(providerCap({ shape: 'B', transport: 'smtp', preset: 'gmail', secret: 'x', username: 'a@b.co' })).toBe(500);
    expect(providerCap({ shape: 'C', transport: 'smtp', preset: 'icloud', secret: 'x', username: 'a@b.co' })).toBe(1000);
    expect(SMTP_PRESETS.gmail).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true });
    expect(SMTP_PRESETS.icloud).toMatchObject({ host: 'smtp.mail.me.com', port: 587, secure: false });
  });
  it('versions a proof by the stored credential and the recipient together', () => {
    expect(credentialVersion('cred', 'h1')).not.toBe(credentialVersion('cred', 'h2'));
    expect(credentialVersion('cred2', 'h1')).not.toBe(credentialVersion('cred', 'h1'));
  });
});

describe('one email day, and the fallback line', () => {
  it('reads the day in the agent’s timezone, so two holders keep one today', () => {
    const t = Date.parse('2026-11-09T06:30:00Z');
    expect(emailDay(t, 'America/Los_Angeles')).toBe('2026-11-08');
    expect(emailDay(t, 'Europe/Berlin')).toBe('2026-11-09');
    expect(emailDay(t, 'Not/AZone')).toBe('2026-11-09');
  });
  it('says plainly why a report came here instead', () => {
    expect(fallbackLine('not-set-up')).toMatch(/isn’t set up/);
    expect(fallbackLine('not-set-up-here')).toMatch(/machine sending it/);
    expect(fallbackLine('unknown')).toMatch(/couldn’t be sure/);
    expect(fallbackLine('refused', 'budget-exhausted')).toMatch(/limit/);
    expect(fallbackLine('refused', 'credential-exposure')).toMatch(/password or key/);
  });
});
