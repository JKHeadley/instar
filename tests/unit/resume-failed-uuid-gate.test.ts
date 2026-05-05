/**
 * resumeFailed listener — UUID-equality gate.
 *
 * The fresh-spawn fallback inside SessionManager runs *after* `resumeFailed`
 * is emitted. If the fresh spawn quickly produces a new claudeSessionId that
 * the proactive-save heartbeat captures into TopicResumeMap, an unconditional
 * `remove(topicId)` in the listener would wipe the new, valid UUID and force
 * a fresh respawn on every subsequent message.
 *
 * The listener (in commands/server.ts) gates `remove()` on UUID equality:
 * only clear the entry when the stored UUID still matches `info.resumeSessionId`.
 *
 * This test isolates that gate behavior with a minimal stand-in for the
 * server.ts wiring — verifying the rule directly rather than through the
 * full server start-up.
 */

import { describe, it, expect } from 'vitest';

interface ResumeFailedInfo {
  tmuxSession: string;
  resumeSessionId: string;
  telegramTopicId?: number;
  slackChannelId?: string;
}

interface ResumeMap {
  get(topicId: number): string | null;
  remove(topicId: number): void;
}

/** Re-creates the gate exactly as wired in src/commands/server.ts. */
function makeListener(map: ResumeMap, log: string[]) {
  return (info: ResumeFailedInfo) => {
    if (info.telegramTopicId == null) return;
    const stored = map.get(info.telegramTopicId);
    if (stored === info.resumeSessionId) {
      map.remove(info.telegramTopicId);
      log.push(`removed:${info.telegramTopicId}:${info.resumeSessionId}`);
    } else {
      log.push(`skipped:${info.telegramTopicId}:stored=${stored ?? 'none'}:failed=${info.resumeSessionId}`);
    }
  };
}

describe('resumeFailed listener: UUID-equality gate', () => {
  it('removes the stored UUID when it matches the failed UUID', () => {
    const store = new Map<number, string>([[42, 'doomed-uuid']]);
    const map: ResumeMap = {
      get: (id) => store.get(id) ?? null,
      remove: (id) => { store.delete(id); },
    };
    const log: string[] = [];
    const listener = makeListener(map, log);

    listener({
      tmuxSession: 'agent-monroe-ai',
      resumeSessionId: 'doomed-uuid',
      telegramTopicId: 42,
    });

    expect(store.has(42)).toBe(false);
    expect(log).toEqual(['removed:42:doomed-uuid']);
  });

  it('preserves a freshly-saved UUID when the stored value no longer matches', () => {
    // Simulates the race: fresh-spawn fallback finished and the proactive
    // 8-second UUID save fired, replacing the stored UUID with a new one
    // BEFORE the resumeFailed listener got around to running.
    const store = new Map<number, string>([[42, 'fresh-new-uuid']]);
    const map: ResumeMap = {
      get: (id) => store.get(id) ?? null,
      remove: (id) => { store.delete(id); },
    };
    const log: string[] = [];
    const listener = makeListener(map, log);

    listener({
      tmuxSession: 'agent-monroe-ai',
      resumeSessionId: 'doomed-uuid',
      telegramTopicId: 42,
    });

    expect(store.get(42)).toBe('fresh-new-uuid');
    expect(log).toEqual(['skipped:42:stored=fresh-new-uuid:failed=doomed-uuid']);
  });

  it('skips when there is no stored UUID at all', () => {
    const store = new Map<number, string>();
    const map: ResumeMap = {
      get: (id) => store.get(id) ?? null,
      remove: (id) => { store.delete(id); },
    };
    const log: string[] = [];
    const listener = makeListener(map, log);

    listener({
      tmuxSession: 'agent-monroe-ai',
      resumeSessionId: 'doomed-uuid',
      telegramTopicId: 42,
    });

    expect(log).toEqual(['skipped:42:stored=none:failed=doomed-uuid']);
  });

  it('does nothing when the failed event has no telegramTopicId', () => {
    const store = new Map<number, string>([[42, 'doomed-uuid']]);
    const map: ResumeMap = {
      get: (id) => store.get(id) ?? null,
      remove: (id) => { store.delete(id); },
    };
    const log: string[] = [];
    const listener = makeListener(map, log);

    listener({
      tmuxSession: 'agent-monroe-ai',
      resumeSessionId: 'doomed-uuid',
    });

    expect(store.get(42)).toBe('doomed-uuid');
    expect(log).toEqual([]);
  });
});
