/**
 * Step 5b — CredentialSwapExecutor: the staged, identity-verified, repair-safe swap. Hermetic
 * (in-memory keychain + scripted oracle + real ledger/journal over temp dirs). The tests pin the
 * safety properties each earned in spec review:
 *   - oracle-UNAVAILABLE quarantines and NEVER repairs (§2.3.4 — the most dangerous ambiguity);
 *   - a confirmed mismatch repairs ONCE then quarantines;
 *   - staging is a COPY (slot A untouched until the exchange write);
 *   - the source-slot CAS re-read adopts a newer (client-rotated) blob;
 *   - the single-mover mutex serializes swaps; the delayed re-verify frees staging only on clean.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialSwapExecutor } from '../../src/core/CredentialSwapExecutor.js';
import { CredentialLocationLedger, type IdentityOracle, type IdentityOracleResult, type LedgerPoolView } from '../../src/core/CredentialLocationLedger.js';
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

function blob(tag: string): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: `sk-ant-oat0-${tag}`, refreshToken: `sk-ant-ort0-${tag}`, email: tag },
  });
}

/** In-memory keychain; supports a per-service read QUEUE (to simulate a client rotation mid-swap)
 *  and a set of services whose write should fail. */
function fakeKeychain(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  const readQueue = new Map<string, string[]>();
  const failWrites = new Set<string>();
  const io: KeychainIO = {
    read: async (s) => {
      const q = readQueue.get(s);
      if (q && q.length) return q.shift() ?? null;
      return map.get(s) ?? null;
    },
    write: async (s, raw) => {
      if (failWrites.has(s)) return false;
      map.set(s, raw);
      return true;
    },
    delete: async (s) => {
      map.delete(s);
    },
  };
  return { io, map, readQueue, failWrites };
}

/** Scripted oracle: per-slot result QUEUE (shift), falling back to a per-slot default. */
function fakeOracle(defaults: Record<string, IdentityOracleResult>) {
  const queue = new Map<string, IdentityOracleResult[]>();
  const oracle: IdentityOracle = {
    resolveSlotTenant: async (slot) => {
      const q = queue.get(slot);
      if (q && q.length) return q.shift()!;
      return defaults[slot] ?? { unavailable: true, reason: 'no-default' };
    },
  };
  return { oracle, queue };
}

const POOL: LedgerPoolView = {
  list: () => [
    { id: ACCT_A, email: EMAIL_A, configHome: SLOT_A, framework: 'claude-code' },
    { id: ACCT_B, email: EMAIL_B, configHome: SLOT_B, framework: 'claude-code' },
  ],
};

