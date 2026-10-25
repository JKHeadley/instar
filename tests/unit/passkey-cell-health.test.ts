import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  PasskeyDigestLedger, PasskeyHealthStore, advancePasskeyHealthClocks, applyPasskeyProofOutcome, buildPasskeyHealthDigest,
  newPasskeyCellHealth, proofDue, PASSKEY_HEALTH_AUDIT_LOG, type PasskeyCellHealthRecord, type PasskeyProofOutcome,
} from '../../src/core/PasskeyCellHealth.js';

// Spec docs/specs/agent-held-google-passkey.md §4 (state table, pool-read-degraded clocks, flapping),
// §13 (self-heal brakes), §5.2 (the one digest item, buzz rules).

const H = 60 * 60_000; const D = 24 * H;
const T0 = Date.parse('2026-09-23T12:00:00.000Z');

function drive(cell: PasskeyCellHealthRecord, steps: Array<{ outcome: PasskeyProofOutcome; at: number; origin?: 'watcher' | 'operator' | 'canary' | 'repair' | 'enrollment'; reenrolled?: boolean }>) {
  const transitions: string[] = [];
  let c = cell;
  for (const s of steps) {
    const r = applyPasskeyProofOutcome({ cell: c, outcome: s.outcome, origin: s.origin ?? 'watcher', nowMs: s.at, reenrolled: s.reenrolled });
    c = r.cell;
    if (r.transition) transitions.push(`${r.transition.from}->${r.transition.to}:${r.transition.cause}`);
  }
  return { cell: c, transitions };
}

