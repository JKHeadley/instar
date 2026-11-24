import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LocalAccessStore, MAX_LIVE_CREDENTIALS, MAX_OPEN_CHALLENGES_PER_TICKET, MAX_UNREDEEMED_TICKETS, TICKET_LIFETIME_MS,
  challengeSecretProof, exchangeText, keyThumbprint, useText,
} from '../../src/core/LocalAccessStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ORIGIN = 'http://127.0.0.1:4321';
const OP = 'tests/unit/local-access-store.test.ts:cleanup';

function keyPair(): { publicKey: string; sign: (t: string) => string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  return {
    publicKey: Buffer.from(raw).toString('base64url'),
    sign: (t: string) => crypto.sign('sha256', Buffer.from(t), { key: privateKey, dsaEncoding: 'der' }).toString('base64url'),
  };
}

function verify(publicKey: string, text: string, sig: string): boolean {
  const raw = Buffer.from(publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  return crypto.verify('sha256', Buffer.from(text), { key, dsaEncoding: 'der' }, Buffer.from(sig, 'base64url'));
}

describe('LocalAccessStore', () => {
  let dir: string;
  let now: number;
  let store: LocalAccessStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-access-'));
    now = 1_800_000_000_000;
    store = new LocalAccessStore({ dir: path.join(dir, 'local-access'), agentName: 'echo', now: () => now });
  });
  afterEach(() => { store.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }); });

  function exchangeWith(m: { id: string; secret: string }, k = keyPair(), origin = ORIGIN) {
    const ch = store.exchangeChallenge({ ticketId: m.id, secretProof: challengeSecretProof(m.secret), publicKey: k.publicKey, origin });
    if (!ch.ok) throw new Error(ch.reason);
    const sig = k.sign(exchangeText('echo', m.id, ch.challenge, origin));
    return store.exchange({ ticketId: m.id, secret: m.secret, publicKey: k.publicKey, challenge: ch.challenge, origin, verify: (t) => verify(k.publicKey, t, sig) });
  }
  function redeem(k = keyPair()) {
    const m = store.mint({ origin: ORIGIN, startedBy: 'terminal' });
    return { m, k, out: exchangeWith(m, k) };
  }

  it('creates a private directory and database', () => {
    expect(fs.statSync(path.join(dir, 'local-access')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'local-access', 'tickets.db')).mode & 0o777).toBe(0o600);
  });

  it('stores only digests of the secret', () => {
    const m = store.mint({ origin: ORIGIN, startedBy: 'terminal' });
    const files = ['tickets.db', 'tickets.db-wal'].map((f) => path.join(dir, 'local-access', f)).filter((f) => fs.existsSync(f));
    expect(files.some((f) => fs.readFileSync(f).toString('latin1').includes(m.secret))).toBe(false);
    expect(m.expiresAt).toBe(now + TICKET_LIFETIME_MS);
    expect(m.launchName).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('redeems once and binds one credential to the key', () => {
    const { out, k } = redeem();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.repeated).toBe(false);
    expect(out.credential.keyThumbprint).toBe(keyThumbprint(k.publicKey));
    expect(out.endedLaunchNames.length).toBe(1);
    expect(store.counts().liveCredentials).toBe(1);
  });

  it('a same-key repeat returns the same credential', () => {
    const { m, k, out } = redeem();
    if (!out.ok) throw new Error('first exchange failed');
    const again = exchangeWith(m, k);
    expect(again.ok && again.repeated && again.credential.credentialId === out.credential.credentialId).toBe(true);
    expect(store.counts().liveCredentials).toBe(1);
  });

  it('a second key cannot take a bound ticket, and racing keys yield one binding', () => {
    const m = store.mint({ origin: ORIGIN, startedBy: 'terminal' });
    const a = keyPair(); const b = keyPair();
    const sp = challengeSecretProof(m.secret);
    const ca = store.exchangeChallenge({ ticketId: m.id, secretProof: sp, publicKey: a.publicKey, origin: ORIGIN });
    const cb = store.exchangeChallenge({ ticketId: m.id, secretProof: sp, publicKey: b.publicKey, origin: ORIGIN });
    if (!ca.ok || !cb.ok) throw new Error('challenges');
    const sa = a.sign(exchangeText('echo', m.id, ca.challenge, ORIGIN));
    const sb = b.sign(exchangeText('echo', m.id, cb.challenge, ORIGIN));
    const ra = store.exchange({ ticketId: m.id, secret: m.secret, publicKey: a.publicKey, challenge: ca.challenge, origin: ORIGIN, verify: (t) => verify(a.publicKey, t, sa) });
    const rb = store.exchange({ ticketId: m.id, secret: m.secret, publicKey: b.publicKey, challenge: cb.challenge, origin: ORIGIN, verify: (t) => verify(b.publicKey, t, sb) });
    expect(ra.ok).toBe(true);
    expect(rb).toEqual({ ok: false, reason: 'bound-to-other-key' });
    expect(store.exchangeChallenge({ ticketId: m.id, secretProof: sp, publicKey: b.publicKey, origin: ORIGIN })).toEqual({ ok: false, reason: 'bound-to-other-key' });
    expect(store.counts().liveCredentials).toBe(1);
  });

  it('a challenge needs proof of the secret; wrong proofs allocate nothing', () => {
    const m = store.mint({ origin: ORIGIN, startedBy: 'terminal' });
    const k = keyPair();
    expect(store.exchangeChallenge({ ticketId: m.id, secretProof: challengeSecretProof('wrong'), publicKey: k.publicKey, origin: ORIGIN })).toEqual({ ok: false, reason: 'bad-secret' });
    expect(store.exchangeChallenge({ ticketId: m.id, secretProof: 'not-hex', publicKey: k.publicKey, origin: ORIGIN })).toEqual({ ok: false, reason: 'bad-secret' });
    expect(store.counts().challenges).toBe(0);
  });

  it('refuses a wrong secret, a wrong origin, a reused or unknown challenge and a bad signature', () => {
    const m = store.mint({ origin: ORIGIN, startedBy: 'terminal' });
    const k = keyPair();
    const sp = challengeSecretProof(m.secret);
    expect(store.exchangeChallenge({ ticketId: m.id, secretProof: sp, publicKey: k.publicKey, origin: 'http://127.0.0.1:9' })).toEqual({ ok: false, reason: 'origin-mismatch' });
    const ch = store.exchangeChallenge({ ticketId: m.id, secretProof: sp, publicKey: k.publicKey, origin: ORIGIN });
    if (!ch.ok) throw new Error('challenge');
    const sig = k.sign(exchangeText('echo', m.id, ch.challenge, ORIGIN));
    const good = (t: string) => verify(k.publicKey, t, sig);
    expect(store.exchange({ ticketId: m.id, secret: 'x'.repeat(43), publicKey: k.publicKey, challenge: ch.challenge, origin: ORIGIN, verify: good })).toEqual({ ok: false, reason: 'bad-secret' });
    expect(store.exchange({ ticketId: m.id, secret: m.secret, publicKey: k.publicKey, challenge: ch.challenge, origin: ORIGIN, verify: () => false })).toEqual({ ok: false, reason: 'bad-signature' });
    expect(store.exchange({ ticketId: m.id, secret: m.secret, publicKey: k.publicKey, challenge: 'nope', origin: ORIGIN, verify: good })).toEqual({ ok: false, reason: 'bad-challenge' });
    expect(store.exchange({ ticketId: m.id, secret: m.secret, publicKey: k.publicKey, challenge: ch.challenge, origin: ORIGIN, verify: good }).ok).toBe(true);
    expect(store.exchange({ ticketId: m.id, secret: m.secret, publicKey: k.publicKey, challenge: ch.challenge, origin: ORIGIN, verify: good })).toEqual({ ok: false, reason: 'bad-challenge' });
  });

  it('expires tickets and credentials at the original deadline, never renewed', () => {
    const { out } = redeem();
    if (!out.ok) throw new Error('exchange');
    now += TICKET_LIFETIME_MS - 1;
    expect(store.useChallenge({ credentialId: out.credential.credentialId, action: 'dashboard-unlock', origin: ORIGIN }).ok).toBe(true);
    now += 1;
    expect(store.useChallenge({ credentialId: out.credential.credentialId, action: 'dashboard-unlock', origin: ORIGIN })).toEqual({ ok: false, reason: 'expired' });
    store.prune();
    expect(store.counts()).toEqual({ unredeemed: 0, liveCredentials: 0, challenges: 0 });
  });

  it('evicts the oldest unredeemed ticket at the cap, so repeated clicks never lock out', () => {
    const minted: Array<{ id: string; launchName: string }> = [];
    const ended: string[] = [];
    for (let i = 0; i < 15; i++) {
      const m = store.mint({ origin: ORIGIN, startedBy: 'terminal' });
      ended.push(...m.endedLaunchNames);
      minted.push(m);
      now += 1;
    }
    expect(store.counts().unredeemed).toBe(MAX_UNREDEEMED_TICKETS);
    expect(ended.sort()).toEqual(minted.slice(0, 5).map((m) => m.launchName).sort());
    const live = store.liveLaunchNames();
    expect(minted.slice(5).every((m) => live.has(m.launchName))).toBe(true);
    const k = keyPair();
    expect(store.exchangeChallenge({ ticketId: minted[0].id, secretProof: 'a'.repeat(64), publicKey: k.publicKey, origin: ORIGIN }).ok).toBe(false);
  });

  it('at the credential cap an exchange ends the oldest live credential instead of refusing', () => {
    const first = redeem();
    if (!first.out.ok) throw new Error('exchange');
    now += 1;
    for (let i = 1; i < MAX_LIVE_CREDENTIALS; i++) { expect(redeem().out.ok).toBe(true); now += 1; }
    const eleventh = redeem();
    expect(eleventh.out.ok).toBe(true);
    expect(store.counts().liveCredentials).toBe(MAX_LIVE_CREDENTIALS);
    expect(store.useChallenge({ credentialId: first.out.credential.credentialId, action: 'dashboard-unlock', origin: ORIGIN })).toEqual({ ok: false, reason: 'unknown-credential' });
  });

  it('a same-key retry never revives an evicted credential', () => {
    const first = redeem();
    if (!first.out.ok) throw new Error('exchange');
    now += 1;
    for (let i = 0; i < MAX_LIVE_CREDENTIALS; i++) { expect(redeem().out.ok).toBe(true); now += 1; }
    // the first credential was evicted; its ticket is redeemed and bound to the first key
    const ch = store.exchangeChallenge({ ticketId: first.m.id, secretProof: challengeSecretProof(first.m.secret), publicKey: first.k.publicKey, origin: ORIGIN });
    if (!ch.ok) throw new Error(ch.reason);
    const sig = first.k.sign(exchangeText('echo', first.m.id, ch.challenge, ORIGIN));
    const again = store.exchange({ ticketId: first.m.id, secret: first.m.secret, publicKey: first.k.publicKey, challenge: ch.challenge, origin: ORIGIN, verify: (t) => verify(first.k.publicKey, t, sig) });
    expect(again).toEqual({ ok: false, reason: 'revoked' });
    expect(store.counts().liveCredentials).toBe(MAX_LIVE_CREDENTIALS);
  });

  it('revokes every unredeemed ticket at server start and keeps bound credentials', () => {
    const bound = redeem();
    if (!bound.out.ok) throw new Error('exchange');
    const pending = store.mint({ origin: ORIGIN, startedBy: 'terminal' });
    const names = store.revokeUnredeemedAtStart();
    expect(names).toEqual([pending.launchName]);
    expect(store.exchangeChallenge({ ticketId: pending.id, secretProof: challengeSecretProof(pending.secret), publicKey: keyPair().publicKey, origin: ORIGIN })).toEqual({ ok: false, reason: 'revoked' });
    expect(store.useChallenge({ credentialId: bound.out.credential.credentialId, action: 'dashboard-unlock', origin: ORIGIN }).ok).toBe(true);
  });

  it('caps open challenges per ticket and allocates nothing for unknown ids', () => {
    const m = store.mint({ origin: ORIGIN, startedBy: 'terminal' });
    const sp = challengeSecretProof(m.secret);
    for (let i = 0; i < MAX_OPEN_CHALLENGES_PER_TICKET; i++) expect(store.exchangeChallenge({ ticketId: m.id, secretProof: sp, publicKey: keyPair().publicKey, origin: ORIGIN }).ok).toBe(true);
    expect(store.exchangeChallenge({ ticketId: m.id, secretProof: sp, publicKey: keyPair().publicKey, origin: ORIGIN })).toEqual({ ok: false, reason: 'too-many-challenges' });
    const before = store.counts().challenges;
    expect(store.exchangeChallenge({ ticketId: 'A'.repeat(22), secretProof: sp, publicKey: keyPair().publicKey, origin: ORIGIN })).toEqual({ ok: false, reason: 'unknown-ticket' });
    expect(store.useChallenge({ credentialId: 'B'.repeat(22), action: 'dashboard-unlock', origin: ORIGIN })).toEqual({ ok: false, reason: 'unknown-credential' });
    expect(store.counts().challenges).toBe(before);
  });

  it('verifies one use per challenge, bound to the action and the key', () => {
    const { out, k } = redeem();
    if (!out.ok) throw new Error('exchange');
    const cid = out.credential.credentialId;
    const mp = 'POST /dashboard/unlock';
    const ch = store.useChallenge({ credentialId: cid, action: 'dashboard-unlock', origin: ORIGIN });
    if (!ch.ok) throw new Error('use challenge');
    const sig = k.sign(useText('echo', cid, 'dashboard-unlock', ch.challenge, ORIGIN, mp));
    const v = (pub: string, text: string) => verify(pub, text, sig);
    expect(store.verifyUse({ credentialId: cid, action: 'other', challenge: ch.challenge, origin: ORIGIN, methodPath: mp, verify: v })).toBeNull();
    expect(store.verifyUse({ credentialId: cid, action: 'dashboard-unlock', challenge: ch.challenge, origin: ORIGIN, methodPath: mp, verify: v })?.credentialId).toBe(cid);
    expect(store.verifyUse({ credentialId: cid, action: 'dashboard-unlock', challenge: ch.challenge, origin: ORIGIN, methodPath: mp, verify: v })).toBeNull();
    const other = keyPair();
    const ch2 = store.useChallenge({ credentialId: cid, action: 'dashboard-unlock', origin: ORIGIN });
    if (!ch2.ok) throw new Error('use challenge 2');
    const bad = other.sign(useText('echo', cid, 'dashboard-unlock', ch2.challenge, ORIGIN, mp));
    expect(store.verifyUse({ credentialId: cid, action: 'dashboard-unlock', challenge: ch2.challenge, origin: ORIGIN, methodPath: mp, verify: (pub, text) => verify(pub, text, bad) })).toBeNull();
  });

  it('remembers mint nonces so a request cannot be replayed', () => {
    expect(store.rememberNonce('n'.repeat(22), now + 60_000)).toBe(true);
    expect(store.rememberNonce('n'.repeat(22), now + 60_000)).toBe(false);
    now += 60_001;
    expect(store.rememberNonce('n'.repeat(22), now + 60_000)).toBe(true);
    expect(store.rememberNonce('bad nonce', now + 60_000)).toBe(false);
  });

  it('refuses a symlinked directory', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'la-real-'));
    const link = path.join(dir, 'linked');
    fs.symlinkSync(real, link);
    expect(() => new LocalAccessStore({ dir: link, agentName: 'echo' })).toThrow('local-access-dir-ownership-invalid');
    SafeFsExecutor.safeRmSync(real, { recursive: true, force: true, operation: OP });
  });
});
