/**
 * Step 5c — CredentialSwapExecutor.recoverInFlight(): boot-recovery of a swap interrupted by a
 * crash. The oracle here is KEYCHAIN-BACKED (it reports the email of the blob actually in a slot),
 * so the partial-state recovery paths are exercised realistically. Recovery WRITES run under the
 * single-mover + per-slot locks; staging is freed ONLY when both slots verify the intended state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialSwapExecutor } from '../../src/core/CredentialSwapExecutor.js';
import { CredentialLocationLedger, type IdentityOracle, type LedgerPoolView } from '../../src/core/CredentialLocationLedger.js';
import { CredentialSwapJournal } from '../../src/core/CredentialSwapJournal.js';
import { CredentialWriteFunnel } from '../../src/core/CredentialWriteFunnel.js';
import { slotService, stagingService, type KeychainIO } from '../../src/core/CredentialKeychainIO.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SLOT_A = '/h/.claude-a';
const SLOT_B = '/h/.claude-b';
const ACCT_A = 'acct-a';
const ACCT_B = 'acct-b';
const EMAIL_A = 'a@example.co';
const EMAIL_B = 'b@example.co';
const SVC_A = slotService(SLOT_A);
const SVC_B = slotService(SLOT_B);
const SVC_OF: Record<string, string> = { [SLOT_A]: SVC_A, [SLOT_B]: SVC_B };
const EMAIL_OF: Record<string, string> = { [ACCT_A]: EMAIL_A, [ACCT_B]: EMAIL_B };
const STAGING = stagingService('recov-1');

function blobFor(account: string, tag = ''): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `sk-ant-oat0-${account}${tag}`, refreshToken: `sk-ant-ort0-${account}${tag}`, email: EMAIL_OF[account] },
  });
}

function fakeKeychain(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  const io: KeychainIO = {
    read: async (s) => map.get(s) ?? null,
    write: async (s, raw) => { map.set(s, raw); return true; },
    delete: async (s) => { map.delete(s); },
  };
  return { io, map };
}

/** Oracle that reflects the blob ACTUALLY in each slot (parses its email). */
function keychainOracle(kc: ReturnType<typeof fakeKeychain>): IdentityOracle {
  return {
    resolveSlotTenant: async (slot) => {
      const raw = await kc.io.read(SVC_OF[slot]);
      if (!raw) return { unavailable: true };
      try {
        const e = (JSON.parse(raw) as { claudeAiOauth?: { email?: unknown } }).claudeAiOauth?.email;
        return typeof e === 'string' && e ? { email: e } : { unavailable: true };
      } catch {
        return { unavailable: true };
      }
    },
  };
}

const POOL: LedgerPoolView = {
  list: () => [
    { id: ACCT_A, email: EMAIL_A, configHome: SLOT_A, framework: 'claude-code' },
    { id: ACCT_B, email: EMAIL_B, configHome: SLOT_B, framework: 'claude-code' },
  ],
};

