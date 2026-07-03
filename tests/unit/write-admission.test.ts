/**
 * WriteAdmission — the §3.2 scoped-domain decision table, typed-refusal shape,
 * seam verdicts, fail directions, and the I2 hard properties (sync, in-memory,
 * p99 < 1ms; ZERO fs on the admission path including negative lookups).
 *
 * Spec: docs/specs/standby-write-reconciliation.md §3.2/§3.4/§5/§8 (Tier 1).
 * BOTH sides of every boundary are exercised (Testing Integrity Standard).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { WriteAdmission, OwnershipIndex, WriteRefusedError, legacyReadOnlyMessage, type WriteAdmissionDeps } from '../../src/core/WriteAdmission.js';
import { buildWriteDomainRegistry, WriteDomainRegistry, sessionBuildContextKeyFor } from '../../src/core/WriteDomainRegistry.js';
import type { SessionOwnershipRecord, SessionOwnershipStatus } from '../../src/core/SessionOwnership.js';

const SELF = 'm_self';
const PEER = 'm_peer';

function rec(sessionKey: string, owner: string, status: SessionOwnershipStatus, epoch = 1): SessionOwnershipRecord {
  return {
    sessionKey,
    ownerMachineId: owner,
    ownershipEpoch: epoch,
    status,
    nonce: `n-${sessionKey}-${epoch}`,
    timestamp: 1_000_000,
    updatedAt: new Date(1_000_000).toISOString(),
  };
}

interface MakeOpts {
  readOnly?: boolean;
  poolActive?: boolean;
  machineId?: string | null;
  dryRun?: boolean;
  /** Test-seam inventory latch override — grants live-mode refusal authority. */
  live?: boolean;
  records?: unknown[];
  binding?: (sessionId: string) => number | string | null;
  registry?: WriteDomainRegistry;
  raiseAttention?: WriteAdmissionDeps['raiseAttention'];
  refusalAggregateThreshold?: number;
  now?: () => number;
}

function makeWA(opts: MakeOpts = {}): WriteAdmission {
  return new WriteAdmission(
    {
      thisMachineId: opts.machineId === undefined ? SELF : opts.machineId,
      isReadOnly: () => opts.readOnly ?? false,
      isPoolActive: () => opts.poolActive ?? true,
      registry: opts.registry ?? buildWriteDomainRegistry({ machineId: opts.machineId === undefined ? SELF : opts.machineId }),
      dryRun: opts.dryRun ?? false,
      resolveTopicForSession: opts.binding,
      raiseAttention: opts.raiseAttention,
      refusalAggregateThreshold: opts.refusalAggregateThreshold,
      now: opts.now,
      disableTimers: true,
      inventoryComplete: opts.live ?? true,
    },
    { all: () => (opts.records ?? []) as SessionOwnershipRecord[] },
  );
}

