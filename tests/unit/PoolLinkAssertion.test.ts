// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 tests for WS4.4 "links that survive machine boundaries"
 * (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4 e) — the cross-machine user-auth
 * ASSERTION (PoolLinkAssertion) + its single-use replay store (PoolLinkJtiStore).
 * SECURITY-SENSITIVE. Uses a REAL Ed25519 keypair (via MachineIdentity.sign/verify)
 * so the signature is genuine, not a fake. Named attack tests prove each property:
 * audience-bound (wrong holder / view / method), single-use (replay within TTL),
 * expired, unexpected-issuer (captured + presented by a different machine).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  mintPoolLinkAssertion,
  verifyPoolLinkAssertion,
  canonicalizePoolLinkAssertion,
  statusForPoolLinkReason,
  type PoolLinkAssertion,
} from '../../src/core/PoolLinkAssertion.js';
import { PoolLinkJtiStore } from '../../src/core/PoolLinkJtiStore.js';
import { sign, verify, generateSigningKeyPair } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FRONTING = 'm_fronting';
const HOLDER = 'm_holder';
const OTHER = 'm_other';
const VIEW = '11111111-2222-3333-4444-555555555555';

// Real Ed25519 keypairs for the fronting machine (issuer) and a different machine.
const frontingKeys = generateSigningKeyPair();
const otherKeys = generateSigningKeyPair();

// Registry: iss → public key PEM. The holder resolves the issuer's REGISTERED key.
const KEYRING: Record<string, string> = {
  [FRONTING]: frontingKeys.publicKey,
  [OTHER]: otherKeys.publicKey,
};

let nowMs: number;
let jtiSeq: number;

function mintFor(
  audience: { holderFingerprint: string; viewId: string; method: string },
  opts: { ttlMs?: number; signerPriv?: string; iss?: string } = {},
): PoolLinkAssertion {
  return mintPoolLinkAssertion(audience, 'pin-session', {
    selfFingerprint: opts.iss ?? FRONTING,
    sign: (c) => sign(c, opts.signerPriv ?? frontingKeys.privateKey),
    mintJti: () => `jti-${++jtiSeq}`,
    now: () => nowMs,
    ttlMs: opts.ttlMs,
  });
}

function holderDeps(over: { expectedIssuer?: string | null; seenJti?: (j: string) => boolean } = {}) {
  return {
    selfFingerprint: HOLDER,
    expectedIssuer: over.expectedIssuer === undefined ? FRONTING : over.expectedIssuer,
    resolveIssuerPublicKeyPem: (iss: string) => KEYRING[iss] ?? null,
    verify: (c: string, s: string, pem: string) => verify(c, s, pem),
    seenJti: over.seenJti ?? (() => false),
    now: () => nowMs,
  };
}

beforeEach(() => {
  nowMs = 1_000_000;
  jtiSeq = 0;
});

describe('PoolLinkAssertion — happy path', () => {
  it('mints + verifies an assertion bound to (holder, view, GET)', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    expect(a.iss).toBe(FRONTING);
    expect(a.aud.holderFingerprint).toBe(HOLDER);
    expect(a.aud.viewId).toBe(VIEW);
    expect(a.aud.method).toBe('GET');
    const v = verifyPoolLinkAssertion(a, { viewId: VIEW, method: 'GET' }, holderDeps());
    expect(v).toEqual({ ok: true, reason: 'ok' });
  });

  it('method binding is case-insensitive (get == GET)', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'get' });
    expect(a.aud.method).toBe('GET');
    const v = verifyPoolLinkAssertion(a, { viewId: VIEW, method: 'get' }, holderDeps());
    expect(v.ok).toBe(true);
  });

  it('NEVER carries the raw PIN/token — only the userAuth KIND label', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    const serialized = JSON.stringify(a);
    // The assertion is a closed shape: iss/aud/jti/iat/exp/userAuth/signature.
    expect(Object.keys(a).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'signature', 'userAuth']);
    expect(a.userAuth).toBe('pin-session');
    // No field named pin/token/password/secret anywhere.
    expect(serialized).not.toMatch(/"pin"|"token"|"password"|"secret"/i);
  });
});

