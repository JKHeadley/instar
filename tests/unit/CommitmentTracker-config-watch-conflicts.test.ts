/**
 * Echo Bugs 10000001049 (2026-10-28): two per-topic model requests were both
 * recorded as config-change on ONE invented key (`topic.model`). One key holds
 * one value, so every sweep "reverted" one of them — 1001 alerts each, and the
 * "keeps reverting" escalation never stopped the repeats.
 *
 * Covers the three fixes:
 *   1. a topic-scoped configPath never becomes a config-watch
 *   2. a second watch on the same key with a different value supersedes the first
 *   3. after escalation, repeat violation alerts stop
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('CommitmentTracker — config-watch conflicts', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-conflict-test-'));
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ updates: { autoApply: true } }, null, 2));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/CommitmentTracker-config-watch-conflicts.test.ts:31' });
    vi.restoreAllMocks();
  });

  describe('topic-scoped configPath', () => {
    it('records the live two-topic case without any config-watch, so no alerts and no config writes', () => {
      const liveConfig = new LiveConfig(stateDir);
      const onViolation = vi.fn();
      const tracker = new CommitmentTracker({ stateDir, liveConfig, onViolation });

      const a = tracker.record({
        type: 'config-change', topicId: 95267, source: 'sentinel',
        userRequest: 'Swap this topic from Fable 5.1 to Opus 5.5', agentResponse: 'Swapping now',
        configPath: 'topic.model', configExpectedValue: 'Opus 5.5',
      });
      const b = tracker.record({
        type: 'config-change', topicId: 18330, source: 'sentinel',
        userRequest: 'swap this topic to gpt-6-sol', agentResponse: 'Done',
        configPath: 'topic.model', configExpectedValue: 'gpt-6-sol',
      });

      for (const c of [a, b]) {
        expect(c.type).toBe('one-time-action');
        expect(c.verificationMethod).toBe('manual');
        expect(c.configPath).toBeUndefined();
        expect(c.status).toBe('pending');
      }
      for (let i = 0; i < 5; i++) tracker.verify();

      expect(onViolation).not.toHaveBeenCalled();
      expect(tracker.get(a.id)!.violationCount).toBe(0);
      expect(tracker.get(b.id)!.violationCount).toBe(0);
      expect(liveConfig.get('topic.model', undefined)).toBeUndefined();
    });

    it('classifies topic/session roots as topic-scoped and global keys as not', () => {
      for (const p of ['topic.model', 'topics.95267.model', 'topicProfile.model', 'this_topic.model', 'session.model']) {
        expect(CommitmentTracker.isTopicScopedConfigPath(p)).toBe(true);
      }
      for (const p of ['updates.autoApply', 'sessions.maxSessions', 'telegram.topicMode', undefined]) {
        expect(CommitmentTracker.isTopicScopedConfigPath(p)).toBe(false);
      }
    });

    it('keeps a global config-change as a real config-watch', () => {
      const liveConfig = new LiveConfig(stateDir);
      liveConfig.set('updates.autoApply', false);
      const tracker = new CommitmentTracker({ stateDir, liveConfig });
      const c = tracker.record({
        type: 'config-change', userRequest: 'Turn off auto-updates', agentResponse: 'Done',
        configPath: 'updates.autoApply', configExpectedValue: false,
      });
      expect(c.type).toBe('config-change');
      expect(c.configPath).toBe('updates.autoApply');
      expect(c.status).toBe('verified');
    });
  });

  describe('two watches on one key', () => {
    it('a newer watch with a different value supersedes the older one at creation', () => {
      const liveConfig = new LiveConfig(stateDir);
      const onViolation = vi.fn();
      const tracker = new CommitmentTracker({ stateDir, liveConfig, onViolation });
      const withdrawn = vi.fn();
      tracker.on('withdrawn', withdrawn);

      const older = tracker.record({
        type: 'config-change', userRequest: 'Turn off auto-updates', agentResponse: 'Done',
        configPath: 'updates.autoApply', configExpectedValue: false,
      });
      const newer = tracker.record({
        type: 'config-change', userRequest: 'Actually turn auto-updates back on', agentResponse: 'Done',
        configPath: 'updates.autoApply', configExpectedValue: true,
      });

      const o = tracker.get(older.id)!;
      expect(o.status).toBe('withdrawn');
      expect(o.supersededBy).toBe(newer.id);
      expect(o.resolution).toContain(`superseded-by-${newer.id}`);
      expect(tracker.get(newer.id)!.status).not.toBe('withdrawn');
      expect(withdrawn).toHaveBeenCalledTimes(1);
      expect(withdrawn.mock.calls[0][0]).toMatchObject({ id: older.id, supersededBy: newer.id });

      for (let i = 0; i < 5; i++) tracker.verify();
      expect(onViolation).not.toHaveBeenCalled();
      expect(tracker.getActive().filter(c => c.configPath === 'updates.autoApply')).toHaveLength(1);
    });

    it('a second watch expecting the SAME value leaves the first alone', () => {
      const liveConfig = new LiveConfig(stateDir);
      const tracker = new CommitmentTracker({ stateDir, liveConfig });
      const first = tracker.record({
        type: 'config-change', userRequest: 'Turn off auto-updates', agentResponse: 'Done',
        configPath: 'updates.autoApply', configExpectedValue: false,
      });
      tracker.record({
        type: 'config-change', userRequest: 'Keep auto-updates off', agentResponse: 'Done',
        configPath: 'updates.autoApply', configExpectedValue: false,
      });
      expect(tracker.get(first.id)!.status).not.toBe('withdrawn');
    });
  });

  describe('after escalation', () => {
    it('stops repeat violation alerts once the "keeps reverting" escalation has fired', () => {
      const liveConfig = new LiveConfig(stateDir);
      liveConfig.set('updates.autoApply', false);
      const onViolation = vi.fn();
      const onEscalation = vi.fn();
      const tracker = new CommitmentTracker({
        stateDir, liveConfig, onViolation, onEscalation, escalationThreshold: 3,
      });
      const c = tracker.record({
        type: 'config-change', userRequest: 'Turn off auto-updates', agentResponse: 'Done',
        configPath: 'updates.autoApply', configExpectedValue: false,
      });

      for (let i = 0; i < 3; i++) {
        liveConfig.set('updates.autoApply', true);
        tracker.verify();
      }
      expect(tracker.get(c.id)!.escalated).toBe(true);
      expect(onEscalation).toHaveBeenCalledTimes(1);
      const alertsBeforeEscalation = onViolation.mock.calls.length;
      expect(alertsBeforeEscalation).toBeGreaterThan(0);

      // Something keeps overwriting the value — the old code alerted every flap forever.
      for (let i = 0; i < 10; i++) {
        liveConfig.set('updates.autoApply', true);
        tracker.verify();
      }
      expect(onViolation).toHaveBeenCalledTimes(alertsBeforeEscalation);
      expect(onEscalation).toHaveBeenCalledTimes(1);
    });
  });
});
