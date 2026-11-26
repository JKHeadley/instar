import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createSubscriptionReloginRuntime } from '../../src/core/SubscriptionReloginRuntime.js';
import type { SubscriptionAccount, SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import type { SubscriptionLoginEpisode, SubscriptionLoginLedger } from '../../src/core/SubscriptionLoginLedger.js';
import type { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import type { QuotaPoller } from '../../src/core/QuotaPoller.js';
import type { IdentityOracle } from '../../src/core/CredentialLocationLedger.js';
import type { PlaywrightProfileRegistry } from '../../src/core/PlaywrightProfileRegistry.js';
import type { ClaudePasteBackController } from '../../src/core/ClaudePasteBackController.js';
import type { PasskeyCellAdmissionState } from '../../src/core/SubscriptionReloginPolicy.js';

// Spec docs/specs/agent-held-google-passkey.md §3.4 — the `google-passkey` method THROUGH the
// production-shaped runtime: no candidate without a computed `ready` cell (the fleet default),
// a suggested episode records the method + a passkey-specific digest when the cell is ready,
// graduation evidence is read per method, and the drive boundary refuses by name (never the
// password flow) on this build.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'subscription-relogin-runtime-passkey.test cleanup' }); });

function harness(opts: { cell?: PasskeyCellAdmissionState; wireCell?: boolean; loginMethod?: string; passkeyKey?: string | null; mode?: 'approval' | 'unattended' } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-passkey-runtime-')); dirs.push(stateDir);
  const userDataDir = path.join(stateDir, 'browser-profile'); fs.mkdirSync(userDataDir);
  const account: SubscriptionAccount = { id: 'acct-pk', nickname: 'Passkey account', email: 'person@example.com',
    provider: 'anthropic', framework: 'claude-code', configHome: path.join(stateDir, 'slot'),
    status: 'needs-reauth', enrolledAt: '2026-01-01T00:00:00Z', version: 1 };
  const source: SubscriptionLoginEpisode = { id: 91, accountId: account.id, machineId: 'machine-1',
    openedAt: '2026-08-28T00:00:00Z', closedAt: null, causeClass: 'exchange-failed',
    corroboration: 'exchange-corroborated', outcome: null, provenance: 'observed' };
  const loginMethod = opts.loginMethod ?? 'google-passkey';
  const passkeyKey = opts.passkeyKey === undefined ? 'pk-entry-1' : opts.passkeyKey;
  // A real-shaped enrollment: the CLI login artifact is minted BEFORE the browser step (as in
  // production), so a passkey refusal is proven at the DRIVE boundary, not by a missing artifact.
  let pending: any = null;
  const enrollment = { getById: () => pending, start: vi.fn(async () => (pending = {
    id: account.id, label: account.nickname, provider: 'anthropic', framework: 'claude-code',
    kind: 'url-code-paste', configHome: account.configHome, verificationUrl: 'https://claude.ai/oauth/authorize',
    ttlExpiresAt: '2099-01-01T00:00:00Z', status: 'pending', reissueCount: 0,
    createdAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z', version: 1,
  })), refresh: vi.fn() } as unknown as EnrollmentWizard;
  const createBrowser = vi.fn(() => { throw new Error('browser-must-not-open'); });
  const passkeyCellState = vi.fn(() => opts.cell ?? 'unknown');
  const runtime = createSubscriptionReloginRuntime({ stateDir, projectDir: stateDir, machineId: 'machine-1',
    mode: opts.mode ?? 'approval', unattendedPolicy: { identities: [account.email], minimumSuccessfulRepairs: 1, minimumEvidenceDays: 0 },
    pool: { getAvailability: () => ({ state: 'ready' }), get: () => ({ ...account }), list: () => [{ ...account }], update: vi.fn() } as unknown as SubscriptionPool,
    ledger: { listEpisodes: () => [{ ...source }], recordStatus: vi.fn() } as unknown as SubscriptionLoginLedger,
    enrollment,
    profiles: { resolve: () => ({ profile: { id: 'profile-pk' }, dirExists: true }),
      listProfiles: () => [{ id: 'profile-pk', userDataDir, description: '', isDefault: false, createdAt: '', dirExists: true,
        accounts: [{ service: 'google', identity: account.email, owner: 'operator', vaultRefs: [], loginMethod,
          ...(passkeyKey ? { vaultBindings: { passkey: passkeyKey } } : {}),
          lastAsserted: true, lastVerifiedAt: null, note: '', danglingRefs: [] }] }] } as unknown as PlaywrightProfileRegistry,
    quotaPoller: { pollAccount: vi.fn() } as unknown as QuotaPoller, identityOracle: { resolveSlotTenant: vi.fn() } as unknown as IdentityOracle,
    pasteBack: {} as ClaudePasteBackController, createBrowser, resolveSecret: async () => null,
    supervise: async ({ allowedActions }) => allowedActions[0],
    ...(opts.wireCell === false ? {} : { passkeyCellState }),
  });
  return { runtime, account, enrollment, createBrowser, passkeyCellState };
}

describe('subscription re-login runtime — google-passkey method', () => {
  it('produces NO candidate when the cell state is not wired (fleet default) or not ready', async () => {
    for (const opts of [{ wireCell: false }, { cell: 'unknown' as const }, { cell: 'security' as const }, { cell: 'suspended' as const }]) {
      const { runtime, enrollment } = harness(opts);
      await runtime.service.tick();
      expect(runtime.store.list()).toEqual([]);
      expect(enrollment.start).not.toHaveBeenCalled();
      runtime.close();
    }
  });

  it('produces NO candidate for a passkey account with no entry key even when the cell reads ready', async () => {
    const { runtime, passkeyCellState } = harness({ cell: 'ready', passkeyKey: null });
    await runtime.service.tick();
    expect(runtime.store.list()).toEqual([]);
    expect(passkeyCellState).not.toHaveBeenCalled();
    runtime.close();
  });

  it('with a ready cell: suggests an episode that records the method, asks the cell state with the entry key, and carries a passkey-specific digest', async () => {
    const { runtime, passkeyCellState } = harness({ cell: 'ready' });
    await runtime.service.tick();
    const [episode] = runtime.store.list();
    expect(episode).toMatchObject({ state: 'suggested', mode: 'approval', loginMethod: 'google-passkey' });
    expect(passkeyCellState).toHaveBeenCalledWith({ accountId: 'acct-pk', machineId: 'machine-1', entryKey: 'pk-entry-1' });

    const { runtime: pw } = harness({ loginMethod: 'session-cookie', passkeyKey: null });
    await pw.service.tick();
    expect(pw.store.list()[0]).toMatchObject({ state: 'suggested', loginMethod: 'session-cookie' });
    expect(pw.store.list()[0].inputDigest).not.toBe(episode.inputDigest);
    pw.close(); runtime.close();
  });

  it('approving a ready passkey episode refuses at the drive boundary by name — the browser is never opened and the password flow never runs', async () => {
    const { runtime, createBrowser, enrollment } = harness({ cell: 'ready' });
    await runtime.service.tick();
    const [episode] = runtime.store.list();
    await runtime.service.approve(episode.id);
    await vi.waitFor(() => expect(runtime.store.get(episode.id)?.state).toBe('refused'));
    expect(runtime.store.get(episode.id)).toMatchObject({ failureClass: 'passkey-refused' });
    expect(createBrowser).not.toHaveBeenCalled();
    expect(runtime.store.listEvents(episode.id).map((e) => e.eventClass)).toContain('browser-drive-refused');
    void enrollment;
    runtime.close();
  });

  it('a cell that turns non-ready between suggest and approve is refused at revalidation with the named reason', async () => {
    let cell: PasskeyCellAdmissionState = 'ready';
    const h = harness({ cell: 'ready' });
    h.passkeyCellState.mockImplementation(() => cell);
    await h.runtime.service.tick();
    const [episode] = h.runtime.store.list();
    cell = 'rejected';
    await expect(h.runtime.service.approve(episode.id)).rejects.toThrow('approval-revalidation-refused:passkey-cell-rejected');
    h.runtime.close();
  });

  it('unattended graduation evidence is read for the passkey method: password successes do not graduate the passkey path', async () => {
    const { runtime } = harness({ cell: 'ready', mode: 'unattended' });
    // Seed a PASSWORD success for the same cell (as if from before enrollment).
    const seeded = runtime.store.suggest({ sourceEpisodeId: 5, accountId: 'acct-pk', machineId: 'machine-1', mode: 'approval',
      inputDigest: `sha256:${'b'.repeat(64)}`, profileId: 'profile-pk', framework: 'claude-code', provider: 'anthropic', loginMethod: 'password' });
    let cur = runtime.store.approve(seeded.id, { inputDigest: seeded.inputDigest });
    for (const to of ['cli-starting', 'artifact-ready', 'browser-driving', 'identity-verifying', 'auth-verifying', 'succeeded'] as const) {
      cur = runtime.store.transition(cur.id, { expectedVersion: cur.version, to, eventClass: to });
    }
    await runtime.service.tick();
    const episode = runtime.store.list().find((e) => e.sourceEpisodeId === 91)!;
    // minimumSuccessfulRepairs: 1 is met by the password row for the password method, NOT for google-passkey → held to approval.
    expect(episode).toMatchObject({ state: 'suggested', mode: 'approval', loginMethod: 'google-passkey' });
    runtime.close();
  });
});