describe('WriteAdmission — §3.2 decision table', () => {
  it('machine-local admits EVERYWHERE — even a read-only standby, even pool-dark', () => {
    for (const readOnly of [false, true]) {
      for (const poolActive of [false, true]) {
        const wa = makeWA({ readOnly, poolActive });
        expect(wa.evaluate('machine-local').admit).toBe(true);
      }
    }
  });

  it('cluster-shared: admit on the lease holder, typed lease-required refusal on a standby (byte-identical authority to today)', () => {
    expect(makeWA({ readOnly: false }).evaluate('cluster-shared').admit).toBe(true);
    const v = makeWA({ readOnly: true }).evaluate('cluster-shared');
    expect(v.admit).toBe(false);
    if (!v.admit) {
      expect(v.refusal.code).toBe('lease-required');
      expect(v.refusal.retryable).toBe(true);
    }
  });

  describe('pool INACTIVE (§3.2 pool-dark clause, was S5): scoped domains collapse to the legacy lease boolean', () => {
    for (const domain of ['session-scoped', 'topic-scoped'] as const) {
      it(`${domain}: holder admits, standby refuses read-only-standby`, () => {
        expect(makeWA({ poolActive: false, readOnly: false }).evaluate(domain, { topicId: 7 }).admit).toBe(true);
        const v = makeWA({ poolActive: false, readOnly: true }).evaluate(domain, { topicId: 7 });
        expect(v.admit).toBe(false);
        if (!v.admit) expect(v.refusal.code).toBe('read-only-standby');
      });
    }
  });

  describe('session-scoped, pool active', () => {
    it('UNBOUND arm: no scope / binding miss / resolver throw ⇒ ADMIT on a read-only standby (M2 reachability)', () => {
      // No sessionId at all.
      expect(makeWA({ readOnly: true }).evaluate('session-scoped').admit).toBe(true);
      // In-memory binding map miss.
      expect(makeWA({ readOnly: true, binding: () => null }).evaluate('session-scoped', { sessionId: 's1' }).admit).toBe(true);
      // Resolver throw fails toward DELIVERY (§5 binding-unresolved row).
      expect(
        makeWA({ readOnly: true, binding: () => { throw new Error('boom'); } }).evaluate('session-scoped', { sessionId: 's1' }).admit,
      ).toBe(true);
    });

    it('no custody record / released record ⇒ ADMIT (today-equivalent: the sessionScoped carve-out)', () => {
      const none = makeWA({ readOnly: true, binding: () => 30193, records: [] });
      expect(none.evaluate('session-scoped', { sessionId: 's1' }).admit).toBe(true);
      const released = makeWA({ readOnly: true, binding: () => 30193, records: [rec('30193', PEER, 'released')] });
      expect(released.evaluate('session-scoped', { sessionId: 's1' }).admit).toBe(true);
    });

    it('owned record: admit iff the FSM owner is THIS machine; refuse not-owner NAMING the owner otherwise', () => {
      for (const status of ['placing', 'active', 'transferring'] as const) {
        const mine = makeWA({ readOnly: true, binding: () => 30193, records: [rec('30193', SELF, status)] });
        expect(mine.evaluate('session-scoped', { sessionId: 's1' }).admit).toBe(true);
        const theirs = makeWA({ readOnly: true, binding: () => 30193, records: [rec('30193', PEER, status)] });
        const v = theirs.evaluate('session-scoped', { sessionId: 's1' });
        expect(v.admit).toBe(false);
        if (!v.admit) {
          expect(v.refusal.code).toBe('not-owner');
          expect(v.refusal.owner?.machineId).toBe(PEER);
        }
      }
    });

    it('an explicit topicId on a session-scoped write short-circuits the binding step', () => {
      const wa = makeWA({ readOnly: true, records: [rec('42', PEER, 'active')] });
      const v = wa.evaluate('session-scoped', { topicId: 42 });
      expect(v.admit).toBe(false);
      if (!v.admit) expect(v.refusal.code).toBe('not-owner');
    });
  });

  describe('topic-scoped, pool active (the C1 split — absent/released is the LEGACY boolean, never admit)', () => {
    it('absent record: holder admits, standby refuses read-only-standby (I4 by construction)', () => {
      expect(makeWA({ readOnly: false, records: [] }).evaluate('topic-scoped', { topicId: 7 }).admit).toBe(true);
      const v = makeWA({ readOnly: true, records: [] }).evaluate('topic-scoped', { topicId: 7 });
      expect(v.admit).toBe(false);
      if (!v.admit) expect(v.refusal.code).toBe('read-only-standby');
    });

    it('released record resolves exactly like absent (same verdict by the table — §3.2 released-arm grounding)', () => {
      const v = makeWA({ readOnly: true, records: [rec('7', SELF, 'released')] }).evaluate('topic-scoped', { topicId: 7 });
      expect(v.admit).toBe(false);
      if (!v.admit) expect(v.refusal.code).toBe('read-only-standby');
    });

    it('the §9.18 EXCEPTION: an entry declaring an I9-audited absent-window story admits on absent', () => {
      const reg = new WriteDomainRegistry();
      const entry = {
        kind: 'kv' as const,
        key: 'topic-thing',
        domain: 'topic-scoped' as const,
        absentWindowStory: { logical: 'pool-scope-read-merge' as const, onSharedGitSyncedPath: false },
      };
      reg.add(entry);
      const wa = makeWA({ readOnly: true, records: [], registry: reg });
      expect(wa.evaluate('topic-scoped', { topicId: 7 }, entry).admit).toBe(true);
      // Without the entry the same lookup refuses — the default is the legacy boolean.
      expect(wa.evaluate('topic-scoped', { topicId: 7 }).admit).toBe(false);
    });

    it('owned record: admit iff the FSM owner is this machine (placing/active/transferring), else not-owner', () => {
      for (const status of ['placing', 'active', 'transferring'] as const) {
        expect(makeWA({ readOnly: true, records: [rec('7', SELF, status)] }).evaluate('topic-scoped', { topicId: 7 }).admit).toBe(true);
        const v = makeWA({ readOnly: true, records: [rec('7', PEER, status)] }).evaluate('topic-scoped', { topicId: 7 });
        expect(v.admit).toBe(false);
        if (!v.admit) expect(v.refusal.code).toBe('not-owner');
      }
    });

    it('a topic-scoped write with NO topic id resolves to the legacy boolean (defensive n/a arm)', () => {
      expect(makeWA({ readOnly: false }).evaluate('topic-scoped', {}).admit).toBe(true);
      expect(makeWA({ readOnly: true }).evaluate('topic-scoped', {}).admit).toBe(false);
    });
  });

  describe('fail-closed on GENUINE ambiguity only (I5)', () => {
    it('a malformed record (failed ingest validation) ⇒ ownership-unresolved — NEVER not-owner with owner:null', () => {
      const malformed = { sessionKey: '7', ownerMachineId: 123, ownershipEpoch: 1, status: 'active' };
      for (const domain of ['session-scoped', 'topic-scoped'] as const) {
        const v = makeWA({ readOnly: false, records: [malformed] }).evaluate(domain, { topicId: 7 });
        expect(v.admit).toBe(false);
        if (!v.admit) {
          expect(v.refusal.code).toBe('ownership-unresolved');
          expect(v.refusal.retryable).toBe(true);
          expect(v.refusal.owner).toBeNull();
        }
      }
    });

    it('an unknown FSM status ⇒ malformed ⇒ ownership-unresolved', () => {
      const weird = { sessionKey: '7', ownerMachineId: SELF, ownershipEpoch: 1, status: 'contested' };
      const v = makeWA({ records: [weird] }).evaluate('topic-scoped', { topicId: 7 });
      expect(v.admit).toBe(false);
      if (!v.admit) expect(v.refusal.code).toBe('ownership-unresolved');
    });

    it('an UNWARMED index answers ownership-unresolved (OwnershipIndex-level; defensive-only at WA level)', () => {
      const idx = new OwnershipIndex();
      expect(idx.lookup('7')).toEqual({ state: 'unwarmed' });
      idx.warmFrom([]);
      expect(idx.lookup('7')).toEqual({ state: 'none' });
    });
  });

  it('I6 single-machine no-op: identity-less install, pool dark, never read-only ⇒ every domain admits', () => {
    const wa = makeWA({ machineId: null, poolActive: false, readOnly: false });
    for (const domain of ['machine-local', 'session-scoped', 'topic-scoped', 'cluster-shared'] as const) {
      expect(wa.evaluate(domain, { topicId: 1, sessionId: 's' }).admit).toBe(true);
    }
  });
});

