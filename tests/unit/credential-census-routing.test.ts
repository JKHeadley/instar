/**
 * Step 6b — census consumer re-routing through CredentialLocationResolver. These verify the ACTIVE
 * side of each re-route's decision boundary (the dark/no-op side is covered by each consumer's
 * existing suite, which runs with the default no-op resolver). The registry is reset after each
 * test so the no-op default is restored for every other suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuotaPoller, type FetchImpl } from '../../src/core/QuotaPoller.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import {
  CredentialLocationResolver,
  setCredentialLocationResolver,
  resetCredentialLocationResolver,
} from '../../src/core/CredentialLocationResolver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const CLEAN_USAGE = { five_hour: { utilization: 5, resets_at: '2026-06-14T00:00:00Z' } };
const okFetch: FetchImpl = async () => ({ ok: true, status: 200, json: async () => CLEAN_USAGE });

/** A resolver whose `active()` is true (seeded + enabled), so census suppression/re-routes engage. */
function activeResolver() {
  return new CredentialLocationResolver({
    ledger: { slotOf: () => null, tenantOf: () => null, isSeeded: () => true, isUnknownMode: () => false },
    config: () => ({ enabled: true }),
  });
}

describe('Step 6b census #3 — QuotaPoller email auto-patch is suppressed when the ledger is active', () => {
  let dir: string;
  let homeDir: string;
  let pool: SubscriptionPool;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census3-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'census3-home-'));
    // The enrollment home's login record reports a DIFFERENT email than the pool record — exactly
    // the post-swap cross-contamination the suppression prevents.
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'wrong@x.co' } }));
    pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'a1', nickname: 'a', provider: 'anthropic', framework: 'claude-code', configHome: homeDir, email: 'right@x.co' } as Parameters<SubscriptionPool['add']>[0]);
  });
  afterEach(() => {
    resetCredentialLocationResolver();
    for (const d of [dir, homeDir]) {
      try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'credential-census-routing.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
    }
  });

  it('DARK (no-op resolver): the email IS patched from the enrollment home (today\'s behavior)', async () => {
    const p = new QuotaPoller({ pool, fetchImpl: okFetch, tokenResolver: () => 'sk-ant-oat01-x' });
    await p.pollAll();
    expect(pool.get('a1')!.email).toBe('wrong@x.co'); // patched — detects the login mismatch
  });

  it('ACTIVE (ledger live): the email auto-patch is SUPPRESSED (no cross-contamination)', async () => {
    setCredentialLocationResolver(activeResolver());
    const p = new QuotaPoller({ pool, fetchImpl: okFetch, tokenResolver: () => 'sk-ant-oat01-x' });
    await p.pollAll();
    expect(pool.get('a1')!.email).toBe('right@x.co'); // unchanged — the pool email→account map is protected
  });
});
