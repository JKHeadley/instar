import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  PasskeyAttemptLedger, PasskeyPeerExclusions, PasskeyPoolReader, buildLocalPasskeyMachineState, clampPasskeyMachineState,
  classifyPasskeyPeer, enrollmentRateLimit, sameAccountGap, activePauseFor, poolAdmission, poolRows,
  PASSKEY_POOL_LASTKNOWN_FILE, PEER_UNOBSERVED_EXCLUDE_OFFER_MS,
  type PasskeyMachineState, type PasskeyAttemptRow, type PasskeyPoolPeer, type PeerStateFetch,
} from '../../src/core/PasskeyPoolState.js';

// Spec docs/specs/agent-held-google-passkey.md §5.1 (pool read path), §3.7 (rate limit), §4 (peer
// classification + same-account gap + pauses), §5.1 table (what each machine may do).

const H = 60 * 60_000;
const T0 = Date.parse('2026-09-23T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function stateOf(machineId: string, over: Partial<PasskeyMachineState> = {}): PasskeyMachineState {
  return { schemaVersion: 1, machineId, generatedAt: iso(T0), cells: [], attempts: [], pauses: [], grantEchoes: [], revokeHighWater: 0, outbox: [], pushEnabled: false, suspension: null, ...over };
}

describe('PasskeyAttemptLedger + PasskeyPeerExclusions (machine-local files)', () => {
  let dir: string; let now = T0;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-pool-')); now = T0; });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'passkey-pool-state.test' }); });

  it('records attempts with THIS machine id, prunes rows older than 24h, and fails closed on a corrupt file', () => {
    const ledger = new PasskeyAttemptLedger({ stateDir: dir, machineId: 'm1', now: () => now });
    ledger.recordAttempt({ canonicalEmail: 'a@example.com', kind: 'enrollment' });
    now += 23 * H;
    ledger.recordAttempt({ canonicalEmail: 'a@example.com', kind: 'proof' });
    expect(ledger.attempts().map((r) => r.kind)).toEqual(['enrollment', 'proof']);
    expect(ledger.attempts().every((r) => r.machineId === 'm1')).toBe(true);
    now += 2 * H;
    expect(ledger.attempts().map((r) => r.kind)).toEqual(['proof']);
    fs.writeFileSync(path.join(dir, 'state', 'passkey-attempts.json'), '{"version":1,"attempts":"nope"}');
    expect(() => ledger.attempts()).toThrow('passkey-attempts-corrupt');
  });

  it('pauses: an identical open pause is extended (never duplicated), expired pauses are pruned, account and machine scopes both stop a cell', () => {
    const ledger = new PasskeyAttemptLedger({ stateDir: dir, machineId: 'm1', now: () => now });
    const p1 = ledger.pause({ canonicalEmail: 'a@example.com', scope: 'account', reason: 'throttled', durationMs: 24 * H });
    const p2 = ledger.pause({ canonicalEmail: 'a@example.com', scope: 'account', reason: 'throttled', durationMs: 30 * H });
    expect(p2.id).toBe(p1.id);
    expect(ledger.activePauses()).toHaveLength(1);
    expect(Date.parse(ledger.activePauses()[0].until) - now).toBe(30 * H);
    ledger.pause({ canonicalEmail: null, scope: 'machine', reason: 'throttled', durationMs: H });
    const pauses = ledger.activePauses();
    expect(activePauseFor({ pauses, canonicalEmail: 'b@example.com', machineId: 'm1', nowMs: now })?.scope).toBe('machine');
    expect(activePauseFor({ pauses, canonicalEmail: 'b@example.com', machineId: 'm2', nowMs: now })).toBeNull();
    expect(activePauseFor({ pauses, canonicalEmail: 'a@example.com', machineId: 'm2', nowMs: now })?.scope).toBe('account');
    now += 31 * H;
    expect(ledger.activePauses()).toEqual([]);
  });

  it('exclusions: exclude is idempotent, include removes, and the file is per machine', () => {
    const ex = new PasskeyPeerExclusions({ stateDir: dir, now: () => now });
    expect(ex.exclude('m2', 'dashboard-pin@m1').changed).toBe(true);
    expect(ex.exclude('m2', 'dashboard-pin@m1').changed).toBe(false);
    expect(ex.isExcluded('m2')).toBe(true);
    expect(ex.include('m2').changed).toBe(true);
    expect(ex.include('m2').changed).toBe(false);
    expect(ex.list()).toEqual([]);
  });

  it('buildLocalPasskeyMachineState publishes one row per granted or held cell with custody, echoes, outbox rows and the ledger — never a secret', () => {
    const ledger = new PasskeyAttemptLedger({ stateDir: dir, machineId: 'm1', now: () => now });
    ledger.recordAttempt({ canonicalEmail: 'a@example.com', kind: 'enrollment' });
    const s = buildLocalPasskeyMachineState({
      machineId: 'm1', now: () => now,
      grants: [{ canonicalEmail: 'a@example.com', status: 'active', localSeq: 2, grantedAt: iso(T0 - H), googleCreatedAt: null },
        { canonicalEmail: 'a@example.com', status: 'revoked', localSeq: 1, grantedAt: iso(T0 - 2 * H) },
        { canonicalEmail: 'old@example.com', status: 'revoked', localSeq: 3, grantedAt: iso(T0 - 2 * H) }],
      issuedPeerGrants: [{ canonicalEmail: 'a@example.com', targetMachineId: 'm2', issuedAt: iso(T0), targetLocalSeq: 7 }],
      revokeHighWater: 3, custody: [{ canonicalEmail: 'old@example.com', state: 'quarantined' }], pendingEmails: ['p@example.com'],
      outbox: [{ canonicalEmail: 'a@example.com', targetMachineId: 'm2', state: 'pending', attempts: 1, issuedAt: iso(T0), nextAttemptAt: iso(T0 + H) }],
      ledger, pushEnabled: true,
    });
    expect(s.cells.map((c) => [c.canonicalEmail, c.granted, c.grantLocalSeq, c.custody])).toEqual([
      ['a@example.com', true, 2, 'absent'], ['old@example.com', false, null, 'quarantined'], ['p@example.com', false, null, 'pending'],
    ]);
    expect(s.grantEchoes).toEqual([{ canonicalEmail: 'a@example.com', targetMachineId: 'm2', targetLocalSeq: 7, issuedAt: iso(T0) }]);
    expect(s.outbox[0]).toMatchObject({ state: 'pending', attempts: 1 });
    expect(s.attempts).toHaveLength(1);
    expect(s.pushEnabled).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/portable|credential|privateKey|emailKey/);
  });
});

