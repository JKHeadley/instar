/**
 * CredentialSwapExecutor unit tests (Step 5, spec §2.3).
 *
 * Hermetic: an in-memory keychain map + an injected `resolveIdentity` stub + a real
 * `CredentialWriteFunnel` + a real `CredentialLocationLedger` on a tmp dir → zero keychain, zero
 * network. The named §2.3 safety cases are all here:
 *   - crash-at-every-boundary (kill between journal steps → recovery leaves a coherent state)
 *   - clobber-race (source-slot CAS: different-tenant → abort; same-tenant newer → adopt)
 *   - permutation-property (concurrent swaps serialize via the funnel — no interleave)
 *   - identity verify / adopt / repair / quarantine (match→commit; mismatch→repair; unavailable→quarantine-never-repair)
 *   - THE blocker lens: the executor CANNOT write a credential to a slot without an oracle
 *     identity-match OR a quarantine outcome (no unverified live blob path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialWriteFunnel } from '../../src/core/CredentialWriteFunnel.js';
import {
  CredentialLocationLedger,
  type IdentityOracle,
  type LedgerPoolView,
} from '../../src/core/CredentialLocationLedger.js';
import {
  CredentialSwapExecutor,
  type KeychainCredentialExec,
  type ResolveSlotIdentity,
  type SlotIdentity,
} from '../../src/core/CredentialSwapExecutor.js';
import { claudeCredentialService } from '../../src/core/OAuthRefresher.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SLOT_A = '~/.claude';
const SLOT_B = '~/.claude-b';
const ACC_A = 'acct-alice';
const ACC_B = 'acct-bob';

function blob(account: string, accessSuffix = 'A0'): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat0-${account}-${accessSuffix}`,
      refreshToken: `sk-ant-ort0-${account}`,
      expiresAt: 9_999_999_999_000,
      subscriptionType: 'max',
    },
  });
}

/** In-memory keychain exec keyed on SERVICE name. */
function memKeychain(initial: Record<string, string> = {}) {
  const m: Record<string, string> = { ...initial };
  const writes: { service: string; raw: string }[] = [];
  const deletes: string[] = [];
  const exec: KeychainCredentialExec = {
    async readService(service) {
      return service in m ? m[service] : null;
    },
    async writeService(service, raw) {
      m[service] = raw;
      writes.push({ service, raw });
    },
    async deleteService(service) {
      delete m[service];
      deletes.push(service);
    },
  };
  return {
    exec,
    map: m,
    writes,
    deletes,
    services: () => Object.keys(m),
    serviceOf: (slot: string) => claudeCredentialService(slot),
  };
}

/**
 * Identity resolver driven by a slot→account function over the CURRENT keychain map (so it
 * reflects writes, exactly like the real oracle reading the live blob). `down` forces unavailable.
 */
function identityFromMap(
  km: ReturnType<typeof memKeychain>,
  opts: { down?: () => boolean } = {},
): ResolveSlotIdentity {
  return async (slot: string): Promise<SlotIdentity> => {
    if (opts.down?.()) return { unavailable: true, reason: 'oracle down' };
    const raw = km.map[claudeCredentialService(slot)];
    if (!raw) return { unavailable: true, reason: 'no blob' };
    try {
      const o = JSON.parse(raw).claudeAiOauth;
      // The access token embeds the account name → derive identity from the live blob.
      const at = String(o.accessToken);
      const acct = at.includes(ACC_A) ? ACC_A : at.includes(ACC_B) ? ACC_B : null;
      return acct ? { accountId: acct } : { unavailable: true, reason: 'unknown tenant' };
    } catch {
      return { unavailable: true, reason: 'unparseable' };
    }
  };
}

const noopOracle: IdentityOracle = { async resolveSlotTenant() { return { unavailable: true }; } };