describe('WriteAdmission — typed refusal contract (§3.4)', () => {
  it('the refusal body is TYPED: error/code/domain/scope/thisMachine/owner/leaseHolder/asOf/retryable/hint', () => {
    const now = () => 1_700_000_000_000;
    const wa = makeWA({ readOnly: true, records: [rec('30193', PEER, 'active')], now });
    const v = wa.evaluate('topic-scoped', { topicId: 30193 });
    expect(v.admit).toBe(false);
    if (v.admit) return;
    const r = v.refusal;
    expect(r.error).toBe('write-refused');
    expect(r.code).toBe('not-owner');
    expect(r.domain).toBe('topic-scoped');
    expect(r.scope).toEqual({ topicId: 30193 });
    expect(r.thisMachine.machineId).toBe(SELF);
    expect(r.owner).toEqual({ machineId: PEER, nickname: null });
    expect(r.asOf).toBe(new Date(1_700_000_000_000).toISOString());
    expect(r.retryable).toBe(true);
    // The hint is advisory prose for a HUMAN — never a runnable command.
    expect(r.hint).toContain('consent-gated');
    expect(r.hint).not.toMatch(/curl|POST \/pool\/transfer/);
  });

  it('every refusal code is retryable:true (the wire contract pairs retryable with Retry-After)', () => {
    const cases = [
      makeWA({ readOnly: true }).evaluate('cluster-shared'),
      makeWA({ readOnly: true, poolActive: false }).evaluate('topic-scoped', { topicId: 1 }),
      makeWA({ records: [{ sessionKey: '1', ownerMachineId: 5, ownershipEpoch: 1, status: 'active' }] }).evaluate('topic-scoped', { topicId: 1 }),
    ];
    for (const v of cases) {
      expect(v.admit).toBe(false);
      if (!v.admit) expect(v.refusal.retryable).toBe(true);
    }
  });

  it('WriteRefusedError preserves the LEGACY read-only message string (log-scraping continuity, §7)', () => {
    const wa = makeWA({ readOnly: true });
    const v = wa.evaluate('cluster-shared');
    expect(v.admit).toBe(false);
    if (v.admit) return;
    const err = new WriteRefusedError(v.refusal, 'saveJobState');
    expect(err.message).toContain(legacyReadOnlyMessage('saveJobState'));
    expect(err.message).toContain('StateManager is read-only (this machine is on standby). Blocked: saveJobState');
    expect(err.refusal.code).toBe('lease-required');
    expect(err.name).toBe('WriteRefusedError');
  });
});

