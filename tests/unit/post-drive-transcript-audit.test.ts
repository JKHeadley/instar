import { describe, it, expect } from 'vitest';
import {
  classifyTranscriptUx,
  runPostDriveTranscriptAudit,
  type TranscriptMessage,
} from '../../src/commands/postDriveTranscriptAudit.js';

const window = {
  start: '2026-06-05T18:15:00.000Z',
  end: '2026-06-05T18:21:00.000Z',
};

function msg(over: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    messageId: over.messageId ?? Math.floor(Math.random() * 1000),
    topicId: 2278,
    text: over.text ?? 'hello',
    fromUser: over.fromUser ?? false,
    timestamp: over.timestamp ?? '2026-06-05T18:16:00.000Z',
    sessionName: null,
  };
}

describe('post-drive transcript audit', () => {
  it('classifies the four operator-seat UX antipatterns in the drive window', () => {
    const findings = classifyTranscriptUx({
      topicId: 2278,
      window,
      observedVersion: 'test-version',
      messages: [
        msg({ messageId: 1, text: 'Message delivered to Telegram.' }),
        msg({ messageId: 2, text: 'Message delivered to Telegram.' }),
        msg({ messageId: 3, text: 'Can you resend the screenshot again?' }),
        msg({ messageId: 4, text: 'The queue restarted and the watchdog is waiting for terminal output.' }),
        msg({ messageId: 5, text: 'Quick update: still working, unchanged so far.' }),
        msg({
          messageId: 6,
          text: 'Implemented the transcript auditor and verified the unit test.',
          timestamp: '2026-06-05T18:22:00.000Z',
        }),
      ],
    });

    expect(findings.map((f) => f.category).sort()).toEqual([
      'asks-of-user',
      'content-free-updates',
      'duplicate-notices-deliveries',
      'infra-noise',
    ]);
    expect(findings.every((f) => f.frameworkIssue.bucket === 'instar-integration-gap')).toBe(true);
    expect(findings.every((f) => f.frameworkIssue.relatedSpec.includes('Observation Needs Structure'))).toBe(true);
    expect(findings.find((f) => f.category === 'asks-of-user')?.severity).toBe('high');
  });

  it('ignores user messages and concrete implementation updates', () => {
    const findings = classifyTranscriptUx({
      topicId: 2271,
      window,
      observedVersion: 'test-version',
      messages: [
        msg({ messageId: 10, fromUser: true, text: 'Please resend it if Telegram dropped it.' }),
        msg({ messageId: 11, text: 'Implemented the fix, pushed the branch, and opened PR #123.' }),
      ],
    });

    expect(findings).toEqual([]);
  });

  it('builds stable dedupe keys from topic, window, category, and evidence', () => {
    const messages = [
      msg({ messageId: 21, text: 'Still working, unchanged so far.' }),
    ];
    const first = classifyTranscriptUx({ topicId: 2278, window, observedVersion: 'test-version', messages });
    const second = classifyTranscriptUx({ topicId: 2278, window, observedVersion: 'test-version', messages });
    const shiftedTopic = classifyTranscriptUx({ topicId: 2271, window, observedVersion: 'test-version', messages });

    expect(first).toHaveLength(1);
    expect(second[0].dedupKey).toBe(first[0].dedupKey);
    expect(shiftedTopic[0].dedupKey).not.toBe(first[0].dedupKey);
  });

  it('reads multiple live-fixture topics and files each finding through the injected ledger sink', async () => {
    const observed: string[] = [];
    const report = await runPostDriveTranscriptAudit({
      topicIds: [2278, 2271],
      start: window.start,
      end: window.end,
      deps: {
        now: () => new Date('2026-06-05T18:30:00.000Z'),
        readTopicHistory: async (topicId) => [
          msg({ topicId, messageId: `${topicId}-a`, text: 'Message delivered to Telegram.' }),
          msg({ topicId, messageId: `${topicId}-b`, text: 'Message delivered to Telegram.' }),
        ],
        observeFinding: async (input) => {
          observed.push(input.dedupKey);
          return { created: true, episodeRecorded: true, issueId: `issue-${observed.length}` };
        },
      },
    });

    expect(report.topicIds).toEqual([2278, 2271]);
    expect(report.summary['duplicate-notices-deliveries']).toBe(2);
    expect(report.summary.total).toBe(2);
    expect(report.observations).toHaveLength(2);
    expect(report.observations.every((o) => o.filed)).toBe(true);
    expect(new Set(observed).size).toBe(2);
  });

  it('supports dry-run reports without filing observations', async () => {
    let filed = 0;
    const report = await runPostDriveTranscriptAudit({
      topicIds: [2278],
      start: window.start,
      end: window.end,
      dryRun: true,
      deps: {
        readTopicHistory: async () => [msg({ messageId: 31, text: 'Can you retry and send that again?' })],
        observeFinding: async () => {
          filed += 1;
          return {};
        },
      },
    });

    expect(filed).toBe(0);
    expect(report.summary['asks-of-user']).toBe(1);
    expect(report.observations).toEqual([{ dedupKey: report.findings[0].dedupKey, filed: false }]);
  });
});
