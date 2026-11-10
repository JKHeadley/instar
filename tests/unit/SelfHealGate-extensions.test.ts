// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * The four SelfHealGate extensions the context budget needs
 * (context-budget-layered-summaries §9.4 "Each ladder is a SelfHealGate
 * declaration"): a pool-shared controller that REFUSES off-owner, async
 * remediation, per-incident keys with bounded pruning, and a per-group ring.
 * All opt-in: a spec or store without them behaves exactly as before.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySelfHealEpisodeStore, SelfHealGate, SqliteSelfHealEpisodeStore, type SelfHealEpisodeRecord, type SelfHealSpec, type SelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'SelfHealGate-extensions.test cleanup' }); });

type Ctx = { topic: string; cause: string; incident: string; owner?: boolean | 'unknown' | 'throw' };
const base = (over: Partial<SelfHealSpec<Ctx>> = {}): SelfHealSpec<Ctx> => ({
  id: 'cb-ladder', controllerResource: 'pool-shared', episodeAuthority: 'durable-machine-local', classId: 'cb',
  severity: () => 'recoverable', dedupeKey: (c) => `m1-${c.topic}-${c.cause}-${c.incident}`, eligible: () => ({ eligible: true, fence: 'f1' }),
  isOwner: (c) => { if (c.owner === 'throw') throw new Error('x'); return c.owner ?? true; },
  remediation: () => ({ outcome: 'healed', evidence: 'repaired' }),
  maxAttempts: 3, maxWallClockMs: 60_000, backoffMs: () => 0, notificationLatencyCeilingMs: 60_000, flap: { maxRecoveries: 10, windowMs: 60_000 },
  remediationActions: { operation: 'test', idempotencyGuard: 'fold-record CAS', compensation: 'none' },
  ...over,
});
function deps(store: SelfHealEpisodeStore = new InMemorySelfHealEpisodeStore()) {
  let n = 0;
  return {
    admit: vi.fn(async () => ({ outcome: 'allow' as const, token: { id: `t${++n}` } as AdmissionToken, reason: 'admitted' as const })),
    consumeToken: vi.fn(() => ({ proceed: true, valid: true })), notify: vi.fn(), audit: vi.fn(), episodeStore: store, bootId: 'b1',
  };
}
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ topic: '141133', cause: 'stage-failed', incident: 'i1', ...over });

describe('extension 1 — pool-shared controller refuses off-owner', () => {
  it('a pool-shared spec without isOwner is refused at construction; hardware-bound needs none', () => {
    expect(() => new SelfHealGate(base({ isOwner: undefined }), deps())).toThrow(/requires isOwner/);
    expect(() => new SelfHealGate(base({ controllerResource: 'hardware-bound', isOwner: undefined }), deps())).not.toThrow();
  });

  it.each([false, 'unknown', 'throw'] as const)('owner=%s: governed not-owner, no episode, no remediation, no admission', async (owner) => {
    const remediation = vi.fn(() => ({ outcome: 'healed', evidence: 'repaired' } as const));
    const store = new InMemorySelfHealEpisodeStore(); const d = deps(store);
    const r = await new SelfHealGate(base({ remediation }), d).attempt(ctx({ owner }));
    expect(r).toEqual({ outcome: 'governed', reason: 'not-owner' });
    expect(remediation).not.toHaveBeenCalled(); expect(d.admit).not.toHaveBeenCalled();
    expect(store.load('cb-ladder:m1-141133-stage-failed-i1')).toBeNull();
    expect(new SelfHealGate(base(), d).recordHealthy(ctx({ owner }))).toEqual({ outcome: 'governed', reason: 'not-owner' });
  });

  it('ownership lost after the first check: refused at the start of the admitted run', async () => {
    let calls = 0;
    const remediation = vi.fn(() => ({ outcome: 'healed', evidence: 'repaired' } as const));
    const g = new SelfHealGate(base({ remediation, isOwner: () => ++calls < 2 }), deps());
    expect(await g.attempt(ctx())).toEqual({ outcome: 'governed', reason: 'not-owner' });
    expect(remediation).not.toHaveBeenCalled();
  });

  it('ownership lost at the very claim: refused inside the atomic claim', async () => {
    let calls = 0;
    const remediation = vi.fn(() => ({ outcome: 'healed', evidence: 'repaired' } as const));
    const g = new SelfHealGate(base({ remediation, isOwner: () => ++calls < 3 }), deps());
    expect(await g.attempt(ctx())).toMatchObject({ outcome: 'governed', reason: 'fence-stale-or-revision-conflict' });
    expect(remediation).not.toHaveBeenCalled();
  });

  it('a QUEUED admission that fires after ownership moved touches nothing and sends no notice', async () => {
    let owner = true; let fire!: (t: AdmissionToken) => void;
    const store = new InMemorySelfHealEpisodeStore(); const d = deps(store);
    let eligibleSeen: (() => boolean) | null = null;
    d.admit = vi.fn(async (_t: unknown, o: { eligible: () => boolean; onAdmitted: (t: AdmissionToken) => void }) => { eligibleSeen = o.eligible; fire = o.onAdmitted; return { outcome: 'queue' as const, reason: 'queued' } as never; }) as never;
    const remediation = vi.fn(() => ({ outcome: 'healed', evidence: 'repaired' } as const));
    const g = new SelfHealGate(base({ remediation, isOwner: () => owner }), d);
    expect(await g.attempt(ctx())).toMatchObject({ outcome: 'governed' });
    const before = store.load('cb-ladder:m1-141133-stage-failed-i1')!;
    owner = false;
    expect(eligibleSeen!()).toBe(false); // the governor's own re-check sees the move
    fire({ id: 'late' } as AdmissionToken);
    await new Promise((r) => setTimeout(r, 10));
    expect(store.load('cb-ladder:m1-141133-stage-failed-i1')!.revision).toBe(before.revision);
    expect(remediation).not.toHaveBeenCalled(); expect(d.notify).not.toHaveBeenCalled();
  });

  it('on the owner it remediates as before', async () => {
    expect(await new SelfHealGate(base(), deps()).attempt(ctx())).toMatchObject({ outcome: 'healed' });
  });
});

