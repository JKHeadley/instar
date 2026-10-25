import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRecovery, type SessionRecoveryDeps } from '../../src/monitoring/SessionRecovery.js';
import { createContextCompactionAttempt } from '../../src/monitoring/ContextCompactionControl.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('context exhaustion recovery → internal control composition', () => {
  let tmpDir = '';
  afterEach(() => {
    if (tmpDir) SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'context-compaction-control integration cleanup' });
  });

  it('carries the authoritative triggering topic into /compact and preserves the session', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-compaction-control-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    const wall = 'Error: Conversation too long. Press esc twice to go up a few messages and try again.';
    let compacted = false;
    let now = 1_000;
    const injectInternalControlCommand = vi.fn((session: string, conversationId: string, command: '/compact') => {
      expect(session).toBe('shared-session-name');
      expect(conversationId).toBe('4412');
      expect(command).toBe('/compact');
      compacted = true;
      return true;
    });
    const sessionControl = {
      injectInternalControlCommand,
      captureOutput: vi.fn(() => compacted ? 'ready prompt' : wall),
    };
    const attemptCompaction = createContextCompactionAttempt(sessionControl, {
      now: () => now,
      sleep: async (ms) => { now += ms; },
      timeoutMs: 100,
      pollMs: 10,
    });
    const deps: SessionRecoveryDeps = {
      isSessionAlive: () => true,
      killSession: vi.fn(),
      respawnSession: vi.fn(async () => {}),
      respawnSessionFresh: vi.fn(async () => {}),
      getPanePid: () => null,
      captureSessionOutput: () => compacted ? 'ready prompt' : wall,
      hasActiveProcesses: () => false,
      attemptCompaction,
    };
    const recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);

    const result = await recovery.checkAndRecover(4412, 'shared-session-name');

    expect(result).toMatchObject({ recovered: true, failureType: 'context_exhaustion' });
    expect(result.message).toContain('/compact');
    expect(injectInternalControlCommand).toHaveBeenCalledOnce();
    expect(deps.killSession).not.toHaveBeenCalled();
    expect(deps.respawnSessionFresh).not.toHaveBeenCalled();
  });

  it('resolves Slack synthetic monitor IDs to the durable delivery conversation', async () => {
    let compacted = false;
    let now = 1_000;
    const injectInternalControlCommand = vi.fn(() => { compacted = true; return true; });
    const attempt = createContextCompactionAttempt({
      injectInternalControlCommand,
      captureOutput: () => compacted ? 'ready prompt' : 'Conversation too long',
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms; },
      pollMs: 10,
      timeoutMs: 100,
      resolveConversationId: (sessionName, topicId) => {
        expect(sessionName).toBe('slack-thread-session');
        expect(topicId).toBe(-9981);
        return '730044';
      },
    });

    await expect(attempt('slack-thread-session', -9981)).resolves.toEqual({ cleared: true });
    expect(injectInternalControlCommand).toHaveBeenCalledWith('slack-thread-session', '730044', '/compact');
  });

  it('refuses compaction when the platform cannot prove delivery conversation authority', async () => {
    const injectInternalControlCommand = vi.fn(() => true);
    const attempt = createContextCompactionAttempt({
      injectInternalControlCommand,
      captureOutput: () => 'Conversation too long',
    }, { resolveConversationId: () => null });

    await expect(attempt('unbound-slack-session', -9981)).resolves.toEqual({
      cleared: false,
      reason: 'conversation-authority-unavailable',
    });
    expect(injectInternalControlCommand).not.toHaveBeenCalled();
  });
});
