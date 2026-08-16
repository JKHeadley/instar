import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { readJwtExp, readSessionExpiry } from '../../src/providers/adapters/grok-build/policy.js';

/**
 * Round-21: the spec claimed the session JWT's `exp` was parsed, and the task
 * list required it, but no code anywhere decoded a token — the gate read the
 * sibling `expires_at` string and trusted it. Against the live session the two
 * agree to within 199 ms, so the proxy was accurate; it was simply unverified,
 * and a vendor change re-pointing `expires_at` at the opaque refresh token
 * would have gone unnoticed.
 *
 * The load-bearing property is DIRECTION: the cross-check may only ever pull
 * the effective expiry EARLIER. A combinator that could pull it later would
 * turn this guard into a way to extend a dead session.
 */

const DIRS: string[] = [];
afterAll(() => {
  for (const d of DIRS) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, sourceTreeOverride: true }); } catch { /* leave it */ }
  }
});

/** Build a signature-less JWT with the given payload. Never a real token. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;
}

function authFileWith(entry: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-jwt-'));
  DIRS.push(dir);
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify({ 'https://auth.x.ai::probe': entry }));
  return file;
}

const NOW = new Date('2026-08-15T12:00:00.000Z');
const IN_SIX_HOURS = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);

describe('readJwtExp', () => {
  it('CONTROL: decodes a seconds-epoch exp, the real vendor shape', () => {
    const exp = Math.floor(IN_SIX_HOURS.getTime() / 1000);
    expect(readJwtExp(jwt({ exp }), NOW)?.toISOString()).toBe(IN_SIX_HOURS.toISOString());
  });

  it('accepts a milliseconds-epoch exp rather than reading it as the year 58000', () => {
    // Read as seconds this lands ~56,000 years out — a session that never
    // expires. The plausibility window is what rejects that interpretation.
    expect(readJwtExp(jwt({ exp: IN_SIX_HOURS.getTime() }), NOW)?.toISOString())
      .toBe(IN_SIX_HOURS.toISOString());
  });

  it('reports unparseable rather than guessing when NEITHER reading is plausible', () => {
    // 10^15 is neither a sane seconds nor a sane milliseconds epoch.
    expect(readJwtExp(jwt({ exp: 1e15 }), NOW)).toBeNull();
  });

  it('returns null for a non-JWT credential instead of wedging the gate', () => {
    expect(readJwtExp('not-a-jwt', NOW)).toBeNull();
    expect(readJwtExp('two.segments', NOW)).toBeNull();
  });

  it('returns null for a token with no exp claim, and for undecodable base64', () => {
    expect(readJwtExp(jwt({ sub: 'x' }), NOW)).toBeNull();
    expect(readJwtExp('aaa.!!!not-base64!!!.sig', NOW)).toBeNull();
  });

  it('returns null for a non-numeric exp rather than coercing it', () => {
    expect(readJwtExp(jwt({ exp: '1786814401' }), NOW)).toBeNull();
  });
});

describe('readSessionExpiry cross-checks the token against the declared expiry', () => {
  it('CONTROL: agreeing values leave the declared expiry standing', () => {
    const file = authFileWith({
      auth_mode: 'oidc',
      expires_at: IN_SIX_HOURS.toISOString(),
      key: jwt({ exp: Math.floor(IN_SIX_HOURS.getTime() / 1000) }),
    });
    expect(readSessionExpiry(file)?.toISOString()).toBe(IN_SIX_HOURS.toISOString());
  });

  it('takes the TOKEN expiry when the token dies first — the case this guards', () => {
    // The declared expiry outlives the credential it describes.
    const tokenDies = new Date(NOW.getTime() + 60 * 1000);
    const file = authFileWith({
      auth_mode: 'oidc',
      expires_at: IN_SIX_HOURS.toISOString(),
      key: jwt({ exp: Math.floor(tokenDies.getTime() / 1000) }),
    });
    expect(readSessionExpiry(file)?.toISOString()).toBe(tokenDies.toISOString());
  });

  it('NEVER extends past the declared expiry, even when the token claims longer', () => {
    // The direction property: a token claiming a year of life cannot revive a
    // session the file says is nearly over.
    const declared = new Date(NOW.getTime() + 60 * 1000);
    const file = authFileWith({
      auth_mode: 'oidc',
      expires_at: declared.toISOString(),
      key: jwt({ exp: Math.floor((NOW.getTime() + 365 * 24 * 3600 * 1000) / 1000) }),
    });
    expect(readSessionExpiry(file)?.toISOString()).toBe(declared.toISOString());
  });

  it('falls back to the declared expiry when the credential is not a JWT', () => {
    const file = authFileWith({
      auth_mode: 'oidc',
      expires_at: IN_SIX_HOURS.toISOString(),
      key: 'opaque-vendor-credential',
    });
    expect(readSessionExpiry(file)?.toISOString()).toBe(IN_SIX_HOURS.toISOString());
  });

  it('still refuses an entry with no parseable declared expiry at all', () => {
    const file = authFileWith({ auth_mode: 'oidc', key: jwt({ exp: 1 }) });
    expect(readSessionExpiry(file)).toBeNull();
  });
});
