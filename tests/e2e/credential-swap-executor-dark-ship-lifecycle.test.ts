/**
 * E2E — CredentialSwapExecutor ships DARK and INERT on the PRODUCTION config path (Step 5, §2.3 / §2.8).
 *
 * This is the single most important test for a destructive dark feature: it proves the executor,
 * constructed from the EXACT config a real agent boots with (the real ConfigDefaults applied the
 * same way `PostUpdateMigrator` / the server composition root do), performs ZERO credential writes
 * because `subscriptionPool.credentialRepointing` is `enabled:false` + `dryRun:true` — for EVERYONE
 * including a dev agent. Going live needs a deliberate two-flag flip; this test is the floor that
 * fails loudly if either flag ever regresses to live-by-default.
 *
 * (Step 5 wires the swap PRIMITIVE; the HTTP route is Step 7. The dark-ship inertness guarantee is
 * the executor's `swap()` boundary returning a strict no-op under the production-default config —
 * exactly the "feature is alive but inert while dark" contract, asserted through the real config.)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { getConfigByPath } from '../../src/core/devGatedFeatures.js';
import { CredentialWriteFunnel } from '../../src/core/CredentialWriteFunnel.js';
import {
  CredentialLocationLedger,
  type LedgerPoolView,
  type IdentityOracle,
} from '../../src/core/CredentialLocationLedger.js';
import {
  CredentialSwapExecutor,
  type KeychainCredentialExec,
  type SlotIdentity,
} from '../../src/core/CredentialSwapExecutor.js';
import { claudeCredentialService } from '../../src/core/OAuthRefresher.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SLOT_A = '~/.claude';
const SLOT_B = '~/.claude-b';
const ACC_A = 'acct-alice';
const ACC_B = 'acct-bob';

function blob(account: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat0-${account}`, refreshToken: `sk-ant-ort0-${account}`, expiresAt: 9_999_999_999_000 } });
}

/** Build the config a real agent boots with — explicit developmentAgent flag + the REAL defaults. */
function bootConfig(developmentAgent: boolean): Record<string, unknown> {
  const cfg: Record<string, unknown> = { developmentAgent };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  return cfg;
}

let stateDir: string;
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-swap-e2e-')); });
afterEach(() => { try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'credential-swap-executor-dark-ship-lifecycle.test.ts:cleanup' }); } catch { /* noop */ } });

function memKeychain() {
  const m: Record<string, string> = { [claudeCredentialService(SLOT_A)]: blob(ACC_A), [claudeCredentialService(SLOT_B)]: blob(ACC_B) };
  const writes: string[] = [];
  const deletes: string[] = [];
  const exec: KeychainCredentialExec = {
    async readService(s) { return s in m ? m[s] : null; },
    async writeService(s, raw) { m[s] = raw; writes.push(s); },
    async deleteService(s) { delete m[s]; deletes.push(s); },
  };
  return { exec, map: m, writes, deletes };
}

const noopOracle: IdentityOracle = { async resolveSlotTenant() { return { unavailable: true }; } };
function pool(): LedgerPoolView {
  return { list: () => [
    { id: ACC_A, email: 'alice@x.io', configHome: SLOT_A, framework: 'claude-code' },
    { id: ACC_B, email: 'bob@x.io', configHome: SLOT_B, framework: 'claude-code' },
  ] };
}
const allowAll: (slot: string) => Promise<SlotIdentity> = async (slot) => ({ accountId: slot === SLOT_A ? ACC_A : ACC_B });

describe('CredentialSwapExecutor — dark-ship inertness on the production config path', () => {
  for (const isDev of [true, false]) {
    it(`a ${isDev ? 'DEV' : 'fleet'} agent's production config gates the executor to a strict no-op (zero writes)`, async () => {
      const cfg = bootConfig(isDev);
      // The two-flag gate as a real agent reads it.
      const enabled = getConfigByPath(cfg, 'subscriptionPool.credentialRepointing.enabled') as boolean;
      const dryRun = getConfigByPath(cfg, 'subscriptionPool.credentialRepointing.dryRun') as boolean;
      expect(enabled).toBe(false);
      expect(dryRun).toBe(true);

      const km = memKeychain();
      const led = new CredentialLocationLedger({ stateDir, pool: pool(), oracle: noopOracle });
      led.recordAssignment(SLOT_A, ACC_A, { op: 'seed' });
      led.recordAssignment(SLOT_B, ACC_B, { op: 'seed' });
      const versionBefore = led.version;

      // Construct the executor EXACTLY as the composition root will: pass the real config block.
      const ex = new CredentialSwapExecutor({
        funnel: new CredentialWriteFunnel(),
        ledger: led,
        keychain: km.exec,
        resolveIdentity: allowAll,
        config: { enabled, dryRun },
      });

      const res = await ex.swap(SLOT_A, SLOT_B);
      // DARK: feature off → strict no-op.
      expect(res.outcome).toBe('disabled');
      expect(km.writes.length).toBe(0);
      expect(km.deletes.length).toBe(0);
      // The ledger was never mutated and the tenants are untouched.
      expect(led.version).toBe(versionBefore);
      expect(led.tenantOf(SLOT_A)).toBe(ACC_A);
      expect(led.tenantOf(SLOT_B)).toBe(ACC_B);
      // The keychain blobs are byte-identical to before the call.
      expect(km.map[claudeCredentialService(SLOT_A)]).toBe(blob(ACC_A));
      expect(km.map[claudeCredentialService(SLOT_B)]).toBe(blob(ACC_B));
    });
  }

  it('recovery on the dark config is also crash-safe: an already-begun exchange finishes regardless of dryRun (§2.3 boot-recovery)', async () => {
    // Recovery completion is INDEPENDENT of dryRun — a swap that already journaled begin/exchanged
    // is FINISHED for crash-safety even on the dark config (dryRun gates NEW decisions, never the
    // completion of an already-begun exchange).
    const km = memKeychain();
    const led = new CredentialLocationLedger({ stateDir, pool: pool(), oracle: noopOracle });
    led.recordAssignment(SLOT_A, ACC_A, { op: 'seed' });
    led.recordAssignment(SLOT_B, ACC_B, { op: 'seed' });
    led.appendJournal({ op: 'swap', phase: 'begin', slots: [SLOT_A, SLOT_B], detail: 'swapId=preexisting staging' });
    led.appendJournal({ op: 'swap', phase: 'exchanged', slots: [SLOT_A, SLOT_B], detail: 'swapId=preexisting keychain' });

    const ex = new CredentialSwapExecutor({
      funnel: new CredentialWriteFunnel(),
      ledger: led,
      keychain: km.exec,
      resolveIdentity: allowAll, // both slots confirmable → recovery closes the row cleanly
      config: { enabled: false, dryRun: true }, // DARK
      recoveryBarrierTimeoutMs: 500,
    });
    await ex.recover();
    expect(ex.isRecoveryComplete()).toBe(true);
    // The in-flight row was resolved (closed `done`) — recovery ran even though the feature is dark.
    const journal = led.getJournal().filter((e) => e.op === 'swap');
    expect(journal.some((e) => e.phase === 'done' && /swapId=preexisting/.test(e.detail ?? ''))).toBe(true);
    await expect(ex.awaitRecoveryComplete()).resolves.toBeUndefined();
  });
});