describe('PoolLinkAssertion — AUDIENCE BINDING (named attack: wrong holder/view/method)', () => {
  it('ATTACK wrong-holder: an assertion bound to a different holder is rejected', () => {
    // Minted for HOLDER, but a different machine (OTHER) tries to accept it.
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    const v = verifyPoolLinkAssertion(
      a,
      { viewId: VIEW, method: 'GET' },
      { ...holderDeps(), selfFingerprint: OTHER },
    );
    expect(v).toEqual({ ok: false, reason: 'wrong-holder' });
  });

  it('ATTACK wrong-view: an assertion captured for view A cannot fetch view B', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    const OTHER_VIEW = '99999999-8888-7777-6666-555555555555';
    const v = verifyPoolLinkAssertion(a, { viewId: OTHER_VIEW, method: 'GET' }, holderDeps());
    expect(v).toEqual({ ok: false, reason: 'wrong-view' });
  });

  it('ATTACK wrong-method: a GET assertion cannot authorize a DELETE', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    const v = verifyPoolLinkAssertion(a, { viewId: VIEW, method: 'DELETE' }, holderDeps());
    expect(v).toEqual({ ok: false, reason: 'wrong-method' });
  });
});

describe('PoolLinkAssertion — ISSUER BINDING (named attack: captured + replayed by another machine)', () => {
  it('ATTACK unexpected-issuer: a captured assertion presented by a DIFFERENT authenticated machine is rejected', () => {
    // FRONTING minted it; the transport authenticated a DIFFERENT sender (OTHER).
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    const v = verifyPoolLinkAssertion(
      a,
      { viewId: VIEW, method: 'GET' },
      holderDeps({ expectedIssuer: OTHER }),
    );
    expect(v).toEqual({ ok: false, reason: 'unexpected-issuer' });
  });

  it('ATTACK forged-signature: an assertion whose iss claims FRONTING but is signed by another key is rejected', () => {
    // Claim iss=FRONTING but sign with OTHER's private key → signature won't
    // verify against FRONTING's REGISTERED public key.
    const a = mintFor(
      { holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' },
      { iss: FRONTING, signerPriv: otherKeys.privateKey },
    );
    const v = verifyPoolLinkAssertion(a, { viewId: VIEW, method: 'GET' }, holderDeps());
    expect(v).toEqual({ ok: false, reason: 'signature-invalid' });
  });

  it('ATTACK tampered-payload: flipping the view id after signing breaks the signature', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    const tampered: PoolLinkAssertion = { ...a, aud: { ...a.aud, viewId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } };
    // The REQUEST is for the tampered view (so it passes the view-match), but
    // the signature covers the original view → signature-invalid.
    const v = verifyPoolLinkAssertion(
      tampered,
      { viewId: tampered.aud.viewId, method: 'GET' },
      holderDeps(),
    );
    expect(v).toEqual({ ok: false, reason: 'signature-invalid' });
  });

  it('rejects an unknown issuer (no registered key)', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' }, { iss: 'm_ghost', signerPriv: otherKeys.privateKey });
    const v = verifyPoolLinkAssertion(
      a,
      { viewId: VIEW, method: 'GET' },
      holderDeps({ expectedIssuer: null }),
    );
    expect(v).toEqual({ ok: false, reason: 'unknown-issuer' });
  });
});

