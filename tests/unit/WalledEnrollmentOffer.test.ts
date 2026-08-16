/**
 * Tier-1 tests for the §5A walled-machine enrollment-offer STUB (spec:
 * cross-machine-account-quota-sharing.md §5A, D14/D16): detect walled → surface an
 * operator offer; idempotent per spell; NEVER blocks; no credential minting.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  detectWalledMachines,
  WalledEnrollmentOfferStub,
} from '../../src/core/WalledEnrollmentOffer.js';
import type { MachineCapacity } from '../../src/core/types.js';

function mc(p: Partial<MachineCapacity> & { machineId: string }): MachineCapacity {
  return { online: true, clockSkewStatus: 'ok', ...p } as MachineCapacity;
}

describe('detectWalledMachines', () => {
  it('flags an online machine with no non-walled account', () => {
    const walled = detectWalledMachines([
      mc({ machineId: 'a', canServe: { hasNonWalledAccount: false } }),
      mc({ machineId: 'b', canServe: { hasNonWalledAccount: true } }),
    ]);
    expect(walled.map((w) => w.machineId)).toEqual(['a']);
  });

  it('an offline walled machine is NOT offered (it ages out)', () => {
    const walled = detectWalledMachines([mc({ machineId: 'a', online: false, canServe: { hasNonWalledAccount: false } })]);
    expect(walled).toEqual([]);
  });

  it('falls back to raw quotaState for an older peer with no canServe summary', () => {
    const walled = detectWalledMachines([mc({ machineId: 'a', quotaState: { blocked: true } })]);
    expect(walled.map((w) => w.machineId)).toEqual(['a']);
  });
});

describe('WalledEnrollmentOfferStub.sweep', () => {
  function makeStub(opts: { enabled?: boolean; dryRun?: boolean } = {}) {
    const surfaceOffer = vi.fn(async () => ({}));
    const stub = new WalledEnrollmentOfferStub({
      isEnabled: () => opts.enabled ?? true,
      isDryRun: () => opts.dryRun ?? false,
      surfaceOffer,
      audit: vi.fn(),
      now: () => 1_000_000,
    });
    return { stub, surfaceOffer };
  }

  it('surfaces ONE offer per walled machine, NO credential minting', async () => {
    const { stub, surfaceOffer } = makeStub();
    const r = await stub.sweep([mc({ machineId: 'a', canServe: { hasNonWalledAccount: false } })]);
    expect(r.surfaced).toEqual(['a']);
    expect(surfaceOffer).toHaveBeenCalledTimes(1);
    // The offer carries NO secret VALUE — only id/title/summary/machineId metadata.
    const arg = surfaceOffer.mock.calls[0][0];
    expect(arg.id).toBe('serve-failover:enroll-offer:a');
    expect(Object.keys(arg).sort()).toEqual(['id', 'machineId', 'nickname', 'summary', 'title']);
    // It must not carry any token/oauth field name (the summary may MENTION the word
    // "credential" — "no credential is copied" — which is the safety reassurance, fine).
    expect(JSON.stringify(arg)).not.toMatch(/oauth|access_?token|refresh_?token|secret/i);
  });

  it('idempotent within a spell: a second sweep does NOT re-offer the same machine', async () => {
    const { stub, surfaceOffer } = makeStub();
    await stub.sweep([mc({ machineId: 'a', canServe: { hasNonWalledAccount: false } })]);
    const r2 = await stub.sweep([mc({ machineId: 'a', canServe: { hasNonWalledAccount: false } })]);
    expect(r2.surfaced).toEqual([]);
    expect(surfaceOffer).toHaveBeenCalledTimes(1);
  });

  it('recovery re-arms: machine recovers then walls again ⇒ a fresh offer', async () => {
    const { stub, surfaceOffer } = makeStub();
    await stub.sweep([mc({ machineId: 'a', canServe: { hasNonWalledAccount: false } })]);
    await stub.sweep([mc({ machineId: 'a', canServe: { hasNonWalledAccount: true } })]); // recovered
    const r3 = await stub.sweep([mc({ machineId: 'a', canServe: { hasNonWalledAccount: false } })]); // walled again
    expect(r3.surfaced).toEqual(['a']);
    expect(surfaceOffer).toHaveBeenCalledTimes(2);
  });

  it('STRICT no-op when disabled', async () => {
    const { stub, surfaceOffer } = makeStub({ enabled: false });
    const r = await stub.sweep([mc({ machineId: 'a', canServe: { hasNonWalledAccount: false } })]);
    expect(r.surfaced).toEqual([]);
    expect(surfaceOffer).not.toHaveBeenCalled();
  });

  it('dry-run: detects but does not surface', async () => {
    const { stub, surfaceOffer } = makeStub({ dryRun: true });
    const r = await stub.sweep([mc({ machineId: 'a', canServe: { hasNonWalledAccount: false } })]);
    expect(r.surfaced).toEqual([]);
    expect(surfaceOffer).not.toHaveBeenCalled();
  });

  it('never throws even if surfaceOffer rejects (never blocks)', async () => {
    const surfaceOffer = vi.fn(async () => { throw new Error('attention down'); });
    const stub = new WalledEnrollmentOfferStub({ isEnabled: () => true, isDryRun: () => false, surfaceOffer, now: () => 1 });
    const r = await stub.sweep([mc({ machineId: 'a', canServe: { hasNonWalledAccount: false } })]);
    expect(r.surfaced).toEqual([]);
    // a failed surface clears the flag so a later sweep retries.
    const r2 = await stub.sweep([mc({ machineId: 'a', canServe: { hasNonWalledAccount: false } })]);
    expect(surfaceOffer).toHaveBeenCalledTimes(2);
    expect(r2).toBeDefined();
  });
});