describe('clampPasskeyMachineState — a peer body is mesh-peer data, never trusted shape', () => {
  it('accepts a well-formed body, stamps every row with the REGISTRY machine id, drops malformed rows, bounds arrays', () => {
    const body = {
      ...stateOf('m2'),
      attempts: [
        { canonicalEmail: 'a@example.com', kind: 'proof', at: iso(T0), machineId: 'forged' },
        { canonicalEmail: 'not-an-email', kind: 'proof', at: iso(T0) },
        { canonicalEmail: 'a@example.com', kind: 'bogus', at: iso(T0) },
        { canonicalEmail: 'a@example.com', kind: 'proof', at: 'yesterday' },
      ],
      pauses: [{ id: 'p1', canonicalEmail: 'a@example.com', scope: 'account', reason: 'risk', from: iso(T0), until: iso(T0 + H), machineId: 'forged' }, { id: 'p2', scope: 'account', canonicalEmail: null, reason: 'risk', from: iso(T0), until: iso(T0 + H) }],
      cells: [
        { canonicalEmail: 'a@example.com', granted: true, grantLocalSeq: 3, custody: 'present', health: 'healthy', googleSide: 'pending-operator' },
        { canonicalEmail: 'b@example.com', granted: true, grantLocalSeq: 1, custody: 'present', health: 'totally-fine', googleSide: 'gone' },
        { canonicalEmail: 'x' },
      ],
    };
    const s = clampPasskeyMachineState(body, 'm2')!;
    expect(s.attempts).toEqual([{ canonicalEmail: 'a@example.com', kind: 'proof', at: iso(T0), machineId: 'm2' }]);
    expect(s.pauses.map((p) => [p.id, p.machineId])).toEqual([['p1', 'm2']]);
    // A closed §4 health state and Google-side state pass through; free text reads `unknown` / is dropped.
    expect(s.cells).toEqual([
      { canonicalEmail: 'a@example.com', granted: true, grantLocalSeq: 3, grantedAt: null, custody: 'present', googleCreatedAt: null, health: 'healthy', googleSide: 'pending-operator' },
      { canonicalEmail: 'b@example.com', granted: true, grantLocalSeq: 1, grantedAt: null, custody: 'present', googleCreatedAt: null, health: 'unknown' },
    ]);
  });
  it('rejects a body for the wrong machine, the wrong schema, or no object', () => {
    expect(clampPasskeyMachineState(stateOf('m3'), 'm2')).toBeNull();
    expect(clampPasskeyMachineState({ ...stateOf('m2'), schemaVersion: 2 }, 'm2')).toBeNull();
    expect(clampPasskeyMachineState('nope', 'm2')).toBeNull();
    expect(clampPasskeyMachineState(null, 'm2')).toBeNull();
  });
});

