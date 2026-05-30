import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import type { ThreadResumeEntry } from '../../../src/threadline/ThreadResumeMap.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): { dir: string; stateDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-test-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    dir,
    stateDir,
    cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline/ThreadResumeMap.test.ts:18' }),
  };
}

function makeEntry(overrides: Partial<ThreadResumeEntry> = {}): ThreadResumeEntry {
  const now = new Date().toISOString();
  return {
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    sessionName: 'thread-test-session',
    createdAt: now,
    savedAt: now,
    lastAccessedAt: now,
    remoteAgent: 'test-agent',
    subject: 'Test Thread',
    state: 'active',
    pinned: false,
    messageCount: 1,
    ...overrides,
  };
}

/**
 * Create a fake JSONL file so that ThreadResumeMap.get() can verify its existence.
 * ThreadResumeMap checks `~/.claude/projects/{hash}/{uuid}.jsonl`.
 */
function createFakeJsonl(uuid: string): string {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  // Use a known hash dir for testing
  const testProjectDir = path.join(claudeProjectsDir, 'threadline-test-project');
  fs.mkdirSync(testProjectDir, { recursive: true });
  const jsonlPath = path.join(testProjectDir, `${uuid}.jsonl`);
  fs.writeFileSync(jsonlPath, '{"test": true}\n');
  return testProjectDir;
}

