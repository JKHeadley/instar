/**
 * Step 6 — CredentialLocationResolver: the single read-side chokepoint for "which slot is this
 * account in?". The load-bearing property is NO-OP WHILE DARK: with the feature disabled (the
 * shipped default), every method returns exactly today's behavior, so re-routing the ~12 census
 * consumers through it changes nothing until the deliberate two-flag flip.
 */

import { describe, it, expect } from 'vitest';
import { CredentialLocationResolver, type CredentialRepointingConfigView } from '../../src/core/CredentialLocationResolver.js';

/** A fake ledger read-surface with controllable seeded/unknown state + a slot map. */
function fakeLedger(opts: { seeded?: boolean; unknown?: boolean; slots?: Record<string, string>; tenants?: Record<string, string> } = {}) {
  const slots = opts.slots ?? {};
  const tenants = opts.tenants ?? {};
  return {
    slotOf: (accountId: string) => slots[accountId] ?? null,
    tenantOf: (slot: string) => tenants[slot] ?? null,
    isSeeded: () => opts.seeded ?? false,
    isUnknownMode: () => opts.unknown ?? false,
  };
}

const HOME_A = '/h/.claude'; // enrollment home for account A
const SLOT_X = '/h/.claude-x'; // where the ledger says A currently lives

describe('CredentialLocationResolver — no-op while dark', () => {
  it('disabled (shipped default) → slotForAccount returns the enrollment home, tenantForSlot null', () => {
    const cfg: CredentialRepointingConfigView = { enabled: false, dryRun: true };
    const r = new CredentialLocationResolver({
      ledger: fakeLedger({ seeded: true, slots: { 'acct-a': SLOT_X }, tenants: { [SLOT_X]: 'acct-a' } }),
      config: () => cfg,
    });
    expect(r.active()).toBe(false);
    expect(r.isEnabled()).toBe(false);
    expect(r.slotForAccount('acct-a', HOME_A)).toBe(HOME_A); // today's behavior, NOT the ledger slot
    expect(r.tenantForSlot(SLOT_X)).toBeNull();
  });

  it('absent config block → treated as disabled', () => {
    const r = new CredentialLocationResolver({
      ledger: fakeLedger({ seeded: true, slots: { 'acct-a': SLOT_X } }),
      config: () => undefined,
    });
    expect(r.active()).toBe(false);
    expect(r.slotForAccount('acct-a', HOME_A)).toBe(HOME_A);
  });

  it('enabled but ledger UNSEEDED → today\'s behavior', () => {
    const r = new CredentialLocationResolver({
      ledger: fakeLedger({ seeded: false, slots: { 'acct-a': SLOT_X } }),
      config: () => ({ enabled: true, dryRun: true }),
    });
    expect(r.active()).toBe(false);
    expect(r.slotForAccount('acct-a', HOME_A)).toBe(HOME_A);
  });

  it('enabled but ledger UNKNOWN mode → today\'s behavior (fail-closed for reads)', () => {
    const r = new CredentialLocationResolver({
      ledger: fakeLedger({ seeded: true, unknown: true, slots: { 'acct-a': SLOT_X } }),
      config: () => ({ enabled: true, dryRun: true }),
    });
    expect(r.active()).toBe(false);
    expect(r.slotForAccount('acct-a', HOME_A)).toBe(HOME_A);
    expect(r.tenantForSlot(SLOT_X)).toBeNull();
  });
});

describe('CredentialLocationResolver — active (enabled + seeded)', () => {
  it('resolves an account to its CURRENT ledger slot, and a slot to its ledger tenant', () => {
    const r = new CredentialLocationResolver({
      ledger: fakeLedger({ seeded: true, slots: { 'acct-a': SLOT_X }, tenants: { [SLOT_X]: 'acct-a' } }),
      config: () => ({ enabled: true, dryRun: false }),
    });
    expect(r.active()).toBe(true);
    expect(r.slotForAccount('acct-a', HOME_A)).toBe(SLOT_X); // the ledger location, not the enrollment home
    expect(r.tenantForSlot(SLOT_X)).toBe('acct-a');
  });

  it('active but account not in the ledger → falls back to the enrollment home', () => {
    const r = new CredentialLocationResolver({
      ledger: fakeLedger({ seeded: true, slots: {} }),
      config: () => ({ enabled: true, dryRun: false }),
    });
    expect(r.slotForAccount('acct-a', HOME_A)).toBe(HOME_A);
  });

  it('reads the config LIVE each call (a flip is honored without reconstructing the resolver)', () => {
    let cfg: CredentialRepointingConfigView = { enabled: false };
    const r = new CredentialLocationResolver({
      ledger: fakeLedger({ seeded: true, slots: { 'acct-a': SLOT_X } }),
      config: () => cfg,
    });
    expect(r.slotForAccount('acct-a', HOME_A)).toBe(HOME_A); // dark
    cfg = { enabled: true }; // operator flips it on
    expect(r.slotForAccount('acct-a', HOME_A)).toBe(SLOT_X); // now resolves live
  });
});
