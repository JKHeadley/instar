/**
 * FollowMeCompletionWatcher — after a submitted paste-back code, the server drives
 * the sign-in to exactly one terminal state (operator report 2026-11-10, topic 33890).
 * Real EnrollmentWizard + real PendingLoginStore on a temp dir; injected clock/sleep,
 * pane liveness, identity oracle and auth-revision witness. No tmux, no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PendingLoginStore } from '../../src/core/PendingLoginStore.js';
import { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import { FollowMeCompletionWatcher } from '../../src/core/FollowMeCompletionWatcher.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-11-10T19:15:41Z');

describe('FollowMeCompletionWatcher', () => {
  let dir: string;
  let clock: number;
  let store: PendingLoginStore;
  let revision: string;
  let paneAlive: boolean | null;
  let identity: { email?: string; unavailable?: boolean; reason?: string };
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-watch-'));
    clock = T0;
    store = new PendingLoginStore({ stateDir: dir, now: () => clock });
    revision = 'before';
    paneAlive = true;
    identity = { unavailable: true, reason: 'profile endpoint returned 401' };
    emit = vi.fn();
    store.issue({
      id: 'gearfinity3d', label: 'gearfinity3d', provider: 'anthropic', framework: 'claude-code',
      kind: 'url-code-paste', configHome: '/x/.claude-followme-gearfinity3d',
      verificationUrl: 'https://claude.com/oauth', expectedEmail: 'gearfinity3d@gmail.com',
      authRevisionBaseline: 'before',
    });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/follow-me-completion-watcher.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  function setup(extra: { afterValidated?: () => Promise<void> } = {}) {
    const wizard = new EnrollmentWizard({
      store,
      now: () => clock,
      driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth', ttlMs: 15 * 60_000 }),
      oracle: { resolveSlotTenant: async () => identity as never },
      authRevisionWitness: () => revision,
      emitAttention: emit,
      ensureReady: () => ({ patched: false, reason: 'already interactive-ready' }),
    });
    const onValidated = vi.fn();
    const ticks: Array<() => void> = [];
    const watcher = new FollowMeCompletionWatcher({
      wizard,
      paneAlive: () => paneAlive,
      onValidated,
      afterValidated: extra.afterValidated,
      now: () => clock,
      sleep: async (ms) => { clock += ms; for (const t of ticks.splice(0)) t(); },
      pollMs: 2_000,
      timeoutMs: 30_000,
      windowClosedGraceMs: 4_000,
    });
    /** Run `fn` once the clock has passed `atMs` after T0. */
    const at = (atMs: number, fn: () => void) => {
      const check = () => { if (clock - T0 >= atMs) fn(); else ticks.push(check); };
      ticks.push(check);
    };
    return { wizard, watcher, onValidated, at };
  }

  it('the credential lands → done, the login completes and the account is upserted', async () => {
    const afterValidated = vi.fn(async () => {});
    const { watcher, onValidated, at } = setup({ afterValidated });
    at(4_000, () => { revision = 'after'; identity = { email: 'gearfinity3d@gmail.com' }; });
    const first = watcher.watch('gearfinity3d');
    expect(first.state).toBe('finishing');
    const done = await watcher.settled('gearfinity3d');
    expect(done?.state).toBe('done');
    expect(done?.email).toBe('gearfinity3d@gmail.com');
    expect(done?.message).toBe('Signed in as gearfinity3d@gmail.com.');
    expect(onValidated).toHaveBeenCalledTimes(1);
    expect(afterValidated).toHaveBeenCalledTimes(1);
    expect(store.get('gearfinity3d')?.status).toBe('completed');
  });

  it('the window closes and the slot never signs in → failed window-closed, no attention, login left pending', async () => {
    const { watcher, onValidated, at } = setup();
    at(2_000, () => { paneAlive = false; });
    watcher.watch('gearfinity3d');
    const r = await watcher.settled('gearfinity3d');
    expect(r?.state).toBe('failed');
    expect(r?.reason).toBe('window-closed');
    expect(r?.message).toMatch(/closed without a sign-in/);
    expect(onValidated).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(store.get('gearfinity3d')?.status).toBe('pending');
  });

  it('the window closes on a host with no readable auth revision but the slot answers live as the expected account → done', async () => {
    const { watcher, onValidated, at } = setup();
    at(2_000, () => { paneAlive = false; identity = { email: 'gearfinity3d@gmail.com' }; });
    watcher.watch('gearfinity3d');
    const r = await watcher.settled('gearfinity3d');
    expect(r?.state).toBe('done');
    expect(onValidated).toHaveBeenCalledTimes(1);
  });

  it('the window stays open and nothing lands → failed timed-out after the bound', async () => {
    const { watcher } = setup();
    watcher.watch('gearfinity3d');
    const r = await watcher.settled('gearfinity3d');
    expect(r?.state).toBe('failed');
    expect(r?.reason).toBe('timed-out');
    expect(clock - T0).toBeGreaterThanOrEqual(30_000);
    expect(clock - T0).toBeLessThan(40_000);
  });

  it('a different account signs in → failed wrong-account naming both, not added', async () => {
    const { watcher, onValidated, at } = setup();
    at(2_000, () => { revision = 'after'; identity = { email: 'someone-else@gmail.com' }; });
    watcher.watch('gearfinity3d');
    const r = await watcher.settled('gearfinity3d');
    expect(r?.state).toBe('failed');
    expect(r?.reason).toBe('wrong-account');
    expect(r?.expected).toBe('gearfinity3d@gmail.com');
    expect(r?.got).toBe('someone-else@gmail.com');
    expect(onValidated).not.toHaveBeenCalled();
  });

  it('cancelled while finishing → failed cancelled', async () => {
    const { watcher, wizard, at } = setup();
    at(2_000, () => { wizard.abandon('gearfinity3d'); });
    watcher.watch('gearfinity3d');
    const r = await watcher.settled('gearfinity3d');
    expect(r?.reason).toBe('cancelled');
  });

  it('finished by another path (the background sweep) → done', async () => {
    const { watcher, wizard, at } = setup();
    at(2_000, () => { wizard.complete('gearfinity3d'); });
    watcher.watch('gearfinity3d');
    const r = await watcher.settled('gearfinity3d');
    expect(r?.state).toBe('done');
  });

  it('a second watch while finishing joins the first instead of starting another', async () => {
    const { watcher } = setup();
    const a = watcher.watch('gearfinity3d');
    const b = watcher.watch('gearfinity3d');
    expect(b.startedAt).toBe(a.startedAt);
    await watcher.settled('gearfinity3d');
  });
});