describe('classifyPasskeyPeer (§4)', () => {
  it('answered ⇒ observed; not answered ⇒ peer-offline only on rope peer-offline; excluded wins over rope; everything else partitioned', () => {
    expect(classifyPasskeyPeer({ answered: true, excluded: true, ropeAvailable: true, rope: 'urgent' })).toBe('observed');
    expect(classifyPasskeyPeer({ answered: false, excluded: true, ropeAvailable: true, rope: 'ok' })).toBe('excluded');
    expect(classifyPasskeyPeer({ answered: false, excluded: false, ropeAvailable: true, rope: 'peer-offline' })).toBe('peer-offline');
    for (const rope of ['ok', 'degraded', 'urgent', 'auth-rejected', 'unknown'] as const)
      expect(classifyPasskeyPeer({ answered: false, excluded: false, ropeAvailable: true, rope }), rope).toBe('partitioned');
    // Rope health absent (it is itself dev-gated) ⇒ partitioned even when the rope row says offline.
    expect(classifyPasskeyPeer({ answered: false, excluded: false, ropeAvailable: false, rope: 'peer-offline' })).toBe('partitioned');
    expect(classifyPasskeyPeer({ answered: false, excluded: false, ropeAvailable: false, rope: null })).toBe('partitioned');
  });
});

describe('enrollmentRateLimit (§3.7) and sameAccountGap (§4)', () => {
  const row = (email: string, kind: PasskeyAttemptRow['kind'], agoMs: number, machineId = 'm1'): PasskeyAttemptRow => ({ canonicalEmail: email, kind, at: iso(T0 - agoMs), machineId });

  it('one enrollment per cell per 30 minutes: the same machine is refused inside the interval, another machine is not', () => {
    const rows = [row('a@example.com', 'enrollment', 10 * 60_000)];
    expect(enrollmentRateLimit({ rows, canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0 })).toMatchObject({ allowed: false, reason: 'cell-interval', retryAfterMs: 20 * 60_000 });
    expect(enrollmentRateLimit({ rows, canonicalEmail: 'a@example.com', machineId: 'm2', nowMs: T0 })).toEqual({ allowed: true });
    expect(enrollmentRateLimit({ rows, canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0 + 21 * 60_000 })).toEqual({ allowed: true });
  });

  it('3 per account per day POOL-WIDE: proofs/canaries/repairs from ANY machine count toward the cap; a fourth enrollment is refused with the retry time', () => {
    const rows = [row('a@example.com', 'proof', 20 * H, 'm2'), row('a@example.com', 'repair', 5 * H, 'm3'), row('a@example.com', 'enrollment', 2 * H, 'm2')];
    const r = enrollmentRateLimit({ rows, canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0 });
    expect(r).toMatchObject({ allowed: false, reason: 'account-daily-cap', retryAfterMs: 4 * H });
    // Another account is untouched; rows past 24h fall out of the count.
    expect(enrollmentRateLimit({ rows, canonicalEmail: 'b@example.com', machineId: 'm1', nowMs: T0 })).toEqual({ allowed: true });
    expect(enrollmentRateLimit({ rows, canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0 + 4 * H + 1 })).toEqual({ allowed: true });
    // The cap is configurable but never below the spec default direction.
    expect(enrollmentRateLimit({ rows, canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0, config: { minIntervalMinutes: 30, maxPerAccountPerDay: 5 } })).toEqual({ allowed: true });
    // MORE rows than the cap: the retry time is when enough rows have aged out (the 3rd-oldest of 5
    // expiring), not when the oldest does — after which enrollment would still be refused.
    const five = [22, 20, 18, 5, 2].map((h, i) => row('a@example.com', 'proof', h * H, `m${i}`));
    const over = enrollmentRateLimit({ rows: five, canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0 });
    expect(over).toMatchObject({ allowed: false, reason: 'account-daily-cap', retryAfterMs: 6 * H });
    expect(enrollmentRateLimit({ rows: five, canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0 + 6 * H + 1 })).toEqual({ allowed: true });
    expect(enrollmentRateLimit({ rows: five, canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0 + 2 * H + 1 })).toMatchObject({ allowed: false });
  });

  it('same-account gap: a proof/canary/enrollment of the account from a DIFFERENT machine within 6h blocks; own-machine and repair rows do not', () => {
    const rows = [row('a@example.com', 'proof', 2 * H, 'm2'), row('a@example.com', 'repair', 1 * H, 'm3'), row('a@example.com', 'proof', 1 * H, 'm1')];
    expect(sameAccountGap({ rows, canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0 })).toMatchObject({ allowed: false, blockedBy: 'm2', retryAfterMs: 4 * H });
    expect(sameAccountGap({ rows: rows.filter((r) => r.machineId !== 'm2'), canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0 })).toEqual({ allowed: true });
    expect(sameAccountGap({ rows, canonicalEmail: 'a@example.com', machineId: 'm1', nowMs: T0 + 5 * H })).toEqual({ allowed: true });
  });
});