describe('WriteAdmission — store seam (guardStoreWrite)', () => {
  it('dry-run: ALWAYS returns legacy (the blanket guard keeps enforcing — §9.6) and counts divergences', () => {
    const wa = makeWA({ dryRun: true, readOnly: true, poolActive: true });
    // machine-local kv (the per-machine build-context key): today THROWS on a
    // standby, new layer would admit ⇒ wouldAdmitChanged.
    const key = sessionBuildContextKeyFor(SELF);
    expect(wa.guardStoreWrite('set', { key })).toEqual({ enforce: 'legacy' });
    // cluster-shared: both refuse — agreement, no divergence row.
    expect(wa.guardStoreWrite('saveJobState')).toEqual({ enforce: 'legacy' });
    const s = wa.status();
    const ml = s.domains.find((d) => d.domain === 'machine-local')!;
    expect(ml.wouldAdmitChanged).toBe(1);
    expect(s.mode).toBe('dry-run');
  });

  it('dry-run: a write the new layer would REFUSE while today succeeds counts wouldRefuse (the false-positive evidence, §6)', () => {
    const wa = makeWA({ dryRun: true, readOnly: false, records: [rec('7', PEER, 'active')] });
    expect(wa.guardStoreWrite('saveSession', { scope: { topicId: 7 }, legacySessionScoped: true })).toEqual({ enforce: 'legacy' });
    const ss = wa.status().domains.find((d) => d.domain === 'session-scoped')!;
    expect(ss.wouldRefuse).toBe(1);
  });

  it('live: machine-local kv admits on a read-only standby; cluster-shared refuses with the typed refusal', () => {
    const wa = makeWA({ dryRun: false, live: true, readOnly: true });
    expect(wa.guardStoreWrite('set', { key: sessionBuildContextKeyFor(SELF) })).toEqual({ enforce: 'admit' });
    const v = wa.guardStoreWrite('saveJobState');
    expect(v.enforce).toBe('refuse');
    if (v.enforce === 'refuse') expect(v.refusal.code).toBe('lease-required');
  });

  it('live: an UNCLASSIFIED kv key defaults cluster-shared (I8) — the LEGACY build-context key included', () => {
    const wa = makeWA({ dryRun: false, live: true, readOnly: true });
    expect(wa.guardStoreWrite('set', { key: 'session-build-context' }).enforce).toBe('refuse');
    expect(wa.guardStoreWrite('set', { key: 'some-unclassified-key' }).enforce).toBe('refuse');
    expect(wa.guardStoreWrite('totally-unknown-op').enforce).toBe('refuse');
  });

  it('the §9.14 inventory latch: dryRun:false WITHOUT the inventory constant stays dry-run (no refusal authority)', () => {
    const wa = makeWA({ dryRun: false, live: false, readOnly: true });
    expect(wa.mode()).toBe('dry-run');
    expect(wa.isLive).toBe(false);
    expect(wa.guardStoreWrite('saveJobState')).toEqual({ enforce: 'legacy' });
  });
});

