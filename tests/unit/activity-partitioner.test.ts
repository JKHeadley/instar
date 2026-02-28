/**
 * Unit tests for ActivityPartitioner — Dual-source timeline builder with boundary detection.
 *
 * Tests:
 * - Basic partitioning of session output
 * - Boundary detection: explicit switch, git commit, long pause, time threshold
 * - Telegram message integration (dual-source merging)
 * - Minimum threshold filtering
 * - Edge cases: empty input, no Telegram, single event
 */

import { describe, it, expect } from 'vitest';
import { ActivityPartitioner } from '../../src/memory/ActivityPartitioner.js';
import type { TelegramLogEntry, PartitionInput } from '../../src/memory/ActivityPartitioner.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeTelegramMessage(overrides: Partial<TelegramLogEntry> = {}): TelegramLogEntry {
  return {
    messageId: 1,
    topicId: 100,
    text: 'Hello from user',
    fromUser: true,
    timestamp: '2026-02-27T10:05:00Z',
    sessionName: null,
    ...overrides,
  };
}

function makeTimestamp(hour: number, minute: number): string {
  return `2026-02-27T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('ActivityPartitioner', () => {
  // ─── Basic Partitioning ───────────────────────────────────────

  describe('basic partitioning', () => {
    it('creates a single unit from simple session output', () => {
      const partitioner = new ActivityPartitioner();
      // Content must be > 500 chars to pass minimum threshold filter
      const longContent = [
        'Running tests...',
        'PASS tests/unit/auth.test.ts (12 tests)',
        'PASS tests/unit/db.test.ts (8 tests)',
        'PASS tests/unit/api.test.ts (15 tests)',
        'All 35 tests passed.',
        'Building project...',
        'Compiled 42 TypeScript files in 3.2s',
        'No errors found.',
        'Deploying to staging environment...',
        'Upload complete. 15 files changed.',
        'Health check passed at staging.example.com',
        'Deployment successful.',
      ].join('\n').repeat(3);  // Repeat to exceed 500 chars

      const units = partitioner.partition({
        sessionOutput: longContent,
      });

      expect(units).toHaveLength(1);
      expect(units[0].sessionContent).toContain('Running tests');
      expect(units[0].boundarySignal).toBe('session_end');
    });

    it('returns empty array for empty session output', () => {
      const partitioner = new ActivityPartitioner();
      expect(partitioner.partition({ sessionOutput: '' })).toEqual([]);
      expect(partitioner.partition({ sessionOutput: '   \n  \n  ' })).toEqual([]);
    });
  });

  // ─── Git Commit Boundary ──────────────────────────────────────

  describe('git commit boundary', () => {
    it('splits at git commit pattern [branch hash]', () => {
      const partitioner = new ActivityPartitioner({
        minSessionMinutes: 0,  // Disable minimum so we get all units
      });

      const sessionOutput = [
        'Writing migration engine...',
        'Tests: 12 passing',
        '[main abc1234] feat: add migration engine',
        'Starting next task...',
        'Reading PROP document...',
      ].join('\n');

      const units = partitioner.partition({
        sessionOutput,
        lastDigestedAt: makeTimestamp(10, 0),
      });

      // First unit should end with the commit, second should be the rest
      expect(units.length).toBeGreaterThanOrEqual(1);
      const commitUnit = units.find(u => u.boundarySignal === 'task_complete');
      expect(commitUnit).toBeDefined();
      expect(commitUnit!.sessionContent).toContain('migration engine');
    });

    it('detects commit SHA pattern', () => {
      const partitioner = new ActivityPartitioner({ minSessionMinutes: 0 });

      const sessionOutput = [
        'Making changes...',
        'commit a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        'More work...',
      ].join('\n');

      const units = partitioner.partition({
        sessionOutput,
        lastDigestedAt: makeTimestamp(10, 0),
      });

      const commitUnit = units.find(u => u.boundarySignal === 'task_complete');
      expect(commitUnit).toBeDefined();
    });

    it('detects git push pattern', () => {
      const partitioner = new ActivityPartitioner({ minSessionMinutes: 0 });

      const sessionOutput = [
        'Pushing changes...',
        '  abc1234..def5678 -> origin/main',
        'Done.',
      ].join('\n');

      const units = partitioner.partition({
        sessionOutput,
        lastDigestedAt: makeTimestamp(10, 0),
      });

      const commitUnit = units.find(u => u.boundarySignal === 'task_complete');
      expect(commitUnit).toBeDefined();
    });
  });

  // ─── Explicit Switch Boundary ─────────────────────────────────

  describe('explicit switch boundary', () => {
    it('splits on "now let\'s work on" from user', () => {
      const partitioner = new ActivityPartitioner({ minSessionMinutes: 0 });

      const messages: TelegramLogEntry[] = [
        makeTelegramMessage({
          messageId: 1,
          text: 'Fix the login bug',
          fromUser: true,
          timestamp: makeTimestamp(10, 0),
        }),
        makeTelegramMessage({
          messageId: 2,
          text: 'Fixed the login bug.',
          fromUser: false,
          timestamp: makeTimestamp(10, 15),
        }),
        makeTelegramMessage({
          messageId: 3,
          text: "now let's work on the dashboard",
          fromUser: true,
          timestamp: makeTimestamp(10, 20),
        }),
        makeTelegramMessage({
          messageId: 4,
          text: 'Starting dashboard work.',
          fromUser: false,
          timestamp: makeTimestamp(10, 25),
        }),
      ];

      const units = partitioner.partition({
        sessionOutput: 'Session work happening',
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(9, 0),
      });

      const switchUnit = units.find(u => u.boundarySignal === 'explicit_switch');
      expect(switchUnit).toBeDefined();
    });

    it('splits on "moving on to"', () => {
      const partitioner = new ActivityPartitioner({ minSessionMinutes: 0, minTelegramMessages: 1 });

      const longContent = 'Working on feature implementation with detailed output.\n'.repeat(15);
      const messages: TelegramLogEntry[] = [
        makeTelegramMessage({
          messageId: 1,
          text: 'Do the first task with detailed instructions here',
          fromUser: true,
          timestamp: makeTimestamp(10, 0),
        }),
        makeTelegramMessage({
          messageId: 2,
          text: 'Done with first task',
          fromUser: false,
          timestamp: makeTimestamp(10, 5),
        }),
        makeTelegramMessage({
          messageId: 3,
          text: 'Moving on to the testing phase',
          fromUser: true,
          timestamp: makeTimestamp(10, 10),
        }),
        makeTelegramMessage({
          messageId: 4,
          text: 'Starting tests now',
          fromUser: false,
          timestamp: makeTimestamp(10, 15),
        }),
      ];

      const units = partitioner.partition({
        sessionOutput: longContent,
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(9, 0),
      });

      const switchUnit = units.find(u => u.boundarySignal === 'explicit_switch');
      expect(switchUnit).toBeDefined();
    });

    it('does not split on agent messages with switch patterns', () => {
      const partitioner = new ActivityPartitioner({ minSessionMinutes: 0 });

      const messages: TelegramLogEntry[] = [
        makeTelegramMessage({
          messageId: 1,
          text: "now let's work on the tests",
          fromUser: false,  // Agent message — should NOT trigger boundary
          timestamp: makeTimestamp(10, 0),
        }),
      ];

      const units = partitioner.partition({
        sessionOutput: 'Some work',
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(9, 0),
      });

      const switchUnit = units.find(u => u.boundarySignal === 'explicit_switch');
      expect(switchUnit).toBeUndefined();
    });
  });

  // ─── Long Pause Boundary ──────────────────────────────────────

  describe('long pause boundary', () => {
    it('splits when 30+ minute gap between events', () => {
      const partitioner = new ActivityPartitioner({ minSessionMinutes: 0 });

      const messages: TelegramLogEntry[] = [
        makeTelegramMessage({
          messageId: 1,
          text: 'Before pause',
          timestamp: makeTimestamp(10, 0),
        }),
        makeTelegramMessage({
          messageId: 2,
          text: 'After long break',
          timestamp: makeTimestamp(10, 45),  // 45 min gap
        }),
      ];

      const units = partitioner.partition({
        sessionOutput: 'Some session work',
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(9, 0),
      });

      const pauseUnit = units.find(u => u.boundarySignal === 'long_pause');
      expect(pauseUnit).toBeDefined();
    });

    it('does not split on short gaps', () => {
      const partitioner = new ActivityPartitioner({ minSessionMinutes: 0 });

      const messages: TelegramLogEntry[] = [
        makeTelegramMessage({
          messageId: 1,
          text: 'Message 1',
          timestamp: makeTimestamp(10, 0),
        }),
        makeTelegramMessage({
          messageId: 2,
          text: 'Message 2',
          timestamp: makeTimestamp(10, 15),  // Only 15 min gap
        }),
      ];

      const units = partitioner.partition({
        sessionOutput: 'Work',
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(9, 0),
      });

      const pauseUnit = units.find(u => u.boundarySignal === 'long_pause');
      expect(pauseUnit).toBeUndefined();
    });
  });

  // ─── Time Threshold Boundary ──────────────────────────────────

  describe('time threshold boundary', () => {
    it('splits after maxUnitMinutes (default 60)', () => {
      const partitioner = new ActivityPartitioner({
        maxUnitMinutes: 60,
        minSessionMinutes: 0,
      });

      // Messages spanning 90 minutes
      const messages: TelegramLogEntry[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(makeTelegramMessage({
          messageId: i,
          text: `Message ${i}`,
          timestamp: makeTimestamp(10, i * 10),  // 0, 10, 20, ... 90 min
        }));
      }

      const units = partitioner.partition({
        sessionOutput: 'Long session work',
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(9, 0),
      });

      const timeUnit = units.find(u => u.boundarySignal === 'time_threshold');
      expect(timeUnit).toBeDefined();
    });

    it('respects custom maxUnitMinutes', () => {
      const partitioner = new ActivityPartitioner({
        maxUnitMinutes: 30,
        minSessionMinutes: 0,
      });

      const messages: TelegramLogEntry[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push(makeTelegramMessage({
          messageId: i,
          text: `Message ${i}`,
          timestamp: makeTimestamp(10, i * 10),  // 0, 10, 20, 30, 40
        }));
      }

      const units = partitioner.partition({
        sessionOutput: 'Work',
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(9, 0),
      });

      // Should split at 30 min mark
      const timeUnit = units.find(u => u.boundarySignal === 'time_threshold');
      expect(timeUnit).toBeDefined();
    });
  });

  // ─── Minimum Threshold Filtering ──────────────────────────────

  describe('minimum threshold filtering', () => {
    it('filters out units with too few Telegram messages and short duration', () => {
      const partitioner = new ActivityPartitioner({
        minTelegramMessages: 5,
        minSessionMinutes: 10,
      });

      // Very short session with few messages
      const messages: TelegramLogEntry[] = [
        makeTelegramMessage({
          messageId: 1,
          text: 'Quick note',
          timestamp: makeTimestamp(10, 0),
        }),
      ];

      const units = partitioner.partition({
        sessionOutput: 'tiny',  // < 500 chars
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(9, 59),  // < 10 min ago
      });

      // May return empty if thresholds not met
      // The unit with just 1 message, <10 min, and <500 chars should be filtered
      for (const unit of units) {
        const msgCount = unit.telegramContent?.split('\n').filter(l => l.trim()).length ?? 0;
        const isLongEnough = new Date(unit.endedAt).getTime() - new Date(unit.startedAt).getTime() >= 10 * 60 * 1000;
        const hasEnoughContent = unit.sessionContent.length > 500;
        const hasEnoughMessages = msgCount >= 5;
        expect(isLongEnough || hasEnoughContent || hasEnoughMessages).toBe(true);
      }
    });

    it('keeps units with enough Telegram messages', () => {
      const partitioner = new ActivityPartitioner({
        minTelegramMessages: 3,
        minSessionMinutes: 60,  // High threshold — but messages should override
      });

      const messages: TelegramLogEntry[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push(makeTelegramMessage({
          messageId: i,
          text: `Message ${i} with some content`,
          timestamp: makeTimestamp(10, i),
        }));
      }

      const units = partitioner.partition({
        sessionOutput: 'Short work',
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(9, 0),
      });

      expect(units.length).toBeGreaterThanOrEqual(1);
    });

    it('keeps units with enough session content volume', () => {
      const partitioner = new ActivityPartitioner({
        minTelegramMessages: 100,  // Very high — but content volume should override
        minSessionMinutes: 1000,
      });

      const longContent = 'A'.repeat(600);  // > 500 chars

      const units = partitioner.partition({
        sessionOutput: longContent,
      });

      expect(units).toHaveLength(1);
    });
  });

  // ─── Dual-Source Merging ──────────────────────────────────────

  describe('dual-source merging', () => {
    it('includes both session and telegram content in units', () => {
      const partitioner = new ActivityPartitioner({ minSessionMinutes: 0, minTelegramMessages: 1 });

      const messages: TelegramLogEntry[] = [
        makeTelegramMessage({
          messageId: 1,
          text: 'Fix the bug please',
          fromUser: true,
          timestamp: makeTimestamp(10, 5),
        }),
        makeTelegramMessage({
          messageId: 2,
          text: 'Bug fixed!',
          fromUser: false,
          timestamp: makeTimestamp(10, 10),
        }),
      ];

      // Content must exceed 500 chars to pass threshold
      const sessionContent = [
        'Debugging the login flow...',
        'Found the issue in auth.ts',
        'The problem was in the validateToken function',
        'Token was being compared with === but the stored hash had trailing whitespace',
        'Fixed by trimming before comparison',
        'Running auth tests to verify the fix...',
        'All 12 auth tests passing',
        'Checking for any downstream effects on the session middleware',
        'No issues found in related modules',
        'Ready for code review',
      ].join('\n').repeat(2);

      const units = partitioner.partition({
        sessionOutput: sessionContent,
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(10, 0),  // Close to telegram timestamps to stay in same unit
      });

      expect(units.length).toBeGreaterThanOrEqual(1);
      // Find the unit that contains both session and telegram content
      const dualUnit = units.find(u => u.sessionContent && u.telegramContent);
      expect(dualUnit).toBeDefined();
      expect(dualUnit!.sessionContent).toContain('Debugging');
      expect(dualUnit!.telegramContent).toContain('User');
      expect(dualUnit!.telegramContent).toContain('Agent');
    });

    it('filters Telegram messages by lastDigestedAt', () => {
      const partitioner = new ActivityPartitioner({ minSessionMinutes: 0 });

      const messages: TelegramLogEntry[] = [
        makeTelegramMessage({
          messageId: 1,
          text: 'Old message',
          timestamp: makeTimestamp(8, 0),  // Before lastDigestedAt
        }),
        makeTelegramMessage({
          messageId: 2,
          text: 'New message',
          timestamp: makeTimestamp(11, 0),  // After lastDigestedAt
        }),
      ];

      const units = partitioner.partition({
        sessionOutput: 'Some work',
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(10, 0),
      });

      if (units.length > 0 && units[0].telegramContent) {
        expect(units[0].telegramContent).toContain('New message');
        expect(units[0].telegramContent).not.toContain('Old message');
      }
    });

    it('works without Telegram messages', () => {
      const partitioner = new ActivityPartitioner({ minSessionMinutes: 0 });

      const units = partitioner.partition({
        sessionOutput: 'Pure session work without any messaging context\n'.repeat(20),
      });

      expect(units).toHaveLength(1);
      expect(units[0].telegramContent).toBeUndefined();
    });
  });

  // ─── Configuration ────────────────────────────────────────────

  describe('configuration', () => {
    it('uses default config when none provided', () => {
      const partitioner = new ActivityPartitioner();
      // Just verify it doesn't throw
      const units = partitioner.partition({ sessionOutput: 'test' });
      expect(Array.isArray(units)).toBe(true);
    });

    it('accepts partial config overrides', () => {
      const partitioner = new ActivityPartitioner({
        pauseThresholdMinutes: 15,
      });

      const messages: TelegramLogEntry[] = [
        makeTelegramMessage({
          messageId: 1,
          text: 'Before',
          timestamp: makeTimestamp(10, 0),
        }),
        makeTelegramMessage({
          messageId: 2,
          text: 'After',
          timestamp: makeTimestamp(10, 20),  // 20 min gap (> custom 15 min threshold)
        }),
      ];

      const units = partitioner.partition({
        sessionOutput: 'Work',
        telegramMessages: messages,
        lastDigestedAt: makeTimestamp(9, 0),
      });

      const pauseUnit = units.find(u => u.boundarySignal === 'long_pause');
      expect(pauseUnit).toBeDefined();
    });
  });
});