describe('poolAdmission — the §5.1 "what each machine may do" table, most restrictive wins', () => {
  const base = { peers: ['observed', 'observed'] as const, suspension: { state: 'none' as const, killSwitch: false }, leaseHolder: { isSelf: true, reachable: true, lastKnownAgeMs: null } };
  const c = (over: Partial<typeof base> & { peers?: Array<'observed' | 'peer-offline' | 'excluded' | 'partitioned'> }) => ({ ...base, ...over, peers: over.peers ?? [...base.peers] });

  it('all peers observed: everything allowed; offline/excluded peers: still allowed (their last-known rows count) and revokes queue', () => {
    for (const a of ['enroll', 'prove', 'canary', 'repair', 'revoke'] as const) expect(poolAdmission(a, c({})).allowed, a).toBe(true);
    const off = c({ peers: ['observed', 'peer-offline', 'excluded'] });
    expect(poolAdmission('enroll', off)).toEqual({ allowed: true, mode: 'normal', reason: null });
    expect(poolAdmission('revoke', off)).toEqual({ allowed: true, mode: 'queued', reason: null });
  });

  it('a partitioned peer refuses enroll/prove/canary with passkey-pool-state-unavailable; repair and revoke are unaffected', () => {
    const part = c({ peers: ['observed', 'partitioned'] });
    for (const a of ['enroll', 'prove', 'canary'] as const) expect(poolAdmission(a, part)).toEqual({ allowed: false, mode: 'normal', reason: 'passkey-pool-state-unavailable' });
    expect(poolAdmission('repair', part).allowed).toBe(true);
    expect(poolAdmission('revoke', part)).toEqual({ allowed: true, mode: 'queued', reason: null });
  });

  it('suspended: canary only, repair by degraded override; stopped or kill switch: no sign-ins at all, repair by override, revoke always', () => {
    const susp = c({ suspension: { state: 'suspended', killSwitch: false } });
    expect(poolAdmission('enroll', susp)).toMatchObject({ allowed: false, reason: 'suspended' });
    expect(poolAdmission('prove', susp)).toMatchObject({ allowed: false, reason: 'suspended' });
    expect(poolAdmission('canary', susp)).toEqual({ allowed: true, mode: 'canary-only', reason: null });
    expect(poolAdmission('repair', susp)).toEqual({ allowed: true, mode: 'degraded-override', reason: 'suspended' });
    for (const s of [c({ suspension: { state: 'suspended-stopped', killSwitch: false } }), c({ suspension: { state: 'none', killSwitch: true } })]) {
      expect(poolAdmission('canary', s).allowed).toBe(false);
      expect(poolAdmission('prove', s).allowed).toBe(false);
      expect(poolAdmission('repair', s).mode).toBe('degraded-override');
      expect(poolAdmission('revoke', s).allowed).toBe(true);
    }
    expect(poolAdmission('enroll', c({ suspension: { state: 'none', killSwitch: true } })).reason).toBe('kill-switch');
  });

  it('COMBINED rows: the most restrictive cell wins — a suspended canary is still refused by a partitioned peer or a stale lease holder; stopped beats everything', () => {
    const suspended = { state: 'suspended' as const, killSwitch: false };
    expect(poolAdmission('canary', c({ suspension: suspended, peers: ['observed', 'partitioned'] }))).toEqual({ allowed: false, mode: 'normal', reason: 'passkey-pool-state-unavailable' });
    expect(poolAdmission('canary', c({ suspension: suspended, leaseHolder: { isSelf: false, reachable: false, lastKnownAgeMs: 30 * H } }))).toEqual({ allowed: false, mode: 'normal', reason: 'passkey-suspension-unknown' });
    expect(poolAdmission('canary', c({ suspension: suspended, leaseHolder: { isSelf: false, reachable: false, lastKnownAgeMs: 1 * H } }))).toEqual({ allowed: true, mode: 'canary-only', reason: null });
    expect(poolAdmission('canary', c({ suspension: { state: 'suspended-stopped', killSwitch: false }, peers: ['partitioned'] }))).toEqual({ allowed: false, mode: 'normal', reason: 'suspended-stopped' });
    // Repair under several degraded conditions names the most severe reason and always runs by override.
    expect(poolAdmission('repair', c({ suspension: suspended, peers: ['partitioned'], leaseHolder: { isSelf: false, reachable: false, lastKnownAgeMs: null } }))).toEqual({ allowed: true, mode: 'degraded-override', reason: 'suspended' });
    expect(poolAdmission('repair', c({ peers: ['partitioned'], leaseHolder: { isSelf: false, reachable: false, lastKnownAgeMs: 2 * H } }))).toEqual({ allowed: true, mode: 'last-known', reason: null });
    // Revoke never refuses under any combination.
    expect(poolAdmission('revoke', c({ suspension: { state: 'none', killSwitch: true }, peers: ['partitioned'], leaseHolder: { isSelf: false, reachable: false, lastKnownAgeMs: null } })).allowed).toBe(true);
  });

  it('lease holder unreachable: ≤24h last-known state is used; older or never ⇒ enroll/prove refuse with passkey-suspension-unknown and repair falls to the override', () => {
    const recent = c({ leaseHolder: { isSelf: false, reachable: false, lastKnownAgeMs: 2 * H } });
    expect(poolAdmission('enroll', recent)).toEqual({ allowed: true, mode: 'last-known', reason: null });
    expect(poolAdmission('enroll', c({ leaseHolder: { isSelf: false, reachable: false, lastKnownAgeMs: 2 * H }, peers: ['partitioned'] }))).toMatchObject({ allowed: false, mode: 'last-known' });
    for (const age of [25 * H, null]) {
      const stale = c({ leaseHolder: { isSelf: false, reachable: false, lastKnownAgeMs: age } });
      expect(poolAdmission('prove', stale)).toEqual({ allowed: false, mode: 'normal', reason: 'passkey-suspension-unknown' });
      expect(poolAdmission('repair', stale)).toEqual({ allowed: true, mode: 'degraded-override', reason: 'lease-holder-unreachable' });
    }
  });
});