describe('PoolLinkAssertion — FRESHNESS (named attack: expired, not-yet-valid)', () => {
  it('ATTACK expired: an assertion past its exp is rejected', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' }, { ttlMs: 30_000 });
    nowMs += 30_001; // just past exp
    const v = verifyPoolLinkAssertion(a, { viewId: VIEW, method: 'GET' }, holderDeps());
    expect(v).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts right up to (but not at) exp', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' }, { ttlMs: 30_000 });
    nowMs += 29_999;
    expect(verifyPoolLinkAssertion(a, { viewId: VIEW, method: 'GET' }, holderDeps()).ok).toBe(true);
    nowMs += 1; // now == exp
    expect(verifyPoolLinkAssertion(a, { viewId: VIEW, method: 'GET' }, holderDeps())).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects an assertion whose iat is too far in the future (beyond skew)', () => {
    nowMs = 1_000_000;
    const future = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    // Roll the holder clock BACK so the assertion looks far-future.
    const v = verifyPoolLinkAssertion(
      future,
      { viewId: VIEW, method: 'GET' },
      { ...holderDeps(), now: () => nowMs - 60_000 },
    );
    expect(v).toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  it('ATTACK ttl-too-long: a far-future-exp assertion is rejected before it can pin a jti (DoS guard)', () => {
    // A misbehaving registered peer mints a 10-min span — over the 5-min holder ceiling.
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' }, { ttlMs: 10 * 60_000 });
    const v = verifyPoolLinkAssertion(a, { viewId: VIEW, method: 'GET' }, holderDeps());
    expect(v).toEqual({ ok: false, reason: 'ttl-too-long' });
  });

  it('accepts a span at the ceiling and rejects just over it (custom maxTtlMs honored)', () => {
    const atCeiling = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' }, { ttlMs: 60_000 });
    expect(verifyPoolLinkAssertion(atCeiling, { viewId: VIEW, method: 'GET' }, { ...holderDeps(), maxTtlMs: 60_000 }).ok).toBe(true);
    const overCeiling = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' }, { ttlMs: 60_001 });
    expect(verifyPoolLinkAssertion(overCeiling, { viewId: VIEW, method: 'GET' }, { ...holderDeps(), maxTtlMs: 60_000 })).toEqual({ ok: false, reason: 'ttl-too-long' });
  });
});

describe('PoolLinkAssertion — SINGLE USE (named attack: replay within TTL)', () => {
  it('ATTACK replay: a second use of the same jti within the window is rejected', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    const seen = new Set<string>();
    // First accept: jti unseen → ok. The caller records it.
    const v1 = verifyPoolLinkAssertion(a, { viewId: VIEW, method: 'GET' }, holderDeps({ seenJti: (j) => seen.has(j) }));
    expect(v1.ok).toBe(true);
    seen.add(a.jti);
    // Replay: same assertion, jti now seen → replayed.
    const v2 = verifyPoolLinkAssertion(a, { viewId: VIEW, method: 'GET' }, holderDeps({ seenJti: (j) => seen.has(j) }));
    expect(v2).toEqual({ ok: false, reason: 'replayed' });
  });
});

describe('PoolLinkAssertion — shape + status mapping', () => {
  it('rejects a malformed assertion', () => {
    const v = verifyPoolLinkAssertion({} as unknown as PoolLinkAssertion, { viewId: VIEW, method: 'GET' }, holderDeps());
    expect(v).toEqual({ ok: false, reason: 'malformed' });
  });
  it('maps reasons to HTTP statuses (auth→401, freshness/replay→409)', () => {
    expect(statusForPoolLinkReason('wrong-holder')).toBe(401);
    expect(statusForPoolLinkReason('wrong-view')).toBe(401);
    expect(statusForPoolLinkReason('wrong-method')).toBe(401);
    expect(statusForPoolLinkReason('unexpected-issuer')).toBe(401);
    expect(statusForPoolLinkReason('signature-invalid')).toBe(401);
    expect(statusForPoolLinkReason('expired')).toBe(409);
    expect(statusForPoolLinkReason('ttl-too-long')).toBe(409);
    expect(statusForPoolLinkReason('replayed')).toBe(409);
    expect(statusForPoolLinkReason('malformed')).toBe(400);
  });
  it('canonicalization is stable + excludes the signature', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    const c = canonicalizePoolLinkAssertion({ iss: a.iss, aud: a.aud, jti: a.jti, iat: a.iat, exp: a.exp, userAuth: a.userAuth });
    expect(c).not.toContain(a.signature);
    expect(c).toContain(VIEW);
  });
});

// ── PoolLinkJtiStore (durable single-use) ─────────────────────────────

