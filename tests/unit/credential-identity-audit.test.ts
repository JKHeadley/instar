/**
 * Unit test for the NON-DESTRUCTIVE periodic identity audit (`CredentialLocationLedger.auditIdentities`).
 *
 * WHY THIS EXISTS (the bug it closes): the credential rebalancer's every objective (wall-rescue
 * AND the use-it-or-lose-it drain) only acts on a DESTINATION slot that passes `targetVerifiedRecent`
 * = lastVerifiedAt within `auditCadenceMs` (default 6h). Nothing refreshed lastVerifiedAt after seed
 * (`markVerified` had zero callers; the only periodic loop never re-verified), so every slot decayed
 * to "not recently verified" and the optimizer went permanently inert. `auditIdentities()` is the
 * missing scheduled re-verification.
 *
 * Both sides of every decision boundary (Testing Integrity — semantic correctness):
 *  - healthy + oracle re-confirms same tenant   → refreshed (lastVerifiedAt advances)
 *  - quarantined + now resolves cleanly         → recovered (assignment restored, un-quarantined)
 *  - healthy + oracle confirms a DIFFERENT acct → diverged-quarantined (safe direction)
 *  - healthy + oracle unavailable (transient)   → unavailable-held (NEVER quarantine a healthy slot)
 *  - healthy + ambiguous email                  → unverifiable-quarantined
 *  - healthy + unknown email                    → unverifiable-quarantined
 *  - already-quarantined + still unavailable    → still-quarantined (no spurious recovery)
 *  - UNKNOWN mode                               → no-op empty report
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  CredentialLocationLedger,
  type IdentityOracle,
  type IdentityOracleResult,
  type LedgerPoolView,
  type LedgerPoolAccount,
} from '../../src/core/CredentialLocationLedger.js';

/** A mutable, scriptable oracle — its response map can be swapped between seed and audit. */
function mutableOracle(initial: Record<string, IdentityOracleResult>, opts?: { throwOn?: () => string | null }) {
  let map = initial;
  const oracle: IdentityOracle = {
    async resolveSlotTenant(slot: string): Promise<IdentityOracleResult> {
      if (opts?.throwOn?.() === slot) throw new Error('oracle boom');
      return map[slot] ?? { unavailable: true, reason: 'no script' };
    },
  };
  return { oracle, set: (next: Record<string, IdentityOracleResult>) => { map = next; } };
}

function poolFrom(accounts: LedgerPoolAccount[]): LedgerPoolView {
  return { list: () => accounts.slice() };
}

let tmp: string;
let counter: number;
const seq = () => `2026-06-16T00:00:${String(counter++).padStart(2, '0')}.000Z`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'credaudit-'));
  counter = 0;
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/credential-identity-audit.test.ts cleanup' });
});

function makeLedger(pool: LedgerPoolView, oracle: IdentityOracle): CredentialLocationLedger {
  return new CredentialLocationLedger({ stateDir: tmp, pool, oracle, now: seq });
}

const POOL = poolFrom([
  { id: 'justin-gmail', email: 'justin@gmail.com', configHome: '/h/justin' },
  { id: 'adriana', email: 'adriana@x.com', configHome: '/h/adriana' },
]);

describe('CredentialLocationLedger.auditIdentities — refresh (the core fix)', () => {
  it('re-stamps lastVerifiedAt on a healthy slot the oracle re-confirms', async () => {
    const { oracle } = mutableOracle({
      '/h/justin': { email: 'justin@gmail.com' },
      '/h/adriana': { email: 'adriana@x.com' },
    });
    const led = makeLedger(POOL, oracle);
    await led.seedFromOracle();
    const seededAt = led.getAssignment('/h/justin')!.lastVerifiedAt;
    expect(seededAt).not.toBeNull();

    const report = await led.auditIdentities();

    const out = report.outcomes.find((o) => o.slot === '/h/justin')!;
    expect(out.result).toBe('refreshed');
    expect(report.refreshed).toBe(2);
    const refreshedAt = led.getAssignment('/h/justin')!.lastVerifiedAt;
    expect(refreshedAt).not.toBeNull();
    // The audit advanced the freshness stamp (later than seed) — the whole point.
    expect(Date.parse(refreshedAt!)).toBeGreaterThan(Date.parse(seededAt!));
    expect(led.getAssignment('/h/justin')!.quarantined).toBe(false);
  });
});