describe('applyPasskeyProofOutcome — the §4 table', () => {
  const fresh = () => newPasskeyCellHealth('a@example.com', 'm1', T0);

  it('a single failed proof arms the 1h confirming proof (§13) and does NOT degrade; a confirmed failure degrades; a later ready heals', () => {
    const first = applyPasskeyProofOutcome({ cell: fresh(), outcome: 'failed', origin: 'watcher', nowMs: T0 });
    expect(first.transition).toBeNull();
    expect(first.cell.state).toBe('healthy');
    expect(first.scheduleConfirmAt).toBe(new Date(T0 + H).toISOString());
    expect(first.cell.nextProofDueAt).toBe(new Date(T0 + H).toISOString());
    // A confirming failure BEFORE the hour does not count (single retry, 1h later); one within the 90m window does.
    const early = applyPasskeyProofOutcome({ cell: first.cell, outcome: 'failed', origin: 'watcher', nowMs: T0 + 10 * 60_000 });
    expect(early.transition).toBeNull();
    // …and it keeps the ORIGINAL anchor (max-attempts 2 / 90m): failing fast can never re-arm the window.
    expect(early.cell.pendingConfirmFailedAt).toBe(first.cell.pendingConfirmFailedAt);
    expect(early.scheduleConfirmAt).toBeNull();
    const fastLoop = drive(first.cell, [30, 60, 65].map((m) => ({ outcome: 'failed' as const, at: T0 + m * 60_000 })));
    expect(fastLoop.transitions).toEqual(['healthy->degraded:confirmed-failure']);
    const confirmed = applyPasskeyProofOutcome({ cell: first.cell, outcome: 'failed', origin: 'watcher', nowMs: T0 + H + 5 * 60_000 });
    expect(confirmed.transition).toMatchObject({ from: 'healthy', to: 'degraded', cause: 'confirmed-failure' });
    expect(confirmed.cell.consecutiveConfirmedFailures).toBe(1);
    // Past the 90m wall-clock the second failure is a NEW first failure, not a confirmation.
    const late = applyPasskeyProofOutcome({ cell: first.cell, outcome: 'failed', origin: 'watcher', nowMs: T0 + 2 * H });
    expect(late.transition).toBeNull();
    expect(late.scheduleConfirmAt).not.toBeNull();
    const healed = applyPasskeyProofOutcome({ cell: confirmed.cell, outcome: 'ready', origin: 'watcher', nowMs: T0 + D });
    expect(healed.transition).toMatchObject({ from: 'degraded', to: 'healthy' });
    expect(healed.cell.consecutiveConfirmedFailures).toBe(0);
    expect(healed.cell.nextProofDueAt).toBe(new Date(T0 + 8 * D).toISOString());
  });

  it('three consecutive weekly confirmed failures open the breaker; only an operator proof or re-enrollment closes it', () => {
    const steps = [] as Array<{ outcome: PasskeyProofOutcome; at: number; origin?: 'watcher' | 'operator' }>;
    for (let w = 0; w < 3; w++) steps.push({ outcome: 'failed', at: T0 + w * 7 * D }, { outcome: 'failed', at: T0 + w * 7 * D + H });
    const { cell, transitions } = drive(fresh(), steps);
    expect(transitions).toEqual(['healthy->degraded:confirmed-failure', 'degraded->breaker-open:three-confirmed-failures']);
    expect(cell.nextProofDueAt).toBeNull();
    expect(proofDue(cell, T0 + 100 * D)).toBe(false);
    const auto = applyPasskeyProofOutcome({ cell, outcome: 'ready', origin: 'watcher', nowMs: T0 + 30 * D });
    expect(auto.transition).toBeNull();
    expect(auto.cell.state).toBe('breaker-open');
    const op = applyPasskeyProofOutcome({ cell, outcome: 'ready', origin: 'operator', nowMs: T0 + 30 * D });
    expect(op.transition).toMatchObject({ to: 'healthy', cause: 'operator-proof-ready' });
    const re = applyPasskeyProofOutcome({ cell, outcome: 'ready', origin: 'enrollment', reenrolled: true, nowMs: T0 + 30 * D });
    expect(re.transition).toMatchObject({ to: 'healthy', cause: 'reenrolled' });
  });

  it('unknowns: three consecutive ⇒ unverified with 7-day backoff; each further unknown doubles 7→14→28 (cap); three at the cap ⇒ unverified-stopped; a ready heals any time before that', () => {
    const three = drive(fresh(), [0, 1, 2].map((i) => ({ outcome: 'unknown' as const, at: T0 + i * 7 * D })));
    expect(three.transitions).toEqual(['healthy->unverified:three-consecutive-unknown']);
    expect(three.cell.nextProofDueAt).toBe(new Date(T0 + 14 * D + 7 * D).toISOString());
    let c = three.cell; let t = T0 + 21 * D;
    const dueDays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = applyPasskeyProofOutcome({ cell: c, outcome: 'unknown', origin: 'watcher', nowMs: t });
      c = r.cell; dueDays.push(Math.round((Date.parse(c.nextProofDueAt!) - t) / D)); t = Date.parse(c.nextProofDueAt!);
      expect(r.transition).toBeNull();
    }
    expect(dueDays).toEqual([14, 28, 28, 28]);
    // A `failed` while unverified is recorded but never shortens the ladder into a 1h confirm (no table row).
    const failedWhileUnverified = applyPasskeyProofOutcome({ cell: c, outcome: 'failed', origin: 'watcher', nowMs: t });
    expect(failedWhileUnverified.transition).toBeNull();
    expect(failedWhileUnverified.scheduleConfirmAt).toBeNull();
    expect(failedWhileUnverified.cell.nextProofDueAt).toBe(c.nextProofDueAt);
    const stopped = applyPasskeyProofOutcome({ cell: c, outcome: 'unknown', origin: 'watcher', nowMs: t });
    expect(stopped.transition).toMatchObject({ from: 'unverified', to: 'unverified-stopped', cause: 'three-unknown-at-cap' });
    expect(stopped.cell.nextProofDueAt).toBeNull();
    // Automatic proofs stop; an operator proof that is ready restores healthy.
    expect(applyPasskeyProofOutcome({ cell: stopped.cell, outcome: 'ready', origin: 'watcher', nowMs: t + D }).transition).toBeNull();
    expect(applyPasskeyProofOutcome({ cell: stopped.cell, outcome: 'ready', origin: 'operator', nowMs: t + D }).transition).toMatchObject({ to: 'healthy' });
    // Before stopping, a ready heals unverified directly and resets the ladder.
    const healed = applyPasskeyProofOutcome({ cell: c, outcome: 'ready', origin: 'watcher', nowMs: t });
    expect(healed.transition).toMatchObject({ from: 'unverified', to: 'healthy' });
    expect(healed.cell.unknownBackoffIndex).toBe(0);
  });

  it('credential-rejected ⇒ rejected (no immediate retry, weekly retry on the backoff); removed-on-google never counts; a ready heals rejected', () => {
    const rej = applyPasskeyProofOutcome({ cell: fresh(), outcome: 'credential-rejected', origin: 'repair', nowMs: T0 });
    expect(rej.transition).toMatchObject({ to: 'rejected', cause: 'credential-rejected' });
    expect(rej.cell.nextProofDueAt).toBe(new Date(T0 + 7 * D).toISOString());
    const removed = applyPasskeyProofOutcome({ cell: fresh(), outcome: 'removed-on-google', origin: 'watcher', nowMs: T0 });
    expect(removed.transition).toBeNull();
    expect(removed.cell.state).toBe('healthy');
    expect(removed.cell.lastProofOutcome).toBe('removed-on-google');
    expect(applyPasskeyProofOutcome({ cell: rej.cell, outcome: 'ready', origin: 'canary', nowMs: T0 + 7 * D }).transition).toMatchObject({ from: 'rejected', to: 'healthy' });
    // A rejected cell's failures do not start the confirm dance, and unknowns keep it REJECTED (the
    // "Google rejected this key" fact is never overwritten by unverified) while riding the backoff.
    expect(applyPasskeyProofOutcome({ cell: rej.cell, outcome: 'failed', origin: 'watcher', nowMs: T0 + 7 * D }).transition).toBeNull();
    const stillRejected = drive(rej.cell, [1, 2, 3, 4].map((i) => ({ outcome: 'unknown' as const, at: T0 + i * 7 * D })));
    expect(stillRejected.transitions).toEqual([]);
    expect(stillRejected.cell.state).toBe('rejected');
    expect(stillRejected.cell.consecutiveUnknown).toBe(4);
  });

  it('security wins from every state and only a re-enrollment leaves it (an operator ready is not enough)', () => {
    for (const start of ['healthy', 'degraded', 'unverified', 'breaker-open', 'unverified-stopped', 'rejected'] as const) {
      const cell = { ...fresh(), state: start };
      const r = applyPasskeyProofOutcome({ cell, outcome: 'security', origin: 'repair', nowMs: T0 });
      expect(r.transition, start).toMatchObject({ from: start, to: 'security' });
      expect(r.cell.nextProofDueAt).toBeNull();
    }
    const sec = applyPasskeyProofOutcome({ cell: fresh(), outcome: 'security', origin: 'repair', nowMs: T0 }).cell;
    expect(applyPasskeyProofOutcome({ cell: sec, outcome: 'ready', origin: 'operator', nowMs: T0 + D }).transition).toBeNull();
    expect(applyPasskeyProofOutcome({ cell: sec, outcome: 'failed', origin: 'watcher', nowMs: T0 + D }).cell.state).toBe('security');
    expect(applyPasskeyProofOutcome({ cell: sec, outcome: 'ready', origin: 'enrollment', reenrolled: true, nowMs: T0 + D }).transition).toMatchObject({ from: 'security', to: 'healthy', cause: 'reenrolled' });
  });

  it('flapping: three healthy↔degraded flips within 30 days set the flag (a flag, never a state); old flips age out', () => {
    const steps: Array<{ outcome: PasskeyProofOutcome; at: number }> = [];
    let t = T0;
    for (let i = 0; i < 2; i++) { steps.push({ outcome: 'failed', at: t }, { outcome: 'failed', at: t + H }, { outcome: 'ready', at: t + D }); t += 2 * D; }
    const { cell, transitions } = drive(fresh(), steps);
    expect(transitions.filter((x) => x.includes('flapping')).length).toBe(0);
    expect(cell.flapping).toBe(true);
    expect(cell.state).toBe('healthy');
    // Flips older than 30 days no longer count toward a NEW flag.
    const old = { ...fresh(), flips: [new Date(T0 - 40 * D).toISOString(), new Date(T0 - 35 * D).toISOString()] };
    const r = drive(old, [{ outcome: 'failed', at: T0 }, { outcome: 'failed', at: T0 + H }]);
    expect(r.cell.flapping).toBe(false);
  });
});

