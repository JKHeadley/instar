/**
 * Unit tests for WS5.2 Step 6 — census consumer re-routing through the CredentialLocationGate.
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §2.2 (the consumer census table).
 *
 * Every re-routed consumer is proven on THREE axes (the load-bearing safety contract):
 *   (a) flag OFF                      → today's enrollment-home behavior (byte-identical);
 *   (b) flag ON + ledger KNOWN        → resolves through the ledger;
 *   (c) flag ON + ledger UNKNOWN/EMPTY → falls back to today's behavior (back-compat).
 * Plus the four adversarial-lens regressions:
 *   - E4a-liar: InUseAccountResolver does NOT re-probe `auth status` when enabled + busts cache;
 *   - competing-writer: writeCredentialsSerialized REFUSES at the manager when slot is owned;
 *   - hot-path safety: an UNKNOWN-mode read returns the fallback + attention, never throws;
 *   - dark-ship inertness: the gate-absent path allocates nothing / behaves exactly as today.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  CredentialLocationLedger,
  type IdentityOracle,
  type LedgerPoolView,
  type LedgerPoolAccount,
  type CredentialLedgerAttentionInput,
} from '../../src/core/CredentialLocationLedger.js';
import {
  CredentialLocationGate,
  type CredentialGateAttentionInput,
} from '../../src/core/CredentialLocationGate.js';
import { credentialSlotKey } from '../../src/core/OAuthRefresher.js';
import { QuotaPoller, type FetchImpl } from '../../src/core/QuotaPoller.js';
import { InUseAccountResolver } from '../../src/core/InUseAccountResolver.js';
import { SubscriptionPool, type SubscriptionAccount } from '../../src/core/SubscriptionPool.js';
import {
  writeCredentialsSerialized,
  setCredentialWriteRefusalGate,
  CredentialWriteRepointingOwnedError,
} from '../../src/monitoring/CredentialProvider.js';
import { CredentialWriteFunnel } from '../../src/core/CredentialWriteFunnel.js';

const noopOracle: IdentityOracle = { async resolveSlotTenant() { return { unavailable: true }; } };
function poolView(accounts: LedgerPoolAccount[]): LedgerPoolView {
  return { list: () => accounts.slice() };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'credgate-'));
});
afterEach(() => {
  setCredentialWriteRefusalGate(undefined);
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'credential-location-gate.test cleanup' });
});

/** A ledger with one assignment recorded for `slot → accountId` (seeded, known). */
function ledgerWith(slot: string, accountId: string): CredentialLocationLedger {
  const ledger = new CredentialLocationLedger({ stateDir: tmp, pool: poolView([]), oracle: noopOracle });
  ledger.recordAssignment(slot, accountId);
  return ledger;
}

/** A never-seeded ledger (empty assignments) — the back-compat case. */
function emptyLedger(): CredentialLocationLedger {
  return new CredentialLocationLedger({ stateDir: tmp, pool: poolView([]), oracle: noopOracle });
}

/** A ledger forced into UNKNOWN mode via a corrupt on-disk file. */
function unknownLedger(): CredentialLocationLedger {
  fs.writeFileSync(path.join(tmp, 'credential-locations.json'), '{ this is not json');
  return new CredentialLocationLedger({ stateDir: tmp, pool: poolView([]), oracle: noopOracle });
}

// ── The gate itself ────────────────────────────────────────────────────────────────────────