describe('CredentialLocationLedger.auditIdentities — quarantine exit (recovery)', () => {
  it('recovers a slot that was seed-quarantined once it resolves cleanly', async () => {
    // Seed with the oracle unavailable for adriana → that slot quarantines.
    const m = mutableOracle({
      '/h/justin': { email: 'justin@gmail.com' },
      '/h/adriana': { unavailable: true, reason: 'down at seed' },
    });
    const led = makeLedger(POOL, m.oracle);
    await led.seedFromOracle();
    expect(led.getAssignment('/h/adriana')!.quarantined).toBe(true);
    expect(led.getAssignment('/h/adriana')!.accountId).toBe('');

    // Oracle recovers → audit should restore + un-quarantine.
    m.set({ '/h/justin': { email: 'justin@gmail.com' }, '/h/adriana': { email: 'adriana@x.com' } });
    const report = await led.auditIdentities();

    const out = report.outcomes.find((o) => o.slot === '/h/adriana')!;
    expect(out.result).toBe('recovered');
    expect(report.recovered).toBe(1);
    expect(led.getAssignment('/h/adriana')!.quarantined).toBe(false);
    expect(led.getAssignment('/h/adriana')!.accountId).toBe('adriana');
    expect(led.getAssignment('/h/adriana')!.lastVerifiedAt).not.toBeNull();
  });
});

describe('CredentialLocationLedger.auditIdentities — divergence (safe direction)', () => {
  it('quarantines a healthy slot whose credential now belongs to a DIFFERENT account', async () => {
    const m = mutableOracle({
      '/h/justin': { email: 'justin@gmail.com' },
      '/h/adriana': { email: 'adriana@x.com' },
    });
    const led = makeLedger(POOL, m.oracle);
    await led.seedFromOracle();

    // /h/justin's blob now resolves to adriana's email (a client write-back swapped the login).
    m.set({ '/h/justin': { email: 'adriana@x.com' }, '/h/adriana': { email: 'adriana@x.com' } });
    const report = await led.auditIdentities();

    const out = report.outcomes.find((o) => o.slot === '/h/justin')!;
    expect(out.result).toBe('diverged-quarantined');
    expect(led.getAssignment('/h/justin')!.quarantined).toBe(true);
    expect(report.quarantined).toBeGreaterThanOrEqual(1);
  });
});

describe('CredentialLocationLedger.auditIdentities — transient unavailability is HELD, never quarantined', () => {
  it('holds a healthy slot when the oracle is unavailable (does NOT demote it)', async () => {
    const m = mutableOracle({
      '/h/justin': { email: 'justin@gmail.com' },
      '/h/adriana': { email: 'adriana@x.com' },
    });
    const led = makeLedger(POOL, m.oracle);
    await led.seedFromOracle();
    const beforeAt = led.getAssignment('/h/justin')!.lastVerifiedAt;

    // Oracle goes down for justin on the audit pass.
    m.set({ '/h/justin': { unavailable: true, reason: 'timeout' }, '/h/adriana': { email: 'adriana@x.com' } });
    const report = await led.auditIdentities();

    const out = report.outcomes.find((o) => o.slot === '/h/justin')!;
    expect(out.result).toBe('unavailable-held');
    // Critically: still healthy, NOT quarantined — a transient blip must not break balancing.
    expect(led.getAssignment('/h/justin')!.quarantined).toBe(false);
    expect(led.getAssignment('/h/justin')!.lastVerifiedAt).toBe(beforeAt); // unchanged (not re-stamped)
  });

  it('treats an oracle that THROWS identically to unavailable (held, not quarantined)', async () => {
    let throwSlot: string | null = null;
    const m = mutableOracle(
      { '/h/justin': { email: 'justin@gmail.com' }, '/h/adriana': { email: 'adriana@x.com' } },
      { throwOn: () => throwSlot },
    );
    const led = makeLedger(POOL, m.oracle);
    await led.seedFromOracle();
    throwSlot = '/h/justin';
    const report = await led.auditIdentities();
    expect(report.outcomes.find((o) => o.slot === '/h/justin')!.result).toBe('unavailable-held');
    expect(led.getAssignment('/h/justin')!.quarantined).toBe(false);
  });
});

