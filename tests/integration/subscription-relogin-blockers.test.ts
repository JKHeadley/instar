import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createSubscriptionReloginRuntime, subscriptionReloginRouteContext } from '../../src/core/SubscriptionReloginRuntime.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import type { SubscriptionAccount, SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import type { SubscriptionLoginEpisode, SubscriptionLoginLedger } from '../../src/core/SubscriptionLoginLedger.js';
import type { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import type { QuotaPoller } from '../../src/core/QuotaPoller.js';
import type { IdentityOracle } from '../../src/core/CredentialLocationLedger.js';
import type { PlaywrightProfileRegistry } from '../../src/core/PlaywrightProfileRegistry.js';
import type { ClaudePasteBackController } from '../../src/core/ClaudePasteBackController.js';

// Registry First for the 2026-10-26 Mac Mini case: five accounts showed "Needs sign-in" and no
// repair ever started — four had no confirmed sign-in failure on that machine, and the fifth
// had no browser profile there. `blockers()` names each reason; it must never start or write anything.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
  recursive: true, force: true, operation: 'subscription-relogin-blockers.test cleanup',
}); });

function account(id: string, email: string, status: SubscriptionAccount['status'],
  extra: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return { id, nickname: id, email, provider: 'anthropic', framework: 'claude-code',
    configHome: `/tmp/${id}`, status, enrolledAt: '2026-01-01T00:00:00Z', version: 1, ...extra };
}
function incident(id: number, accountId: string): SubscriptionLoginEpisode {
  return { id, accountId, machineId: 'machine-1', openedAt: '2026-10-23T00:00:00Z', closedAt: null,
    causeClass: 'exchange-failed', corroboration: 'exchange-corroborated', outcome: null, provenance: 'observed' };
}

function build(accounts: SubscriptionAccount[], incidents: SubscriptionLoginEpisode[]) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-blockers-')); dirs.push(stateDir);
  const userDataDir = path.join(stateDir, 'profile'); fs.mkdirSync(userDataDir);
  const pool = { getAvailability: () => ({ state: 'ready' }), list: () => accounts.map((a) => ({ ...a })),
    get: (id: string) => accounts.find((a) => a.id === id) ?? null, update: vi.fn() } as unknown as SubscriptionPool;
  const ledger = { listEpisodes: () => incidents.map((i) => ({ ...i })), recordStatus: vi.fn() } as unknown as SubscriptionLoginLedger;
  const enrollment = { getById: () => null, start: vi.fn(), refresh: vi.fn() } as unknown as EnrollmentWizard;
  // Only `has-profile@example.com` has a dedicated browser profile on this machine.
  const profiles = {
    resolve: (service: string, identity: string) => service === 'google' && identity === 'has-profile@example.com'
      ? { profile: { id: 'p1' }, dirExists: true } : { profile: null },
    listProfiles: () => [{ id: 'p1', userDataDir, description: '', isDefault: false, createdAt: '', dirExists: true,
      accounts: [{ service: 'google', identity: 'has-profile@example.com', owner: 'operator', vaultRefs: [],
        loginMethod: 'password', lastAsserted: true, lastVerifiedAt: null, note: '', danglingRefs: [] }] }],
  } as unknown as PlaywrightProfileRegistry;
  const runtime = createSubscriptionReloginRuntime({ stateDir, projectDir: stateDir, machineId: 'machine-1',
    seatLease: new PlaywrightSeatLease({ filePath: path.join(stateDir, 'seat-lease.json') }),
    mode: 'approval', pool, ledger, enrollment, profiles,
    quotaPoller: { pollAccount: vi.fn() } as unknown as QuotaPoller,
    identityOracle: { resolveSlotTenant: vi.fn() } as unknown as IdentityOracle,
    pasteBack: { finish: vi.fn() } as unknown as ClaudePasteBackController,
    createBrowser: () => { throw new Error('blockers must never open a browser'); },
    resolveSecret: async () => null, supervise: async ({ allowedActions }) => allowedActions[0],
  });
  return { runtime, ledger, enrollment };
}

