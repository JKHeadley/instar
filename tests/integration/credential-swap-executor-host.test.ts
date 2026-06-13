/**
 * CredentialSwapExecutor integration tier (Step 5, spec §2.3).
 *
 * Composes the executor exactly as its host (the Step-7 route/manager) will: the REAL
 * `CredentialIdentityOracle` (profile-endpoint identity, injected fetch) + the REAL pool-mapping
 * + the REAL `CredentialLocationLedger` + the REAL `CredentialWriteFunnel`. This is the
 * dependency-injection wiring-integrity tier — it proves the executor's verify path delegates to
 * the genuine oracle (not a hand-stub) and yields the right outcome under:
 *   (a) a mock oracle that ALLOWS (profile returns the expected email) → commit, and
 *   (b) a mock oracle that is UNAVAILABLE (5xx) at verify → QUARANTINE (never repair).
 *
 * Hermetic: an in-memory keychain + an injected fetch → zero keychain, zero network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialWriteFunnel } from '../../src/core/CredentialWriteFunnel.js';
import {
  CredentialLocationLedger,
  type LedgerPoolView,
  type IdentityOracle,
} from '../../src/core/CredentialLocationLedger.js';
import { CredentialIdentityOracle, type OracleFetch } from '../../src/core/CredentialIdentityOracle.js';
import {
  CredentialSwapExecutor,
  type KeychainCredentialExec,
  type SlotIdentity,
} from '../../src/core/CredentialSwapExecutor.js';
import { claudeCredentialService, type CredentialStore } from '../../src/core/OAuthRefresher.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SLOT_A = '~/.claude';
const SLOT_B = '~/.claude-b';
const ACC_A = 'acct-alice';
const ACC_B = 'acct-bob';
const EMAIL_A = 'alice@x.io';
const EMAIL_B = 'bob@x.io';

function blob(account: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat0-${account}`,
      refreshToken: `sk-ant-ort0-${account}`,
      expiresAt: 9_999_999_999_000,
      subscriptionType: 'max',
    },
  });
}

/** In-memory keychain (executor's async exec surface) keyed on SERVICE name. */
function memKeychain(initial: Record<string, string> = {}) {
  const m: Record<string, string> = { ...initial };
  const exec: KeychainCredentialExec = {
    async readService(s) { return s in m ? m[s] : null; },
    async writeService(s, raw) { m[s] = raw; },
    async deleteService(s) { delete m[s]; },
  };
  return { exec, map: m, services: () => Object.keys(m) };
}

/** A CredentialStore the REAL oracle reads through, backed by the same keychain map (service-keyed). */
function oracleStore(km: ReturnType<typeof memKeychain>): CredentialStore {
  return {
    read: (configHome) => km.map[claudeCredentialService(configHome)] ?? null,
    write: () => true, // the oracle never writes
  };
}

/** Map a token (which embeds the account) → that account's email, for the profile fetch. */
function profileFetch(opts: { unavailable?: () => boolean } = {}): OracleFetch {
  return async (_url, init) => {
    if (opts.unavailable?.()) return { ok: false, status: 503, json: async () => ({}) };
    const auth = init?.headers?.Authorization ?? '';
    const email = auth.includes(ACC_A) ? EMAIL_A : auth.includes(ACC_B) ? EMAIL_B : '';
    if (!email) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ account: { email } }) };
  };
}

const noopOracle: IdentityOracle = { async resolveSlotTenant() { return { unavailable: true }; } };

function pool(): LedgerPoolView {
  return {
    list: () => [
      { id: ACC_A, email: EMAIL_A, configHome: SLOT_A, framework: 'claude-code' },
      { id: ACC_B, email: EMAIL_B, configHome: SLOT_B, framework: 'claude-code' },
    ],
  };
}

