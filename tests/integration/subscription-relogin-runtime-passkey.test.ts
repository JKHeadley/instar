import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createSubscriptionReloginRuntime, type SubscriptionReloginRuntimeDeps } from '../../src/core/SubscriptionReloginRuntime.js';
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

const seatLeaseFile = (stateDir: string) => path.join(stateDir, 'seat-lease.json');

function harness(opts: { cell?: PasskeyCellAdmissionState; wireCell?: boolean; loginMethod?: string; passkeyKey?: string | null; mode?: 'approval' | 'unattended'; passkeySignIn?: SubscriptionReloginRuntimeDeps['passkeySignIn'] | null; identity?: string; seatLease?: SubscriptionReloginRuntimeDeps['seatLease']; stateDir?: string; helperLastResort?: boolean; onCreateBrowser?: () => void } = {}) {
  const stateDir = opts.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-passkey-runtime-')); if (!opts.stateDir) dirs.push(stateDir);
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
  const createBrowser = vi.fn(() => { opts.onCreateBrowser?.(); throw new Error('browser-must-not-open'); });
  const passkeyCellState = vi.fn(() => opts.cell ?? 'unknown');
  const runtime = createSubscriptionReloginRuntime({ stateDir, projectDir: stateDir, machineId: 'machine-1',
    mode: opts.mode ?? 'approval', unattendedPolicy: { identities: [account.email], minimumSuccessfulRepairs: 1, minimumEvidenceDays: 0 },
    pool: { getAvailability: () => ({ state: 'ready' }), get: () => ({ ...account }), list: () => [{ ...account }], update: vi.fn() } as unknown as SubscriptionPool,
    ledger: { listEpisodes: () => [{ ...source }], recordStatus: vi.fn() } as unknown as SubscriptionLoginLedger,
    enrollment,
    profiles: { resolve: () => ({ profile: { id: 'profile-pk' }, dirExists: true }),
      listProfiles: () => [{ id: 'profile-pk', userDataDir, description: '', isDefault: false, createdAt: '', dirExists: true,
        accounts: [{ service: 'google', identity: opts.identity ?? account.email, owner: 'operator', vaultRefs: [], loginMethod,
          ...(passkeyKey ? { vaultBindings: { passkey: passkeyKey } } : {}),
          lastAsserted: true, lastVerifiedAt: null, note: '', danglingRefs: [] }] }] } as unknown as PlaywrightProfileRegistry,
    quotaPoller: { pollAccount: vi.fn() } as unknown as QuotaPoller, identityOracle: { resolveSlotTenant: vi.fn() } as unknown as IdentityOracle,
    pasteBack: {} as ClaudePasteBackController, createBrowser, resolveSecret: async () => null,
    supervise: async ({ allowedActions }) => allowedActions[0],
    // Never the real machine's seat file: every harness gets its own (a busy seat is built on it).
    seatLease: opts.seatLease ?? new PlaywrightSeatLease({ filePath: seatLeaseFile(stateDir) }),
    ...(opts.wireCell === false ? {} : { passkeyCellState }),
    // The agent-session path with no other healthy account to run the helper, and the last-resort
    // model available: the repair falls back to the server-side drive (its own seat holder).
    ...(opts.helperLastResort ? {
      navigation: 'agent-session' as const,
      helperSession: { spawn: vi.fn(async () => 'helper-tmux'), isAlive: () => false, kill: vi.fn(), listHelpers: () => [],
        hasCapacity: () => true, serverPort: 4042 },
      lastResort: { available: () => true, beginDrive: vi.fn(), endDrive: vi.fn(), status: vi.fn() } as never,
      navigate: async () => 'give-up',
    } : {}),
    // The sign-in step is wired by default here (as with repairUsesPasskey on); `passkeySignIn: null`
    // is the fleet default where the step is off.
    ...(opts.passkeySignIn === null ? {} : { passkeySignIn: opts.passkeySignIn
      ?? vi.fn(async () => ({ outcome: 'ready' as const, reason: 'signed-in', riskPage: false, throttled: false })) }),
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
    expect(passkeyCellState).toHaveBeenCalledWith({ accountId: 'acct-pk', machineId: 'machine-1', entryKey: 'pk-entry-1', canonicalEmail: 'person@example.com' });

    const { runtime: pw } = harness({ loginMethod: 'session-cookie', passkeyKey: null });
    await pw.service.tick();
    expect(pw.store.list()[0]).toMatchObject({ state: 'suggested', loginMethod: 'session-cookie' });
    expect(pw.store.list()[0].inputDigest).not.toBe(episode.inputDigest);
    pw.close(); runtime.close();
  });

  it('with the passkey sign-in step off, a ready cell is never offered: no candidate, no cell read, no browser, no password flow', async () => {
    const { runtime, createBrowser, enrollment, passkeyCellState } = harness({ cell: 'ready', passkeySignIn: null });
    await runtime.service.tick();
    expect(runtime.store.list()).toEqual([]);
    expect(passkeyCellState).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
    expect(enrollment.start).not.toHaveBeenCalled();
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

  describe('the passkey sign-in step (wired only when repairUsesPasskey is on)', () => {
    async function approve(h: ReturnType<typeof harness>) {
      await h.runtime.service.tick();
      const [episode] = h.runtime.store.list();
      await h.runtime.service.approve(episode.id);
      return episode.id;
    }
    async function approveAndSettle(h: ReturnType<typeof harness>) {
      const id = await approve(h);
      await vi.waitFor(() => expect(['refused', 'failed', 'waiting-operator-only', 'succeeded']).toContain(h.runtime.store.get(id)?.state));
      return h.runtime.store.get(id)!;
    }

    it("ready: signs the account's own profile in to Google, then the provider sign-in runs in the normal browser with no secret", async () => {
      const passkeySignIn = vi.fn(async () => ({ outcome: 'ready' as const, reason: 'signed-in', riskPage: false, throttled: false }));
      const h = harness({ cell: 'ready', passkeySignIn });
      await approve(h);
      await vi.waitFor(() => expect(h.createBrowser).toHaveBeenCalled());
      expect(passkeySignIn).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-pk', canonicalEmail: 'person@example.com',
        profileDir: expect.stringContaining('browser-profile') }), expect.anything());
      expect(h.createBrowser).toHaveBeenCalled(); // the ordinary drive started after the passkey step
      h.runtime.close();
    });

    it('a profile already signed in is used as-is (session-present), like the live session today', async () => {
      const passkeySignIn = vi.fn(async () => ({ outcome: 'unknown' as const, reason: 'session-present', riskPage: false, throttled: false }));
      const h = harness({ cell: 'ready', passkeySignIn });
      await approve(h);
      await vi.waitFor(() => expect(h.createBrowser).toHaveBeenCalled());
      h.runtime.close();
    });

    it('stops by name, never opening the normal browser, on a risk page, a wrong identity or a rejected key', async () => {
      const cases = [
        { result: { outcome: 'unknown' as const, reason: 'risk-page', riskPage: true, throttled: false }, failureClass: 'captcha' },
        { result: { outcome: 'security' as const, reason: 'different-identity', riskPage: false, throttled: false }, failureClass: 'wrong-identity' },
        { result: { outcome: 'credential-rejected' as const, reason: 'google-credential-not-recognized', riskPage: false, throttled: false }, failureClass: 'passkey-refused' },
        { result: { outcome: 'unknown' as const, reason: 'throttled', riskPage: false, throttled: true }, failureClass: 'passkey-refused' },
        { result: { outcome: 'failed' as const, reason: 'assertion-not-observed', riskPage: false, throttled: false }, failureClass: 'passkey-refused' },
        { result: { outcome: 'removed-on-google' as const, reason: 'passkey-removed', riskPage: false, throttled: false }, failureClass: 'passkey-refused' },
      ];
      for (const c of cases) {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-passkey-runtime-')); dirs.push(stateDir);
        const seatLease = new PlaywrightSeatLease({ filePath: seatLeaseFile(stateDir) });
        const h = harness({ cell: 'ready', passkeySignIn: vi.fn(async () => c.result), seatLease, stateDir });
        const ep = await approveAndSettle(h);
        expect(ep.failureClass).toBe(c.failureClass);
        expect(h.createBrowser).not.toHaveBeenCalled();
        // The step gave the browser seat back on its way out: another holder can take it at once.
        expect(seatLease.acquire('next-task', 'after a refused passkey step').acquired).toBe(true);
        h.runtime.close();
      }
    });

    it('never admits a profile whose Google identity is not the account email (no candidate, no passkey step)', async () => {
      const passkeySignIn = vi.fn(async () => ({ outcome: 'ready' as const, reason: 'signed-in', riskPage: false, throttled: false }));
      const h = harness({ cell: 'ready', passkeySignIn, identity: 'someone-else@example.com' });
      await h.runtime.service.tick();
      expect(h.runtime.store.list()).toEqual([]);
      expect(passkeySignIn).not.toHaveBeenCalled();
      expect(h.createBrowser).not.toHaveBeenCalled();
      h.runtime.close();
    });

    it('on the helper path falling back to the last-resort drive, hands the seat on before the fallback drive takes it', async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-passkey-runtime-')); dirs.push(stateDir);
      const seatLease = new PlaywrightSeatLease({ filePath: seatLeaseFile(stateDir) });
      const passkeySignIn = vi.fn(async () => ({ outcome: 'ready' as const, reason: 'signed-in', riskPage: false, throttled: false }));
      // The server-side driver is built right after the passkey step and takes the seat under its own
      // holder, so at that moment the passkey step must already have handed the seat back.
      let seatFreeAtDrive: boolean | null = null;
      const onCreateBrowser = () => {
        seatFreeAtDrive = seatLease.acquire('probe', 'seat check at the fallback drive').acquired;
        if (seatFreeAtDrive) seatLease.release('probe');
      };
      const h = harness({ cell: 'ready', passkeySignIn, seatLease, stateDir, helperLastResort: true, onCreateBrowser });
      await approve(h);
      await vi.waitFor(() => expect(h.createBrowser).toHaveBeenCalled());
      expect(passkeySignIn).toHaveBeenCalled();
      expect(seatFreeAtDrive).toBe(true);
      h.runtime.close();
    });

    // The orchestrator's own release also frees the helper holder once the attempt settles, so this
    // proves the end state, not that the passkey step itself released early (no harness has a real
    // helper seat yet).
    it('on the helper path, the seat is free once a refused passkey attempt settles', async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-passkey-runtime-')); dirs.push(stateDir);
      const seatLease = new PlaywrightSeatLease({ filePath: seatLeaseFile(stateDir) });
      const passkeySignIn = vi.fn(async () => ({ outcome: 'failed' as const, reason: 'assertion-not-observed', riskPage: false, throttled: false }));
      const h = harness({ cell: 'ready', passkeySignIn, seatLease, stateDir, helperLastResort: true });
      const ep = await approveAndSettle(h);
      expect(ep.failureClass).toBe('passkey-refused');
      expect(seatLease.acquire('next-task', 'after a refused passkey step').acquired).toBe(true);
      h.runtime.close();
    });

    it('waits (seat-busy) without touching Google when another holder has the browser seat', async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-passkey-runtime-')); dirs.push(stateDir);
      const seatLease = new PlaywrightSeatLease({ filePath: seatLeaseFile(stateDir) });
      expect(seatLease.acquire('someone-else', 'another browser task').acquired).toBe(true);
      const passkeySignIn = vi.fn(async () => ({ outcome: 'ready' as const, reason: 'signed-in', riskPage: false, throttled: false }));
      const h = harness({ cell: 'ready', passkeySignIn, seatLease, stateDir });
      const id = await approve(h);
      await vi.waitFor(() => expect(h.runtime.store.get(id)).toMatchObject({ failureClass: 'seat-busy' }));
      expect(h.runtime.store.listEvents(id).some((e) => e.reason === 'seat-busy')).toBe(true);
      expect(passkeySignIn).not.toHaveBeenCalled();
      expect(h.createBrowser).not.toHaveBeenCalled();
      h.runtime.close();
    });
  });
});