function cleanupFakeJsonl(): void {
  const testProjectDir = path.join(os.homedir(), '.claude', 'projects', 'threadline-test-project');
  try {
    SafeFsExecutor.safeRmSync(testProjectDir, { recursive: true, force: true, operation: 'tests/unit/threadline/ThreadResumeMap.test.ts:57' });
  } catch {
    // May not exist
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe('ThreadResumeMap', () => {
  let temp: ReturnType<typeof createTempDir>;
  let map: ThreadResumeMap;
  let fakeProjectDir: string;

  const testUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeEach(() => {
    temp = createTempDir();
    map = new ThreadResumeMap(temp.stateDir, '/test/project');
    fakeProjectDir = createFakeJsonl(testUuid);
  });

  afterEach(() => {
    temp.cleanup();
    cleanupFakeJsonl();
  });

  // ── save / get / remove ──────────────────────────────────────

  describe('save and get', () => {
    it('saves an entry and retrieves it by threadId', () => {
      const threadId = 'thread-001';
      const entry = makeEntry();

      map.save(threadId, entry);
      const retrieved = map.get(threadId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.uuid).toBe(testUuid);
      expect(retrieved!.remoteAgent).toBe('test-agent');
      expect(retrieved!.subject).toBe('Test Thread');
      expect(retrieved!.state).toBe('active');
    });

    it('returns null for non-existent threadId', () => {
      expect(map.get('nonexistent')).toBeNull();
    });

    it('updates savedAt on save', () => {
      const threadId = 'thread-002';
      const entry = makeEntry({ savedAt: '2020-01-01T00:00:00.000Z' });

      map.save(threadId, entry);
      const retrieved = map.get(threadId);

      expect(retrieved).not.toBeNull();
      // savedAt should be updated to current time, not the original
      expect(new Date(retrieved!.savedAt).getFullYear()).toBeGreaterThan(2020);
    });

    it('overwrites existing entry for the same threadId', () => {
      const threadId = 'thread-003';
      map.save(threadId, makeEntry({ subject: 'Original' }));
      map.save(threadId, makeEntry({ subject: 'Updated' }));

      const retrieved = map.get(threadId);
      expect(retrieved!.subject).toBe('Updated');
    });
  });

  describe('remove', () => {
    it('removes an existing entry', () => {
      const threadId = 'thread-004';
      map.save(threadId, makeEntry());
      expect(map.get(threadId)).not.toBeNull();

      map.remove(threadId);
      expect(map.get(threadId)).toBeNull();
    });

    it('does not throw when removing non-existent entry', () => {
      expect(() => map.remove('nonexistent')).not.toThrow();
    });
  });

  // ── TTL / Expiry ─────────────────────────────────────────────

  describe('TTL and expiry', () => {
    it('returns null for entries older than 7 days', () => {
      const threadId = 'thread-ttl-expired';
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const entry = makeEntry({
        lastAccessedAt: eightDaysAgo,
        savedAt: eightDaysAgo,
      });

      // Write directly to the file to bypass save() updating savedAt
      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data: Record<string, ThreadResumeEntry> = { [threadId]: entry };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      const result = map.get(threadId);
      expect(result).toBeNull();
    });

    it('returns entry for entries within 7 days', () => {
      const threadId = 'thread-ttl-valid';
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const entry = makeEntry({
        lastAccessedAt: twoDaysAgo,
        savedAt: twoDaysAgo,
      });

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data: Record<string, ThreadResumeEntry> = { [threadId]: entry };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      const result = map.get(threadId);
      expect(result).not.toBeNull();
    });

    it('does not expire pinned entries regardless of age', () => {
      const threadId = 'thread-pinned-old';
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const entry = makeEntry({
        lastAccessedAt: thirtyDaysAgo,
        savedAt: thirtyDaysAgo,
        pinned: true,
      });

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data: Record<string, ThreadResumeEntry> = { [threadId]: entry };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      const result = map.get(threadId);
      expect(result).not.toBeNull();
      expect(result!.pinned).toBe(true);
    });
  });

  // ── Resolve ──────────────────────────────────────────────────

  describe('resolve', () => {
    it('sets state to resolved and sets resolvedAt', () => {
      const threadId = 'thread-resolve';
      map.save(threadId, makeEntry());
      map.resolve(threadId);

      const retrieved = map.get(threadId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.state).toBe('resolved');
      expect(retrieved!.resolvedAt).toBeDefined();
    });

    it('does not throw when resolving non-existent thread', () => {
      expect(() => map.resolve('nonexistent')).not.toThrow();
    });

    it('resolved entries expire after 7-day grace period', () => {
      const threadId = 'thread-resolve-expired';
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const entry = makeEntry({
        state: 'resolved',
        resolvedAt: eightDaysAgo,
        savedAt: new Date().toISOString(),
      });

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data: Record<string, ThreadResumeEntry> = { [threadId]: entry };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      const result = map.get(threadId);
      expect(result).toBeNull();
    });

    it('resolved entries are accessible within 7-day grace period', () => {
      const threadId = 'thread-resolve-recent';
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const entry = makeEntry({
        state: 'resolved',
        resolvedAt: twoDaysAgo,
        savedAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data: Record<string, ThreadResumeEntry> = { [threadId]: entry };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      const result = map.get(threadId);
      expect(result).not.toBeNull();
      expect(result!.state).toBe('resolved');
    });
  });

  // ── Pin / Unpin ──────────────────────────────────────────────

  describe('pin and unpin', () => {
    it('pin sets pinned to true', () => {
      const threadId = 'thread-pin';
      map.save(threadId, makeEntry({ pinned: false }));
      map.pin(threadId);

      const retrieved = map.get(threadId);
      expect(retrieved!.pinned).toBe(true);
    });

    it('unpin sets pinned to false', () => {
      const threadId = 'thread-unpin';
      map.save(threadId, makeEntry({ pinned: true }));
      map.unpin(threadId);

      const retrieved = map.get(threadId);
      expect(retrieved!.pinned).toBe(false);
    });

    it('pin does not throw for non-existent thread', () => {
      expect(() => map.pin('nonexistent')).not.toThrow();
    });

    it('unpin does not throw for non-existent thread', () => {
      expect(() => map.unpin('nonexistent')).not.toThrow();
    });
  });

  // ── getByRemoteAgent ─────────────────────────────────────────

  describe('getByRemoteAgent', () => {
    it('returns threads for a specific remote agent', () => {
      map.save('thread-a1', makeEntry({ remoteAgent: 'agent-alpha' }));
      map.save('thread-a2', makeEntry({ remoteAgent: 'agent-alpha' }));
      map.save('thread-b1', makeEntry({ remoteAgent: 'agent-beta' }));

      const alphaThreads = map.getByRemoteAgent('agent-alpha');
      expect(alphaThreads).toHaveLength(2);
      expect(alphaThreads.every(t => t.entry.remoteAgent === 'agent-alpha')).toBe(true);
    });

    it('returns empty array for unknown agent', () => {
      map.save('thread-x', makeEntry({ remoteAgent: 'agent-known' }));
      const result = map.getByRemoteAgent('agent-unknown');
      expect(result).toHaveLength(0);
    });

    it('excludes expired entries', () => {
      const threadId = 'thread-expired-agent';
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const entry = makeEntry({
        remoteAgent: 'agent-old',
        lastAccessedAt: eightDaysAgo,
        savedAt: eightDaysAgo,
      });

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      const data: Record<string, ThreadResumeEntry> = { [threadId]: entry };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      const result = map.getByRemoteAgent('agent-old');
      expect(result).toHaveLength(0);
    });

    it('includes pinned expired entries', () => {
      const threadId = 'thread-pinned-agent';
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const entry = makeEntry({
        remoteAgent: 'agent-pinned',
        lastAccessedAt: thirtyDaysAgo,
        savedAt: thirtyDaysAgo,
        pinned: true,
      });

      // Phase 2a: the store is conversations.json; seed via the API.
      map.save(threadId, entry);

      const result = map.getByRemoteAgent('agent-pinned');
      expect(result).toHaveLength(1);
    });
  });

  // ── listActive ───────────────────────────────────────────────

  describe('listActive', () => {
    it('returns active and idle threads', () => {
      map.save('thread-active', makeEntry({ state: 'active' }));
      map.save('thread-idle', makeEntry({ state: 'idle' }));
      map.save('thread-resolved', makeEntry({ state: 'resolved' }));
      map.save('thread-failed', makeEntry({ state: 'failed' }));
      map.save('thread-archived', makeEntry({ state: 'archived' }));

      const active = map.listActive();
      expect(active).toHaveLength(2);
      const states = active.map(t => t.entry.state);
      expect(states).toContain('active');
      expect(states).toContain('idle');
    });

    it('returns empty array when no active threads', () => {
      map.save('thread-resolved', makeEntry({ state: 'resolved' }));
      expect(map.listActive()).toHaveLength(0);
    });

    it('archives stale active and idle threads before listing', () => {
      const now = new Date('2026-05-30T09:00:00.000Z');
      const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
      const fresh = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

      map.save('stale-active', makeEntry({ state: 'active', lastAccessedAt: stale, savedAt: stale }));
      map.save('stale-idle', makeEntry({ state: 'idle', lastAccessedAt: stale, savedAt: stale }));
      map.save('fresh-active', makeEntry({ state: 'active', lastAccessedAt: fresh, savedAt: fresh }));

      expect(map.retireInactive(24 * 60 * 60 * 1000, now)).toBe(2);
      expect(map.listActive().map(t => t.threadId)).toEqual(['fresh-active']);
      expect(map.get('stale-active')?.state).toBe('archived');
      expect(map.get('stale-idle')?.state).toBe('archived');
    });
  });

  // ── LRU Eviction at 1000 entries ─────────────────────────────

  describe('LRU eviction', () => {
    it('evicts oldest non-pinned entries when exceeding 1000', () => {
      // Write 1001 entries directly to the file
      const data: Record<string, ThreadResumeEntry> = {};
      const now = Date.now();

      for (let i = 0; i < 1001; i++) {
        const threadId = `thread-${String(i).padStart(4, '0')}`;
        const accessTime = new Date(now - (1001 - i) * 1000).toISOString(); // oldest first
        data[threadId] = makeEntry({
          lastAccessedAt: accessTime,
          savedAt: accessTime,
          subject: `Thread ${i}`,
        });
      }

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      // Trigger prune
      map.prune();

      // Check size is now <= 1000
      expect(map.size()).toBeLessThanOrEqual(1000);
    });

    it('preserves pinned entries during LRU eviction', () => {
      const data: Record<string, ThreadResumeEntry> = {};
      const now = Date.now();

      // Create 1001 entries, first 5 are pinned with oldest timestamps
      for (let i = 0; i < 1001; i++) {
        const threadId = `thread-${String(i).padStart(4, '0')}`;
        const accessTime = new Date(now - (1001 - i) * 1000).toISOString();
        data[threadId] = makeEntry({
          lastAccessedAt: accessTime,
          savedAt: accessTime,
          pinned: i < 5, // first 5 are pinned (and are the oldest)
        });
      }

      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

      map.prune();

      // All 5 pinned entries should survive despite being the oldest
      for (let i = 0; i < 5; i++) {
        const threadId = `thread-${String(i).padStart(4, '0')}`;
        // Read directly from file since get() also checks jsonl existence
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        expect(raw[threadId]).toBeDefined();
        expect(raw[threadId].pinned).toBe(true);
      }

      expect(map.size()).toBeLessThanOrEqual(1000);
    });
  });

  // ── Prune behavior ──────────────────────────────────────────

  describe('prune', () => {
    // Phase 2a: the store is conversations.json — seed via the API, assert there.
    const convKeys = (): string[] => {
      const p = path.join(temp.stateDir, 'threadline', 'conversations.json');
      if (!fs.existsSync(p)) return [];
      return Object.keys(JSON.parse(fs.readFileSync(p, 'utf-8')).conversations ?? {});
    };

    it('removes expired entries', () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      map.save('thread-old', makeEntry({ lastAccessedAt: eightDaysAgo, savedAt: eightDaysAgo }));
      map.save('thread-new', makeEntry());

      map.prune();

      expect(convKeys()).not.toContain('thread-old');
      expect(convKeys()).toContain('thread-new');
    });

    it('removes resolved entries past grace period', () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      map.save('thread-resolved-old', makeEntry({ state: 'resolved', resolvedAt: eightDaysAgo, lastAccessedAt: eightDaysAgo }));
      map.save('thread-resolved-recent', makeEntry({ state: 'resolved', resolvedAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString() }));

      map.prune();

      expect(convKeys()).not.toContain('thread-resolved-old');
      expect(convKeys()).toContain('thread-resolved-recent');
    });

    it('does not prune pinned entries even if expired', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      map.save('thread-pinned-old', makeEntry({ lastAccessedAt: thirtyDaysAgo, savedAt: thirtyDaysAgo, pinned: true }));

      map.prune();

      expect(convKeys()).toContain('thread-pinned-old');
    });
  });

  // ── Persistence ──────────────────────────────────────────────

  describe('persistence', () => {
    it('persists data to the conversations store', () => {
      map.save('thread-persist', makeEntry());

      // Phase 2a: ThreadResumeMap is a view over conversations.json.
      const filePath = path.join(temp.stateDir, 'threadline', 'conversations.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(raw.conversations['thread-persist']).toBeDefined();
    });

    it('survives reconstruction from file', () => {
      map.save('thread-survive', makeEntry({ subject: 'Survivor' }));

      // Create a new map instance pointing at the same state dir
      const map2 = new ThreadResumeMap(temp.stateDir, '/test/project');
      // Read from file — but get() checks jsonl existence, so use size()
      expect(map2.size()).toBe(1);
    });

    it('handles corrupted JSON file gracefully', () => {
      const filePath = path.join(temp.stateDir, 'threadline', 'thread-resume-map.json');
      fs.writeFileSync(filePath, 'NOT VALID JSON');

      // Should not throw — returns empty map
      expect(map.size()).toBe(0);
      expect(map.get('anything')).toBeNull();
    });

    it('creates threadline directory if not exists', () => {
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-fresh-'));
      const freshStateDir = path.join(freshDir, '.instar');
      fs.mkdirSync(freshStateDir, { recursive: true });

      // Should create threadline subdirectory
      const freshMap = new ThreadResumeMap(freshStateDir, '/test/project');
      freshMap.save('thread-fresh', makeEntry());

      const threadlineDir = path.join(freshStateDir, 'threadline');
      expect(fs.existsSync(threadlineDir)).toBe(true);

      SafeFsExecutor.safeRmSync(freshDir, { recursive: true, force: true, operation: 'tests/unit/threadline/ThreadResumeMap.test.ts:533' });
    });
  });

  // ── size() ───────────────────────────────────────────────────

  describe('size', () => {
    it('returns 0 for empty map', () => {
      expect(map.size()).toBe(0);
    });

    it('returns correct count', () => {
      map.save('thread-1', makeEntry());
      map.save('thread-2', makeEntry());
      map.save('thread-3', makeEntry());
      expect(map.size()).toBe(3);
    });

    it('decreases after remove', () => {
      map.save('thread-r1', makeEntry());
      map.save('thread-r2', makeEntry());
      expect(map.size()).toBe(2);

      map.remove('thread-r1');
      expect(map.size()).toBe(1);
    });
  });

  // ── JSONL existence check ────────────────────────────────────

  describe('JSONL verification', () => {
    it('returns null for entry whose JSONL file was deleted', () => {
      const threadId = 'thread-no-jsonl';
      const deadUuid = 'deadbeef-dead-dead-dead-deaddeaddead';
      map.save(threadId, makeEntry({ uuid: deadUuid }));

      // No fake JSONL created for deadUuid, so get() should return null
      const result = map.get(threadId);
      expect(result).toBeNull();
    });

    it('returns entry when JSONL file exists', () => {
      const threadId = 'thread-has-jsonl';
      map.save(threadId, makeEntry({ uuid: testUuid }));

      const result = map.get(threadId);
      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(testUuid);
    });
  });

  describe('topic-linkage JSONL-guard exemption (Fix 1 / A1+C)', () => {
    let temp2: ReturnType<typeof createTempDir>;
    let map2: ThreadResumeMap;
    beforeEach(() => { temp2 = createTempDir(); map2 = new ThreadResumeMap(temp2.stateDir, temp2.dir); });
    afterEach(() => { temp2.cleanup(); cleanupFakeJsonl(); });

    it('RETURNS a topic-bound entry (originTopicId set) even when no session JSONL exists', () => {
      // No fake JSONL is created → jsonlExists(uuid) is false. Before the fix
      // this entry was nulled (the A1/C root cause: inbound replies fell through
      // to spawnNewThread and threadline_history 404'd).
      map2.save('t-topicbound', makeEntry({ uuid: 'no-jsonl-uuid-00000000000000', originTopicId: 12304 }));
      const entry = map2.get('t-topicbound');
      expect(entry).not.toBeNull();
      expect(entry!.originTopicId).toBe(12304);
    });

    it('still NULLS a non-topic entry whose session JSONL is gone (guard intact for the original case)', () => {
      map2.save('t-plain', makeEntry({ uuid: 'gone-uuid-11111111111111111111', originTopicId: undefined }));
      expect(map2.get('t-plain')).toBeNull();
    });

    it('still RETURNS a pinned non-topic entry without JSONL (pinned exemption unchanged)', () => {
      map2.save('t-pinned', makeEntry({ uuid: 'gone-uuid-22222222222222222222', originTopicId: undefined, pinned: true }));
      expect(map2.get('t-pinned')).not.toBeNull();
    });
  });
});