describe('PoolLinkJtiStore — single-use + replay across restart', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-link-jti-'));
    nowMs = 1_000_000;
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PoolLinkAssertion.test.ts:cleanup' });
  });

  function makeStore() {
    return new PoolLinkJtiStore({ filePath: path.join(dir, 'pool-link-jtis.json'), now: () => nowMs });
  }

  it('records a jti and reports it seen thereafter', () => {
    const s = makeStore();
    expect(s.seen('jti-A')).toBe(false);
    s.record('jti-A', nowMs + 30_000);
    expect(s.seen('jti-A')).toBe(true);
  });

  it('ATTACK replay-across-restart: a recorded jti is still seen by a FRESH store reading the persisted file', () => {
    const s1 = makeStore();
    s1.record('jti-X', nowMs + 30_000);
    // New store instance (simulates a holder restart) reads the same file.
    const s2 = makeStore();
    expect(s2.seen('jti-X')).toBe(true);
  });

  it('record is idempotent (a second record of the same jti is a no-op)', () => {
    const s = makeStore();
    s.record('jti-Y', nowMs + 30_000);
    s.record('jti-Y', nowMs + 30_000);
    expect(s.size()).toBe(1);
  });

  it('GCs records past the retention window', () => {
    const s = new PoolLinkJtiStore({ filePath: path.join(dir, 'pool-link-jtis.json'), now: () => nowMs, retentionMs: 1000 });
    s.record('jti-old', nowMs + 30_000);
    expect(s.seen('jti-old')).toBe(true);
    nowMs += 35_000; // well past exp + retention
    s.record('jti-new', nowMs + 30_000); // triggers gc()
    expect(s.seen('jti-old')).toBe(false);
  });

  it('a corrupt store fails closed (empty) without throwing', () => {
    fs.writeFileSync(path.join(dir, 'pool-link-jtis.json'), '{ not json');
    const s = makeStore();
    expect(() => s.seen('anything')).not.toThrow();
    expect(s.seen('anything')).toBe(false);
  });

  it('ATTACK store-flood: enforces a fixed size cap, evicting oldest-expiry first (DoS guard, P19)', () => {
    const s = new PoolLinkJtiStore({ filePath: path.join(dir, 'pool-link-jtis.json'), now: () => nowMs, maxEntries: 3 });
    // Five distinct jtis with increasing expiry — exceeds the cap of 3.
    s.record('jti-1', nowMs + 10_000);
    s.record('jti-2', nowMs + 20_000);
    s.record('jti-3', nowMs + 30_000);
    s.record('jti-4', nowMs + 40_000);
    s.record('jti-5', nowMs + 50_000);
    expect(s.size()).toBeLessThanOrEqual(3);
    expect(s.droppedForCapCount()).toBeGreaterThan(0);
    // The two OLDEST-expiry jtis were evicted; the newest survive.
    expect(s.seen('jti-1')).toBe(false);
    expect(s.seen('jti-5')).toBe(true);
  });

  it('clamps a far-future assertion exp to now+retention so gc can never be pinned (DoS guard)', () => {
    const s = new PoolLinkJtiStore({ filePath: path.join(dir, 'pool-link-jtis.json'), now: () => nowMs, retentionMs: 1000 });
    // A misbehaving peer's assertion claims an exp 10 years out.
    s.record('jti-farfuture', nowMs + 10 * 365 * 24 * 60 * 60 * 1000);
    expect(s.seen('jti-farfuture')).toBe(true);
    // Advance past now+retention. If the record had kept the 10-year exp it would
    // survive; clamping to now+retention means gc drops it here.
    nowMs += 5000;
    s.record('jti-trigger-gc', nowMs + 500);
    expect(s.seen('jti-farfuture')).toBe(false);
  });
});

// Sanity: crypto is real (not a stub) — a forged signature truly fails.
describe('PoolLinkAssertion — crypto is genuine', () => {
  it('a hand-crafted signature with random bytes does not verify', () => {
    const a = mintFor({ holderFingerprint: HOLDER, viewId: VIEW, method: 'GET' });
    const forged: PoolLinkAssertion = { ...a, signature: crypto.randomBytes(64).toString('base64') };
    expect(verifyPoolLinkAssertion(forged, { viewId: VIEW, method: 'GET' }, holderDeps())).toEqual({ ok: false, reason: 'signature-invalid' });
  });
});