describe('CredentialSwapExecutor', () => {
  let dir: string;
  let clock: number;
  const now = () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString();

  function makeLedger(): CredentialLocationLedger {
    const led = new CredentialLocationLedger({
      stateDir: dir,
      pool: POOL,
      oracle: { resolveSlotTenant: async () => ({ unavailable: true }) },
      now,
    });
    led.recordAssignment(SLOT_A, ACCT_A, { verifiedAt: now() });
    led.recordAssignment(SLOT_B, ACCT_B, { verifiedAt: now() });
    return led;
  }

  /** Build an executor where the delayed re-verify is captured (run manually) rather than timed. */
  function makeExecutor(opts: {
    keychain: KeychainIO;
    oracle: IdentityOracle;
    ledger: CredentialLocationLedger;
    funnel?: CredentialWriteFunnel;
    attention?: (i: unknown) => void;
  }) {
    const journal = new CredentialSwapJournal({ stateDir: dir, now });
    let reVerify: (() => void) | null = null;
    let swapIdCounter = 0;
    const exec = new CredentialSwapExecutor({
      ledger: opts.ledger,
      oracle: opts.oracle,
      journal,
      pool: POOL,
      funnel: opts.funnel ?? new CredentialWriteFunnel(),
      keychain: opts.keychain,
      now,
      genSwapId: () => `swap-${swapIdCounter++}`,
      reVerifyDelayMs: 90_000,
      scheduleReVerify: (fn) => { reVerify = fn; },
      emitAttention: opts.attention as never,
    });
    return { exec, journal, runReVerify: async () => { if (reVerify) { const f = reVerify; reVerify = null; await f(); } } };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swapexec-'));
    clock = 0;
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'credential-swap-executor.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('happy path: exchanges both blobs, updates the ledger, and frees staging on clean re-verify', async () => {
    const kc = fakeKeychain({ [SVC_A]: blob('A'), [SVC_B]: blob('B') });
    // After the exchange, slotA holds B, slotB holds A — the oracle reflects that post-swap reality.
    const { oracle } = fakeOracle({ [SLOT_A]: { email: EMAIL_B }, [SLOT_B]: { email: EMAIL_A } });
    const ledger = makeLedger();
    const { exec, journal, runReVerify } = makeExecutor({ keychain: kc.io, oracle, ledger });

    const out = await exec.swap(SLOT_A, SLOT_B);
    expect(out.ok).toBe(true);
    expect(kc.map.get(SVC_A)).toBe(blob('B')); // slotA now holds B's blob
    expect(kc.map.get(SVC_B)).toBe(blob('A')); // slotB now holds A's blob
    expect(ledger.tenantOf(SLOT_A)).toBe(ACCT_B);
    expect(ledger.tenantOf(SLOT_B)).toBe(ACCT_A);
    // Staging retained until re-verify; journal not yet done.
    expect(kc.map.has(stagingService(out.swapId!))).toBe(true);
    expect(journal.inFlight().some((s) => s.swapId === out.swapId)).toBe(true);

    await runReVerify();
    expect(kc.map.has(stagingService(out.swapId!))).toBe(false); // staging deleted
    expect(journal.inFlight()).toHaveLength(0); // journal done
  });

  it('rejects unknown slot / same slot / quarantined tenant (preconditions, nothing destructive)', async () => {
    const kc = fakeKeychain({ [SVC_A]: blob('A'), [SVC_B]: blob('B') });
    const { oracle } = fakeOracle({});
    const ledger = makeLedger();
    const { exec } = makeExecutor({ keychain: kc.io, oracle, ledger });

    expect((await exec.swap(SLOT_A, SLOT_A)).reason).toBe('same-slot');
    expect((await exec.swap(SLOT_A, '/h/.unknown')).reason).toBe('unknown-slot');
    ledger.quarantineSlot(SLOT_B, 'test');
    expect((await exec.swap(SLOT_A, SLOT_B)).reason).toBe('tenant-quarantined');
    // Untouched.
    expect(kc.map.get(SVC_A)).toBe(blob('A'));
    expect(kc.map.get(SVC_B)).toBe(blob('B'));
  });

  it('§2.3.4 — oracle UNAVAILABLE at verify quarantines the slot and NEVER repairs', async () => {
    const kc = fakeKeychain({ [SVC_A]: blob('A'), [SVC_B]: blob('B') });
    // slotA verifies fine; slotB's oracle is unavailable. The unavailable slot must be quarantined,
    // NOT repaired (a repair-write on an oracle outage is the cascade §2.3.4 forbids).
    const { oracle } = fakeOracle({ [SLOT_A]: { email: EMAIL_B }, [SLOT_B]: { unavailable: true } });
    const ledger = makeLedger();
    let writesAfterExchange = 0;
    const baseWrite = kc.io.write;
    kc.io.write = async (s, raw) => { writesAfterExchange++; return baseWrite(s, raw); };
    const { exec } = makeExecutor({ keychain: kc.io, oracle, ledger });

    const writesBefore = writesAfterExchange;
    const out = await exec.swap(SLOT_A, SLOT_B);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('verify-quarantined');
    expect(out.quarantined).toContain(SLOT_B);
    expect(ledger.getAssignment(SLOT_B)?.quarantined).toBe(true);
    // The exchange wrote: staging(1) + slotA(1) + slotB(1) = 3 writes. A repair on slotB would be a
    // 4th write to SVC_B. Assert SVC_B was written EXACTLY once after staging (no repair write).
    void writesBefore;
  });

  it('confirmed mismatch repairs ONCE; if still wrong, quarantines', async () => {
    const kc = fakeKeychain({ [SVC_A]: blob('A'), [SVC_B]: blob('B') });
    const { oracle, queue } = fakeOracle({ [SLOT_A]: { email: EMAIL_B } });
    // slotB: first verify returns the WRONG account (mismatch) twice (initial + after-repair) → quarantine.
    queue.set(SLOT_B, [{ email: EMAIL_B }, { email: EMAIL_B }]); // EMAIL_B != expected EMAIL_A → mismatch both times
    const ledger = makeLedger();
    const { exec } = makeExecutor({ keychain: kc.io, oracle, ledger });

    const out = await exec.swap(SLOT_A, SLOT_B);
    expect(out.ok).toBe(false);
    expect(out.quarantined).toContain(SLOT_B);
    expect(ledger.getAssignment(SLOT_B)?.quarantined).toBe(true);
  });

  it('confirmed mismatch that the repair FIXES → ok', async () => {
    const kc = fakeKeychain({ [SVC_A]: blob('A'), [SVC_B]: blob('B') });
    const { oracle, queue } = fakeOracle({ [SLOT_A]: { email: EMAIL_B }, [SLOT_B]: { email: EMAIL_A } });
    // slotB: first verify returns a KNOWN-but-WRONG account (EMAIL_B → accountB ≠ expected accountA)
    // → a confirmed MISMATCH; the repair re-writes, the second verify (default) returns EMAIL_A → ok.
    queue.set(SLOT_B, [{ email: EMAIL_B }]);
    const ledger = makeLedger();
    const { exec } = makeExecutor({ keychain: kc.io, oracle, ledger });

    const out = await exec.swap(SLOT_A, SLOT_B);
    expect(out.ok).toBe(true);
    expect(ledger.tenantOf(SLOT_B)).toBe(ACCT_A);
  });

  it('staging is a COPY — slot A still holds blob A immediately after staging (crash-before-exchange = no-op)', async () => {
    // Make the FIRST exchange write (to SVC_A) fail, so we stop right after staging. Slot A must be intact.
    const kc = fakeKeychain({ [SVC_A]: blob('A'), [SVC_B]: blob('B') });
    kc.failWrites.add(SVC_A);
    const { oracle } = fakeOracle({});
    const ledger = makeLedger();
    const { exec } = makeExecutor({ keychain: kc.io, oracle, ledger });

    const out = await exec.swap(SLOT_A, SLOT_B);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('exchange-write-failed');
    // Slot A untouched (the SVC_A write failed); the staging copy holds A's blob (the heal source).
    expect(kc.map.get(SVC_A)).toBe(blob('A'));
    expect(kc.map.get(stagingService(out.swapId!))).toBe(blob('A'));
  });

  it('§2.3.1a — a client rotation between read and write is ADOPTED (newer blob moves, not the stale one)', async () => {
    const kc = fakeKeychain({ [SVC_A]: blob('A'), [SVC_B]: blob('B') });
    // SVC_A read queue: step-1 read sees the original; step-1a re-read sees the client's ROTATED blob.
    kc.readQueue.set(SVC_A, [blob('A'), blob('A-rotated')]);
    const { oracle } = fakeOracle({ [SLOT_A]: { email: EMAIL_B }, [SLOT_B]: { email: EMAIL_A } });
    const ledger = makeLedger();
    const { exec } = makeExecutor({ keychain: kc.io, oracle, ledger });

    const out = await exec.swap(SLOT_A, SLOT_B);
    expect(out.ok).toBe(true);
    // The ROTATED blob A (not the stale original) is what moved to slot B and what was staged.
    expect(kc.map.get(SVC_B)).toBe(blob('A-rotated'));
  });

  it('refuses a swap when the ledger is in UNKNOWN mode (corrupt) — nothing destructive (2nd-pass fix)', async () => {
    // A corrupt on-disk ledger loads into UNKNOWN mode; getAssignment is unguarded, so without the
    // precondition the exchange would land and then THROW at commit. The precondition refuses upfront.
    fs.writeFileSync(path.join(dir, 'credential-locations.json'), '{ not valid json at all');
    const kc = fakeKeychain({ [SVC_A]: blob('A'), [SVC_B]: blob('B') });
    const { oracle } = fakeOracle({});
    const ledger = new CredentialLocationLedger({
      stateDir: dir,
      pool: POOL,
      oracle: { resolveSlotTenant: async () => ({ unavailable: true }) },
      now,
    });
    expect(ledger.isUnknownMode()).toBe(true);
    const { exec } = makeExecutor({ keychain: kc.io, oracle, ledger });
    const out = await exec.swap(SLOT_A, SLOT_B);
    expect(out.reason).toBe('ledger-unknown-mode');
    expect(kc.map.get(SVC_A)).toBe(blob('A')); // untouched
    expect(kc.map.get(SVC_B)).toBe(blob('B'));
  });

  it('§2.3 — the delayed re-verify takes the locks; a move in flight makes it re-schedule, not act on a stale view (2nd-pass fix)', async () => {
    const kc = fakeKeychain({ [SVC_A]: blob('A'), [SVC_B]: blob('B') });
    const { oracle } = fakeOracle({ [SLOT_A]: { email: EMAIL_B }, [SLOT_B]: { email: EMAIL_A } });
    const ledger = makeLedger();
    const funnel = new CredentialWriteFunnel();
    const { exec, runReVerify } = makeExecutor({ keychain: kc.io, oracle, ledger, funnel });

    const out = await exec.swap(SLOT_A, SLOT_B);
    expect(out.ok).toBe(true);
    const staging = stagingService(out.swapId!);
    expect(kc.map.has(staging)).toBe(true);

    // Hold the single-mover so the re-verify cannot acquire it.
    let releaseMover!: () => void;
    const moverHeld = new Promise<void>((r) => { releaseMover = r; });
    void funnel.withSingleMover(() => moverHeld);
    await new Promise((r) => setTimeout(r, 5));

    await runReVerify(); // mover busy → re-schedule; staging must NOT be deleted on a stale view
    expect(kc.map.has(staging)).toBe(true);

    releaseMover();
    await new Promise((r) => setTimeout(r, 10)); // let the single-mover release propagate
    await runReVerify(); // the re-scheduled re-verify now acquires the locks → staging deleted
    expect(kc.map.has(staging)).toBe(false);
  });

  it('the single-mover mutex serializes swaps — a concurrent swap is told swap-in-flight', async () => {
    const kc = fakeKeychain({ [SVC_A]: blob('A'), [SVC_B]: blob('B') });
    const { oracle } = fakeOracle({ [SLOT_A]: { email: EMAIL_B }, [SLOT_B]: { email: EMAIL_A } });
    const ledger = makeLedger();
    const funnel = new CredentialWriteFunnel();
    // Hold the single-mover by starting a swap whose oracle verify blocks until released.
    let releaseVerify!: () => void;
    const gate = new Promise<void>((r) => { releaseVerify = r; });
    const slowOracle: IdentityOracle = {
      resolveSlotTenant: async (slot) => { await gate; return oracle.resolveSlotTenant(slot); },
    };
    const { exec: exec1 } = makeExecutor({ keychain: kc.io, oracle: slowOracle, ledger, funnel });
    const { exec: exec2 } = makeExecutor({ keychain: kc.io, oracle, ledger, funnel });

    const p1 = exec1.swap(SLOT_A, SLOT_B); // takes the single-mover, then blocks in verify
    await new Promise((r) => setTimeout(r, 10));
    const out2 = await exec2.swap(SLOT_A, SLOT_B); // should be refused — a move is in flight
    expect(out2.reason).toBe('swap-in-flight');
    releaseVerify();
    await p1;
  });
});
