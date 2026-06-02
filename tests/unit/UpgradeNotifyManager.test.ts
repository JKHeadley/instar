import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpgradeNotifyManager } from '../../src/core/UpgradeNotifyManager.js';
import type {
  UpgradeNotifyConfig,
  UpgradeNotifyTiming,
  SessionSpawner,
  SessionCompletionChecker,
  ActivityLogger,
} from '../../src/core/UpgradeNotifyManager.js';
import type { Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-notify-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  return dir;
}

function writePendingGuide(stateDir: string, content: string = '# Test Guide\n## What Changed\nTest changes'): string {
  const guidePath = path.join(stateDir, 'state', 'pending-upgrade-guide.md');
  fs.writeFileSync(guidePath, content);
  return guidePath;
}

function makeConfig(stateDir: string, guidePath: string): UpgradeNotifyConfig {
  return {
    pendingGuidePath: guidePath,
    projectDir: '/tmp/test-project',
    stateDir,
    port: 4040,
    dashboardPin: '123456',
    tunnelUrl: 'https://test.trycloudflare.com',
    currentVersion: '0.9.9',
    replyScript: '/tmp/test-project/.claude/scripts/telegram-reply.sh',
    notifyTopicId: 997,
  };
}

function makeSession(id: string): Session {
  return {
    id,
    name: 'upgrade-notify',
    status: 'running',
    tmuxSession: 'test-upgrade-notify',
    startedAt: new Date().toISOString(),
    model: 'fast',
    jobSlug: 'upgrade-notify',
    maxDurationMinutes: 5,
  };
}

/** Zero-delay timing for tests */
const TEST_TIMING: UpgradeNotifyTiming = {
  sessionTimeoutMs: 500,
  pollIntervalMs: 10,
  postCompletionDelayMs: 0,
};

// ── Tests ────────────────────────────────────────────────────────

