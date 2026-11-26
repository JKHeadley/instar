/**
 * PORTED to threadline-core (spec threadline-standalone-pairing): the same suite Instar runs, against
 * packages/threadline-core with PinnedKeyStore as the trust store. Keep both in step.
 *
 * Pure core of verified pairing by invite link (docs/specs/a2a-pairing-invite-link.md §4.1–§4.2, §7).
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  createInvite, encodeInvite, decodeInvite, findInviteToken, isExpired, transcript, macKey,
  inviteTag, verifyInviteTag, checkCode, inviteMessage, cleanLabel,
  INVITE_DEFAULT_TTL_MS, INVITE_MAX_TTL_MS,
} from '../../../packages/threadline-core/src/invite.js';

const key = () => crypto.randomBytes(32).toString('hex');
const T0 = new Date('2026-10-14T12:00:00.000Z');

describe('invite encode / decode', () => {
  it('round-trips, including a bound fingerprint', () => {
    const k = key();
    const bind = key().slice(0, 32);
    const inv = createInvite({ identityPubHex: k, owner: 'Justin', agent: 'Scout', bindFp: bind, now: T0 });
    const back = decodeInvite(encodeInvite(inv));
    expect(back).toEqual({ ok: true, invite: inv });
    expect(inv.fp).toBe(k.slice(0, 32));
    expect(inv.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(inv.iid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('finds the code inside a forwarded message with prose around it', () => {
    const inv = createInvite({ identityPubHex: key(), owner: 'J', agent: 'S', now: T0 });
    const msg = `Fwd: hey, here you go\n\n${encodeInvite(inv)}\n\nthanks!`;
    expect(findInviteToken(msg)).toBe(encodeInvite(inv));
    expect(decodeInvite(msg).ok).toBe(true);
  });

  it('a one-character edit, a truncation or a lost checksum is refused as damaged', () => {
    const code = encodeInvite(createInvite({ identityPubHex: key(), owner: 'J', agent: 'S', now: T0 }));
    const [head, sum] = code.split('.');
    const i = 20;
    const flipped = head.slice(0, i) + (head[i] === 'A' ? 'B' : 'A') + head.slice(i + 1) + '.' + sum;
    for (const bad of [flipped, code.slice(0, code.length - 3), head]) {
      const r = decodeInvite(bad);
      expect(r.ok).toBe(false);
    }
    expect(decodeInvite('no code here')).toEqual({ ok: false, reason: 'no invite code found' });
  });

  it('the checksum alone catches an edit that is still valid JSON (the old checksum no longer matches)', () => {
    const inv = createInvite({ identityPubHex: key(), owner: 'Justin', agent: 'Scout', now: T0 });
    const [, sum] = encodeInvite(inv).split('.');
    const edited = Buffer.from(JSON.stringify({ ...inv, owner: 'Mallory' }), 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeInvite(`tlinv1:${edited}.${sum}`)).toMatchObject({ ok: false, reason: expect.stringMatching(/checksum/) });
  });

  it('refuses a payload whose fingerprint is not its key, even with a valid checksum', () => {
    const inv = createInvite({ identityPubHex: key(), owner: 'J', agent: 'S', now: T0 });
    const forged = encodeInvite({ ...inv, fp: key().slice(0, 32) });
    expect(decodeInvite(forged)).toMatchObject({ ok: false, reason: expect.stringMatching(/fingerprint/) });
  });

  it('expiry: default 1 h, capped at 24 h, and checked against the clock', () => {
    const inv = createInvite({ identityPubHex: key(), owner: 'J', agent: 'S', now: T0 });
    expect(Date.parse(inv.exp) - T0.getTime()).toBe(INVITE_DEFAULT_TTL_MS);
    const long = createInvite({ identityPubHex: key(), owner: 'J', agent: 'S', now: T0, ttlMs: 7 * 24 * 3600_000 });
    expect(Date.parse(long.exp) - T0.getTime()).toBe(INVITE_MAX_TTL_MS);
    expect(isExpired(inv, new Date(T0.getTime() + INVITE_DEFAULT_TTL_MS - 1))).toBe(false);
    expect(isExpired(inv, new Date(T0.getTime() + INVITE_DEFAULT_TTL_MS))).toBe(true);
  });

  it('self-described names are cleaned and capped, never trusted as text', () => {
    expect(cleanLabel('Sc\u0000out\n')).toBe('Scout');
    expect(cleanLabel('x'.repeat(200))).toHaveLength(64);
  });

  it('the message to send is a code, never an http(s) URL (link scanners must not fetch it)', () => {
    const msg = inviteMessage(createInvite({ identityPubHex: key(), owner: 'Justin', agent: 'Scout' }));
    expect(msg).toContain('tlinv1:');
    expect(msg).not.toMatch(/https?:\/\//);
    expect(msg).toMatch(/Keep it private/);
  });
});

describe('transcript, MAC key and tag', () => {
  const base = {
    iid: 'a'.repeat(32), fpA: 'b'.repeat(32), idA: 'b'.repeat(64), fpB: 'c'.repeat(32), idB: 'c'.repeat(64),
    exp: '2026-10-14T13:00:00.000Z', nonce: 'd'.repeat(32), direction: 'accept' as const,
  };

  it('is length-prefixed: moving a character between adjacent fields changes the bytes', () => {
    const t1 = transcript({ ...base, iid: 'ab', fpA: 'c' });
    const t2 = transcript({ ...base, iid: 'a', fpA: 'bc' });
    expect(t1.equals(t2)).toBe(false);
  });

  it('separates directions: an accept tag never verifies as a finish', () => {
    const K = macKey('e'.repeat(64), base.iid);
    const tag = inviteTag(K, transcript(base));
    expect(verifyInviteTag(K, transcript(base), tag)).toBe(true);
    expect(verifyInviteTag(K, transcript({ ...base, direction: 'finish' }), tag)).toBe(false);
  });

  it('binds every field: changing either key, either fingerprint, exp or nonce breaks the tag', () => {
    const K = macKey('e'.repeat(64), base.iid);
    const tag = inviteTag(K, transcript(base));
    for (const change of [{ idB: 'f'.repeat(64) }, { idA: 'f'.repeat(64) }, { fpB: 'f'.repeat(32) }, { fpA: 'f'.repeat(32) },
      { exp: '2026-10-15T13:00:00.000Z' }, { nonce: 'f'.repeat(32) }]) {
      expect(verifyInviteTag(K, transcript({ ...base, ...change }), tag)).toBe(false);
    }
  });

  it('case does not split the two sides: upper-case hex gives the same transcript', () => {
    expect(transcript({ ...base, idB: base.idB.toUpperCase() }).equals(transcript(base))).toBe(true);
  });

  it('MAC key is HKDF-SHA256(S, salt = iid, info) — matches node crypto directly', () => {
    const S = crypto.randomBytes(32).toString('hex');
    const iid = crypto.randomBytes(16).toString('hex');
    const expected = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(S, 'hex'), Buffer.from(iid, 'hex'), 'threadline-invite-mac-v1', 32));
    expect(macKey(S, iid).equals(expected)).toBe(true);
    expect(macKey(S, crypto.randomBytes(16).toString('hex')).equals(expected)).toBe(false);
  });

  it('a wrong secret, a malformed or missing tag all fail closed without throwing', () => {
    const T = transcript(base);
    const tag = inviteTag(macKey('e'.repeat(64), base.iid), T);
    expect(verifyInviteTag(macKey('1'.repeat(64), base.iid), T, tag)).toBe(false);
    for (const bad of [undefined, null, 42, 'zz', tag.slice(2)]) expect(verifyInviteTag(macKey('e'.repeat(64), base.iid), T, bad)).toBe(false);
  });
});

describe('optional check code', () => {
  it('is 4 Crockford characters, stable for the same pair, and changes with either key', () => {
    const K = macKey('e'.repeat(64), 'a'.repeat(32));
    const a = key(), b = key();
    const c = checkCode(K, a, b);
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(checkCode(K, a, b)).toBe(c);
    const others = new Set([checkCode(K, key(), b), checkCode(K, a, key()), checkCode(macKey('1'.repeat(64), 'a'.repeat(32)), a, b)]);
    expect(others.has(c)).toBe(false);
  });

  it('cleanLabel removes bidi overrides, zero-width and control characters, and NFKC-normalises (SEC-12)', () => {
    expect(cleanLabel('ca\u202Erl')).toBe('carl');
    expect(cleanLabel('c\u200Ba\u200Dr\uFEFFl')).toBe('carl');
    expect(cleanLabel('ca\u2066rl\u2069')).toBe('carl');
    expect(cleanLabel('\u0085carl\u009b')).toBe('carl');
    expect(cleanLabel('ｃａｒｌ')).toBe('carl'); // full-width letters fold to ASCII
    expect(cleanLabel('Échø agent')).toBe('Échø agent'); // ordinary letters and spaces are kept
  });
});