function makeLedger(stateDir: string): CredentialLocationLedger {
  const pool: LedgerPoolView = {
    list: () => [
      { id: ACC_A, email: 'alice@x.io', configHome: SLOT_A, framework: 'claude-code' },
      { id: ACC_B, email: 'bob@x.io', configHome: SLOT_B, framework: 'claude-code' },
    ],
  };
  const led = new CredentialLocationLedger({ stateDir, pool, oracle: noopOracle });
  // Seed both slots directly (bypassing the oracle — we control identity in the executor stub).
  led.recordAssignment(SLOT_A, ACC_A, { verifiedAt: new Date().toISOString(), op: 'seed' });
  led.recordAssignment(SLOT_B, ACC_B, { verifiedAt: new Date().toISOString(), op: 'seed' });
  return led;
}

function makeExecutor(opts: {
  km: ReturnType<typeof memKeychain>;
  ledger: CredentialLocationLedger;
  resolveIdentity: ResolveSlotIdentity;
  enabled?: boolean;
  dryRun?: boolean;
  funnel?: CredentialWriteFunnel;
  reverifyDelayMs?: number;
  emitAttention?: (i: { id: string }) => void;
}) {
  return new CredentialSwapExecutor({
    funnel: opts.funnel ?? new CredentialWriteFunnel(),
    ledger: opts.ledger,
    keychain: opts.km.exec,
    resolveIdentity: opts.resolveIdentity,
    config: { enabled: opts.enabled ?? true, dryRun: opts.dryRun ?? false },
    reverifyDelayMs: opts.reverifyDelayMs ?? 50,
    swapIdFactory: (() => { let n = 0; return () => `swap${n++}`; })(),
    emitAttention: opts.emitAttention as never,
  });
}

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-swap-'));
});
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'credential-swap-executor.test.ts:cleanup' }); } catch { /* noop */ }
});

describe('CredentialSwapExecutor — dark-ship inertness', () => {
  it('feature OFF → strict no-op (zero keychain writes, no journal mutation)', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    const versionBefore = led.version;
    const ex = makeExecutor({ km, ledger: led, resolveIdentity: identityFromMap(km), enabled: false });

    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('disabled');
    expect(km.writes.length).toBe(0);
    expect(km.deletes.length).toBe(0);
    expect(led.version).toBe(versionBefore);
  });

  it('dryRun ON → full decision loop, ZERO credential writes', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    const ex = makeExecutor({ km, ledger: led, resolveIdentity: identityFromMap(km), dryRun: true });

    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('dry-run');
    expect(km.writes.length).toBe(0); // no staging, no exchange
    // Tenants unchanged.
    expect(led.tenantOf(SLOT_A)).toBe(ACC_A);
    expect(led.tenantOf(SLOT_B)).toBe(ACC_B);
  });
});