describe('WriteAdmission — route seam (guardRouteWrite, §3.4/§9.16)', () => {
  it('an UNWIRED route proceeds (I8 — no behavior change, lint-visible)', () => {
    const wa = makeWA({ readOnly: true, live: true });
    expect(wa.guardRouteWrite('POST', '/some/unwired/route')).toEqual({ action: 'proceed' });
  });

  it('wave-1 families are machine-local ⇒ proceed everywhere, even live on a read-only standby', () => {
    const wa = makeWA({ readOnly: true, live: true, dryRun: false });
    expect(wa.guardRouteWrite('POST', '/evolution/actions').action).toBe('proceed');
    expect(wa.guardRouteWrite('PATCH', '/evolution/actions/ACT-1').action).toBe('proceed');
    expect(wa.guardRouteWrite('POST', '/attention').action).toBe('proceed');
    expect(wa.guardRouteWrite('PATCH', '/attention/att-1').action).toBe('proceed');
  });

  it('live: a cluster-shared route entry on a standby refuses 409 + Retry-After 5 with the typed body', () => {
    const reg = new WriteDomainRegistry();
    reg.add({ kind: 'route', method: 'POST', pathPrefix: '/test-shared', domain: 'cluster-shared' });
    const wa = makeWA({ readOnly: true, live: true, dryRun: false, registry: reg });
    const v = wa.guardRouteWrite('POST', '/test-shared/thing');
    expect(v.action).toBe('refuse');
    if (v.action === 'refuse') {
      expect(v.status).toBe(409);
      expect(v.retryAfterSeconds).toBe(5);
      expect(v.refusal.code).toBe('lease-required');
    }
  });

  it('dry-run: the SAME cluster-shared route proceeds (zero authority until dryRun:false — §9.6) and logs a would-verdict', () => {
    const reg = new WriteDomainRegistry();
    reg.add({ kind: 'route', method: 'POST', pathPrefix: '/test-shared', domain: 'cluster-shared' });
    const wa = makeWA({ readOnly: true, dryRun: true, registry: reg });
    expect(wa.guardRouteWrite('POST', '/test-shared/thing')).toEqual({ action: 'proceed' });
    expect(wa.status().domains.find((d) => d.domain === 'cluster-shared')!.wouldRefuse).toBe(1);
  });

  it('admission-layer throw splits by domain (§9.16): machine-local PROCEEDS, cluster-shared refuses admission-error', () => {
    const reg = new WriteDomainRegistry();
    reg.add({ kind: 'route', method: 'POST', pathPrefix: '/test-shared', domain: 'cluster-shared' });
    const wa = makeWA({ live: true, dryRun: false, registry: reg });
    vi.spyOn(wa, 'evaluate').mockImplementation(() => { throw new Error('guard broke'); });
    const shared = wa.guardRouteWrite('POST', '/test-shared/x');
    expect(shared.action).toBe('refuse');
    if (shared.action === 'refuse') expect(shared.refusal.code).toBe('admission-error');

    const reg2 = buildWriteDomainRegistry({ machineId: SELF });
    const wa2 = makeWA({ live: true, dryRun: false, registry: reg2 });
    vi.spyOn(wa2, 'evaluate').mockImplementation(() => { throw new Error('guard broke'); });
    expect(wa2.guardRouteWrite('POST', '/evolution/actions')).toEqual({ action: 'proceed' });
  });

  it('admission-layer throw in DRY-RUN never refuses (even scoped/shared — no authority while dry)', () => {
    const reg = new WriteDomainRegistry();
    reg.add({ kind: 'route', method: 'POST', pathPrefix: '/test-shared', domain: 'cluster-shared' });
    const wa = makeWA({ dryRun: true, registry: reg });
    vi.spyOn(wa, 'evaluate').mockImplementation(() => { throw new Error('guard broke'); });
    expect(wa.guardRouteWrite('POST', '/test-shared/x')).toEqual({ action: 'proceed' });
  });
});