describe('CredentialLocationLedger.auditIdentities — unverifiable email quarantines', () => {
  it('quarantines a healthy slot whose email became AMBIGUOUS (≥2 pool accounts)', async () => {
    const dupPool = poolFrom([
      { id: 'justin-gmail', email: 'shared@x.com', configHome: '/h/justin' },
      { id: 'justin-2', email: 'shared@x.com', configHome: '/h/justin2' },
      { id: 'adriana', email: 'adriana@x.com', configHome: '/h/adriana' },
    ]);
    // Seed cleanly first (distinct emails), then make justin's email collide.
    const m = mutableOracle({ '/h/justin': { email: 'uniq@x.com' }, '/h/justin2': { email: 'other@x.com' }, '/h/adriana': { email: 'adriana@x.com' } });
    const seedPool = poolFrom([
      { id: 'justin-gmail', email: 'uniq@x.com', configHome: '/h/justin' },
      { id: 'justin-2', email: 'other@x.com', configHome: '/h/justin2' },
      { id: 'adriana', email: 'adriana@x.com', configHome: '/h/adriana' },
    ]);
    const led = new CredentialLocationLedger({ stateDir: tmp, pool: seedPool, oracle: m.oracle, now: seq });
    await led.seedFromOracle();
    expect(led.getAssignment('/h/justin')!.quarantined).toBe(false);
    // Re-point the SAME ledger's pool view by rebuilding with the dup pool would change identity;
    // instead simulate the audit pool returning shared emails via a fresh ledger over the same dir.
    const led2 = new CredentialLocationLedger({ stateDir: tmp, pool: dupPool, oracle: mutableOracle({ '/h/justin': { email: 'shared@x.com' }, '/h/justin2': { email: 'shared@x.com' }, '/h/adriana': { email: 'adriana@x.com' } }).oracle, now: seq });
    const report = await led2.auditIdentities();
    expect(report.outcomes.find((o) => o.slot === '/h/justin')!.result).toBe('unverifiable-quarantined');
    expect(led2.getAssignment('/h/justin')!.quarantined).toBe(true);
  });

  it('quarantines a healthy slot whose email matches NO pool account (unknown-email)', async () => {
    const m = mutableOracle({ '/h/justin': { email: 'justin@gmail.com' }, '/h/adriana': { email: 'adriana@x.com' } });
    const led = makeLedger(POOL, m.oracle);
    await led.seedFromOracle();
    m.set({ '/h/justin': { email: 'stranger@nowhere.com' }, '/h/adriana': { email: 'adriana@x.com' } });
    const report = await led.auditIdentities();
    expect(report.outcomes.find((o) => o.slot === '/h/justin')!.result).toBe('unverifiable-quarantined');
    expect(led.getAssignment('/h/justin')!.quarantined).toBe(true);
  });
});

describe('CredentialLocationLedger.auditIdentities — already-quarantined stays quarantined', () => {
  it('does not spuriously recover a quarantined slot the oracle still cannot resolve', async () => {
    const m = mutableOracle({ '/h/justin': { email: 'justin@gmail.com' }, '/h/adriana': { unavailable: true } });
    const led = makeLedger(POOL, m.oracle);
    await led.seedFromOracle();
    expect(led.getAssignment('/h/adriana')!.quarantined).toBe(true);
    const report = await led.auditIdentities();
    expect(report.outcomes.find((o) => o.slot === '/h/adriana')!.result).toBe('still-quarantined');
    expect(led.getAssignment('/h/adriana')!.quarantined).toBe(true);
  });
});

describe('CredentialLocationLedger.auditIdentities — report aggregate + getter', () => {
  it('counts a mixed pass and retains the last report', async () => {
    const m = mutableOracle({ '/h/justin': { email: 'justin@gmail.com' }, '/h/adriana': { unavailable: true } });
    const led = makeLedger(POOL, m.oracle);
    await led.seedFromOracle(); // justin healthy, adriana quarantined
    m.set({ '/h/justin': { email: 'justin@gmail.com' }, '/h/adriana': { email: 'adriana@x.com' } });
    const report = await led.auditIdentities(); // justin refreshed, adriana recovered
    expect(report.refreshed).toBe(1);
    expect(report.recovered).toBe(1);
    expect(report.quarantined).toBe(0);
    expect(led.getLastAuditReport()).toEqual(report);
  });

  it('is a no-op (empty report) in UNKNOWN mode', async () => {
    // Corrupt the on-disk store to force UNKNOWN mode.
    const m = mutableOracle({ '/h/justin': { email: 'justin@gmail.com' } });
    const led = makeLedger(poolFrom([{ id: 'justin-gmail', email: 'justin@gmail.com', configHome: '/h/justin' }]), m.oracle);
    await led.seedFromOracle();
    fs.writeFileSync(path.join(tmp, 'credential-locations.json'), '{ not valid json');
    const led2 = makeLedger(poolFrom([{ id: 'justin-gmail', email: 'justin@gmail.com', configHome: '/h/justin' }]), m.oracle);
    expect(led2.isUnknownMode()).toBe(true);
    const report = await led2.auditIdentities();
    expect(report.outcomes).toEqual([]);
    expect(report.refreshed).toBe(0);
  });
});