describe('CredentialLocationGate — slotForAccount / tenantForSlot', () => {
  it('(a) flag OFF → returns the enrollment home / null (byte-identical to today)', () => {
    const gate = new CredentialLocationGate({ isEnabled: () => false, ledger: ledgerWith('/home/acct-b', 'acct-a') });
    expect(gate.slotForAccount('acct-a', '/enroll/acct-a')).toBe('/enroll/acct-a');
    expect(gate.tenantForSlot('/home/acct-b')).toBeNull();
  });

  it('(b) flag ON + ledger KNOWN → resolves through the ledger', () => {
    const gate = new CredentialLocationGate({ isEnabled: () => true, ledger: ledgerWith('/slot/now', 'acct-a') });
    expect(gate.slotForAccount('acct-a', '/enroll/acct-a')).toBe('/slot/now');
    expect(gate.tenantForSlot('/slot/now')).toBe('acct-a');
  });

  it('(c) flag ON + ledger never-seeded → falls back to today (back-compat), no attention', () => {
    const seen: CredentialGateAttentionInput[] = [];
    const gate = new CredentialLocationGate({ isEnabled: () => true, ledger: emptyLedger(), emitAttention: (i) => void seen.push(i) });
    expect(gate.slotForAccount('acct-a', '/enroll/acct-a')).toBe('/enroll/acct-a');
    expect(gate.tenantForSlot('/slot/x')).toBeNull();
    expect(seen).toHaveLength(0); // never-seeded is NORMAL, not a degradation
  });

  it('hot-path safety: UNKNOWN mode → fallback + ONE deduped HIGH attention, never throws', () => {
    const seen: CredentialGateAttentionInput[] = [];
    const gate = new CredentialLocationGate({ isEnabled: () => true, ledger: unknownLedger(), emitAttention: (i) => void seen.push(i) });
    expect(() => gate.slotForAccount('acct-a', '/enroll/acct-a')).not.toThrow();
    expect(gate.slotForAccount('acct-a', '/enroll/acct-a')).toBe('/enroll/acct-a');
    expect(gate.tenantForSlot('/slot/x')).toBeNull();
    // Many reads → ONE attention item (deduped per process).
    gate.slotForAccount('acct-a', '/enroll/acct-a');
    gate.tenantForSlot('/slot/x');
    expect(seen).toHaveLength(1);
    expect(seen[0].priority).toBe('HIGH');
  });

  it('hot-path safety: a THROWING attention emitter never escapes the read', () => {
    const gate = new CredentialLocationGate({
      isEnabled: () => true,
      ledger: unknownLedger(),
      emitAttention: () => { throw new Error('telegram down'); },
    });
    expect(() => gate.slotForAccount('acct-a', '/enroll/acct-a')).not.toThrow();
  });

  it('touchesDefaultHome canonicalizes spellings of ~/.claude', () => {
    expect(CredentialLocationGate.touchesDefaultHome('~/.claude')).toBe(true);
    expect(CredentialLocationGate.touchesDefaultHome(credentialSlotKey('~/.claude'))).toBe(true);
    expect(CredentialLocationGate.touchesDefaultHome('/some/other/home')).toBe(false);
  });
});

// ── Census #1–#4: QuotaPoller ────────────────────────────────────────────────────────────────

function acct(over: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return {
    id: 'acct-a',
    nickname: 'A',
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: '/enroll/acct-a',
    status: 'active',
    ...over,
  } as SubscriptionAccount;
}
const OK_BODY = {
  five_hour: { utilization: 10, resets_at: '2026-06-07T00:20:00Z' },
  seven_day: { utilization: 71, resets_at: '2026-06-12T18:59:59Z' },
};
const okFetch: FetchImpl = async () => ({ ok: true, status: 200, json: async () => OK_BODY });

describe('QuotaPoller census #1 (token read) — slot re-routing', () => {
  it('(a) flag OFF → token resolver sees the enrollment home unchanged', async () => {
    const gate = new CredentialLocationGate({ isEnabled: () => false, ledger: ledgerWith('/slot/now', 'acct-a') });
    const seenHomes: string[] = [];
    const poller = new QuotaPoller({
      pool: new SubscriptionPool({ stateDir: tmp }),
      fetchImpl: okFetch,
      tokenResolver: (a) => { seenHomes.push(a.configHome); return 'sk-ant-oat-x'; },
      locationGate: gate,
    });
    await poller.pollAccount(acct());
    expect(seenHomes).toEqual(['/enroll/acct-a']);
  });

  it('(b) flag ON + ledger KNOWN → token resolver sees the LIVE slot, account.id preserved', async () => {
    const gate = new CredentialLocationGate({ isEnabled: () => true, ledger: ledgerWith('/slot/now', 'acct-a') });
    const seenHomes: string[] = [];
    const poller = new QuotaPoller({
      pool: new SubscriptionPool({ stateDir: tmp }),
      fetchImpl: okFetch,
      tokenResolver: (a) => { seenHomes.push(a.configHome); expect(a.id).toBe('acct-a'); return 'sk-ant-oat-x'; },
      locationGate: gate,
    });
    await poller.pollAccount(acct());
    expect(seenHomes).toEqual(['/slot/now']);
  });

  it('(c) flag ON + ledger never-seeded → enrollment home (back-compat)', async () => {
    const gate = new CredentialLocationGate({ isEnabled: () => true, ledger: emptyLedger() });
    const seenHomes: string[] = [];
    const poller = new QuotaPoller({
      pool: new SubscriptionPool({ stateDir: tmp }),
      fetchImpl: okFetch,
      tokenResolver: (a) => { seenHomes.push(a.configHome); return 'sk-ant-oat-x'; },
      locationGate: gate,
    });
    await poller.pollAccount(acct());
    expect(seenHomes).toEqual(['/enroll/acct-a']);
  });
});