describe('extension 2 — async remediation', () => {
  const asyncSpec = (fn: () => Promise<{ outcome: 'healed' | 'not-healed' | 'pending-restart'; evidence: 'repaired' | 'verification-failed' }>, ms = 1_000) =>
    base({ remediation: undefined, remediationMode: 'async', remediationAsync: fn, maxRemediationMs: ms });

  it('construction requires remediationAsync and a positive bound; sync still requires remediation', () => {
    expect(() => new SelfHealGate(base({ remediationMode: 'async', remediation: undefined }), deps())).toThrow(/remediationAsync/);
    expect(() => new SelfHealGate(base({ remediationMode: 'async', remediation: undefined, remediationAsync: async () => ({ outcome: 'healed', evidence: 'repaired' }) }), deps())).toThrow(/maxRemediationMs/);
    expect(() => new SelfHealGate(base({ remediation: undefined }), deps())).toThrow(/requires remediation/);
  });

  it('an awaited heal closes the episode', async () => {
    expect(await new SelfHealGate(asyncSpec(async () => { await new Promise((r) => setTimeout(r, 5)); return { outcome: 'healed', evidence: 'repaired' }; }), deps()).attempt(ctx()))
      .toMatchObject({ outcome: 'healed', reason: 'repaired' });
  });

  it('a timeout is not-healed (remediation-timeout) and counts as an attempt; a rejection is io-error', async () => {
    const store = new InMemorySelfHealEpisodeStore();
    const slow = new SelfHealGate(asyncSpec(() => new Promise(() => { /* never settles */ }), 20), deps(store));
    expect(await slow.attempt(ctx())).toMatchObject({ outcome: 'attempted', reason: 'remediation-timeout' });
    expect(store.load('cb-ladder:m1-141133-stage-failed-i1')?.attempts).toBe(1);
    expect(await new SelfHealGate(asyncSpec(async () => { throw new Error('boom'); }), deps()).attempt(ctx({ incident: 'i2' })))
      .toMatchObject({ outcome: 'attempted', reason: 'io-error' });
  });

  it('a malformed async result is not-healed', async () => {
    expect(await new SelfHealGate(asyncSpec(async () => ({ outcome: 'weird' } as never)), deps()).attempt(ctx())).toMatchObject({ outcome: 'attempted', reason: 'io-error' });
  });

  it('one remediation per key in flight: a concurrent attempt is busy and never runs a second remediation', async () => {
    let release!: () => void; const gateOpen = new Promise<void>((r) => { release = r; });
    const fn = vi.fn(async () => { await gateOpen; return { outcome: 'healed' as const, evidence: 'repaired' as const }; });
    const g = new SelfHealGate(asyncSpec(fn, 5_000), deps());
    const first = g.attempt(ctx());
    await new Promise((r) => setTimeout(r, 5));
    expect(await g.attempt(ctx())).toEqual({ outcome: 'busy', reason: 'remediation-in-flight' });
    release();
    expect(await first).toMatchObject({ outcome: 'healed' });
    expect(fn).toHaveBeenCalledTimes(1);
    // A different incident is a different key: not blocked.
    expect(await g.attempt(ctx({ incident: 'i9' }))).toMatchObject({ outcome: 'healed' });
  });

  it('maxRemediationMs may not exceed the wall clock (nor overflow setTimeout)', () => {
    expect(() => new SelfHealGate(asyncSpec(async () => ({ outcome: 'healed', evidence: 'repaired' }), 2 ** 31), deps())).toThrow(/maxWallClockMs/);
    expect(() => new SelfHealGate(asyncSpec(async () => ({ outcome: 'healed', evidence: 'repaired' }), 60_001), deps())).toThrow(/maxWallClockMs/);
  });

  it('a timed-out remediation still RUNNING keeps the key in flight; once it settles the next attempt proceeds', async () => {
    let finish!: () => void; const slow = new Promise<void>((r) => { finish = r; });
    let calls = 0;
    const g = new SelfHealGate(asyncSpec(async () => { calls++; if (calls === 1) { await slow; } return { outcome: 'not-healed', evidence: 'verification-failed' }; }, 20), deps());
    expect(await g.attempt(ctx())).toMatchObject({ outcome: 'attempted', reason: 'remediation-timeout' });
    expect(await g.attempt(ctx())).toEqual({ outcome: 'busy', reason: 'remediation-in-flight' });
    expect(calls).toBe(1);
    finish(); await new Promise((r) => setTimeout(r, 5));
    expect(await g.attempt(ctx())).toMatchObject({ outcome: 'attempted', reason: 'verification-failed' });
    expect(calls).toBe(2);
  });

  it('ownership lost DURING the await: governed not-owner, nothing recorded as healed', async () => {
    let owner = true; const store = new InMemorySelfHealEpisodeStore();
    const g = new SelfHealGate(base({ remediation: undefined, remediationMode: 'async', maxRemediationMs: 1_000, isOwner: () => owner,
      remediationAsync: async () => { owner = false; return { outcome: 'healed', evidence: 'repaired' }; } }), deps(store));
    expect(await g.attempt(ctx())).toMatchObject({ outcome: 'governed', reason: 'not-owner' });
    expect(store.load('cb-ladder:m1-141133-stage-failed-i1')).toMatchObject({ status: 'active', recoveries: [] });
  });

  it('the sync path still refuses a returned promise', async () => {
    const r = await new SelfHealGate(base({ remediation: (() => Promise.resolve({ outcome: 'healed', evidence: 'repaired' })) as never }), deps()).attempt(ctx());
    expect(r).toMatchObject({ outcome: 'attempted', reason: 'io-error' });
  });
});