describe('CredentialSwapExecutor.recoverInFlight', () => {
  let dir: string;
  let clock: number;
  const now = () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString();

  function makeLedger(slotATenant: string, slotBTenant: string): CredentialLocationLedger {
    const led = new CredentialLocationLedger({
      stateDir: dir, pool: POOL, oracle: { resolveSlotTenant: async () => ({ unavailable: true }) }, now,
    });
    led.recordAssignment(SLOT_A, slotATenant, { verifiedAt: now() });
    led.recordAssignment(SLOT_B, slotBTenant, { verifiedAt: now() });
    return led;
  }

  function makeExecutor(kc: ReturnType<typeof fakeKeychain>, oracle: IdentityOracle, ledger: CredentialLocationLedger, journal: CredentialSwapJournal, funnel?: CredentialWriteFunnel) {
    return new CredentialSwapExecutor({
      ledger, oracle, journal, pool: POOL,
      funnel: funnel ?? new CredentialWriteFunnel(),
      keychain: kc.io, now,
      scheduleReVerify: () => { /* recovery does not schedule */ },
    });
  }

  function journalWith(phase: 'begin' | 'exchanged' | 'committed'): CredentialSwapJournal {
    const j = new CredentialSwapJournal({ stateDir: dir, now });
    j.begin({ swapId: 'recov-1', slotA: SLOT_A, slotB: SLOT_B, accountA: ACCT_A, accountB: ACCT_B, stagingRef: STAGING });
    if (phase !== 'begin') j.advance('recov-1', phase === 'committed' ? 'committed' : 'exchanged');
    return j;
  }

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swaprecov-')); clock = 0; });
  afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'credential-swap-recovery.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ } });

  it('empty journal → no-op', async () => {
    const kc = fakeKeychain({ [SVC_A]: blobFor(ACCT_A), [SVC_B]: blobFor(ACCT_B) });
    const journal = new CredentialSwapJournal({ stateDir: dir, now });
    const exec = makeExecutor(kc, keychainOracle(kc), makeLedger(ACCT_A, ACCT_B), journal, undefined);
    expect(await exec.recoverInFlight()).toEqual([]);
  });

  it('committed + both slots already post-swap → completes (staging freed, journal done)', async () => {
    // 'committed' means the executor already wrote the ledger post-swap + exchanged the keychain;
    // only the delayed re-verify was lost. Keychain + ledger are post-swap; staging retained.
    const kc = fakeKeychain({ [SVC_A]: blobFor(ACCT_B), [SVC_B]: blobFor(ACCT_A), [STAGING]: blobFor(ACCT_A) });
    const ledger = makeLedger(ACCT_B, ACCT_A); // post-swap
    const journal = journalWith('committed');
    const exec = makeExecutor(kc, keychainOracle(kc), ledger, journal, undefined);

    const out = await exec.recoverInFlight();
    expect(out).toEqual([{ swapId: 'recov-1', resolution: 'completed' }]);
    expect(kc.map.has(STAGING)).toBe(false);
    expect(journal.inFlight()).toHaveLength(0);
    expect(ledger.tenantOf(SLOT_A)).toBe(ACCT_B);
    expect(ledger.tenantOf(SLOT_B)).toBe(ACCT_A);
  });

  it('begin + both slots still pre-swap (no exchange took) → aborts (staging freed, ledger unchanged)', async () => {
    const kc = fakeKeychain({ [SVC_A]: blobFor(ACCT_A), [SVC_B]: blobFor(ACCT_B), [STAGING]: blobFor(ACCT_A) });
    const ledger = makeLedger(ACCT_A, ACCT_B); // pre-swap (commit never ran)
    const journal = journalWith('begin');
    const exec = makeExecutor(kc, keychainOracle(kc), ledger, journal, undefined);

    const out = await exec.recoverInFlight();
    expect(out[0].resolution).toBe('aborted-noop');
    expect(kc.map.has(STAGING)).toBe(false);
    expect(ledger.tenantOf(SLOT_A)).toBe(ACCT_A); // unchanged
    expect(ledger.tenantOf(SLOT_B)).toBe(ACCT_B);
  });

  it('exchanged + partial (slotA done, slotB not) → re-drives to the intended state and commits', async () => {
    // Crash after blobB→slotA but before blobA→slotB: slotA holds accountB, slotB still holds
    // accountB (its original blob, not yet overwritten); staging holds accountA. Recovery re-drives.
    const kc = fakeKeychain({ [SVC_A]: blobFor(ACCT_B), [SVC_B]: blobFor(ACCT_B), [STAGING]: blobFor(ACCT_A) });
    const ledger = makeLedger(ACCT_A, ACCT_B); // pre-swap (commit never ran)
    const journal = journalWith('exchanged');
    const exec = makeExecutor(kc, keychainOracle(kc), ledger, journal, undefined);

    const out = await exec.recoverInFlight();
    expect(out[0].resolution).toBe('re-driven');
    expect(kc.map.get(SVC_A)).toBe(blobFor(ACCT_B)); // slotA = accountB
    expect(kc.map.get(SVC_B)).toBe(blobFor(ACCT_A)); // slotB = accountA (from staging)
    expect(kc.map.has(STAGING)).toBe(false);
    expect(ledger.tenantOf(SLOT_A)).toBe(ACCT_B);
    expect(ledger.tenantOf(SLOT_B)).toBe(ACCT_A);
    expect(journal.inFlight()).toHaveLength(0);
  });

  it('oracle unavailable (an unreadable slot) → quarantines + retains staging (no guess)', async () => {
    // slotB blob is missing → the keychain oracle reports unavailable for slotB.
    const kc = fakeKeychain({ [SVC_A]: blobFor(ACCT_B), [STAGING]: blobFor(ACCT_A) });
    const ledger = makeLedger(ACCT_A, ACCT_B);
    const journal = journalWith('committed');
    const exec = makeExecutor(kc, keychainOracle(kc), ledger, journal, undefined);

    const out = await exec.recoverInFlight();
    expect(out[0].resolution).toBe('deferred-oracle-unavailable');
    expect(out[0].quarantined).toContain(SLOT_B);
    expect(ledger.getAssignment(SLOT_B)?.quarantined).toBe(true);
    expect(kc.map.has(STAGING)).toBe(true); // retained for re-probe
    expect(journal.inFlight()).toHaveLength(1); // not resolved
  });

  it('a live swap holding the single-mover makes recovery report busy (retry next sweep)', async () => {
    const kc = fakeKeychain({ [SVC_A]: blobFor(ACCT_B), [SVC_B]: blobFor(ACCT_A), [STAGING]: blobFor(ACCT_A) });
    const funnel = new CredentialWriteFunnel();
    const ledger = makeLedger(ACCT_B, ACCT_A);
    const journal = journalWith('committed');
    const exec = makeExecutor(kc, keychainOracle(kc), ledger, journal, funnel);

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    void funnel.withSingleMover(() => held); // hold the mover
    await new Promise((r) => setTimeout(r, 5));

    const out = await exec.recoverInFlight();
    expect(out[0].resolution).toBe('busy');
    expect(kc.map.has(STAGING)).toBe(true); // untouched while busy
    release();
  });
});
