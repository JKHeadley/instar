import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicSpawnBriefStore, formatCarriedBriefBlock, MAX_BRIEF_CHARS } from '../../src/core/TopicSpawnBriefStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('TopicSpawnBriefStore', () => {
  let dir = '';
  const mk = () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-briefs-')));
    return new TopicSpawnBriefStore(dir);
  };
  afterEach(() => {
    if (dir) {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/TopicSpawnBriefStore.test.ts:cleanup' });
      dir = '';
    }
  });

  it('returns nothing for a topic that was never direct-spawned', () => {
    const s = mk();
    expect(s.get(42)).toBeNull();
    expect(s.getForSession(42, 'echo-x')).toBeNull();
  });

  it('records a brief and returns it only for the session it belongs to', () => {
    const s = mk();
    s.record(42, 'echo-bug-a', 'Fix the bug end to end.');
    expect(s.getForSession(42, 'echo-bug-a')?.prompt).toBe('Fix the bug end to end.');
    // Another (later, unrelated) session of the same topic never inherits it.
    expect(s.getForSession(42, 'echo-other')).toBeNull();
    expect(s.getForSession(42, undefined)).toBeNull();
    // Survives a new store instance (server restart).
    expect(new TopicSpawnBriefStore(dir).getForSession(42, 'echo-bug-a')?.prompt).toBe('Fix the bug end to end.');
  });

  it('rebind follows the brief to the replacement session', () => {
    const s = mk();
    s.record(42, 'echo-bug-a', 'brief');
    s.rebind(42, 'echo-bug-a', 'echo-bug-a-respawned');
    expect(s.getForSession(42, 'echo-bug-a')).toBeNull();
    expect(s.getForSession(42, 'echo-bug-a-respawned')?.prompt).toBe('brief');
  });

  it('rebind from a session that does not own the brief changes nothing', () => {
    const s = mk();
    s.record(42, 'echo-bug-a', 'brief');
    s.rebind(42, 'echo-stranger', 'echo-new');
    expect(s.getForSession(42, 'echo-bug-a')?.prompt).toBe('brief');
    expect(s.getForSession(42, 'echo-new')).toBeNull();
  });

  it('a newer spawn on the same topic replaces the older brief', () => {
    const s = mk();
    s.record(42, 'echo-a', 'old task');
    s.record(42, 'echo-b', 'new task');
    expect(s.getForSession(42, 'echo-a')).toBeNull();
    expect(s.getForSession(42, 'echo-b')?.prompt).toBe('new task');
  });

  it('clear drops the brief, so a later session reusing the same tmux name never inherits it', () => {
    const s = mk();
    s.record(42, 'echo-topic', 'finished task');
    s.clear(42); // a natural/user-driven spawn took over the topic
    expect(s.getForSession(42, 'echo-topic')).toBeNull();
    s.clear(42); // idempotent on a missing brief
    s.clear(99);
  });

  it('ignores empty prompts and truncates oversized ones', () => {
    const s = mk();
    s.record(42, 'echo-a', '');
    expect(s.get(42)).toBeNull();
    s.record(43, 'echo-b', 'x'.repeat(MAX_BRIEF_CHARS + 50));
    expect(s.get(43)?.prompt.length).toBe(MAX_BRIEF_CHARS);
  });

  it('an unreadable brief file reads as no brief (never throws)', () => {
    const s = mk();
    fs.mkdirSync(path.join(dir, 'state', 'topic-spawn-briefs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'topic-spawn-briefs', '42.json'), '{not json');
    expect(s.get(42)).toBeNull();
  });

  it('the carried block holds the prompt verbatim and says it is not in the history', () => {
    const block = formatCarriedBriefBlock('Do X then Y.');
    expect(block).toContain('Do X then Y.');
    expect(block).toMatch(/NOT in the thread history/);
    expect(block.startsWith('--- Original Task Brief ---')).toBe(true);
  });
});
