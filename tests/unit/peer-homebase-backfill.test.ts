/**
 * Unit tier for the homebase BACKFILL (peer-conversation-homebase-topic §6, now built):
 * a peer paired before homebases existed gets one on contact or on the boot sweep.
 */
import { describe, it, expect } from 'vitest';
import { PeerHomebaseBackfill, type BackfillPeer } from '../../src/threadline/peerHomebaseBackfill.js';
import { peerHomebaseEnabled } from '../../src/threadline/peerHomebase.js';

const PP: BackfillPeer = { fingerprint: 'abcdef0123456789', name: 'pp' };

function harness(over: Partial<ConstructorParameters<typeof PeerHomebaseBackfill>[0]> = {}) {
  const recorded = new Map<string, number>();
  const calls: string[] = [];
  let clock = 1_000;
  let failNext = false;
  const peers = new Map<string, BackfillPeer>([[PP.fingerprint, PP], [PP.name, PP]]);
  const b = new PeerHomebaseBackfill({
    enabled: () => true,
    holdsLease: () => true,
    resolveMutualVerified: (k) => peers.get(k) ?? null,
    listMutualVerified: () => [PP],
    findOrCreateTopic: async (name) => {
      calls.push(name);
      if (failNext) { failNext = false; throw new Error('telegram down'); }
      return { topicId: 777, reused: false };
    },
    getRecorded: (fp) => recorded.get(fp),
    record: (fp, id) => { recorded.set(fp, id); return true; },
    now: () => clock,
    ...over,
  });
  return {
    b, recorded, calls,
    tick: (ms: number) => { clock += ms; },
    failOnce: () => { failNext = true; },
  };
}

describe('PeerHomebaseBackfill', () => {
  it('contact with a mutual-verified peer that has no homebase CREATES and records one', async () => {
    const h = harness();
    const r = await h.b.ensureFor(PP.fingerprint);
    expect(r).toEqual({ created: true, topicId: 777, reused: false });
    expect(h.calls).toEqual(['🤝 pp']);
    expect(h.recorded.get(PP.fingerprint)).toBe(777);
  });

  it('resolves a NAME to the peer (paths that only know the sender name)', async () => {
    const h = harness();
    await h.b.ensureFor('pp');
    expect(h.recorded.get(PP.fingerprint)).toBe(777);
  });

  it('a peer that already has a homebase costs no Telegram call', async () => {
    const h = harness();
    h.recorded.set(PP.fingerprint, 5);
    expect(await h.b.ensureFor(PP.fingerprint)).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('a peer that is NOT mutual-verified never gets a topic (a stranger cannot cause one)', async () => {
    const h = harness();
    expect(await h.b.ensureFor('stranger-fp')).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('a standby (not lease holder) creates nothing', async () => {
    const h = harness({ holdsLease: () => false });
    expect(await h.b.ensureFor(PP.fingerprint)).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('disabled creates nothing', async () => {
    const h = harness({ enabled: () => false });
    expect(await h.b.ensureFor(PP.fingerprint)).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('concurrent contacts share ONE creation (no duplicate topic)', async () => {
    const h = harness();
    await Promise.all([h.b.ensureFor(PP.fingerprint), h.b.ensureFor(PP.fingerprint), h.b.ensureFor('pp')]);
    expect(h.calls).toHaveLength(1);
  });

  it('a failed creation waits out the retry window, then retries', async () => {
    const h = harness();
    h.failOnce();
    expect(await h.b.ensureFor(PP.fingerprint)).toEqual({ created: false, reason: 'create-failed' });
    expect(await h.b.ensureFor(PP.fingerprint)).toBeNull(); // inside the quiet period
    expect(h.calls).toHaveLength(1);
    h.tick(10 * 60_000);
    expect(await h.b.ensureFor(PP.fingerprint)).toEqual({ created: true, topicId: 777, reused: false });
    expect(h.calls).toHaveLength(2);
  });

  it('sweep covers every mutual-verified peer, including one that never messages', async () => {
    const h = harness();
    const out = await h.b.sweep();
    expect(out).toEqual([{ fingerprint: PP.fingerprint, result: { created: true, topicId: 777, reused: false } }]);
  });

  it('onContact never throws, even when a dependency does', () => {
    const h = harness({ resolveMutualVerified: () => { throw new Error('boom'); } });
    expect(() => h.b.onContact(PP.fingerprint)).not.toThrow();
    expect(() => h.b.onContact(undefined)).not.toThrow();
  });
});

describe('peerHomebaseEnabled — default ON, explicit false is the off switch', () => {
  it('absent config → on (fleet builds included, not just a dev agent)', () => {
    expect(peerHomebaseEnabled({})).toBe(true);
    expect(peerHomebaseEnabled(undefined)).toBe(true);
    expect(peerHomebaseEnabled({ threadline: {} })).toBe(true);
  });
  it('explicit false → off; explicit true → on', () => {
    expect(peerHomebaseEnabled({ threadline: { peerHomebase: { enabled: false } } })).toBe(false);
    expect(peerHomebaseEnabled({ threadline: { peerHomebase: { enabled: true } } })).toBe(true);
  });
});