describe('advancePasskeyHealthClocks — the 21-day rule and the pool-degraded pause', () => {
  it('no ready for 21 days ⇒ unverified; the clock PAUSES while the pool read path is degraded for the account and resumes after', () => {
    const cell = newPasskeyCellHealth('a@example.com', 'm1', T0);
    expect(advancePasskeyHealthClocks({ cell, nowMs: T0 + 20 * D, poolDegraded: false }).transition).toBeNull();
    expect(advancePasskeyHealthClocks({ cell, nowMs: T0 + 21 * D, poolDegraded: false }).transition).toMatchObject({ to: 'unverified', cause: 'no-ready-21-days' });
    // Degraded from day 10 to day 20: the 21-day clock is paused for those 10 days.
    const paused = advancePasskeyHealthClocks({ cell, nowMs: T0 + 10 * D, poolDegraded: true }).cell;
    expect(paused.clocksPausedSince).toBe(new Date(T0 + 10 * D).toISOString());
    expect(advancePasskeyHealthClocks({ cell: paused, nowMs: T0 + 25 * D, poolDegraded: true }).transition).toBeNull();
    const resumed = advancePasskeyHealthClocks({ cell: paused, nowMs: T0 + 20 * D, poolDegraded: false });
    expect(resumed.transition).toBeNull();
    expect(resumed.cell.pausedMs).toBe(10 * D);
    expect(advancePasskeyHealthClocks({ cell: resumed.cell, nowMs: T0 + 30 * D, poolDegraded: false }).transition).toBeNull();
    expect(advancePasskeyHealthClocks({ cell: resumed.cell, nowMs: T0 + 31 * D, poolDegraded: false }).transition).toMatchObject({ to: 'unverified' });
    // A ready resets the anchor and the paused time.
    const ready = applyPasskeyProofOutcome({ cell: resumed.cell, outcome: 'ready', origin: 'watcher', nowMs: T0 + 25 * D }).cell;
    expect(ready.pausedMs).toBe(0);
    expect(advancePasskeyHealthClocks({ cell: ready, nowMs: T0 + 45 * D, poolDegraded: false }).transition).toBeNull();
    // Terminal / rejected states are not moved by the clock.
    const rej = { ...cell, state: 'rejected' as const };
    expect(advancePasskeyHealthClocks({ cell: rej, nowMs: T0 + 40 * D, poolDegraded: false }).transition).toBeNull();
  });
});

