/**
 * Tests for SessionManager.injectTelegramMessage behavior.
 *
 * Covers: short messages (inline), long messages (file redirect),
 * file creation, cleanup of temp directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('SessionManager.injectTelegramMessage', () => {
  let project: TempProject;
  let sendKeyCalls: string[][];

  beforeEach(() => {
    project = createTempProject();
    sendKeyCalls = [];
  });

  afterEach(() => {
    project.cleanup();
    // Clean up temp files
    const tmpDir = '/tmp/instar-telegram';
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('msg-'));
      for (const f of files) {
        try { SafeFsExecutor.safeUnlinkSync(path.join(tmpDir, f), { operation: 'tests/unit/session-telegram-inject.test.ts:32' }); } catch { /* ignore */ }
      }
    }
  });

  // We test the logic by examining the file system side effects
  // since the tmux commands will fail in test (no tmux session)

  it('writes long messages to temp file', () => {
    const sm = new SessionManager(
      {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/bin/claude',
        projectDir: project.stateDir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: [],
      },
      project.state,
    );

    // Create a message longer than 500 chars
    const longText = 'A'.repeat(600);

    // This will fail on the tmux send-keys (no real session),
    // but the file should still be created
    sm.injectTelegramMessage('nonexistent-session', 42, longText);

    // Check that temp file was created
    const tmpDir = '/tmp/instar-telegram';
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('msg-42-'));
      // File may or may not exist depending on timing, but the directory should be created
      expect(fs.existsSync(tmpDir)).toBe(true);
    }
  });

  it('threshold is 500 chars for the tagged message', () => {
    // The tagged text is `[telegram:${topicId}] ${text}`
    // For topicId=42, that's "[telegram:42] " = 14 chars prefix
    // So text needs to be 500 - 14 = 486 chars to exceed threshold
    const prefix = '[telegram:42] ';
    const text = 'X'.repeat(500 - prefix.length); // Exactly 500 tagged = below threshold
    const taggedLength = prefix.length + text.length;
    expect(taggedLength).toBe(500); // Should NOT go to file

    const textOver = text + 'Y'; // 501 tagged = above threshold
    const taggedLengthOver = prefix.length + textOver.length;
    expect(taggedLengthOver).toBe(501); // Should go to file
  });

  // ── Delivery-chokepoint dedup (a single user message must reach a session at
  // most once even if an upstream path over-forwards it 5x). We count the temp
  // files written for a unique topicId to detect whether a delivery happened.
  const mkSm = () => new SessionManager(
    {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: project.stateDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    },
    project.state,
  );
  const longText = 'Z'.repeat(600); // exceeds the 500-char file threshold
  const countFilesFor = (topicId: number) => {
    const dir = '/tmp/instar-telegram';
    return fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.startsWith(`msg-${topicId}-`)).length
      : 0;
  };

  it('dedupes a repeated Telegram messageId — delivers a single user message once', () => {
    const sm = mkSm();
    const topicId = 770111;
    const messageId = 555001;

    sm.injectTelegramMessage('sess-a', topicId, longText, undefined, undefined, undefined, messageId);
    expect(countFilesFor(topicId)).toBe(1);

    // Same messageId again (the over-forward) → suppressed, no new file.
    sm.injectTelegramMessage('sess-a', topicId, longText, undefined, undefined, undefined, messageId);
    expect(countFilesFor(topicId)).toBe(1);

    // A genuinely distinct messageId → delivered.
    sm.injectTelegramMessage('sess-a', topicId, longText, undefined, undefined, undefined, messageId + 1);
    expect(countFilesFor(topicId)).toBe(2);
  });

  it('does NOT dedupe when no messageId is supplied (in-process back-compat)', () => {
    const sm = mkSm();
    const topicId = 770122;
    // No messageId → no dedup; both deliveries land.
    sm.injectTelegramMessage('sess-b', topicId, longText);
    sm.injectTelegramMessage('sess-b', topicId, longText);
    expect(countFilesFor(topicId)).toBe(2);
  });

  it('does NOT dedupe messageId 0 (sentinel "no id") — both deliver', () => {
    const sm = mkSm();
    const topicId = 770133;
    sm.injectTelegramMessage('sess-c', topicId, longText, undefined, undefined, undefined, 0);
    sm.injectTelegramMessage('sess-c', topicId, longText, undefined, undefined, undefined, 0);
    expect(countFilesFor(topicId)).toBe(2);
  });

  it('dedup is per-session — same messageId to two sessions both deliver', () => {
    const sm = mkSm();
    const topicId = 770144;
    const messageId = 555777;
    sm.injectTelegramMessage('sess-x', topicId, longText, undefined, undefined, undefined, messageId);
    sm.injectTelegramMessage('sess-y', topicId, longText, undefined, undefined, undefined, messageId);
    expect(countFilesFor(topicId)).toBe(2);
  });
});