describe('WriteAdmission — §6 aggregate alerting (never per-event; the flood lesson)', () => {
  it('≥N refusals of one (surface, code) in the window raise EXACTLY ONE deduped attention item', () => {
    const raised: Array<{ id: string }> = [];
    const wa = makeWA({
      readOnly: true, live: true, dryRun: false,
      raiseAttention: (item) => raised.push(item),
      refusalAggregateThreshold: 5,
      now: () => 1_700_000_000_000,
    });
    for (let i = 0; i < 25; i++) wa.guardStoreWrite('saveJobState');
    expect(raised.length).toBe(1);
    expect(raised[0].id).toContain('write-admission');
    expect(wa.status().recentRefusals.length).toBeLessThanOrEqual(50);
  });

  it('below the threshold no item is raised', () => {
    const raised: unknown[] = [];
    const wa = makeWA({ readOnly: true, live: true, dryRun: false, raiseAttention: (i) => raised.push(i), refusalAggregateThreshold: 5 });
    for (let i = 0; i < 4; i++) wa.guardStoreWrite('saveJobState');
    expect(raised.length).toBe(0);
  });
});

describe('WriteAdmission — I2 hard properties', () => {
  it('ZERO fs on the admission path — including NEGATIVE lookups (the OQ1 decision)', () => {
    const spies = [
      vi.spyOn(fs, 'existsSync'),
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'readdirSync'),
      vi.spyOn(fs, 'statSync'),
      vi.spyOn(fs, 'writeFileSync'),
      vi.spyOn(fs, 'appendFileSync'),
    ];
    try {
      const wa = makeWA({ readOnly: true, live: true, dryRun: false, records: [rec('7', PEER, 'active')] });
      spies.forEach((s) => s.mockClear());
      // Positive lookup, negative lookup, unbound, cluster-shared, machine-local.
      wa.evaluate('topic-scoped', { topicId: 7 });
      wa.evaluate('topic-scoped', { topicId: 999999 }); // keyless — negative answer from MEMORY
      wa.evaluate('session-scoped', { sessionId: 'never-seen' });
      wa.evaluate('cluster-shared');
      wa.evaluate('machine-local');
      wa.guardStoreWrite('set', { key: 'some-key' });
      wa.guardRouteWrite('POST', '/evolution/actions');
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('p99 < 1ms over 10k evaluate calls (the <2s SLO is met by construction whenever the loop is alive)', () => {
    const wa = makeWA({ readOnly: true, records: [rec('7', PEER, 'active'), rec('8', SELF, 'active')] });
    const durations: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      const t0 = process.hrtime.bigint();
      wa.evaluate(i % 2 === 0 ? 'topic-scoped' : 'session-scoped', { topicId: i % 3 === 0 ? 7 : 8 });
      durations.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    durations.sort((a, b) => a - b);
    const p99 = durations[Math.floor(durations.length * 0.99)];
    expect(p99).toBeLessThan(1);
  });
});

describe('WriteAdmission — status surface (§6)', () => {
  it('reports mode, per-domain counters, ownership index stats, and the event-loop gauge shape', () => {
    const wa = makeWA({ records: [rec('7', SELF, 'active')] });
    const s = wa.status();
    expect(s.enabled).toBe(true);
    expect(s.mode).toMatch(/^(dry-run|live)$/);
    expect(s.domains.map((d) => d.domain).sort()).toEqual(['cluster-shared', 'machine-local', 'session-scoped', 'topic-scoped']);
    expect(s.ownershipIndex.entries).toBe(1);
    expect(s.eventLoop).toHaveProperty('p50');
    expect(s.eventLoop).toHaveProperty('starvedWindows24h');
  });

  it('recentRefusals carry the typed body MINUS the hint (§6)', () => {
    const wa = makeWA({ readOnly: true, live: true, dryRun: false });
    wa.guardStoreWrite('saveJobState');
    const r = wa.status().recentRefusals[0] as Record<string, unknown>;
    expect(r.code).toBe('lease-required');
    expect(r.hint).toBeUndefined();
    expect(r.surface).toBe('saveJobState');
    expect(r.seam).toBe('store');
  });
});