/** Compose the host-style identity resolver: REAL oracle (email) → pool (accountId). */
function hostResolveIdentity(oracle: CredentialIdentityOracle, p: LedgerPoolView) {
  return async (slot: string): Promise<SlotIdentity> => {
    const r = await oracle.resolveSlotTenant(slot);
    if (r.unavailable || !r.email) return { unavailable: true, reason: r.reason ?? 'oracle unavailable' };
    const matches = p.list().filter((a) => a.email === r.email);
    if (matches.length !== 1) return { unavailable: true, reason: `ambiguous/unknown email (${matches.length} matches)` };
    return { accountId: matches[0].id };
  };
}

let stateDir: string;
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-swap-int-')); });
afterEach(() => { try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'credential-swap-executor-host.test.ts:cleanup' }); } catch { /* noop */ } });

function seededLedger(): CredentialLocationLedger {
  const led = new CredentialLocationLedger({ stateDir, pool: pool(), oracle: noopOracle });
  led.recordAssignment(SLOT_A, ACC_A, { verifiedAt: new Date().toISOString(), op: 'seed' });
  led.recordAssignment(SLOT_B, ACC_B, { verifiedAt: new Date().toISOString(), op: 'seed' });
  return led;
}

describe('CredentialSwapExecutor host wiring — REAL oracle ALLOW → commit', () => {
  it('exchanges and commits when the real profile oracle confirms both tenants', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = seededLedger();
    const oracle = new CredentialIdentityOracle({ store: oracleStore(km), fetchImpl: profileFetch() });
    const ex = new CredentialSwapExecutor({
      funnel: new CredentialWriteFunnel(),
      ledger: led,
      keychain: km.exec,
      resolveIdentity: hostResolveIdentity(oracle, pool()),
      config: { enabled: true, dryRun: false },
      reverifyDelayMs: 30,
    });

    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('swapped');
    expect(led.tenantOf(SLOT_A)).toBe(ACC_B);
    expect(led.tenantOf(SLOT_B)).toBe(ACC_A);
    // The verify path actually delegated to the REAL oracle (not null/no-op): the exchanged
    // keychain blobs identity-resolve to the swapped tenants.
    expect(km.map[claudeCredentialService(SLOT_A)]).toContain(ACC_B);
    expect(km.map[claudeCredentialService(SLOT_B)]).toContain(ACC_A);
  });
});

describe('CredentialSwapExecutor host wiring — REAL oracle UNAVAILABLE at verify → QUARANTINE', () => {
  it('quarantines (never repairs) when the real oracle 5xxs during verify', async () => {
    const km = memKeychain({ [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) });
    const led = seededLedger();
    // The oracle is healthy through preconditions/CAS, then goes 5xx once the exchange writes land.
    let down = false;
    const oracle = new CredentialIdentityOracle({ store: oracleStore(km), fetchImpl: profileFetch({ unavailable: () => down }) });
    const resolver = hostResolveIdentity(oracle, pool());
    const attn: { id: string }[] = [];
    const ex = new CredentialSwapExecutor({
      funnel: new CredentialWriteFunnel(),
      ledger: led,
      keychain: {
        readService: km.exec.readService,
        async writeService(s, raw) {
          // The moment a slot credential is written (the exchange), flip the oracle DOWN so the
          // subsequent VERIFY reads as unavailable.
          if (s.startsWith('Claude Code-credentials')) down = true;
          return km.exec.writeService(s, raw);
        },
        deleteService: km.exec.deleteService,
      },
      resolveIdentity: resolver,
      config: { enabled: true, dryRun: false },
      emitAttention: (i) => attn.push(i as never),
    });

    const res = await ex.swap(SLOT_A, SLOT_B);
    expect(res.outcome).toBe('quarantined');
    expect((res.quarantinedSlots ?? []).length).toBeGreaterThan(0);
    // Quarantine surfaced an attention item (the blast-radius surface), and a quarantined slot
    // exists in the ledger — never a silent committed-unverified write.
    expect(attn.length).toBeGreaterThan(0);
    const anyQuarantined = led.getAssignments().some((a) => a.quarantined);
    expect(anyQuarantined).toBe(true);
  });
});