describe('PasskeyPoolReader — one query per peer per tick, budgets, last-known rows, exclusion auto-clear', () => {
  let dir: string; let now = T0;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-reader-')); now = T0; });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'passkey-pool-state.test reader' }); });

  const reader = (opts: {
    peers: PasskeyPoolPeer[]; answers: Record<string, () => Promise<PeerStateFetch> | PeerStateFetch>; rope?: Record<string, 'ok' | 'peer-offline' | 'urgent'>; ropeAvailable?: boolean; overallTimeoutMs?: number; memoTtlMs?: number;
  }) => {
    const exclusions = new PasskeyPeerExclusions({ stateDir: dir, now: () => now });
    const calls: string[] = [];
    const r = new PasskeyPoolReader({
      stateDir: dir, selfMachineId: 'm1', now: () => now, memoTtlMs: opts.memoTtlMs,
      localState: () => stateOf('m1', { attempts: [{ canonicalEmail: 'a@example.com', kind: 'proof', at: iso(now - H), machineId: 'm1' }] }),
      listPeers: () => opts.peers,
      fetchPeerState: async (peer) => { calls.push(peer.machineId); const a = opts.answers[peer.machineId]; return a ? a() : { ok: false, reason: 'unreachable' }; },
      ropeCondition: (id) => opts.rope?.[id] ?? null, ropeAvailable: () => opts.ropeAvailable ?? true,
      exclusions, overallTimeoutMs: opts.overallTimeoutMs ?? 200, perPeerTimeoutMs: 100,
    });
    return { r, exclusions, calls };
  };
  const peers = (...ids: string[]): PasskeyPoolPeer[] => ids.map((id) => ({ machineId: id, nickname: null, url: `http://${id}.example`, online: true }));

  it('merges an answering peer as observed, marks a non-answering rope-offline peer peer-offline (rows still count) and a silent rope-ok peer partitioned (degraded)', async () => {
    const m2 = stateOf('m2', { attempts: [{ canonicalEmail: 'a@example.com', kind: 'enrollment', at: iso(T0 - 2 * H), machineId: 'm2' }] });
    const { r, calls } = reader({ peers: peers('m2', 'm3', 'm4'), answers: { m2: () => ({ ok: true, body: m2 }) }, rope: { m3: 'peer-offline', m4: 'ok' } });
    const snap = await r.tick();
    expect(calls.sort()).toEqual(['m2', 'm3', 'm4']);
    expect(snap.peers.map((p) => [p.machineId, p.condition, p.fetch])).toEqual([['m2', 'observed', 'ok'], ['m3', 'peer-offline', 'unreachable'], ['m4', 'partitioned', 'unreachable']]);
    expect(snap.degraded).toBe(true);
    expect(snap.degradedReasons).toEqual(['m4:unreachable:rope-ok']);
    expect(snap.singleMachine).toBe(false);
    expect(poolRows(snap).attempts.map((a) => a.machineId).sort()).toEqual(['m1', 'm2']);
    // A malformed or wrong-machine body is `malformed`, never merged as current: the peer reads
    // partitioned and its LAST-KNOWN rows (from the first tick) stay in force, unchanged.
    const bad = reader({ peers: peers('m2'), answers: { m2: () => ({ ok: true, body: stateOf('m9') }) }, rope: { m2: 'ok' } });
    const badView = (await bad.r.tick()).peers[0];
    expect(badView).toMatchObject({ condition: 'partitioned', fetch: 'malformed', lastObservedAt: iso(T0) });
    expect(badView.state?.machineId).toBe('m2');
    expect(badView.state?.attempts).toHaveLength(1);
  });

  it('keeps each peer\'s LAST-KNOWN rows durably across a restart and counts them while the peer is offline; never for a peer never observed', async () => {
    const m2 = stateOf('m2', { attempts: [{ canonicalEmail: 'a@example.com', kind: 'enrollment', at: iso(T0 - H), machineId: 'm2' }] });
    const first = reader({ peers: peers('m2'), answers: { m2: () => ({ ok: true, body: m2 }) } });
    await first.r.tick();
    expect(fs.existsSync(path.join(dir, PASSKEY_POOL_LASTKNOWN_FILE))).toBe(true);
    now += 30 * 60_000;
    const second = reader({ peers: peers('m2', 'm3'), answers: {}, rope: { m2: 'peer-offline', m3: 'peer-offline' } });
    const snap = await second.r.tick();
    const p2 = snap.peers.find((p) => p.machineId === 'm2')!;
    expect(p2.condition).toBe('peer-offline');
    expect(p2.state?.attempts).toHaveLength(1);
    expect(p2.lastObservedAt).toBe(iso(T0));
    expect(snap.peers.find((p) => p.machineId === 'm3')).toMatchObject({ condition: 'peer-offline', state: null, lastObservedAt: null, excludeOfferDue: false });
    expect(poolRows(snap).attempts.some((a) => a.machineId === 'm2')).toBe(true);
    // Past 72h unobserved the exclude offer becomes due (a peer never observed is not offered — it may be brand new).
    now = T0 + PEER_UNOBSERVED_EXCLUDE_OFFER_MS + 1;
    const third = reader({ peers: peers('m2'), answers: {}, rope: { m2: 'ok' } });
    expect((await third.r.tick()).peers[0].excludeOfferDue).toBe(true);
  });

  it('an UNREADABLE last-known cache is the restrictive case: silent peers read partitioned (even rope-offline / excluded), the file is never overwritten, and the reason is named', async () => {
    const m2 = stateOf('m2', { pauses: [{ id: 'p', canonicalEmail: 'a@example.com', scope: 'account', reason: 'risk', from: iso(T0), until: iso(T0 + 24 * H), machineId: 'm2' }] });
    const first = reader({ peers: peers('m2'), answers: { m2: () => ({ ok: true, body: m2 }) } });
    await first.r.tick();
    const file = path.join(dir, PASSKEY_POOL_LASTKNOWN_FILE);
    fs.writeFileSync(file, '{"version":1,"peers":{"m2":{"state":{"machineId":"m2"');
    const corrupt = fs.readFileSync(file, 'utf8');
    now += H;
    const second = reader({ peers: peers('m2', 'm3'), answers: {}, rope: { m2: 'peer-offline', m3: 'peer-offline' } });
    second.exclusions.exclude('m3', 'dashboard-pin@m1');
    const snap = await second.r.tick();
    expect(snap.peers.map((p) => [p.machineId, p.condition])).toEqual([['m2', 'partitioned'], ['m3', 'partitioned']]);
    expect(snap.degraded).toBe(true);
    expect(snap.degradedReasons[0]).toBe('last-known-cache-unreadable');
    expect(fs.readFileSync(file, 'utf8')).toBe(corrupt);
    // A wrong-version file is the same case.
    fs.writeFileSync(file, '{"version":7,"peers":{}}');
    expect((await reader({ peers: peers('m2'), answers: {}, rope: { m2: 'peer-offline' } }).r.tick()).degradedReasons[0]).toBe('last-known-cache-unsupported-version');
    // An answering peer is still observed and its rows current, so a repaired pool heals on its own.
    const healthy = reader({ peers: peers('m2'), answers: { m2: () => ({ ok: true, body: m2 }) } });
    expect((await healthy.r.tick()).peers[0].condition).toBe('observed');
  });

  it('an excluded peer reads `excluded` while silent and the exclusion clears automatically the moment it answers', async () => {
    const { r, exclusions } = reader({ peers: peers('m2'), answers: {}, rope: { m2: 'ok' } });
    exclusions.exclude('m2', 'dashboard-pin@m1');
    expect((await r.tick()).peers[0].condition).toBe('excluded');
    expect((await r.tick()).degraded).toBe(false);
    const back = reader({ peers: peers('m2'), answers: { m2: () => ({ ok: true, body: stateOf('m2') }) } });
    back.exclusions.exclude('m2', 'dashboard-pin@m1');
    expect((await back.r.tick()).peers[0].condition).toBe('observed');
    expect(back.exclusions.isExcluded('m2')).toBe(false);
  });

  it('a peer that outlives the overall budget is `timeout` (partitioned), the tick still returns, and a single-flight tick is shared', async () => {
    const slow = () => new Promise<PeerStateFetch>((resolve) => setTimeout(() => resolve({ ok: true, body: stateOf('m3') }), 2_000));
    const { r, calls } = reader({ peers: peers('m2', 'm3'), answers: { m2: () => ({ ok: true, body: stateOf('m2') }), m3: slow }, rope: { m3: 'ok' }, overallTimeoutMs: 150 });
    const [a, b] = await Promise.all([r.tick(), r.tick()]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c === 'm3')).toHaveLength(1);
    expect(a.peers.find((p) => p.machineId === 'm3')).toMatchObject({ condition: 'partitioned', fetch: 'timeout' });
    expect(a.peers.find((p) => p.machineId === 'm2')?.condition).toBe('observed');
  }, 10_000);

  it('read() serves the memo within its TTL (no peer traffic) and re-ticks after; a single-machine agent is never degraded', async () => {
    const { r, calls } = reader({ peers: peers('m2'), answers: { m2: () => ({ ok: true, body: stateOf('m2') }) }, memoTtlMs: 60_000 });
    expect(r.memoView()).toEqual({ snapshot: null, ageMs: null });
    await r.read(); await r.read();
    expect(calls).toHaveLength(1);
    now += 61_000;
    await r.read();
    expect(calls).toHaveLength(2);
    expect(r.memoView().ageMs).toBe(0);
    const solo = reader({ peers: [], answers: {} });
    const snap = await solo.r.tick();
    expect(snap).toMatchObject({ singleMachine: true, degraded: false, peers: [] });
  });
});