describe('UpgradeNotifyManager', () => {
  let tmpDir: string;
  let guidePath: string;
  let config: UpgradeNotifyConfig;
  let spawnSession: ReturnType<typeof vi.fn>;
  let isSessionComplete: ReturnType<typeof vi.fn>;
  let logActivity: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = createTmpDir();
    guidePath = writePendingGuide(tmpDir);
    config = makeConfig(tmpDir, guidePath);
    spawnSession = vi.fn();
    isSessionComplete = vi.fn();
    logActivity = vi.fn();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/UpgradeNotifyManager.test.ts:84' });
    vi.restoreAllMocks();
  });

  describe('notify() — success on first attempt', () => {
    it('returns success when guide is acknowledged after haiku session', async () => {
      const session = makeSession('sess-001');
      spawnSession.mockResolvedValue(session);

      // Session completes immediately
      isSessionComplete.mockReturnValue(true);

      // Simulate upgrade-ack removing the pending guide
      // We need to remove it after spawnSession is called but before isAcknowledged is checked
      spawnSession.mockImplementation(async () => {
        SafeFsExecutor.safeUnlinkSync(guidePath, { operation: 'tests/unit/UpgradeNotifyManager.test.ts:100' });
        return session;
      });

      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const result = await manager.notify();

      expect(result.success).toBe(true);
      expect(result.model).toBe('fast');
      expect(result.attempts).toBe(1);
      expect(spawnSession).toHaveBeenCalledTimes(1);
      expect(spawnSession.mock.calls[0][0].model).toBe('fast');
    });

    it('logs success activity event', async () => {
      spawnSession.mockImplementation(async () => {
        SafeFsExecutor.safeUnlinkSync(guidePath, { operation: 'tests/unit/UpgradeNotifyManager.test.ts:117' });
        return makeSession('sess-001');
      });
      isSessionComplete.mockReturnValue(true);

      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      await manager.notify();

      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'upgrade_notify_success',
        }),
      );
    });
  });

  describe('notify() — model escalation', () => {
    it('escalates to sonnet when haiku fails to acknowledge', async () => {
      const haikuSession = makeSession('sess-haiku');
      const sonnetSession = makeSession('sess-sonnet');

      let callCount = 0;
      spawnSession.mockImplementation(async (opts: any) => {
        callCount++;
        if (callCount === 2) {
          // Sonnet succeeds — remove the guide
          SafeFsExecutor.safeUnlinkSync(guidePath, { operation: 'tests/unit/UpgradeNotifyManager.test.ts:144' });
          return sonnetSession;
        }
        return haikuSession; // Haiku doesn't remove it
      });

      isSessionComplete.mockReturnValue(true);

      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const result = await manager.notify();

      expect(result.success).toBe(true);
      expect(result.model).toBe('balanced');
      expect(result.attempts).toBe(2);
      expect(spawnSession).toHaveBeenCalledTimes(2);
      expect(spawnSession.mock.calls[0][0].model).toBe('fast');
      expect(spawnSession.mock.calls[1][0].model).toBe('balanced');
    });
  });

  describe('notify() — all attempts fail', () => {
    it('returns failure after both haiku and sonnet fail', async () => {
      spawnSession.mockResolvedValue(makeSession('sess-fail'));
      isSessionComplete.mockReturnValue(true);
      // Guide is never removed

      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const result = await manager.notify();

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.error).toContain('not acknowledged');
      expect(spawnSession).toHaveBeenCalledTimes(2);
    });

    it('preserves the pending guide file on failure', async () => {
      spawnSession.mockResolvedValue(makeSession('sess-fail'));
      isSessionComplete.mockReturnValue(true);

      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      await manager.notify();

      // Guide should still be on disk for next session-start
      expect(fs.existsSync(guidePath)).toBe(true);
    });

    it('logs failure activity event', async () => {
      spawnSession.mockResolvedValue(makeSession('sess-fail'));
      isSessionComplete.mockReturnValue(true);

      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      await manager.notify();

      expect(logActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'upgrade_notify_failed',
        }),
      );
    });
  });

  describe('notify() — spawn failure', () => {
    it('handles spawn errors gracefully and escalates', async () => {
      let callCount = 0;
      spawnSession.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('tmux session already exists');
        SafeFsExecutor.safeUnlinkSync(guidePath, { operation: 'tests/unit/UpgradeNotifyManager.test.ts:212' });
        return makeSession('sess-recovery');
      });
      isSessionComplete.mockReturnValue(true);

      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const result = await manager.notify();

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });
  });

  describe('notify() — no pending guide', () => {
    it('returns immediately when no pending guide exists', async () => {
      // Remove the guide
      SafeFsExecutor.safeUnlinkSync(guidePath, { operation: 'tests/unit/UpgradeNotifyManager.test.ts:229' });

      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const result = await manager.notify();

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(0);
      expect(spawnSession).not.toHaveBeenCalled();
    });
  });

  describe('buildPrompt()', () => {
    // Silent-by-default (mature-update-announcements spec): the dashboard
    // URL/PIN/version/reply-script are injected only when there is a user-facing
    // announcement to compose. A guide carrying a `user_announcement` user entry
    // exercises that announce branch.
    const ANNOUNCE_GUIDE = [
      '---',
      'user_announcement:',
      '  - audience: user',
      '    maturity: stable',
      '    headline: New thing',
      '    body: you can use it now',
      '---',
      '# Guide',
      '## What Changed',
      'Big stuff',
    ].join('\n');

    it('includes guide content', () => {
      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const prompt = manager.buildPrompt('# My Guide\n## What Changed\nBig stuff');

      expect(prompt).toContain('# My Guide');
      expect(prompt).toContain('Big stuff');
      expect(prompt).toContain('--- UPGRADE GUIDE ---');
      expect(prompt).toContain('--- END GUIDE ---');
    });

    it('includes dashboard URL with tunnel when available (announce branch)', () => {
      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const prompt = manager.buildPrompt(ANNOUNCE_GUIDE);

      expect(prompt).toContain('https://test.trycloudflare.com/dashboard');
    });

    it('includes dashboard PIN (announce branch)', () => {
      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const prompt = manager.buildPrompt(ANNOUNCE_GUIDE);

      expect(prompt).toContain('123456');
    });

    it('includes current version (announce branch)', () => {
      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const prompt = manager.buildPrompt(ANNOUNCE_GUIDE);

      expect(prompt).toContain('0.9.9');
    });

    it('includes all three required steps', () => {
      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const prompt = manager.buildPrompt('guide');

      expect(prompt).toContain('## Step 1: Notify your user');
      expect(prompt).toContain('## Step 2: Update your memory');
      expect(prompt).toContain('## Step 3: Acknowledge');
      expect(prompt).toContain('instar upgrade-ack');
    });

    it('includes Telegram reply instruction when script exists (announce branch)', () => {
      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const prompt = manager.buildPrompt(ANNOUNCE_GUIDE);

      expect(prompt).toContain('telegram-reply.sh');
      expect(prompt).toContain('997');
    });

    it('uses localhost when no tunnel URL (announce branch)', () => {
      const noTunnelConfig = { ...config, tunnelUrl: '' };
      const manager = new UpgradeNotifyManager(noTunnelConfig, spawnSession, isSessionComplete, logActivity);
      const prompt = manager.buildPrompt(ANNOUNCE_GUIDE);

      expect(prompt).toContain('http://localhost:4040/dashboard');
    });

    it('skips the user message when the guide has no user-facing announcement (silent by default)', () => {
      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      const prompt = manager.buildPrompt('# Guide\n## What Changed\ninfra only');

      expect(prompt).toContain('## Step 1: Notify your user — SKIP');
      expect(prompt).not.toContain('Lead with the biggest USER-VISIBLE feature');
      // Steps 2 & 3 still run so the agent still learns the capability.
      expect(prompt).toContain('## Step 2: Update your memory');
      expect(prompt).toContain('## Step 3: Acknowledge');
    });
  });

  describe('isAcknowledged()', () => {
    it('returns false when pending guide exists', () => {
      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      expect(manager.isAcknowledged()).toBe(false);
    });

    it('returns true when pending guide has been removed', () => {
      SafeFsExecutor.safeUnlinkSync(guidePath, { operation: 'tests/unit/UpgradeNotifyManager.test.ts:307' });
      const manager = new UpgradeNotifyManager(config, spawnSession, isSessionComplete, logActivity, TEST_TIMING);
      expect(manager.isAcknowledged()).toBe(true);
    });
  });
});