describe('QuotaPoller census #2 (401-refresh) — slot re-routing', () => {
  it('flag ON + ledger KNOWN → refresher sees the LIVE slot', async () => {
    const gate = new CredentialLocationGate({ isEnabled: () => true, ledger: ledgerWith('/slot/now', 'acct-a') });
    const seenHomes: string[] = [];
    let call = 0;
    const fetchImpl: FetchImpl = async () => (call++ === 0
      ? { ok: false, status: 401, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => OK_BODY });
    const poller = new QuotaPoller({
      pool: new SubscriptionPool({ stateDir: tmp }),
      fetchImpl,
      tokenResolver: () => 'sk-ant-oat-x',
      refresher: async (a) => { seenHomes.push(a.configHome); return { ok: true, accessToken: 'sk-ant-oat-fresh' }; },
      locationGate: gate,
    });
    await poller.pollAccount(acct());
    expect(seenHomes).toEqual(['/slot/now']);
  });
});

describe('QuotaPoller census #3 (email auto-patch) — SUPPRESSED while enabled', () => {
  it('flag ON → no email auto-patch (suppressed)', async () => {
    const pool = new SubscriptionPool({ stateDir: tmp });
    pool.add({ id: 'acct-a', nickname: 'A', provider: 'anthropic', framework: 'claude-code', configHome: tmp, email: 'old@x.com' } as never);
    const gate = new CredentialLocationGate({ isEnabled: () => true, ledger: ledgerWith(tmp, 'acct-a') });
    // .claude.json in tmp records a DIFFERENT email — today this would be auto-patched.
    fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'observed@y.com' } }));
    const updateSpy = vi.spyOn(pool, 'update');
    const poller = new QuotaPoller({ pool, fetchImpl: okFetch, tokenResolver: () => 'sk-ant-oat-x', locationGate: gate });
    await poller.pollAll();
    const patchedEmail = updateSpy.mock.calls.some((c) => (c[1] as Record<string, unknown>).email !== undefined);
    expect(patchedEmail).toBe(false); // suppressed — no cross-contamination
  });

  it('flag OFF → email auto-patch happens (today\'s behavior preserved)', async () => {
    const pool = new SubscriptionPool({ stateDir: tmp });
    pool.add({ id: 'acct-a', nickname: 'A', provider: 'anthropic', framework: 'claude-code', configHome: tmp, email: 'old@x.com' } as never);
    const gate = new CredentialLocationGate({ isEnabled: () => false, ledger: ledgerWith(tmp, 'acct-a') });
    fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'observed@y.com' } }));
    const updateSpy = vi.spyOn(pool, 'update');
    const poller = new QuotaPoller({ pool, fetchImpl: okFetch, tokenResolver: () => 'sk-ant-oat-x', locationGate: gate });
    await poller.pollAll();
    const patchedEmail = updateSpy.mock.calls.some((c) => (c[1] as Record<string, unknown>).email === 'observed@y.com');
    expect(patchedEmail).toBe(true);
  });
});

// ── Census #8: InUseAccountResolver (the E4a liar) ──────────────────────────────────────────