describe('PasskeyHealthStore — durable records, transitions audited as states only', () => {
  let dir: string; let now = T0;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-health-')); now = T0; });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'passkey-cell-health.test' }); });

  it('creates a cell healthy-and-due on first sight, records outcomes, audits transitions without the email, fails closed on a corrupt file', () => {
    const store = new PasskeyHealthStore({ stateDir: dir, machineId: 'm1', now: () => now });
    expect(store.ensure('a@example.com')).toMatchObject({ state: 'healthy', machineId: 'm1' });
    expect(proofDue(store.get('a@example.com')!, now)).toBe(true);
    store.recordOutcome({ canonicalEmail: 'a@example.com', outcome: 'failed', origin: 'watcher' });
    now += H;
    const r = store.recordOutcome({ canonicalEmail: 'a@example.com', outcome: 'failed', origin: 'watcher' });
    expect(r.transition?.to).toBe('degraded');
    expect(store.get('a@example.com')?.state).toBe('degraded');
    const audit = fs.readFileSync(path.join(dir, PASSKEY_HEALTH_AUDIT_LOG), 'utf8');
    expect(audit).toContain('"to":"degraded"');
    expect(audit).not.toContain('a@example.com');
    store.setGoogleSide('a@example.com', 'pending-operator');
    expect(store.get('a@example.com')?.googleSide).toBe('pending-operator');
    // Google-side state is set on an EXISTING record only — never minted for a cell never held here.
    expect(store.setGoogleSide('never@example.com', 'operator-attested')).toBeNull();
    expect(store.get('never@example.com')).toBeNull();
    now += 30 * D;
    const moved = store.advanceClocks(() => false);
    expect(moved.map((t) => t.to)).toEqual(['unverified']);
    expect(store.remove('a@example.com')).toBe(true);
    expect(store.remove('a@example.com')).toBe(false);
    fs.writeFileSync(path.join(dir, 'state', 'passkey-health.json'), '{"version":1,"cells":[]}');
    expect(() => store.list()).toThrow('passkey-health-corrupt');
    // A record whose state is outside the closed set is corrupt too (it would fall through the table).
    fs.writeFileSync(path.join(dir, 'state', 'passkey-health.json'), JSON.stringify({ version: 1, cells: { 'x@example.com': { ...newPasskeyCellHealth('x@example.com', 'm1', now), state: 'bogus' } } }));
    expect(() => store.get('x@example.com')).toThrow('passkey-health-corrupt');
  });
});

