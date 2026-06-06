import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyTranscriptUx,
  runPostDriveTranscriptAudit,
  runPostDriveTranscriptAuditCli,
  type TranscriptMessage,
} from '../../src/commands/postDriveTranscriptAudit.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/post-drive-transcript-audit.test.ts:afterEach',
    });
  }
});

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

  describe('split read/write servers (--history-base-url, the cross-agent mentor flow)', () => {
    function makeConfigDir(): string {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdta-cli-'));
      tmpDirs.push(tmp);
      fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.instar', 'config.json'),
        JSON.stringify({
          projectName: 'pdta-test',
          port: 4099,
          authToken: 'local-token',
          // Hermeticity: CI runners have no claude/tmux binaries — explicit
          // config paths bypass loadConfig's host detection (the #862 lesson,
          // same pattern as tests/unit/config-loadconfig.test.ts).
          sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude' },
        }),
      );
      return tmp;
    }

    it('reads history from --history-base-url with the remote token, files findings to the local ledger with the local token', async () => {
      const dir = makeConfigDir();
      const calls: Array<{ url: string; auth: string | undefined }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: u, auth: headers.Authorization });
        if (u.includes('/telegram/topics/')) {
          return new Response(JSON.stringify({ messages: [
            { messageId: 7, topicId: 1052, text: 'Please resend that file again', fromUser: false, timestamp: '2026-06-05T18:16:00.000Z' },
          ] }), { status: 200 });
        }
        if (u.includes('/framework-issues/observe')) {
          return new Response(JSON.stringify({ created: true, issueId: 'iss-1' }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${u}`);
      }) as typeof fetch;
      const originalEnv = process.env.INSTAR_HISTORY_AUTH_TOKEN;
      process.env.INSTAR_HISTORY_AUTH_TOKEN = 'mentee-token';

      try {
        const exitCode = await runPostDriveTranscriptAuditCli({
          topic: ['1052'],
          start: window.start,
          end: window.end,
          dir,
          json: true,
          historyBaseUrl: 'http://localhost:4777',
        });
        expect(exitCode).toBe(0);

        const historyCall = calls.find((c) => c.url.includes('/telegram/topics/'))!;
        const observeCall = calls.find((c) => c.url.includes('/framework-issues/observe'))!;
        // Read side: the MENTEE's server, with the history token — never the local one.
        expect(historyCall.url.startsWith('http://localhost:4777/')).toBe(true);
        expect(historyCall.auth).toBe('Bearer mentee-token');
        // Write side: the auditing agent's OWN ledger with its own token.
        expect(observeCall.url.startsWith('http://localhost:4099/')).toBe(true);
        expect(observeCall.auth).toBe('Bearer local-token');
      } finally {
        globalThis.fetch = originalFetch;
        if (originalEnv === undefined) delete process.env.INSTAR_HISTORY_AUTH_TOKEN;
        else process.env.INSTAR_HISTORY_AUTH_TOKEN = originalEnv;
      }
    });

    it('sends NO auth header to a remote history server when no history token is provided (never leaks the local token)', async () => {
      const dir = makeConfigDir();
      const calls: Array<{ url: string; auth: string | undefined }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: u, auth: headers.Authorization });
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }) as typeof fetch;
      const originalEnv = process.env.INSTAR_HISTORY_AUTH_TOKEN;
      delete process.env.INSTAR_HISTORY_AUTH_TOKEN;

      try {
        await runPostDriveTranscriptAuditCli({
          topic: ['1052'],
          start: window.start,
          end: window.end,
          dir,
          json: true,
          historyBaseUrl: 'http://localhost:4777',
        });
        const historyCall = calls.find((c) => c.url.includes('/telegram/topics/'))!;
        expect(historyCall.auth).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
        if (originalEnv !== undefined) process.env.INSTAR_HISTORY_AUTH_TOKEN = originalEnv;
      }
    });

    it('defaults to the single-server #864 flow when --history-base-url is omitted', async () => {
      const dir = makeConfigDir();
      const calls: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }) as typeof fetch;

      try {
        await runPostDriveTranscriptAuditCli({
          topic: ['1052'],
          start: window.start,
          end: window.end,
          dir,
          json: true,
        });
        expect(calls.every((u) => u.startsWith('http://localhost:4099/'))).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
