/**
 * Tests for TelegramAdapter — registry, message logging, topic management.
 *
 * Verifies: registry persistence, topic-session mapping, message logging,
 * topic history retrieval, registry reload from disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';

describe('TelegramAdapter', () => {
  let project: TempProject;

  const fakeConfig = {
    token: 'fake-bot-token',
    chatId: '-1001234567890',
    pollIntervalMs: 60000, // long interval — won't actually poll in tests
  };

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  function createAdapter() {
    return new TelegramAdapter(fakeConfig, project.stateDir);
  }

  describe('Topic-Session Registry', () => {
    it('registers and retrieves topic-session mapping', () => {
      const adapter = createAdapter();
      adapter.registerTopicSession(42, 'my-session');

      expect(adapter.getSessionForTopic(42)).toBe('my-session');
      expect(adapter.getTopicForSession('my-session')).toBe(42);
    });

    it('returns null for unknown topic/session', () => {
      const adapter = createAdapter();
      expect(adapter.getSessionForTopic(999)).toBeNull();
      expect(adapter.getTopicForSession('nonexistent')).toBeNull();
    });

    it('persists registry to disk', () => {
      const adapter = createAdapter();
      adapter.registerTopicSession(10, 'sess-a');
      adapter.registerTopicSession(20, 'sess-b');

      // Registry file should exist
      const registryPath = path.join(project.stateDir, 'topic-session-registry.json');
      expect(fs.existsSync(registryPath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      expect(data.topicToSession['10']).toBe('sess-a');
      expect(data.topicToSession['20']).toBe('sess-b');
    });

    it('uses atomic writes for registry (no .tmp files left)', () => {
      const adapter = createAdapter();
      adapter.registerTopicSession(10, 'sess-a');

      const tmpPath = path.join(project.stateDir, 'topic-session-registry.json.tmp');
      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it('loads registry from disk on construction', () => {
      // Create first adapter and register
      const adapter1 = createAdapter();
      adapter1.registerTopicSession(100, 'persisted-session');

      // Create second adapter — should load from disk
      const adapter2 = createAdapter();
      expect(adapter2.getSessionForTopic(100)).toBe('persisted-session');
      expect(adapter2.getTopicForSession('persisted-session')).toBe(100);
    });

    it('overwrites previous session for same topic', () => {
      const adapter = createAdapter();
      adapter.registerTopicSession(42, 'old-session');
      adapter.registerTopicSession(42, 'new-session');

      expect(adapter.getSessionForTopic(42)).toBe('new-session');
    });
  });

  describe('Topic Names', () => {
    it('returns null for unknown topic name', () => {
      const adapter = createAdapter();
      expect(adapter.getTopicName(999)).toBeNull();
    });
    it('keeps a verified name when a standby rebinds with a generated placeholder', () => {
      const adapter = createAdapter();
      adapter.registerTopicSession(127504, 'first', 'Instar dashboard makeover');
      adapter.registerTopicSession(127504, 'second', 'topic-127504');
      expect(adapter.getTopicName(127504)).toBe('Instar dashboard makeover');
      expect(adapter.getAllTopicMappings()).toContainEqual({ topicId: 127504, sessionName: 'second', topicName: 'Instar dashboard makeover' });
    });
    it('does not load a generated placeholder as a verified name', () => {
      const adapter = createAdapter();
      adapter.registerTopicSession(127504, 'first', 'topic-127504');
      expect(adapter.getTopicName(127504)).toBeNull();
      expect(adapter.getAllTopicMappings()).toContainEqual({ topicId: 127504, sessionName: 'first', topicName: null });
    });
  });

  describe('getAllTopicMappings', () => {
    it('returns empty array when no mappings exist', () => {
      const adapter = createAdapter();
      expect(adapter.getAllTopicMappings()).toEqual([]);
    });

    it('returns all topic-session-name mappings', () => {
      const adapter = createAdapter();
      adapter.registerTopicSession(10, 'session-a');
      adapter.registerTopicSession(20, 'session-b');

      const mappings = adapter.getAllTopicMappings();
      expect(mappings).toHaveLength(2);

      const sorted = mappings.sort((a, b) => a.topicId - b.topicId);
      expect(sorted[0]).toEqual({ topicId: 10, sessionName: 'session-a', topicName: null });
      expect(sorted[1]).toEqual({ topicId: 20, sessionName: 'session-b', topicName: null });
    });

    it('includes topic names when available', () => {
      const adapter = createAdapter();
      adapter.registerTopicSession(42, 'named-session');

      // Write a registry file with topic names to simulate topic name capture
      const registryPath = path.join(project.stateDir, 'topic-session-registry.json');
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      data.topicToName = { '42': 'My Topic' };
      fs.writeFileSync(registryPath, JSON.stringify(data));

      // Reload by creating a new adapter
      const adapter2 = createAdapter();
      const mappings = adapter2.getAllTopicMappings();
      expect(mappings).toHaveLength(1);
      expect(mappings[0].topicName).toBe('My Topic');
    });

    it('keeps a verified title available after its session is unregistered', () => {
      const adapter = createAdapter();
      adapter.registerTopicSession(127504, 'session', 'Instar dashboard makeover');
      adapter.unregisterTopic(127504);
      expect(adapter.getAllTopicMappings()).toContainEqual({ topicId: 127504, sessionName: null, topicName: 'Instar dashboard makeover' });
    });
  });

  describe('Message Logging', () => {
    it('getTopicHistory returns empty for nonexistent log', () => {
      const adapter = createAdapter();
      expect(adapter.getTopicHistory(42)).toEqual([]);
    });

    it('getTopicHistory reads entries for specific topic', () => {
      const adapter = createAdapter();
      const logPath = path.join(project.stateDir, 'telegram-messages.jsonl');

      // Write some log entries
      const entries = [
        { messageId: 1, topicId: 42, text: 'hello', fromUser: true, timestamp: '2026-01-01T00:00:00Z', sessionName: null },
        { messageId: 2, topicId: 99, text: 'other', fromUser: true, timestamp: '2026-01-01T00:01:00Z', sessionName: null },
        { messageId: 3, topicId: 42, text: 'world', fromUser: false, timestamp: '2026-01-01T00:02:00Z', sessionName: 'sess-1' },
      ];
      fs.writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const history = adapter.getTopicHistory(42);
      expect(history).toHaveLength(2);
      expect(history[0].text).toBe('hello');
      expect(history[1].text).toBe('world');
    });

    it('getTopicHistory respects limit', () => {
      const adapter = createAdapter();
      const logPath = path.join(project.stateDir, 'telegram-messages.jsonl');

      const entries = Array.from({ length: 10 }, (_, i) => ({
        messageId: i,
        topicId: 42,
        text: `msg-${i}`,
        fromUser: true,
        timestamp: `2026-01-01T00:0${i}:00Z`,
        sessionName: null,
      }));
      fs.writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const history = adapter.getTopicHistory(42, 3);
      expect(history).toHaveLength(3);
      // Should return LAST 3 entries
      expect(history[0].text).toBe('msg-7');
      expect(history[2].text).toBe('msg-9');
    });

    it('getTopicHistory skips malformed lines', () => {
      const adapter = createAdapter();
      const logPath = path.join(project.stateDir, 'telegram-messages.jsonl');

      const content = [
        JSON.stringify({ messageId: 1, topicId: 42, text: 'good', fromUser: true, timestamp: '2026-01-01T00:00:00Z', sessionName: null }),
        'not valid json!!!',
        JSON.stringify({ messageId: 3, topicId: 42, text: 'also good', fromUser: true, timestamp: '2026-01-01T00:02:00Z', sessionName: null }),
      ].join('\n') + '\n';
      fs.writeFileSync(logPath, content);

      const history = adapter.getTopicHistory(42);
      expect(history).toHaveLength(2);
    });
  });

  describe('Polling lifecycle', () => {
    it('stop clears the poll timeout', async () => {
      const adapter = createAdapter();
      // Don't actually start polling (it would hit real API)
      // Just verify stop works cleanly
      await adapter.stop();
      // Should not throw
    });
  });
});
