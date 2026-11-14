/**
 * Keyed fenced lease (context-budget-layered-summaries §9.3 step 1, §14 "Fold
 * lock", §18 "keyed fenced lease on local and git media with the key in the
 * signed tuple"). Real Ed25519 keys, real files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { KeyedLeaseLock, LocalKeyedLeaseStore, GitKeyedLeaseStore } from '../../src/core/KeyedLease.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/KeyedLease.test.ts';
const keys: Record<string, crypto.KeyObject> = {};
const pubs: Record<string, crypto.KeyObject> = {};
for (const m of ['m_alpha', 'm_beta']) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  keys[m] = privateKey; pubs[m] = publicKey;
}
const cryptoFor = (self: string): LeaseCrypto => ({
  selfMachineId: self,
  sign: (c) => crypto.sign(null, Buffer.from(c), keys[self]).toString('base64'),
  verify: (c, sig, holder) => {
    const pub = pubs[holder];
    if (!pub) return false;
    try { return crypto.verify(null, Buffer.from(c), pub, Buffer.from(sig, 'base64')); } catch { return false; }
  },
});
const fencedFor = (self: string) => new FencedLease(cryptoFor(self), { leaseTtlMs: 60_000, failoverThresholdMs: 120_000 });

describe('FencedLease keyed signing', () => {
  const f = fencedFor('m_alpha');
  const base = { key: '141133', role: 'coordinator', generation: 3, acquiredAt: '2026-11-10T00:00:00.000Z', expiresAt: '2026-11-10T00:01:00.000Z', nonce: 7 };

  it('verifies a lease it minted, and refuses it once the key (or any field) is changed', () => {
    const l = f.signKeyedLease(base);
    expect(f.verifyKeyedLease(l)).toBe(true);
    expect(f.verifyKeyedLease({ ...l, key: '999' })).toBe(false); // a lock for one topic never verifies for another
    expect(f.verifyKeyedLease({ ...l, generation: 4 })).toBe(false);
    expect(f.verifyKeyedLease({ ...l, role: 'sentinel' })).toBe(false);
    expect(f.verifyKeyedLease({ ...l, released: true })).toBe(false);
  });

  it('a keyed lease never verifies as a machine lease, and a machine lease never as a keyed one', () => {
    const keyed = f.signKeyedLease(base);
    const machine = f.signLease(3, base.acquiredAt, base.expiresAt, 7);
    expect(f.verifyLease({ ...machine, signature: keyed.signature })).toBe(false);
    expect(f.verifyKeyedLease({ ...keyed, signature: machine.signature })).toBe(false);
    expect(FencedLease.canonicalize(machine)).toBe(JSON.stringify(['m_alpha', 3, base.acquiredAt, base.expiresAt, 7])); // legacy form untouched
  });

  it("a lease claiming another machine's name does not verify", () => {
    const l = f.signKeyedLease(base);
    expect(f.verifyKeyedLease({ ...l, holder: 'm_beta' })).toBe(false);
  });
});

describe('KeyedLeaseLock on the local medium', () => {
  let dir: string;
  let now: number;
  let alpha: KeyedLeaseLock;
  let beta: KeyedLeaseLock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyed-lease-'));
    now = Date.parse('2026-11-10T07:00:00Z');
    // Two machines sharing one directory stand in for a shared medium; each
    // lock re-reads the file on every call, as two hands in one process do.
    alpha = new KeyedLeaseLock({ fenced: fencedFor('m_alpha'), store: new LocalKeyedLeaseStore(dir), ttlMs: 60_000, now: () => now });
    beta = new KeyedLeaseLock({ fenced: fencedFor('m_beta'), store: new LocalKeyedLeaseStore(dir), ttlMs: 60_000, now: () => now });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }));

  it('acquires a free key at generation 1, file 0600 in a 0700 dir', () => {
    const r = alpha.acquire('141133', 'coordinator');
    if (!r.ok) throw new Error('acquire failed');
    expect(r.lease.generation).toBe(1);
    expect(fs.statSync(path.join(dir, '141133.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(alpha.holds(r.lease)).toBe(true);
    expect(fs.existsSync(path.join(dir, '141133.lock'))).toBe(false); // the store lock is transient
  });

  it('refuses a second acquirer while the lock is live, on either machine or role', () => {
    alpha.acquire('141133', 'coordinator');
    expect(beta.acquire('141133', 'coordinator')).toMatchObject({ ok: false, reason: 'held', holder: { holder: 'm_alpha', generation: 1 } });
    expect(alpha.acquire('141133', 'sentinel')).toMatchObject({ ok: false, reason: 'held' });
  });

  it('keys are independent: a lock on one topic does not block another', () => {
    alpha.acquire('141133', 'coordinator');
    const r = beta.acquire('130715', 'coordinator');
    expect(r.ok).toBe(true);
  });

  it('after expiry another holder may acquire at the next generation, and the old holder is fenced out', () => {
    const a = alpha.acquire('141133', 'coordinator');
    now += 61_000;
    const b = beta.acquire('141133', 'coordinator');
    expect(b.ok && b.lease.generation).toBe(2);
    if (!a.ok) throw new Error('acquire failed');
    expect(alpha.holds(a.lease, { allowExpired: true })).toBe(false);
    expect(alpha.renew(a.lease)).toBeNull(); // a late renewal cannot resurrect it
  });

  it('renewal keeps the generation and pushes the expiry out; holds() fails once expired', () => {
    const a = alpha.acquire('141133', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    now += 50_000;
    const r = alpha.renew(a.lease);
    if (!r) throw new Error('renew failed');
    expect(r.generation).toBe(1);
    expect(alpha.holds(a.lease)).toBe(false); // the pre-renewal record is no longer the committed one
    now += 50_000; // 100 s after acquire, 50 s after renew
    expect(alpha.holds(r)).toBe(true);
    now += 11_000;
    expect(alpha.holds(r)).toBe(false);
  });

  it('handover moves the lock to the sentinel with a new generation, even after expiry, without a re-acquire', () => {
    const a = alpha.acquire('141133', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    now += 120_000; // the coordinator hung; the lock has expired
    const h = alpha.handover(a.lease, 'sentinel');
    if (!h.ok) throw new Error('handover failed');
    expect(h.lease).toMatchObject({ role: 'sentinel', generation: 2, holder: 'm_alpha' });
    expect(alpha.holds(a.lease, { allowExpired: true })).toBe(false); // the old hand is fenced
    expect(alpha.holds(h.lease)).toBe(true);
  });

  it('handover is refused for a lock this machine does not hold at that generation', () => {
    const a = alpha.acquire('141133', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    expect(beta.handover(a.lease, 'sentinel')).toMatchObject({ ok: false, reason: 'not-held-by-caller' }); // another machine
    expect(alpha.handover({ ...a.lease, generation: 5 }, 'sentinel')).toMatchObject({ ok: false }); // wrong generation
    const renewed = alpha.renew(a.lease)!;
    expect(alpha.handover(a.lease, 'sentinel')).toMatchObject({ ok: false, reason: 'not-held-by-caller' }); // a stale copy of the record
    expect(alpha.handover(renewed, 'sentinel').ok).toBe(true);
  });

  it('release writes a signed tombstone at the next generation; the floor never goes down', () => {
    const a = alpha.acquire('141133', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    expect(alpha.release(a.lease)).toBe(true);
    const v = alpha.read('141133');
    expect(v).toMatchObject({ generation: 2, lease: { released: true } });
    const b = beta.acquire('141133', 'coordinator');
    expect(b.ok && b.lease.generation).toBe(3);
  });

  it('a forged or replayed file does not count as held, and cannot lower the floor', () => {
    const a = alpha.acquire('141133', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    const file = path.join(dir, '141133.json');
    fs.writeFileSync(file, JSON.stringify({ lease: { ...a.lease, holder: 'm_beta' } })); // forged holder name
    expect(beta.holds({ ...a.lease, holder: 'm_beta' })).toBe(false);
    const r = beta.acquire('141133', 'coordinator'); // not live (fails verification) ⇒ acquirable, and only upward
    expect(r.ok && r.lease.generation).toBe(2);
    const store = new LocalKeyedLeaseStore(dir);
    expect(store.casWrite(a.lease).ok).toBe(false); // replaying generation 1 is refused
  });

  it('refuses an unsafe key on every method, never throws', () => {
    expect(alpha.acquire('../etc', 'coordinator')).toEqual({ ok: false, reason: 'bad-key' });
    const fake = fencedFor('m_alpha').signKeyedLease({ key: '../etc', role: 'coordinator', generation: 1, acquiredAt: 'x', expiresAt: 'y', nonce: 1 });
    expect(alpha.holds(fake)).toBe(false);
    expect(alpha.renew(fake)).toBeNull();
    expect(alpha.release(fake)).toBe(false);
    expect(alpha.handover(fake, 'sentinel')).toMatchObject({ ok: false, reason: 'bad-key' });
    expect(alpha.read('../etc')).toEqual({ lease: null, generation: 0 });
  });

  it('fencing pins the exact record: same holder with only the role, or only the generation, wrong fails', () => {
    const a = alpha.acquire('141133', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    const f = fencedFor('m_alpha');
    const wrongRole = f.signKeyedLease({ ...a.lease, role: 'sentinel' });
    const wrongGen = f.signKeyedLease({ ...a.lease, generation: 2 });
    expect(alpha.holds(wrongRole, { allowExpired: true })).toBe(false);
    expect(alpha.holds(wrongGen, { allowExpired: true })).toBe(false);
    // Two hands with the SAME role and generation but different signed records cannot both pass.
    const twin = f.signKeyedLease({ ...a.lease, nonce: a.lease.nonce + 1 });
    expect(alpha.holds(twin, { allowExpired: true })).toBe(false);
    expect(alpha.holds(a.lease)).toBe(true);
  });

  it('a lost or torn lease file cannot let a generation be reused (floor file)', () => {
    const a = alpha.acquire('141133', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    fs.writeFileSync(path.join(dir, '141133.json'), '{"lease": {torn');
    const b = beta.acquire('141133', 'coordinator');
    expect(b.ok && b.lease.generation).toBe(2);
    expect(alpha.holds(a.lease, { allowExpired: true })).toBe(false);
  });

  it('a forged MAX_SAFE_INTEGER generation is not a floor either', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '556.floor'), String(Number.MAX_SAFE_INTEGER));
    const r = alpha.acquire('556', 'coordinator');
    expect(r.ok && r.lease.generation).toBe(1);
  });

  it('a forged unbounded generation is not a floor (the key stays usable)', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '555.json'), JSON.stringify({ lease: { key: '555', holder: 'm_beta', role: 'coordinator', generation: 1e308, acquiredAt: 'x', expiresAt: 'y', nonce: 1, signature: 'z' } }));
    const r = alpha.acquire('555', 'coordinator');
    expect(r.ok && r.lease.generation).toBe(1);
  });

  it("a non-boolean 'released' never verifies and never reads as free", () => {
    const a = alpha.acquire('141133', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    const f = fencedFor('m_alpha');
    expect(f.verifyKeyedLease({ ...a.lease, released: 1 as unknown as true })).toBe(false);
    fs.writeFileSync(path.join(dir, '141133.json'), JSON.stringify({ lease: { ...a.lease, released: 1 } }));
    // The doctored record does not verify, so it is neither held by alpha nor a valid tombstone; the floor still holds.
    const b = beta.acquire('141133', 'coordinator');
    expect(b.ok && b.lease.generation).toBe(2);
  });

  it('the store lock serialises writers: a held lock file blocks a CAS, a stale one is broken', () => {
    const store = new LocalKeyedLeaseStore(dir);
    fs.mkdirSync(dir, { recursive: true });
    const lf = path.join(dir, '777.lock');
    fs.writeFileSync(lf, '99999');
    const cand = fencedFor('m_alpha').signKeyedLease({ key: '777', role: 'coordinator', generation: 1, acquiredAt: 'a', expiresAt: 'b', nonce: 1 });
    expect(store.casWrite(cand).ok).toBe(false); // a live writer holds it: refuse, never throw or wait
    fs.utimesSync(lf, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(store.casWrite(cand).ok).toBe(true);
    expect(fs.existsSync(lf)).toBe(false);
  });
});

describe('GitKeyedLeaseStore (git medium)', () => {
  let dir: string;
  let pushes: string[][];
  let pushOk: boolean;
  let reverted: string[];
  let pulls: number;
  let committed: Map<string, string>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyed-lease-git-'));
    pushes = []; reverted = []; pulls = 0; pushOk = true; committed = new Map();
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }));

  const store = () => new GitKeyedLeaseStore({
    dir,
    pullRebase: () => { pulls += 1; return true; },
    commitAndPush: (_m, paths) => {
      pushes.push(paths);
      if (pushOk) for (const p of paths) committed.set(p, fs.readFileSync(p, 'utf-8'));
      return pushOk;
    },
    revertPath: (p) => {
      reverted.push(p);
      const c = committed.get(p);
      if (c === undefined) SafeFsExecutor.safeRmSync(p, { force: true, operation: OP });
      else fs.writeFileSync(p, c);
    },
  });

  it('CAS pushes per step: acquire and renew each commit-and-push the one lock file', () => {
    const lock = new KeyedLeaseLock({ fenced: fencedFor('m_alpha'), store: store(), ttlMs: 60_000 });
    const a = lock.acquire('141133', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    expect(lock.renew(a.lease)).not.toBeNull();
    // Acquire pushes the lease and its floor; renewal pushes the lease only.
    expect(pushes).toEqual([[path.join(dir, '141133.json'), path.join(dir, '141133.floor')], [path.join(dir, '141133.json')]]);
    expect(pulls).toBeGreaterThan(0);
  });

  it('a rejected push loses the CAS and reverts the local write (no split authority)', () => {
    pushOk = false;
    const lock = new KeyedLeaseLock({ fenced: fencedFor('m_alpha'), store: store(), ttlMs: 60_000 });
    expect(lock.acquire('141133', 'coordinator')).toMatchObject({ ok: false, reason: 'cas-lost' });
    expect(reverted).toEqual([path.join(dir, '141133.json'), path.join(dir, '141133.floor')]);
    expect(lock.read('141133').lease).toBeNull();
  });

  it('a rejected renewal reports the lock as lost', () => {
    const lock = new KeyedLeaseLock({ fenced: fencedFor('m_alpha'), store: store(), ttlMs: 60_000 });
    const a = lock.acquire('141133', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    pushOk = false;
    expect(lock.renew(a.lease)).toBeNull();
  });
});