describe('buildPasskeyHealthDigest + PasskeyDigestLedger — one item, honest buzz rules', () => {
  let dir: string; let now = T0;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-digest-')); now = T0; });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'passkey-cell-health.test digest' }); });
  const base = { pendingRevokes: [], chromeGateFailures: [], suspension: null, unobservedPeers: [], poolDegraded: false, nowIso: new Date(T0).toISOString() };
  const line = (state: 'healthy' | 'degraded' | 'security' | 'rejected', email = 'a@example.com', extra: Record<string, unknown> = {}) => ({ canonicalEmail: email, machineId: 'm1', state, googleSide: 'none' as const, detail: '', ...extra });

  it('lists only cells that need a human, plus pending revokes, gate failures, suspension and peers; healthy cells produce an empty digest', () => {
    expect(buildPasskeyHealthDigest({ ...base, cells: [line('healthy')] }).empty).toBe(true);
    const d = buildPasskeyHealthDigest({ ...base, cells: [line('healthy'), line('degraded', 'b@example.com', { flapping: true, poolDegraded: true }), line('healthy', 'c@example.com', { googleSide: 'pending-operator' })], pendingRevokes: [{ canonicalEmail: 'b@example.com', targetMachineId: 'm2', state: 'pending', attempts: 3 }], unobservedPeers: ['m3'] });
    expect(d.empty).toBe(false);
    expect(d.counts).toEqual({ cells: 2, pendingRevokes: 1, chromeGateFailures: 0, unobservedPeers: 1 });
    expect(d.body).toContain('b@example.com on m1: degraded (flapping; not proved: pool degraded)');
    expect(d.body).toContain('c@example.com on m1: healthy (google-side: pending-operator)');
    expect(d.body).toContain('b@example.com → m2: pending, 3 attempt(s)');
    expect(d.body).toContain('Peers unobserved by the pool read path: m3');
    expect(d.urgent).toBe(false);
    expect(buildPasskeyHealthDigest({ ...base, cells: [line('security')] })).toMatchObject({ urgent: true, title: expect.stringContaining('SECURITY') });
    expect(buildPasskeyHealthDigest({ ...base, cells: [], suspension: { state: 'suspended' } })).toMatchObject({ urgent: true, empty: false });
  });

  it('buzzes on new content, then at most once per 24h; a peer-list change alone is silent; security buzzes regardless; an empty digest resolves once', () => {
    const ledger = new PasskeyDigestLedger({ stateDir: dir, now: () => now });
    const d1 = buildPasskeyHealthDigest({ ...base, cells: [line('degraded')] });
    expect(ledger.decide(d1)).toBe('buzz');
    ledger.record(d1, 'buzz');
    expect(ledger.decide(d1)).toBe('none');
    const d2 = buildPasskeyHealthDigest({ ...base, cells: [line('degraded'), line('rejected', 'b@example.com')], nowIso: new Date(T0 + H).toISOString() });
    expect(ledger.decide(d2)).toBe('silent');
    ledger.record(d2, 'silent');
    const peersOnly = buildPasskeyHealthDigest({ ...base, cells: [line('degraded'), line('rejected', 'b@example.com')], unobservedPeers: ['m9'], nowIso: new Date(T0 + 2 * H).toISOString() });
    expect(ledger.decide(peersOnly)).toBe('silent');
    now = T0 + 25 * H;
    expect(ledger.decide(d2)).toBe('buzz');
    const sec = buildPasskeyHealthDigest({ ...base, cells: [line('security')] });
    now = T0 + 26 * H; ledger.record(d2, 'buzz');
    expect(ledger.decide(sec)).toBe('buzz');
    ledger.record(sec, 'buzz');
    // While a security line STANDS, an unrelated delta (a new degraded cell) is silent inside the floor;
    // a CHANGE to the security section itself (a second cell) buzzes per tick.
    const secPlusDegraded = buildPasskeyHealthDigest({ ...base, cells: [line('security'), line('degraded', 'z@example.com')] });
    expect(ledger.decide(secPlusDegraded)).toBe('silent');
    ledger.record(secPlusDegraded, 'silent');
    const twoSecurity = buildPasskeyHealthDigest({ ...base, cells: [line('security'), line('security', 'y@example.com')] });
    expect(ledger.decide(twoSecurity)).toBe('buzz');
    ledger.record(twoSecurity, 'buzz');
    const empty = buildPasskeyHealthDigest({ ...base, cells: [line('healthy')] });
    expect(ledger.decide(empty)).toBe('resolve');
    ledger.record(empty, 'resolve');
    expect(ledger.decide(empty)).toBe('none');
    // After a resolve, the same content coming back is a new episode — but the 24h floor still
    // applies (the last buzz was the security one moments ago): silent now, buzz once the floor passes.
    expect(ledger.decide(d1)).toBe('silent');
    now = T0 + 51 * H;
    expect(ledger.decide(d1)).toBe('buzz');
    // An unreadable ledger DENIES buzzing (it cannot know the last buzz time) until a record rewrites it.
    fs.writeFileSync(path.join(dir, 'state', 'passkey-health-digest.json'), '{not json');
    expect(ledger.read().unreadable).toBe(true);
    expect(ledger.decide(buildPasskeyHealthDigest({ ...base, cells: [line('security', 'q@example.com')] }))).toBe('silent');
    ledger.record(d1, 'silent');
    expect(ledger.read().unreadable).toBeUndefined();
  });
});