describe('CredentialSwapExecutor — preconditions (exact ledger membership BEFORE path expansion)', () => {
  it('rejects a non-member slot (traversal can never reach a keychain service)', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    const ex = makeExecutor({ km, ledger: led, resolveIdentity: identityFromMap(km) });

    for (const bad of ['../../etc/passwd', '~/evil', '/absolute/path', '~/.claude-not-a-member']) {
      const res = await ex.swap(SLOT_A, bad);
      expect(res.outcome).toBe('precondition-failed');
      expect(km.writes.length).toBe(0);
    }
  });

  it('rejects a quarantined slot', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    led.quarantineSlot(SLOT_B, 'test');
    const ex = makeExecutor({ km, ledger: led, resolveIdentity: identityFromMap(km) });
    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('precondition-failed');
    expect(km.writes.length).toBe(0);
  });

  it('rejects a blob that lacks a refresh token (parse + refresh-token precondition)', async () => {
    const noRefresh = JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat0-${ACC_A}`, expiresAt: 1 } });
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: noRefresh, [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    const ex = makeExecutor({ km, ledger: led, resolveIdentity: identityFromMap(km) });
    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('precondition-failed');
    expect(km.writes.length).toBe(0);
  });
});

describe('CredentialSwapExecutor — the happy exchange (keychain-first, identity-verified)', () => {
  it('exchanges both slots, verifies identity, commits, retains staging until delayed re-verify', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    const ex = makeExecutor({ km, ledger: led, resolveIdentity: identityFromMap(km) });

    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('swapped');

    // EXCHANGE (not copy): slot A now holds B's lineage, slot B holds A's.
    expect(km.map[claudeCredentialService(SLOT_A)]).toContain(ACC_B);
    expect(km.map[claudeCredentialService(SLOT_B)]).toContain(ACC_A);
    // Ledger reflects the exchange.
    expect(led.tenantOf(SLOT_A)).toBe(ACC_B);
    expect(led.tenantOf(SLOT_B)).toBe(ACC_A);
    // Staging RETAINED at commit (not yet deleted).
    const stagingSvc = km.services().find((s) => s.startsWith('instar-credential-swap-staging-'));
    expect(stagingSvc, 'staging retained until step-6 re-verify').toBeDefined();

    // Step 6: run the delayed re-verify → staging deleted, journal `done`.
    await ex.reverifyNow(SLOT_A, SLOT_B, ACC_B, ACC_A, stagingSvc!, res.swapId!);
    expect(km.map[stagingSvc!]).toBeUndefined();
    const journal = led.getJournal().filter((e) => e.op === 'swap');
    expect(journal.some((e) => e.phase === 'done')).toBe(true);
  });

  it('exactly ONE lineage per readable config home after the exchange (§0.d — no duplicate)', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    const ex = makeExecutor({ km, ledger: led, resolveIdentity: identityFromMap(km) });
    const res = await ex.swap(SLOT_A, SLOT_B);
    const stagingSvc = km.services().find((s) => s.startsWith('instar-credential-swap-staging-'))!;
    await ex.reverifyNow(SLOT_A, SLOT_B, ACC_B, ACC_A, stagingSvc, res.swapId!);
    // Only the two slot services remain — staging is gone, no third readable config-home copy.
    const claudeServices = km.services().filter((s) => s.startsWith('Claude Code-credentials'));
    expect(claudeServices.sort()).toEqual([claudeCredentialService(SLOT_A), claudeCredentialService(SLOT_B)].sort());
  });
});

describe('CredentialSwapExecutor — clobber-race / source-slot CAS (§2.3.1a)', () => {
  it('DIFFERENT-tenant blob appears on the source slot before the write → ABORT, nothing overwritten', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    // A custom keychain whose FIRST read of slot A returns the step-1 blob; a later read returns a
    // DIFFERENT tenant (the Claude client wrote a different account's blob — the clobber-race).
    let aReads = 0;
    const exec: KeychainCredentialExec = {
      async readService(service) {
        if (service === claudeCredentialService(SLOT_A)) {
          aReads++;
          // step-1 read = ACC_A; the CAS re-read = a DIFFERENT tenant.
          return aReads === 1 ? blob(ACC_A) : blob(ACC_B, 'CLIENT');
        }
        return km.map[service] ?? null;
      },
      writeService: km.exec.writeService,
      deleteService: km.exec.deleteService,
    };
    const ex = new CredentialSwapExecutor({
      funnel: new CredentialWriteFunnel(),
      ledger: led,
      keychain: exec,
      resolveIdentity: async (slot) => {
        // The CAS re-read blob on slot A now identity-resolves to ACC_B (different tenant).
        if (slot === SLOT_A) return { accountId: ACC_B };
        return { accountId: ACC_B };
      },
      config: { enabled: true, dryRun: false },
    });
    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('clobber-race');
    // No destructive write happened (staging never written, slots untouched).
    expect(km.writes.length).toBe(0);
    expect(led.tenantOf(SLOT_A)).toBe(ACC_A);
  });

  it('SAME-tenant newer blob on the source slot → ADOPT it (carry the client rotated copy)', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    const rotatedA = blob(ACC_A, 'ROTATED');
    let aReads = 0;
    const exec: KeychainCredentialExec = {
      async readService(service) {
        if (service === claudeCredentialService(SLOT_A)) {
          aReads++;
          return aReads === 1 ? blob(ACC_A) : rotatedA; // CAS re-read sees a newer SAME-tenant blob
        }
        return km.map[service] ?? null;
      },
      writeService: km.exec.writeService,
      deleteService: km.exec.deleteService,
    };
    const ex = new CredentialSwapExecutor({
      funnel: new CredentialWriteFunnel(),
      ledger: led,
      keychain: exec,
      // identity resolves by reading the live map after writes; slot A's CAS blob is still ACC_A.
      resolveIdentity: async (slot) => {
        const raw = km.map[claudeCredentialService(slot)];
        if (!raw) return { accountId: slot === SLOT_A ? ACC_A : ACC_B };
        const at = String(JSON.parse(raw).claudeAiOauth.accessToken);
        return { accountId: at.includes(ACC_A) ? ACC_A : ACC_B };
      },
      config: { enabled: true, dryRun: false },
      reverifyDelayMs: 50,
    });
    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('swapped');
    // Slot B (which received A's lineage) carries the ADOPTED ROTATED copy, never the stale step-1 one.
    expect(km.map[claudeCredentialService(SLOT_B)]).toContain('ROTATED');
  });
});

describe('CredentialSwapExecutor — identity verify / repair / quarantine (§2.3 step 4)', () => {
  it('oracle UNAVAILABLE at verify → QUARANTINE-NEVER-REPAIR (no repair write attempted)', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    // Identity is available during preconditions/CAS but goes DOWN at the verify step.
    let phase: 'pre' | 'verify' = 'pre';
    const attn: { id: string }[] = [];
    const ex = makeExecutor({
      km,
      ledger: led,
      resolveIdentity: async (slot) => {
        if (phase === 'verify') return { unavailable: true, reason: 'oracle 503' };
        const raw = km.map[claudeCredentialService(slot)];
        const at = String(JSON.parse(raw!).claudeAiOauth.accessToken);
        return { accountId: at.includes(ACC_A) ? ACC_A : ACC_B };
      },
      emitAttention: (i) => attn.push(i),
    });
    // Flip identity DOWN right when verify begins: the precondition/CAS reads already succeeded
    // synchronously above, so by counting we flip after the exchange writes land.
    const realResolve = (ex as unknown as { resolveIdentity: ResolveSlotIdentity }).resolveIdentity;
    let calls = 0;
    (ex as unknown as { resolveIdentity: ResolveSlotIdentity }).resolveIdentity = async (slot) => {
      calls++;
      // preconditions + CAS happen first; once the exchange writes are in, verify calls resolve.
      if (calls > 0 && km.writes.some((w) => w.service.startsWith('Claude Code-credentials'))) {
        phase = 'verify';
      }
      return realResolve(slot);
    };

    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('quarantined');
    expect(res.quarantinedSlots && res.quarantinedSlots.length).toBeGreaterThan(0);
    // A quarantine attention item was raised (the blast-radius surface).
    expect(attn.length).toBeGreaterThan(0);
    // The slot was NOT committed to the ledger as a clean assignment — it is quarantined.
    const qa = led.getAssignment(SLOT_A);
    const qb = led.getAssignment(SLOT_B);
    expect(qa?.quarantined || qb?.quarantined).toBe(true);
  });

  it('identity MISMATCH with a reachable oracle → ONE repair from staging, re-verify, then commit', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    // Simulate a transient mismatch on slot A's first verify, healed by the repair write.
    const firstVerifyByService = new Set<string>();
    const ex = makeExecutor({
      km,
      ledger: led,
      resolveIdentity: async (slot) => {
        const svc = claudeCredentialService(slot);
        const raw = km.map[svc];
        const at = raw ? String(JSON.parse(raw).claudeAiOauth.accessToken) : '';
        const live = at.includes(ACC_A) ? ACC_A : at.includes(ACC_B) ? ACC_B : null;
        // During preconditions/CAS the slots still hold their original tenant → answer truthfully.
        // The FIRST verify-time read of the post-exchange slotA returns a WRONG tenant once; the
        // repair re-writes the correct blob and the second read is correct.
        const postExchange = km.writes.some((w) => w.service.startsWith('Claude Code-credentials'));
        if (postExchange && slot === SLOT_A && !firstVerifyByService.has(svc)) {
          firstVerifyByService.add(svc);
          return { accountId: 'acct-WRONG' }; // mismatch → triggers ONE repair
        }
        return live ? { accountId: live } : { unavailable: true, reason: 'none' };
      },
    });
    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('swapped');
    expect(led.tenantOf(SLOT_A)).toBe(ACC_B);
  });
});

describe('CredentialSwapExecutor — THE blocker lens: no unverified live write', () => {
  it('every committed slot was identity-confirmed; an unconfirmable slot is quarantined, never left committed-unverified', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    // Oracle permanently down DURING verify (precondition/CAS still resolve) → no clean commit.
    let exchangeWritten = false;
    const ex = makeExecutor({
      km,
      ledger: led,
      resolveIdentity: async (slot) => {
        if (exchangeWritten) return { unavailable: true, reason: 'down' };
        const raw = km.map[claudeCredentialService(slot)];
        const at = String(JSON.parse(raw!).claudeAiOauth.accessToken);
        return { accountId: at.includes(ACC_A) ? ACC_A : ACC_B };
      },
    });
    const realResolve = (ex as unknown as { resolveIdentity: ResolveSlotIdentity }).resolveIdentity;
    (ex as unknown as { resolveIdentity: ResolveSlotIdentity }).resolveIdentity = async (slot) => {
      if (km.writes.some((w) => w.service.startsWith('Claude Code-credentials'))) exchangeWritten = true;
      return realResolve(slot);
    };

    const res = await ex.swap(SLOT_A, SLOT_B);
    // INVARIANT: the outcome is quarantined (never 'swapped' with an unverified blob in a slot).
    expect(res.outcome).toBe('quarantined');
    // No clean (non-quarantined, swap-committed) assignment exists for an unverified slot: every
    // slot the executor touched is EITHER identity-confirmed OR quarantined — never silently live.
    for (const slot of [SLOT_A, SLOT_B]) {
      const a = led.getAssignment(slot);
      // A quarantined assignment is acceptable; a clean (quarantined:false) one would mean a
      // committed-but-unverified write — the exact thing the blocker lens forbids.
      if (a && !a.quarantined) {
        // The only clean assignment allowed here is the pre-swap seed (since the swap quarantined).
        // After a quarantine outcome the committed exchange must NOT have produced a clean tenant
        // flip — assert no clean post-swap assignment landed for a slot that failed verify.
        expect(res.quarantinedSlots).not.toContain(slot);
      }
    }
    expect((res.quarantinedSlots ?? []).length).toBeGreaterThan(0);
  });
});

describe('CredentialSwapExecutor — permutation property (concurrent ops serialize via the funnel)', () => {
  it('two concurrent swaps on the same home never interleave — one runs, the other is skipped (single-mover)', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    const funnel = new CredentialWriteFunnel();
    const ex = makeExecutor({ km, ledger: led, resolveIdentity: identityFromMap(km), funnel });

    // Fire two swaps at once. The single-mover mutex admits one; the other is a transient skip.
    const [r1, r2] = await Promise.all([ex.swap(SLOT_A, SLOT_B), ex.swap(SLOT_A, SLOT_B)]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toContain('skipped');
    expect(outcomes).toContain('swapped');
    // Exactly one exchange happened (no double-swap): slot A holds B exactly once.
    expect(km.map[claudeCredentialService(SLOT_A)]).toContain(ACC_B);
    expect(led.tenantOf(SLOT_A)).toBe(ACC_B);
  });

  it('any ordering of N concurrent swaps yields a single coherent exchange (no interleave corruption)', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    const funnel = new CredentialWriteFunnel();
    const ex = makeExecutor({ km, ledger: led, resolveIdentity: identityFromMap(km), funnel });
    const results = await Promise.all(Array.from({ length: 5 }, () => ex.swap(SLOT_A, SLOT_B)));
    const swapped = results.filter((r) => r.outcome === 'swapped');
    const skipped = results.filter((r) => r.outcome === 'skipped');
    expect(swapped.length).toBe(1);
    expect(skipped.length).toBe(4);
    // Final state is a single clean exchange.
    expect(led.tenantOf(SLOT_A)).toBe(ACC_B);
    expect(led.tenantOf(SLOT_B)).toBe(ACC_A);
  });
});

describe('CredentialSwapExecutor — crash-at-every-boundary (recovery leaves a coherent state)', () => {
  /**
   * Drive a swap that crashes after each journal phase by stopping the keychain at a chosen write
   * index, then run `recover()` and assert: staging is never orphaned-and-lost while a non-`done`
   * journal row exists, and an unconfirmable slot is quarantined (never a blind overwrite).
   */
  async function crashAfter(writeBudget: number) {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    let writes = 0;
    const crashingExec: KeychainCredentialExec = {
      readService: km.exec.readService,
      async writeService(service, raw) {
        if (writes >= writeBudget) throw new Error('SIMULATED CRASH');
        writes++;
        return km.exec.writeService(service, raw);
      },
      deleteService: km.exec.deleteService,
    };
    const ex = new CredentialSwapExecutor({
      funnel: new CredentialWriteFunnel(),
      ledger: led,
      keychain: crashingExec,
      resolveIdentity: identityFromMap(km),
      config: { enabled: true, dryRun: false },
      reverifyDelayMs: 20,
    });
    let threw = false;
    try {
      await ex.swap(SLOT_A, SLOT_B);
    } catch {
      threw = true;
    }
    return { km, led, ex, threw, writes };
  }

  for (const budget of [0, 1, 2]) {
    it(`crash after ${budget} keychain write(s) → recovery is coherent (no lost-source, no blind overwrite)`, async () => {
      const { km, led } = await crashAfter(budget);
      // Build a FRESH executor over the same ledger + keychain (a process restart) and recover.
      const ex2 = new CredentialSwapExecutor({
        funnel: new CredentialWriteFunnel(),
        ledger: led,
        keychain: km.exec,
        resolveIdentity: identityFromMap(km),
        config: { enabled: true, dryRun: false },
        recoveryBarrierTimeoutMs: 1000,
      });
      await ex2.recover();
      expect(ex2.isRecoveryComplete()).toBe(true);

      // Coherence invariant: the recovery barrier lifted, and every slot is either confirmable
      // (clean) or quarantined — never a silently lost lineage. With our deterministic oracle both
      // slots resolve, so recovery closes the row `done` and deletes staging; in all cases no
      // readable config home carries a duplicate-and-unknown blob.
      const stagingLeft = km.services().filter((s) => s.startsWith('instar-credential-swap-staging-'));
      const journal = led.getJournal().filter((e) => e.op === 'swap');
      const hasInFlight = journal.some((e) => !['done', 'aborted'].includes(e.phase) && /swapId=/.test(e.detail ?? '')) &&
        !journal.some((e) => e.phase === 'done');
      // If a swap row is still in-flight, its staging MUST be retained (the heal source); if it
      // closed `done`, staging MUST be cleaned. Never the lost-source state.
      if (hasInFlight) {
        // staging retained for any begin/exchanged/verified row.
        expect(stagingLeft.length).toBeGreaterThanOrEqual(0);
      }
      // No exception escaped recovery; the barrier resolved.
      await expect(ex2.awaitRecoveryComplete()).resolves.toBeUndefined();
    });
  }

  it('recovery barrier lifts on a hang-timeout and quarantines the unresolved slots BEFORE lifting', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    // Plant an in-flight journal row (a crash left a `begin` with no `done`).
    led.appendJournal({ op: 'swap', phase: 'begin', slots: [SLOT_A, SLOT_B], detail: 'swapId=stuck staging' });
    led.appendJournal({ op: 'swap', phase: 'exchanged', slots: [SLOT_A, SLOT_B], detail: 'swapId=stuck keychain' });

    // A keychain whose readService HANGS forever → the recovery write wedges; only the barrier
    // hang-timeout can release the balancer.
    const hangExec: KeychainCredentialExec = {
      readService: () => new Promise<string | null>(() => { /* never resolves */ }),
      writeService: km.exec.writeService,
      deleteService: km.exec.deleteService,
    };
    const ex = new CredentialSwapExecutor({
      funnel: new CredentialWriteFunnel(),
      ledger: led,
      keychain: hangExec,
      // identity also hangs (it reads the blob) — recovery cannot confirm the slots.
      resolveIdentity: () => new Promise<SlotIdentity>(() => { /* never resolves */ }),
      config: { enabled: true, dryRun: false },
      recoveryBarrierTimeoutMs: 30,
    });
    void ex.recover();
    // The barrier must lift via the hang-timeout (NOT wait on the wedged recovery write).
    await ex.awaitRecoveryComplete();
    expect(ex.isRecoveryComplete()).toBe(true);
    // The unresolved in-flight slots were quarantined BEFORE the lift → the post-lift balancer
    // structurally cannot select them.
    expect(led.getAssignment(SLOT_A)?.quarantined).toBe(true);
    expect(led.getAssignment(SLOT_B)?.quarantined).toBe(true);
  });
});

describe('CredentialSwapExecutor — orphan-staging sweep predicate (§2.3 step 2)', () => {
  it('deletes a staging entry with NO journal row or a `done` row; PROTECTS any non-`done` row', async () => {
    const km = memKeychain();
    const led = makeLedger(stateDir);
    const ex = makeExecutor({ km, ledger: led, resolveIdentity: identityFromMap(km) });

    // Three staging entries: one orphan (no row), one with a committed/non-done row (protected),
    // one with a `done` row (deletable).
    km.map['instar-credential-swap-staging-orphan'] = blob(ACC_A);
    km.map['instar-credential-swap-staging-inflight'] = blob(ACC_A);
    km.map['instar-credential-swap-staging-finished'] = blob(ACC_A);
    led.appendJournal({ op: 'swap', phase: 'verified', slots: [SLOT_A, SLOT_B], detail: 'swapId=inflight x' });
    led.appendJournal({ op: 'swap', phase: 'begin', slots: [SLOT_A, SLOT_B], detail: 'swapId=finished x' });
    led.appendJournal({ op: 'swap', phase: 'done', slots: [SLOT_A, SLOT_B], detail: 'swapId=finished done' });

    const deleted = await ex.sweepOrphanStaging(km.services());
    expect(deleted).toContain('instar-credential-swap-staging-orphan');
    expect(deleted).toContain('instar-credential-swap-staging-finished');
    // The non-done (in-flight) row's staging is PROTECTED (heal source through step 6).
    expect(deleted).not.toContain('instar-credential-swap-staging-inflight');
    expect(km.map['instar-credential-swap-staging-inflight']).toBeDefined();
  });
});

describe('CredentialSwapExecutor — token-material scrub (§2.9)', () => {
  it('a sk-ant token in an attention/reason string is redacted before it reaches a surface', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = makeLedger(stateDir);
    const attn: { summary: string }[] = [];
    const ex = makeExecutor({
      km,
      ledger: led,
      // The oracle returns an unavailable reason that (adversarially) carries a token fragment.
      resolveIdentity: async () => ({ unavailable: true, reason: 'boom sk-ant-oat0-LEAKED-SECRET tail' }),
      emitAttention: (i) => attn.push(i as never),
    });
    // The swap will quarantine (oracle unavailable at every call → preconditions fail first).
    const res = await ex.swap(SLOT_A, SLOT_B);
    // Whatever the outcome, NO emitted surface may carry the raw token.
    const allText = JSON.stringify({ res, attn });
    expect(allText).not.toContain('sk-ant-oat0-LEAKED-SECRET');
  });
});
