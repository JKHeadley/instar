/**
 * A failed browser drive records the screen state beside its failure (2026-11-26: Chrome stopped
 * answering Apple Events on the Studio and Mini while the console was locked and the display
 * asleep). The note is audit only: it never changes the outcome, the state or the reason.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionReloginOrchestrator } from '../../src/core/SubscriptionReloginOrchestrator.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';
import { screenStateToken } from '../../src/core/MachineLockStateReader.js';
import { EMPTY_LOCK_INPUTS } from '../../src/monitoring/machineMaintenance/lockState.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true, operation: 'subscription-relogin-screen-state.test cleanup',
  });
});

function fixture(screen?: () => Promise<'locked' | 'asleep' | 'lock-flag-set' | null>) {
  const now = Date.parse('2026-11-26T21:30:00.000Z');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-screen-'));
  dirs.push(stateDir);
  const store = new SubscriptionReloginStore({ stateDir, now: () => now, idFactory: () => 'repair-1' });
  const suggested = store.suggest({ sourceEpisodeId: 7, accountId: 'acct-1', machineId: 'machine-1',
    mode: 'approval', inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1',
    framework: 'claude-code', provider: 'anthropic' });
  const approved = store.approve(suggested.id, { inputDigest: suggested.inputDigest });
  const ports = {
    store,
    authorityReady: vi.fn(() => true),
    sourceIncidentOpen: vi.fn(() => true),
    recoverUncertain: vi.fn(async () => 'credential-ready' as const),
    startOrRecoverLogin: vi.fn(async () => ({ attemptId: 'attempt-1', kind: 'url-code-paste' as const,
      expiresAt: new Date(now + 600_000).toISOString(), reissueCount: 0 })),
    driveBrowser: vi.fn(async (): Promise<any> => ({ outcome: 'transient', failureClass: 'provider-transient', reason: 'chrome-launch-timeout-apple-event-no-reply' })),
    finishCli: vi.fn(async () => 'complete' as const),
    verifyIdentity: vi.fn(async () => 'match' as const),
    quarantineIdentityMismatch: vi.fn(async () => undefined),
    verifyAuthenticatedUse: vi.fn(async () => true),
    finalizeSuccess: vi.fn(async () => undefined),
    accountActive: vi.fn(() => false),
    now: () => now,
    retryBaseMs: 1_000,
    maxAttempts: 3,
    ...(screen ? { screenStateAtFailure: vi.fn(screen) } : {}),
  };
  return { store, approved, ports };
}
const notes = (store: SubscriptionReloginStore, id: string) =>
  store.listEvents(id).filter((e) => e.eventClass === 'screen-state-at-failure').map((e) => e.reason);

describe('screen state beside a failed repair', () => {
  it('records the reading next to a transient failure and keeps the failure reason unchanged', async () => {
    const { store, approved, ports } = fixture(async () => 'lock-flag-set');
    const result = await new SubscriptionReloginOrchestrator(ports).tick(approved.id);
    expect(result.episode).toMatchObject({ state: 'approved', failureClass: 'provider-transient' });
    expect(notes(store, approved.id)).toEqual(['browser-screen-lock-flag-set']);
    const retry = store.listEvents(approved.id).find((e) => e.eventClass === 'transient-retry-scheduled');
    expect(retry?.reason).toBe('chrome-launch-timeout-apple-event-no-reply');
    store.close();
  });

  it('records it for refused, operator-only and thrown drives too', async () => {
    for (const drive of [
      async () => ({ outcome: 'refused', failureClass: 'agent-sign-in-unfinished', reason: 'agent-helper-exited' }),
      async () => ({ outcome: 'operator-only', failureClass: 'captcha' }),
      async () => { throw new Error('boom'); },
    ]) {
      const { store, approved, ports } = fixture(async () => 'locked');
      ports.driveBrowser.mockImplementation(drive as never);
      await new SubscriptionReloginOrchestrator(ports).tick(approved.id);
      expect(notes(store, approved.id)).toEqual(['browser-screen-locked']);
      store.close();
    }
  });

  it('records nothing on success, on an awake screen, without a reader, or when the reader fails or hangs', async () => {
    const ok = fixture(async () => 'locked');
    ok.ports.driveBrowser.mockResolvedValue({ outcome: 'approved', pasteCode: 'code' });
    await new SubscriptionReloginOrchestrator(ok.ports).tick(ok.approved.id);
    expect(notes(ok.store, ok.approved.id)).toEqual([]);
    ok.store.close();
    for (const screen of [async () => null, undefined, async () => { throw new Error('probe'); }]) {
      const f = fixture(screen as never);
      const r = await new SubscriptionReloginOrchestrator(f.ports).tick(f.approved.id);
      expect(r.episode.failureClass).toBe('provider-transient');
      expect(notes(f.store, f.approved.id)).toEqual([]);
      f.store.close();
    }
    vi.useFakeTimers();
    try {
      const hang = fixture(() => new Promise(() => {}));
      const pending = new SubscriptionReloginOrchestrator(hang.ports).tick(hang.approved.id);
      await vi.advanceTimersByTimeAsync(3_100);
      const r = await pending;
      expect(r.episode.failureClass).toBe('provider-transient');
      expect(notes(hang.store, hang.approved.id)).toEqual([]);
      hang.store.close();
    } finally { vi.useRealTimers(); }
  });

  it('lets a cancel that lands during the reading win, with no note after it', async () => {
    for (const thrown of [false, true]) {
      const controller = new AbortController();
      let storeRef: SubscriptionReloginStore | undefined; let idRef = '';
      const { store, approved, ports } = fixture(async () => {
        storeRef!.cancel(idRef); controller.abort(); return 'locked';
      });
      storeRef = store; idRef = approved.id;
      if (thrown) ports.driveBrowser.mockImplementation(async () => { throw new Error('osascript died'); });
      const result = await new SubscriptionReloginOrchestrator(ports).tick(approved.id, controller.signal);
      expect(result).toMatchObject({ outcome: 'terminal', episode: { state: 'cancelled' } });
      expect(notes(store, approved.id)).toEqual([]);
      expect(store.listEvents(approved.id)[0].eventClass).toBe('operator-cancelled');
      store.close();
    }
  });

  it('never writes a note on a moved or ended episode', () => {
    const { store, approved } = fixture();
    store.recordNote(approved.id, approved.version + 1, 'screen-state-at-failure', 'browser-screen-locked');
    expect(notes(store, approved.id)).toEqual([]);
    const cancelled = store.cancel(approved.id);
    store.recordNote(approved.id, cancelled.version, 'screen-state-at-failure', 'browser-screen-locked');
    expect(notes(store, approved.id)).toEqual([]);
    store.close();
  });
});

describe('screenStateToken', () => {
  const r = (lockState: any, flagLocked: boolean | null) => ({ lockState, inputs: { ...EMPTY_LOCK_INPUTS, flagLocked } });
  it('maps the honest reading without ever turning unknown into locked', () => {
    expect(screenStateToken(r('locked', true))).toBe('locked');
    expect(screenStateToken(r('screensaver-or-display-sleep', true))).toBe('asleep');
    expect(screenStateToken(r('unknown', true))).toBe('lock-flag-set');
    expect(screenStateToken(r('unknown', null))).toBeNull();
    expect(screenStateToken(r('unlocked', false))).toBeNull();
    expect(screenStateToken(r('not-applicable', null))).toBeNull();
    expect(screenStateToken(null)).toBeNull();
  });
});
