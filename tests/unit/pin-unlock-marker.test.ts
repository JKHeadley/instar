import { describe, it, expect } from 'vitest';
import { issuePinMarker, verifyPinMarker, pinMarkerCookieOptions, PIN_MARKER_COOKIE } from '../../src/server/pinUnlockMarker.js';

const TOKEN = 'agent-token-abc123';
const TTL = 30 * 24 * 60 * 60 * 1000;

describe('pinUnlockMarker', () => {
  it('a freshly issued marker verifies for its token and returns its id', () => {
    const now = 1_000_000;
    const m = issuePinMarker(TOKEN, now, TTL);
    const id = verifyPinMarker(TOKEN, m, now + 1000);
    expect(id).toBe(m.split('.')[1]); // the signed id, used to key marked-abuse accounting
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is rejected after its signed expiry', () => {
    const now = 1_000_000;
    const m = issuePinMarker(TOKEN, now, 5000);
    expect(verifyPinMarker(TOKEN, m, now + 4000)).not.toBeNull();
    expect(verifyPinMarker(TOKEN, m, now + 6000)).toBeNull();
  });

  it('cannot be forged without the derived key (different token fails)', () => {
    const now = 1_000_000;
    const m = issuePinMarker(TOKEN, now, TTL);
    expect(verifyPinMarker('a-different-token', m, now + 1000)).toBeNull();
  });

  it('tampering with the expiry invalidates it (expiry is inside the signature)', () => {
    const now = 1_000_000;
    const m = issuePinMarker(TOKEN, now, 5000);
    const [, id, mac] = m.split('.');
    const forged = `${now + 10_000_000}.${id}.${mac}`;
    expect(verifyPinMarker(TOKEN, forged, now + 6000)).toBeNull();
  });

  it('rejects malformed values and missing token', () => {
    const now = 1_000_000;
    expect(verifyPinMarker(TOKEN, 'garbage', now)).toBeNull();
    expect(verifyPinMarker(TOKEN, '123.abc', now)).toBeNull();
    expect(verifyPinMarker(TOKEN, '', now)).toBeNull();
    expect(verifyPinMarker(undefined, issuePinMarker(TOKEN, now, TTL), now)).toBeNull();
    expect(verifyPinMarker(TOKEN, 123 as unknown as string, now)).toBeNull();
  });

  it('cookie options are httpOnly + Secure + SameSite=Strict', () => {
    const o = pinMarkerCookieOptions(TTL);
    expect(o.httpOnly).toBe(true);
    expect(o.secure).toBe(true);
    expect(o.sameSite).toBe('strict');
    expect(o.maxAge).toBe(TTL); // ms for Express res.cookie
    expect(PIN_MARKER_COOKIE).toBe('instar_pin_ok');
  });
});