describe('InUseAccountResolver census #8 — E4a-liar resurrection BLOCKER', () => {
  const accounts: SubscriptionAccount[] = [
    { id: 'acct-a', email: 'a@x.com', provider: 'anthropic', framework: 'claude-code' } as SubscriptionAccount,
    { id: 'acct-b', email: 'b@x.com', provider: 'anthropic', framework: 'claude-code' } as SubscriptionAccount,
  ];

  it('flag ON + ledger KNOWN → resolves from the ledger, NEVER re-probes auth status', async () => {
    const probe = vi.fn(async () => 'a@x.com'); // the LYING oracle, would say acct-a
    const gate = new CredentialLocationGate({ isEnabled: () => true, ledger: ledgerWith('~/.claude', 'acct-b') });
    const resolver = new InUseAccountResolver({ probe, locationGate: gate });
    const res = await resolver.resolve(accounts);
    expect(res.activeAccountId).toBe('acct-b'); // the LEDGER's tenant, not the liar's acct-a
    expect(res.activeEmail).toBe('b@x.com');
    expect(probe).not.toHaveBeenCalled(); // THE blocker: no re-probe at all
  });

  it('flag OFF → re-probes auth status exactly as today', async () => {
    const probe = vi.fn(async () => 'a@x.com');
    const gate = new CredentialLocationGate({ isEnabled: () => false, ledger: ledgerWith('~/.claude', 'acct-b') });
    const resolver = new InUseAccountResolver({ probe, locationGate: gate });
    const res = await resolver.resolve(accounts);
    expect(res.activeAccountId).toBe('acct-a');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('flag ON + ledger never-seeded → falls through to the probe (back-compat)', async () => {
    const probe = vi.fn(async () => 'a@x.com');
    const gate = new CredentialLocationGate({ isEnabled: () => true, ledger: emptyLedger() });
    const resolver = new InUseAccountResolver({ probe, locationGate: gate });
    const res = await resolver.resolve(accounts);
    expect(res.activeAccountId).toBe('acct-a');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('bustCache clears a cached probe result so the next read re-resolves', async () => {
    let n = 0;
    const probe = vi.fn(async () => (n++ === 0 ? 'a@x.com' : 'b@x.com'));
    const resolver = new InUseAccountResolver({ probe, ttlMs: 60_000 });
    expect((await resolver.resolve(accounts)).activeAccountId).toBe('acct-a');
    expect((await resolver.resolve(accounts)).activeAccountId).toBe('acct-a'); // cached
    resolver.bustCache();
    expect((await resolver.resolve(accounts)).activeAccountId).toBe('acct-b'); // re-probed
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

// ── Census #9: competing-writer refusal at the MANAGER ──────────────────────────────────────

describe('writeCredentialsSerialized census #9 — competing-writer clobber BLOCKER', () => {
  const fakeProvider = { writeCredentials: vi.fn(async () => {}) };

  it('REFUSES at the manager when the slot is repointing-owned (no write occurs)', async () => {
    setCredentialWriteRefusalGate({ shouldRefuse: (slot) => slot === credentialSlotKey('~/.claude') });
    const funnel = new CredentialWriteFunnel();
    await expect(
      writeCredentialsSerialized(fakeProvider, '~/.claude', { accessToken: 'x', expiresAt: 0 }, funnel),
    ).rejects.toBeInstanceOf(CredentialWriteRepointingOwnedError);
    expect(fakeProvider.writeCredentials).not.toHaveBeenCalled();
  });

  it('a non-owned slot writes through normally', async () => {
    fakeProvider.writeCredentials.mockClear();
    setCredentialWriteRefusalGate({ shouldRefuse: (slot) => slot === credentialSlotKey('~/.claude') });
    const funnel = new CredentialWriteFunnel();
    const out = await writeCredentialsSerialized(fakeProvider, '/other/home', { accessToken: 'x', expiresAt: 0 }, funnel);
    expect(out.ran).toBe(true);
    expect(fakeProvider.writeCredentials).toHaveBeenCalledTimes(1);
  });

  it('dark-ship inertness: NO refusal gate installed → write proceeds (today\'s behavior)', async () => {
    fakeProvider.writeCredentials.mockClear();
    setCredentialWriteRefusalGate(undefined);
    const funnel = new CredentialWriteFunnel();
    const out = await writeCredentialsSerialized(fakeProvider, '~/.claude', { accessToken: 'x', expiresAt: 0 }, funnel);
    expect(out.ran).toBe(true);
    expect(fakeProvider.writeCredentials).toHaveBeenCalledTimes(1);
  });
});
