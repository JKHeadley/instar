// safe-git-allow: integration test for the keyed fold lease's git medium; direct git usage builds a real bare remote and two clones and implements the store's injected pull/commit/push/revert seams.
/**
 * context-budget-layered-summaries §14 "Fold lock" / §18: the keyed fenced
 * lease on the `git` medium, over a REAL git remote with two machine clones
 * and real Ed25519 keys. CAS push per step; a lost race is a rejected push,
 * reverted locally; the loser sees the winner after its pull. Also records
 * the per-step push cost on this machine (§14: "measured in Phase 0").
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { KeyedLeaseLock, GitKeyedLeaseStore } from '../../src/core/KeyedLease.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/keyed-lease-git-medium.test.ts';
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const tryGit = (cwd: string, ...args: string[]) => { try { git(cwd, ...args); return true; } catch { return false; } };

const keys: Record<string, { pub: crypto.KeyObject; priv: crypto.KeyObject }> = {};
for (const m of ['m_one', 'm_two']) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  keys[m] = { pub: publicKey, priv: privateKey };
}
const cryptoFor = (self: string): LeaseCrypto => ({
  selfMachineId: self,
  sign: (c) => crypto.sign(null, Buffer.from(c), keys[self].priv).toString('base64'),
  verify: (c, s, h) => { const k = keys[h]; if (!k) return false; try { return crypto.verify(null, Buffer.from(c), k.pub, Buffer.from(s, 'base64')); } catch { return false; } },
});

describe('keyed fold lease — git medium over a real remote', () => {
  let root: string;
  let clones: Record<string, string>;

  const storeFor = (clone: string) => new GitKeyedLeaseStore({
    dir: path.join(clone, 'fold-leases'),
    pullRebase: () => tryGit(clone, 'pull', '--rebase', '--quiet', 'origin', 'main'),
    commitAndPush: (msg, paths) => {
      if (!tryGit(clone, 'add', ...paths)) return false;
      if (!tryGit(clone, 'commit', '--quiet', '-m', msg)) return false;
      if (tryGit(clone, 'push', '--quiet', 'origin', 'HEAD:main')) return true;
      git(clone, 'reset', '--quiet', '--hard', 'origin/main'); // drop the local commit we could not push
      return false;
    },
    revertPath: (p) => {
      if (!tryGit(clone, 'checkout', '--quiet', 'origin/main', '--', p)) {
        SafeFsExecutor.safeRmSync(p, { force: true, operation: OP });
      }
    },
  });
  const lockFor = (m: string) => new KeyedLeaseLock({
    fenced: new FencedLease(cryptoFor(m), { leaseTtlMs: 60_000, failoverThresholdMs: 120_000 }),
    store: storeFor(clones[m]), ttlMs: 60_000,
  });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'keyed-lease-gitint-'));
    const bare = path.join(root, 'remote.git');
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
    const seed = path.join(root, 'seed');
    git(root, 'clone', '--quiet', bare, seed);
    git(seed, 'config', 'user.email', 'itest@instar.local'); git(seed, 'config', 'user.name', 'itest');
    fs.writeFileSync(path.join(seed, 'README'), 'seed\n');
    git(seed, 'add', 'README'); git(seed, 'commit', '--quiet', '-m', 'seed'); git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
    clones = {};
    for (const m of ['m_one', 'm_two']) {
      const c = path.join(root, m);
      git(root, 'clone', '--quiet', bare, c);
      git(c, 'config', 'user.email', `${m}@instar.local`); git(c, 'config', 'user.name', m);
      clones[m] = c;
    }
  });
  afterAll(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP }));

  it('one machine acquires; the other, after its pull, sees the lock held and is refused', () => {
    const one = lockFor('m_one');
    const two = lockFor('m_two');
    const t0 = Date.now();
    const a = one.acquire('141133', 'coordinator');
    const acquireMs = Date.now() - t0;
    expect(a.ok).toBe(true);
    expect(two.acquire('141133', 'coordinator')).toMatchObject({ ok: false, reason: 'held', holder: { holder: 'm_one', generation: 1 } });
    // Phase 0 measurement (§14): one CAS step on the git medium, local bare remote.
    console.log(`[keyed-lease git medium] acquire (pull + write + commit + push) took ${acquireMs} ms`);
    expect(acquireMs).toBeLessThan(30_000);
  });

  it('a race on a stale view loses at push time, reverts, and then observes the winner', () => {
    const one = lockFor('m_one');
    const two = lockFor('m_two');
    const t = Date.now();
    const winner = one.acquire('130715', 'coordinator');
    expect(winner.ok).toBe(true);
    // m_two's store pulls before its CAS, so it sees generation 1 and refuses.
    const r = two.acquire('130715', 'coordinator');
    expect(r).toMatchObject({ ok: false, reason: 'held' });
    // Simulate the true lost race: m_two's pull fails (offline), it writes gen 1 locally, the push is rejected.
    const offline = new KeyedLeaseLock({
      fenced: new FencedLease(cryptoFor('m_two'), { leaseTtlMs: 60_000, failoverThresholdMs: 120_000 }),
      ttlMs: 60_000,
      store: new GitKeyedLeaseStore({
        dir: path.join(clones.m_two, 'fold-leases'),
        pullRebase: () => false,
        commitAndPush: (msg, paths) => {
          git(clones.m_two, 'add', ...paths); git(clones.m_two, 'commit', '--quiet', '-m', msg);
          if (tryGit(clones.m_two, 'push', '--quiet', 'origin', 'HEAD:main')) return true;
          git(clones.m_two, 'reset', '--quiet', '--hard', 'HEAD~1');
          return false;
        },
        revertPath: (p) => { if (!tryGit(clones.m_two, 'checkout', '--quiet', 'HEAD', '--', p)) SafeFsExecutor.safeRmSync(p, { force: true, operation: OP }); },
      }),
    });
    // Rewind m_two's view of this key so it believes the lock is free.
    git(clones.m_two, 'reset', '--quiet', '--hard', 'HEAD~1');
    expect(fs.existsSync(path.join(clones.m_two, 'fold-leases', '130715.json'))).toBe(false);
    expect(offline.acquire('130715', 'coordinator')).toMatchObject({ ok: false, reason: 'cas-lost' });
    expect(fs.existsSync(path.join(clones.m_two, 'fold-leases', '130715.json'))).toBe(false); // reverted
    // Back online: m_two observes m_one's lock.
    const back = lockFor('m_two');
    expect(back.read('130715')).toMatchObject({ generation: 1, lease: { holder: 'm_one' } });
    expect(Date.now() - t).toBeLessThan(60_000);
  });

  it('release on one machine lets the other acquire at the next generation', () => {
    const one = lockFor('m_one');
    const two = lockFor('m_two');
    const a = one.acquire('100001', 'coordinator');
    if (!a.ok) throw new Error('acquire failed');
    expect(one.release(a.lease)).toBe(true);
    const b = two.acquire('100001', 'coordinator');
    expect(b.ok && b.lease.generation).toBe(3);
  });
});
