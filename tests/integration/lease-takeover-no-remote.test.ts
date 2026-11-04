/**
 * Two real coordinators, real git repos with no remote, one machine stopped
 * (docs/specs/lease-takeover-no-shared-medium.md). The peers talk over an in-process link
 * that can be cut; the stores, signatures and git commits are real.
 */

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseStore, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { GitLeaseStore } from '../../src/core/GitLeaseStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import type { LeaseRecord, MachineRegistry } from '../../src/core/types.js';

const TTL = 60_000;
const FAILOVER = 15 * 60_000;
const KEYS: Record<string, { publicKey: string; privateKey: string }> = Object.fromEntries(['A', 'B'].map((id) => [id,
  crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })]));
function crypt(self: string): LeaseCrypto {
  return {
    selfMachineId: self,
    sign: (c) => crypto.sign(null, Buffer.from(c), KEYS[self].privateKey).toString('base64'),
    verify: (c, sig, holder) => {
      const pub = KEYS[holder]?.publicKey;
      if (!pub) return false;
      try { return crypto.verify(null, Buffer.from(c), pub, Buffer.from(sig, 'base64')); } catch { return false; }
    },
  };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/lease-takeover-no-remote.test.ts:cleanup' }); });

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    const out = SafeGitExecutor.run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd, operation: 'tests/integration/lease-takeover-no-remote.test.ts:git', stdio: 'pipe' });
    return { ok: true, out: out ?? '' };
  } catch {
    return { ok: false, out: '' }; // a failed push is the case under test
  }
}

