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
import type { ReloginBrowserPort } from '../../src/core/AnthropicReloginBrowserDriver.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
  recursive: true, force: true, operation: 'subscription-relogin-runtime.test cleanup',
}); });

describe('production-shaped subscription re-login runtime', () => {
  it.each(['google', 'anthropic'])('connects a %s-backed browser identity through admission, browser, quota, pool activation, and exact ledger closure', async (browserService) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-runtime-')); dirs.push(stateDir);
    const userDataDir = path.join(stateDir, 'browser-profile'); fs.mkdirSync(userDataDir);
    let account: SubscriptionAccount = { id: 'acct-1', nickname: 'Claude account', email: 'person@example.com',
      provider: 'anthropic', framework: 'claude-code', configHome: path.join(stateDir, 'slot'),
      status: 'needs-reauth', enrolledAt: '2026-01-01T00:00:00Z', version: 1 };
    let source: SubscriptionLoginEpisode = { id: 71, accountId: account.id, machineId: 'machine-1',
      openedAt: '2026-08-28T00:00:00Z', closedAt: null, causeClass: 'exchange-failed',
      corroboration: 'exchange-corroborated', outcome: null, provenance: 'observed' };
    const pool = { getAvailability: () => ({ state: 'ready' }), get: (id: string) => id === account.id ? { ...account } : null,
      update: vi.fn((_id: string, patch: Partial<SubscriptionAccount>) => { account = { ...account, ...patch, version: account.version + 1 }; return account; }) } as unknown as SubscriptionPool;
    const ledger = { listEpisodes: () => [{ ...source }], recordStatus: vi.fn(() => {
      source = { ...source, closedAt: '2026-08-28T01:00:00Z', outcome: 'resolved' }; return { changed: true, episodeId: source.id };
    }) } as unknown as SubscriptionLoginLedger;
    let pending: any = null;
    const enrollment = { getById: () => pending, start: vi.fn(async () => (pending = {
      id: account.id, label: account.nickname, provider: 'anthropic', framework: 'claude-code',
      kind: 'url-code-paste', configHome: account.configHome, verificationUrl: 'https://claude.ai/oauth/authorize',
      ttlExpiresAt: '2099-01-01T00:00:00Z', status: 'pending', reissueCount: 0,
      createdAt: '2026-08-28T00:00:00Z', updatedAt: '2026-08-28T00:00:00Z', version: 1,
    })), refresh: vi.fn() } as unknown as EnrollmentWizard;
    const profiles = { resolve: () => ({ profile: { id: 'profile-1' }, dirExists: true }), listProfiles: () => [{
      id: 'profile-1', userDataDir, description: '', isDefault: false, createdAt: '', dirExists: true,
      accounts: [{ service: browserService, identity: account.email, owner: 'operator', vaultRefs: [],
        loginMethod: 'session-cookie', lastAsserted: true, lastVerifiedAt: null, note: '', danglingRefs: [] }],
    }] } as unknown as PlaywrightProfileRegistry;
    const browser: ReloginBrowserPort = { open: vi.fn(async () => {}), snapshot: vi.fn(async () => ({
      origin: 'https://claude.ai', pageClass: 'success', expectedAccountVisible: true,
      hasNext: false, hasAuthorize: false, requestedScopes: [],
    })), chooseExpectedAccount: vi.fn(), fillPublic: vi.fn(), fillSecret: vi.fn(), click: vi.fn(),
    readPasteCode: vi.fn(), wait: vi.fn(), close: vi.fn(async () => {}) };
    const runtime = createSubscriptionReloginRuntime({ stateDir, projectDir: stateDir, machineId: 'machine-1',
      mode: 'approval', pool, ledger, enrollment, profiles,
      quotaPoller: { pollAccount: vi.fn(async () => ({ source: 'oauth-api', measuredAt: new Date().toISOString() })) } as unknown as QuotaPoller,
      identityOracle: { resolveSlotTenant: vi.fn(async () => ({ email: account.email })) } as unknown as IdentityOracle,
      pasteBack: { finish: vi.fn(async () => 'complete') } as unknown as ClaudePasteBackController,
      createBrowser: () => browser, resolveSecret: async () => null,
      supervise: async ({ allowedActions }) => allowedActions[0],
    });
    await runtime.service.tick();
    const suggested = runtime.store.list()[0]; expect(suggested.state).toBe('suggested');
    await runtime.service.approve(suggested.id);
    await vi.waitFor(() => expect(runtime.store.get(suggested.id)?.state).toBe('succeeded'));
    expect(account.status).toBe('active');
    expect(source.closedAt).not.toBeNull();
    expect(enrollment.start).toHaveBeenCalledWith(expect.objectContaining({ openBrowser: false }));
    expect(browser.open).toHaveBeenCalledWith('https://claude.ai/oauth/authorize');
    runtime.close();
  });
});
