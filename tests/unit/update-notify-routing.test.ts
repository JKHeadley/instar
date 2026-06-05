/**
 * Wiring-integrity tests for AutoUpdater's notify() funnel.
 *
 * The pure policy lives in update-notify-policy.test.ts. THIS file proves the
 * funnel is actually wired to the policy and to Telegram — i.e. the decision is
 * not a no-op:
 *   - a 'mechanics' notify NEVER reaches Telegram (housekeeping → logs only)
 *   - an 'interruption' / 'actionable' / 'failure-escalated' notify DOES reach
 *     Telegram
 *   - the option-B heartbeat is gated by the backgroundRefreshHeartbeat config:
 *     OFF → the background-refresh confirmation is silent; ON → it sends
 *
 * Regression target: the Updates topic was flooding with version-churn
 * mechanics ("Just updated to v1.3.217. Restarting…", "vX applied but I'm still
 * running vY", "rolling into the pending restart at 02:42"). These assertions
 * lock in that those mechanics no longer reach the user.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { AutoUpdaterConfig } from '../../src/core/AutoUpdater.js';

const UPDATES_TOPIC = 7849;

function mockUpdateChecker(): UpdateChecker {
  return {
    check: vi.fn(),
    applyUpdate: vi.fn(),
    getInstalledVersion: vi.fn().mockReturnValue('1.3.217'),
    getLastCheck: vi.fn().mockReturnValue(null),
    rollback: vi.fn(),
    canRollback: vi.fn().mockReturnValue(false),
    getRollbackInfo: vi.fn().mockReturnValue(null),
    fetchChangelog: vi.fn().mockResolvedValue(undefined),
  } as unknown as UpdateChecker;
}

function mockTelegram(): TelegramAdapter {
  return {
    sendToTopic: vi.fn().mockResolvedValue(undefined),
    platform: 'telegram',
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn(),
    resolveUser: vi.fn(),
  } as unknown as TelegramAdapter;
}

function mockState(): StateManager {
  return {
    get: vi.fn((key: string) => (key === 'agent-updates-topic' ? UPDATES_TOPIC : undefined)),
    set: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    saveSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
  } as unknown as StateManager;
}

function makeUpdater(config?: Partial<AutoUpdaterConfig>) {
  const telegram = mockTelegram();
  const updater = new AutoUpdater(
    mockUpdateChecker(),
    mockState(),
    os.tmpdir(),
    config as AutoUpdaterConfig,
    telegram,
    null,
  );
  // notify() is private; the funnel is what we're testing, so reach it directly.
  const notify = (msg: string, kind?: string, opts?: unknown) =>
    (updater as unknown as {
      notify: (m: string, k?: string, o?: unknown) => Promise<void>;
    }).notify(msg, kind, opts);
  return { updater, telegram, notify };
}

describe('AutoUpdater.notify funnel routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT send update mechanics to Telegram (silent → logs only)', async () => {
    const { telegram, notify } = makeUpdater();
    await notify('v1.3.217 applied but still running v1.3.218', 'mechanics');
    expect(telegram.sendToTopic).not.toHaveBeenCalled();
  });

  it('defaults an untagged notify to silent mechanics (fail-safe)', async () => {
    const { telegram, notify } = makeUpdater();
    await notify('some future un-audited update notice');
    expect(telegram.sendToTopic).not.toHaveBeenCalled();
  });

  it('sends an interruption to Telegram (a restart hitting the user now)', async () => {
    const { telegram, notify } = makeUpdater();
    await notify('Heads up — restarting now. Back in a few seconds.', 'interruption');
    expect(telegram.sendToTopic).toHaveBeenCalledTimes(1);
    expect(telegram.sendToTopic).toHaveBeenCalledWith(
      UPDATES_TOPIC,
      expect.stringContaining('Back in a few seconds'),
    );
  });

  it('sends an actionable notice to Telegram', async () => {
    const { telegram, notify } = makeUpdater();
    await notify('Say "update" and I will apply it.', 'actionable');
    expect(telegram.sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('sends an escalated failure to Telegram', async () => {
    const { telegram, notify } = makeUpdater();
    await notify('The restart did not take.', 'failure-escalated');
    expect(telegram.sendToTopic).toHaveBeenCalledTimes(1);
  });

  describe('option B — backgroundRefreshHeartbeat', () => {
    it('silences the background-refresh confirmation when OFF (default A)', async () => {
      const { telegram, notify } = makeUpdater({ backgroundRefreshHeartbeat: false });
      await notify('Just refreshed in the background — I am current.', 'mechanics', {
        isBackgroundRefreshConfirmation: true,
      });
      expect(telegram.sendToTopic).not.toHaveBeenCalled();
    });

    it('sends the background-refresh confirmation when ON', async () => {
      const { telegram, notify } = makeUpdater({ backgroundRefreshHeartbeat: true });
      await notify('Just refreshed in the background — I am current.', 'mechanics', {
        isBackgroundRefreshConfirmation: true,
      });
      expect(telegram.sendToTopic).toHaveBeenCalledTimes(1);
    });

    it('still silences NON-confirmation mechanics when ON (no flood regression)', async () => {
      const { telegram, notify } = makeUpdater({ backgroundRefreshHeartbeat: true });
      await notify('rolling into the pending restart at 02:42', 'mechanics');
      expect(telegram.sendToTopic).not.toHaveBeenCalled();
    });
  });
});