function gitStore(self: string, peer: string): { store: LeaseStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lease-${self}-`));
  dirs.push(dir);
  git(dir, 'init', '-q');
  const file = path.join(dir, 'registry.json');
  fs.writeFileSync(file, JSON.stringify({ machines: { [self]: {}, [peer]: {} } }));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'seed');
  const store = new GitLeaseStore({
    machineId: self,
    loadRegistry: () => JSON.parse(fs.readFileSync(file, 'utf-8')) as MachineRegistry,
    saveRegistry: (r) => fs.writeFileSync(file, JSON.stringify(r)),
    registryAbsPath: file,
    pullRebase: () => git(dir, 'pull', '--rebase').ok,
    commitAndPush: (msg, paths) => {
      git(dir, 'add', ...paths);
      if (!git(dir, 'commit', '-qm', msg).ok) return false;
      return git(dir, 'push').ok; // no remote: always fails, as in the real pair
    },
    localCommitIsFinal: () => git(dir, 'remote').out.trim() === '',
  });
  return { store, dir };
}

class Link {
  cut = false;
  nodes = new Map<string, { seen: LeaseRecord | null }>();
  transport(self: string): LeaseTransport {
    const me = { seen: null as LeaseRecord | null };
    this.nodes.set(self, me);
    return {
      broadcast: async (lease) => {
        if (this.cut) return false;
        let reached = false;
        for (const [id, node] of this.nodes) if (id !== self) { node.seen = lease; reached = true; }
        return reached;
      },
      observed: () => ({ lease: me.seen, lastNonceByHolder: me.seen ? { [me.seen.holder]: me.seen.nonce } : {} }),
      isReachable: () => !this.cut,
    };
  }
}

function pair(storeA: LeaseStore, storeB: LeaseStore) {
  const clock = { mono: 1_000, wall: 1_000_000 };
  const link = new Link();
  const make = (self: string, store: LeaseStore) => new LeaseCoordinator({
    lease: new FencedLease(crypt(self), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER }),
    store,
    tunnel: link.transport(self),
    presumedDeadHolders: () => new Set(),
    now: () => clock.wall,
    monotonicNow: () => clock.mono,
    soloCaptainHold: () => ({ enabled: true }),
    survivorMayHold: () => true,
  });
  const a = make('A', storeA);
  const b = make('B', storeB);
  return { a, b, link, advance: (ms: number) => { clock.mono += ms; clock.wall += ms; } };
}

async function thirtyMinutes(p: ReturnType<typeof pair>, tick: (() => Promise<unknown>)[], check: () => void) {
  for (let i = 0; i < 60; i++) {
    p.advance(30_000);
    for (const t of tick) await t();
    check();
  }
}

describe('takeover with no git remote', () => {
  const kinds = {
    'git and git': () => [gitStore('A', 'B').store, gitStore('B', 'A').store],
    'local and git (the pair in topic 136880)': () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-local-'));
      dirs.push(dir);
      return [new LocalLeaseStore({ filePath: path.join(dir, 'lease.json') }), gitStore('B', 'A').store];
    },
  } as const;

  for (const [name, stores] of Object.entries(kinds)) {
    it(`${name}: the main machine stops, the standby takes over once and keeps it for 30 minutes`, async () => {
      const [sa, sb] = stores();
      const p = pair(sa, sb);
      expect(await p.a.acquireIfEligible()).toBe(true);
      await p.b.acquireIfEligible();
      expect(p.a.holdsLease()).toBe(true);
      expect(p.b.holdsLease()).toBe(false);
      const startEpoch = p.a.currentEpoch();

      p.link.cut = true; // A is gone: nothing reaches B, and A no longer ticks
      p.advance(TTL + 1_000);
      expect(await p.b.acquireIfEligible()).toBe(true);
      const taken = p.b.currentEpoch();
      expect(taken).toBe(startEpoch + 1);

      await thirtyMinutes(p, [() => p.b.acquireIfEligible()], () => expect(p.b.holdsLease()).toBe(true));
      expect(p.b.currentEpoch()).toBe(taken);
    });

    it(`${name}: the standby stops, the main machine carries on with no gap`, async () => {
      const [sa, sb] = stores();
      const p = pair(sa, sb);
      await p.a.acquireIfEligible();
      const epoch = p.a.currentEpoch();
      p.link.cut = true;
      await thirtyMinutes(p, [() => p.a.acquireIfEligible()], () => expect(p.a.holdsLease()).toBe(true));
      expect(p.a.currentEpoch()).toBe(epoch);
    });

    it(`${name}: a link cut heals to one holder, the newer epoch`, async () => {
      const [sa, sb] = stores();
      const p = pair(sa, sb);
      await p.a.acquireIfEligible();
      await p.b.acquireIfEligible();
      const heldAt = p.a.currentEpoch();
      p.link.cut = true;
      // Real ticks, 30 s apart: the holder renews inside its lease, so it never lapses.
      await thirtyMinutes(p, [() => p.a.acquireIfEligible(), () => p.b.acquireIfEligible()], () => {
        expect(p.a.holdsLease()).toBe(true);
      });
      expect(p.b.holdsLease()).toBe(true); // both believe: the stated cost of a cut
      expect(p.a.currentEpoch()).toBe(heldAt); // the old holder never climbs,
      expect(p.b.currentEpoch()).toBe(heldAt + 1); // so reconnect is not a tie

      p.link.cut = false;
      p.advance(30_000);
      await p.b.acquireIfEligible(); // B renews: A now sees the higher epoch
      await p.a.acquireIfEligible();
      expect(p.b.holdsLease()).toBe(true);
      expect(p.a.holdsLease()).toBe(false);
      expect(p.a.currentHolder()).toBe('B');
    });
  }

  it('a same-epoch tie on git resolves through the real contested path, signatures included', async () => {
    const p = pair(gitStore('A', 'B').store, gitStore('B', 'A').store);
    p.link.cut = true;
    await p.a.acquireIfEligible();
    await p.b.acquireIfEligible(); // both took epoch 1 unseen: as after a restart during a cut
    expect(p.a.currentEpoch()).toBe(p.b.currentEpoch());
    p.link.cut = false;
    p.b.relinquish(); // the tie-break: lower machine id wins
    expect(p.b.holdsLease()).toBe(false);
    expect(await p.a.advanceEpochForContestedWin()).toBe(true);
    expect(p.a.holdsLease()).toBe(true);
    expect(p.b.currentHolder()).toBe('A');
    expect(p.b.currentEpoch()).toBe(p.a.currentEpoch());
    expect(p.b.holdsLease()).toBe(false);
  });

  it('the takeover really is a local commit', async () => {
    const b = gitStore('B', 'A');
    const a = gitStore('A', 'B');
    const p = pair(a.store, b.store);
    await p.a.acquireIfEligible();
    await p.b.acquireIfEligible();
    p.link.cut = true;
    p.advance(TTL + 1_000);
    await p.b.acquireIfEligible();
    expect(git(b.dir, 'log', '--oneline').out).toMatch(/lease epoch 2/);
  });
});