describe('subscription re-login blockers (why a needs-sign-in account has no repair)', () => {
  it('names no-open-incident and profile-unresolved, and lists nothing for active or admissible accounts', async () => {
    const accounts = [
      account('no-incident', 'dawn@example.com', 'needs-reauth'),
      account('no-profile', 'luna@example.com', 'needs-reauth'),
      account('admissible', 'has-profile@example.com', 'needs-reauth'),
      account('healthy', 'ok@example.com', 'active'),
      account('codex-unsupported-provider', 'x@example.com', 'needs-reauth', { provider: 'google', framework: 'gemini-cli' } as Partial<SubscriptionAccount>),
    ];
    const { runtime, ledger, enrollment } = build(accounts, [incident(11, 'no-profile'), incident(12, 'admissible')]);
    const blockers = await runtime.blockers();
    expect(blockers).toEqual([
      { accountId: 'no-incident', machineId: 'machine-1', framework: 'claude-code', reason: 'no-open-incident' },
      { accountId: 'no-profile', machineId: 'machine-1', framework: 'claude-code', reason: 'profile-unresolved' },
    ]);
    // Read-only: no repair row, no ledger write, no login started.
    expect(runtime.store.list()).toEqual([]);
    expect(ledger.recordStatus).not.toHaveBeenCalled();
    expect(enrollment.start).not.toHaveBeenCalled();
    // The admissible account really is admitted by the same tick the blockers read mirrors.
    await runtime.service.tick();
    expect(runtime.store.list().map((e) => e.accountId)).toEqual(['admissible']);
    // Once its repair row exists, the episode itself carries the state: no duplicate blocker.
    expect((await runtime.blockers()).map((b) => b.accountId)).toEqual(['no-incident', 'no-profile']);
    runtime.close();
  });

  it('names device-limit-benched for a benched account, with or without an open incident (codex-device-limit-tripwire §8)', async () => {
    const benched = { statusCause: 'codex-device-limit' as const, deviceLimitSince: '2026-10-31T12:00:00Z' };
    const accounts = [
      account('benched-no-incident', 'dawn@example.com', 'needs-reauth', benched),
      // Would otherwise be admissible (incident + dedicated profile): the bench still names the reason.
      account('benched-admissible', 'has-profile@example.com', 'needs-reauth', benched),
      account('benched-codex', 'codex@example.com', 'needs-reauth', { ...benched, provider: 'openai', framework: 'codex-cli' }),
      // A restored account with a stale cause is not needs-reauth: not listed.
      account('restored', 'ok@example.com', 'active', benched),
    ];
    const { runtime, ledger, enrollment } = build(accounts, [incident(21, 'benched-admissible'), incident(22, 'benched-codex')]);
    expect(await runtime.blockers()).toEqual([
      { accountId: 'benched-no-incident', machineId: 'machine-1', framework: 'claude-code', reason: 'device-limit-benched' },
      { accountId: 'benched-admissible', machineId: 'machine-1', framework: 'claude-code', reason: 'device-limit-benched' },
      { accountId: 'benched-codex', machineId: 'machine-1', framework: 'codex-cli', reason: 'device-limit-benched' },
    ]);
    // Admission agrees: the tick starts no repair for any benched account.
    await runtime.service.tick();
    expect(runtime.store.list()).toEqual([]);
    expect(ledger.recordStatus).not.toHaveBeenCalled();
    expect(enrollment.start).not.toHaveBeenCalled();
    runtime.close();
  });

  it('endForDeviceLimit ends this machine\'s live repair for the account (runtime wiring)', async () => {
    const { runtime } = build([account('admissible', 'has-profile@example.com', 'needs-reauth')], [incident(31, 'admissible')]);
    await runtime.service.tick();
    const [ep] = runtime.store.list();
    expect(ep).toMatchObject({ accountId: 'admissible', state: 'suggested' });
    expect(await runtime.endForDeviceLimit('admissible')).toEqual([{ id: ep!.id, ended: true }]);
    expect(runtime.store.get(ep!.id)).toMatchObject({ state: 'refused', failureClass: 'device-limit' });
    expect(await runtime.endForDeviceLimit('admissible')).toEqual([]);
    runtime.close();
  });

  it('is exposed on the route context the server wires (wiring integrity)', async () => {
    const { runtime } = build([account('no-incident', 'dawn@example.com', 'needs-reauth')], []);
    const ctx = subscriptionReloginRouteContext(runtime);
    expect(typeof ctx.blockers).toBe('function');
    expect((await ctx.blockers()).map((b) => b.reason)).toEqual(['no-open-incident']);
    runtime.close();
  });
});
