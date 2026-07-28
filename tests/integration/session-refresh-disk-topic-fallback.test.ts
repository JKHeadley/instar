// safe-git-allow: test file — no git calls.

/**
 * Integration test for the disk-backed topic fallback in SessionRefresh.
 *
 * Drives the REAL SessionRefresh against a REAL TelegramAdapter (only
 * SessionManager/StateManager/respawner are mocked), proving the cross-component
 * contract that the unit tests stub out: when a session's topic binding exists
 * ONLY on disk (the in-memory sessionToTopic map missed it — the exact shape of
 * a --no-telegram server whose map is a boot-time snapshot while the lifeline
 * keeps writing bindings to the registry file), refreshSession still resolves
 * the topic and proceeds to respawn instead of bailing with not_telegram_bound.
 *
 * This is the gap that left the wedged Codey collaboration session (topic 13435)
 * un-recoverable on 2026-05-28.
 *
 * Spec: docs/specs/context-wedge-sentinel.md (null-topic recovery follow-up)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRefresh } from '../../src/core/SessionRefresh.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { TopicResumeMap } from '../../src/core/TopicResumeMap.js';

describe('SessionRefresh × TelegramAdapter — disk-backed topic fallback', () => {
  let tmpDir: string;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sr-disk-'));
    adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, tmpDir);
  });

  afterEach(async () => {
    await adapter.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/session-refresh-disk-topic-fallback.test.ts' });
  });

  function makeRefresh(sessionName: string) {
    const killed: string[] = [];
    const respawned: Array<{ sessionName: string; topicId: number }> = [];

    const sessionManager: Partial<SessionManager> = {
      killSession: vi.fn((id: string) => { killed.push(id); return true; }) as unknown as SessionManager['killSession'],
    };
    const state: Partial<StateManager> = {
      listSessions: vi.fn().mockReturnValue([{ id: 'state-1', tmuxSession: sessionName, status: 'running' }]) as unknown as StateManager['listSessions'],
    };
    const topicResumeMap: Partial<TopicResumeMap> = {
      remove: vi.fn() as unknown as TopicResumeMap['remove'],
    };

    const refresh = new SessionRefresh({
      sessionManager: sessionManager as SessionManager,
      state: state as StateManager,
      telegram: adapter,
      topicResumeMap: topicResumeMap as TopicResumeMap,
      respawner: vi.fn(async (name: string, topicId: number) => {
        respawned.push({ sessionName: name, topicId });
        return `${name}-respawned`;
      }),
    });

    return { refresh, killed, respawned, topicResumeMap };
  }

  it('recovers a session whose topic binding exists only on disk (in-memory miss)', async () => {
    const sessionName = 'echo-codey-collaboration';

    // Simulate the lifeline having written the binding to the registry file
    // AFTER this adapter loaded — so the in-memory reverse map does not have it.
    const registryPath = path.join(tmpDir, 'topic-session-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ topicToSession: { '13435': sessionName } }));

    // Precondition: the in-memory lookup genuinely misses.
    expect(adapter.getTopicForSession(sessionName)).toBeNull();

    const { refresh, killed, respawned, topicResumeMap } = makeRefresh(sessionName);
    const result = await refresh.refreshSession({ sessionName, fresh: true, reason: 'context-wedge-400' });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ ok: true, topicId: 13435 });
    // Full recovery happened: killed the dead session, cleared the resume UUID
    // (fresh mode), and respawned bound to the disk-resolved topic.
    expect(killed).toEqual(['state-1']);
    expect(topicResumeMap.remove).toHaveBeenCalledWith(13435);
    expect(respawned).toEqual([{ sessionName, topicId: 13435 }]);
  });

  it('still bails with not_telegram_bound when the disk registry has no binding either', async () => {
    const sessionName = 'truly-orphan-session';
    // Registry exists but binds a different session.
    adapter.registerTopicSession(999, 'someone-else');

    const { refresh, killed, respawned } = makeRefresh(sessionName);
    const result = await refresh.refreshSession({ sessionName, fresh: true });

    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('not_telegram_bound');
    expect(killed).toEqual([]);
    expect(respawned).toEqual([]);
  });
});
