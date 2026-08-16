/**
 * Codex `auth.json` fixture loader.
 *
 * WHY THIS EXISTS (2026-08-03, found by running `--check`, not by reading):
 *   The generator's SAFE-DRIFT RULE is correct about the hazard and was wrong about the remedy.
 *   It says: a fixture may FREEZE a time value only when the passage of time moves it further into
 *   its intended case; the LIVE case (`exp` in the future) silently FLIPS to expired, so it "MUST be
 *   stamped". It then stamped it AT GENERATION TIME — into a file that is COMMITTED. A committed
 *   future timestamp is not stamped, it is frozen with extra steps: `auth.valid.json` is guaranteed
 *   to expire exactly one token-lifetime (1h) after every regeneration, so a CI gate asserting its
 *   liveness can never be green. Running `--check` reported `STALE ... expired 44 min ago`.
 *
 *   This is the same defect shape the spec review has hit for thirteen rounds: the rule was stated
 *   correctly at one site and its consequence not carried to the other. "Stamp it" is only a fix
 *   where the stamp happens at the moment of USE.
 *
 * WHAT THIS DOES
 *   Re-stamps `iat`/`exp` at LOAD time for the LIVE case, so "this token is live" is a property of
 *   every test RUN rather than of the hour after regeneration. Every other fixture is returned
 *   byte-for-byte: their frozen timestamps satisfy the safe-drift rule honestly (an expired token
 *   only gets more expired; a stale `iat` only gets staler), and re-stamping them would destroy the
 *   very case they encode.
 *
 * WHY RE-SIGNING IS NOT REQUIRED
 *   Fixture signatures are fixed placeholders — no fixture can pass a real signature check, and the
 *   README already requires tests to stub the JWKS verifier. Re-stamping the payload therefore
 *   changes nothing a test relies on. It would be WRONG to re-stamp if these were signature-valid.
 *
 * WHAT THIS DOES NOT DO
 *   It does not make the committed `auth.valid.json` live. Read that file directly and you get an
 *   expired token. That is deliberate: the honest artifact stays on disk, and liveness is supplied by
 *   the loader at the moment of use. A test that bypasses this loader for the LIVE case is testing
 *   the expired path and will say so.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('.', import.meta.url).pathname;

/** Measured against codex-cli 0.145.0: the real id_token lifetime. */
export const TOKEN_LIFETIME_S = 3600;

/** The only fixture whose intended case DEGRADES with time, so the only one re-stamped. */
const LIVE_CASE = 'auth.valid.json';

const b64u = {
  dec: (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  enc: (b: Buffer): string =>
    b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};

/** Re-stamp a compact JWS payload's `iat`/`exp` (and the auth-time claims that track them). */
function restamp(jwt: string, nowS: number): string {
  const [h, p, s] = jwt.split('.');
  if (!h || !p) throw new Error('fixture id_token is not a compact JWS');
  const payload = JSON.parse(b64u.dec(p).toString('utf8')) as Record<string, unknown>;
  payload.iat = nowS;
  payload.exp = nowS + TOKEN_LIFETIME_S;
  // These track the login moment in the real artifact; leaving them frozen while iat moves would
  // produce a claim set no real login ever emits.
  if (typeof payload.auth_time === 'number') payload.auth_time = nowS;
  if (typeof payload.rat === 'number') payload.rat = nowS;
  return `${h}.${b64u.enc(Buffer.from(JSON.stringify(payload), 'utf8'))}.${s ?? ''}`;
}

export interface CodexAuthFixture {
  auth_mode: string;
  OPENAI_API_KEY: unknown;
  tokens: { id_token: string; access_token: string; refresh_token: string; account_id: string };
  last_refresh: string;
}

/**
 * Load a codex auth fixture.
 *
 * @param name  fixture filename, e.g. `auth.valid.json`
 * @param nowS  epoch seconds to stamp the LIVE case against (defaults to now). Pass an explicit
 *              value to test a deterministic instant — that is the supported way to pin time, NOT
 *              editing the committed fixture.
 */
export function loadCodexAuthFixture(name: string, nowS = Math.floor(Date.now() / 1000)): CodexAuthFixture {
  const doc = JSON.parse(readFileSync(join(DIR, name), 'utf8')) as CodexAuthFixture;
  if (name !== LIVE_CASE) return doc;
  return { ...doc, tokens: { ...doc.tokens, id_token: restamp(doc.tokens.id_token, nowS) } };
}

/** The claim set of a fixture's id_token, without verifying anything. Test convenience. */
export function fixtureClaims(f: CodexAuthFixture): Record<string, unknown> {
  const p = f.tokens.id_token.split('.')[1];
  if (!p) throw new Error('fixture id_token has no payload segment');
  return JSON.parse(b64u.dec(p).toString('utf8')) as Record<string, unknown>;
}