const row = (key: string, status: SelfHealEpisodeRecord['status'], updatedAt: number): SelfHealEpisodeRecord => ({
  schemaVersion: 1, key, revision: 0, status, startedAt: updatedAt, attempts: 0, nextEligibleAt: 0,
  latch: { schemaVersion: 1, failingSince: null, failures: 0, signaledFor: null }, notices: {}, recoveries: [], restart: null, updatedAt,
});
const group = (k: string) => k.slice(0, k.lastIndexOf('-')); // drop the incident id: cb-ladder:m1-<topic>-<cause>
const kinds: Array<[string, (o: ConstructorParameters<typeof InMemorySelfHealEpisodeStore>[0]) => SelfHealEpisodeStore]> = [
  ['in-memory', (o) => new InMemorySelfHealEpisodeStore(o)],
  ['sqlite', (o) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shg-ring-')); dirs.push(d); return new SqliteSelfHealEpisodeStore(path.join(d, 'cb.db'), o); }],
];

describe.each(kinds)('extensions 3+4 — per-incident keys, ring and pruning (%s store)', (_n, make) => {
  it('ring of 4 per group: the 5th incident evicts the OLDEST TERMINAL episode', () => {
    const s = make({ ring: { groupOf: group, perGroup: 4 } });
    s.create(row('cb-ladder:m1-141133-stage-i1', 'exhausted', 10));
    s.create(row('cb-ladder:m1-141133-stage-i2', 'recovered', 5));
    s.create(row('cb-ladder:m1-141133-stage-i3', 'active', 1));
    s.create(row('cb-ladder:m1-141133-stage-i4', 'exhausted', 20));
    expect(s.create(row('cb-ladder:m1-141133-stage-i5', 'active', 30))).not.toBeNull();
    expect(s.load('cb-ladder:m1-141133-stage-i2')).toBeNull(); // oldest terminal (5) evicted
    for (const k of ['i1', 'i3', 'i4', 'i5']) expect(s.load(`cb-ladder:m1-141133-stage-${k}`)).not.toBeNull();
    s.close?.();
  });

  it('refuses only when all four in the group are live; another group is unaffected', () => {
    const s = make({ ring: { groupOf: group, perGroup: 4 } });
    for (const i of [1, 2, 3, 4]) s.create(row(`cb-ladder:m1-141133-stage-i${i}`, 'active', i));
    expect(s.create(row('cb-ladder:m1-141133-stage-i5', 'active', 9))).toBeNull();
    expect(s.create(row('cb-ladder:m1-999-stage-i1', 'active', 9))).not.toBeNull();
    s.close?.();
  });

  it('with a ring the global cap evicts the oldest terminal episode before refusing', () => {
    const s = make({ maxRows: 3, ring: { groupOf: group, perGroup: 4 } });
    s.create(row('cb-ladder:m1-1-a-i1', 'recovered', 1));
    s.create(row('cb-ladder:m1-2-a-i1', 'active', 2));
    s.create(row('cb-ladder:m1-3-a-i1', 'active', 3));
    expect(s.create(row('cb-ladder:m1-4-a-i1', 'active', 4))).not.toBeNull();
    expect(s.load('cb-ladder:m1-1-a-i1')).toBeNull();
    expect(s.create(row('cb-ladder:m1-5-a-i1', 'active', 5))).toBeNull(); // all live
    s.close?.();
  });

  it('pruneTerminal deletes recovered and exhausted episodes and keeps active ones', () => {
    const s = make({});
    s.create(row('k-a', 'active', 1)); s.create(row('k-r', 'recovered', 1)); s.create(row('k-x', 'exhausted', 1));
    expect(s.pruneTerminal?.()).toBe(2);
    expect(s.load('k-a')).not.toBeNull(); expect(s.load('k-r')).toBeNull(); expect(s.load('k-x')).toBeNull();
    s.close?.();
  });
});

describe('review fixes — abandoned episodes, pending notices, bad rows', () => {
  it('ownership moving mid-incident leaves no permanent block: past the wall clock the prune frees the ring', async () => {
    let now = 1_000; let owner = true;
    const store = new InMemorySelfHealEpisodeStore({ ring: { groupOf: group, perGroup: 4 } });
    const d = { ...deps(store), now: () => now };
    const g = new SelfHealGate(base({ isOwner: () => owner, remediation: () => { owner = false; return { outcome: 'not-healed', evidence: 'verification-failed' }; } }), d);
    for (const i of ['i1', 'i2', 'i3', 'i4']) { owner = true; expect((await g.attempt(ctx({ incident: i }))).outcome).toBe('attempted'); }
    owner = true;
    expect((await g.attempt(ctx({ incident: 'i5' }))).outcome).toBe('state-failure'); // all four live
    expect(g.pruneTerminal()).toBe(0); // not yet past the wall clock
    now += 60_000;
    expect(g.pruneTerminal()).toBe(4);
    now += 1; expect((await g.attempt(ctx({ incident: 'i5' }))).outcome).not.toBe('state-failure');
  });

  it('prune BEFORE attempt on the owner past the wall clock: the ladder still exhausts with exactly one notice', async () => {
    let now = 1_000; const store = new InMemorySelfHealEpisodeStore({ ring: { groupOf: group, perGroup: 4 } });
    const d = { ...deps(store), now: () => now };
    const remediation = vi.fn(() => ({ outcome: 'not-healed', evidence: 'verification-failed' } as const));
    const g = new SelfHealGate(base({ maxAttempts: 10, maxWallClockMs: 10 * 60_000, notificationLatencyCeilingMs: 24 * 60 * 60_000, remediation }), d);
    let last: unknown;
    for (let tick = 0; tick < 40; tick++) { now += 60_000; g.pruneTerminal(); last = await g.attempt(ctx()); }
    expect(last).toMatchObject({ outcome: 'exhausted' });
    expect(d.notify).toHaveBeenCalledTimes(1);
    expect(remediation.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('exhaustedRetentionMs must be finite and at least the wall clock', () => {
    for (const v of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 59_999]) expect(() => new SelfHealGate(base({ exhaustedRetentionMs: v }), deps())).toThrow(/exhaustedRetentionMs/);
    expect(() => new SelfHealGate(base({ exhaustedRetentionMs: 60_000 }), deps())).not.toThrow();
  });

  it('a pool-shared id may not contain ":" (its prune scope is the id prefix)', () => {
    expect(() => new SelfHealGate(base({ id: 'cb:x' }), deps())).toThrow(/must not contain/);
  });

  it('prune never touches another ladder\'s rows in a shared store', async () => {
    const store = new InMemorySelfHealEpisodeStore();
    store.create(row('other-ladder:x-1', 'exhausted', 1));
    const g = new SelfHealGate(base(), deps(store));
    expect(g.pruneTerminal()).toBe(0);
    expect(store.load('other-ladder:x-1')).not.toBeNull();
  });

  it('an exhausted episode whose notice failed is KEPT from pruning and retries the notice', async () => {
    const store = new InMemorySelfHealEpisodeStore(); const d = deps(store);
    d.notify = vi.fn().mockRejectedValueOnce(new Error('attention down')).mockResolvedValue(undefined);
    const g = new SelfHealGate(base({ maxAttempts: 1, remediation: () => ({ outcome: 'not-healed', evidence: 'verification-failed' }) }), d);
    await g.attempt(ctx());
    expect(await g.attempt(ctx())).toMatchObject({ outcome: 'exhausted' }); // notice enqueue failed
    expect(g.pruneTerminal()).toBe(0);
    expect(await g.attempt(ctx())).toMatchObject({ outcome: 'exhausted', noticeAttempted: true }); // retried
    expect(d.notify).toHaveBeenCalledTimes(2);
    expect(store.pruneTerminal()).toBe(1); // notice out: the store-level prune may now take it
  });

  it('a ring needs a groupOf function', () => {
    expect(() => new InMemorySelfHealEpisodeStore({ ring: { groupOf: 'x' as never, perGroup: 4 } })).toThrow(/invalid self-heal ring/);
  });

  it('an unreadable SQLite row is kept by every prune and never blocks other keys', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shg-bad-')); dirs.push(d);
    const dbPath = path.join(d, 'cb.db');
    const s = new SqliteSelfHealEpisodeStore(dbPath, { ring: { groupOf: group, perGroup: 4 } });
    s.create(row('cb-ladder:m1-1-stage-i1', 'exhausted', 1));
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(dbPath); raw.prepare('INSERT INTO self_heal_episodes(episode_key,revision,payload,updated_at) VALUES(?,?,?,?)').run('cb-ladder:m1-1-stage-bad', 0, '{not json', 0); raw.close();
    const g = new SelfHealGate(base(), deps(s));
    expect(g.pruneTerminal()).toBe(1);
    expect(s.create(row('cb-ladder:m1-1-stage-i2', 'active', 5))).not.toBeNull();
    s.close();
  });
});

describe('defaults are unchanged', () => {
  it('a store with no options keeps the 256-row cap and never evicts', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shg-cap-')); dirs.push(d);
    const s = new SqliteSelfHealEpisodeStore(path.join(d, 'x.db'));
    for (let i = 0; i < 256; i++) expect(s.create(row(`k${i}`, 'exhausted', i))).not.toBeNull();
    expect(s.create(row('k256', 'active', 999))).toBeNull();
    expect(s.load('k0')).not.toBeNull();
    s.close();
  });

  it('per-incident keys: an exhausted incident no longer blocks the next incident of the same cause', async () => {
    const store = new InMemorySelfHealEpisodeStore({ ring: { groupOf: group, perGroup: 4 } });
    const g = new SelfHealGate(base({ maxAttempts: 1, remediation: () => ({ outcome: 'not-healed', evidence: 'verification-failed' }) }), deps(store));
    await g.attempt(ctx()); expect(await g.attempt(ctx())).toMatchObject({ outcome: 'exhausted' });
    expect(await g.attempt(ctx({ incident: 'i2' }))).toMatchObject({ outcome: 'attempted' });
    expect(g.pruneTerminal()).toBe(0); // an exhausted incident is kept for its retention period
  });

  it('the gate prunes recovered episodes at once and exhausted ones only after the retention period', async () => {
    let now = 1_000; const store = new InMemorySelfHealEpisodeStore();
    let heal = false;
    const g = new SelfHealGate(base({ maxAttempts: 1, remediation: () => (heal ? { outcome: 'healed', evidence: 'repaired' } : { outcome: 'not-healed', evidence: 'verification-failed' }) }), { ...deps(store), now: () => now });
    await g.attempt(ctx({ incident: 'x' })); expect(await g.attempt(ctx({ incident: 'x' }))).toMatchObject({ outcome: 'exhausted' });
    heal = true; expect(await g.attempt(ctx({ incident: 'r' }))).toMatchObject({ outcome: 'healed' });
    expect(g.pruneTerminal()).toBe(1); // the recovered one
    now += 24 * 60 * 60_000 - 1; expect(g.pruneTerminal()).toBe(0);
    now += 1; expect(g.pruneTerminal()).toBe(1);
  });
});
