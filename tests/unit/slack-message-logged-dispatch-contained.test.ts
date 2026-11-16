/**
 * SlackAdapter: the `onMessageLogged` subscriber cannot take the inbound message with it.
 *
 * The subscriber is server.ts's Slack closure, and it performs the TopicMemory dual-write
 * (`writeSlackLogRow` -> `TopicRowWriter.writeRow` -> `insertKeyedMessage` -> SQLite).
 * Nothing between there and the adapter catches. Two of the three Slack dispatch sites were
 * bare, so an operational write failure (SQLITE_READONLY / BUSY / FULL) escaped into
 * `_handleMessage` and `_handleFileShared` BEFORE the acknowledging reaction and before the
 * hand-off to the message handler — the whole inbound message was dropped: no reply, no
 * handler. Telegram's two dispatch sites have contained the same failure since they were
 * written. Measured on instar upstream d76d018c0 (PROP-1289).
 *
 * Every containment assertion here carries its POSITIVE CONTROL in the same `it`: the
 * identical path with a subscriber that does NOT throw must show the subscriber was really
 * invoked. Without that, a test passing because the dispatch never happened at all is
 * indistinguishable from a test passing because the failure was contained.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const BOOM = 'topic-memory write failed (SQLITE_READONLY)';

let stateDir: string;

function createTestAdapter() {
  const messages: Array<{ content: string; channel: string }> = [];
  fs.mkdirSync(path.join(stateDir, 'slack-files'), { recursive: true });

  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    authorizedUserIds: ['U_TEST'],
    workspaceMode: 'dedicated',
  } as any, stateDir);

  adapter.onMessage(async (msg) => {
    messages.push({ content: msg.content, channel: msg.channel.identifier });
  });

  return { adapter, messages };
}

/** Mock files.info + the download so `_handleFileShared` runs without network. */
function mockFileShare(adapter: SlackAdapter) {
  const apiClient = (adapter as any).apiClient;
  apiClient.call = vi.fn(async (method: string) => {
    if (method === 'files.info') {
      return {
        ok: true,
        file: {
          id: 'F_TEST_PDF',
          name: 'report.pdf',
          mimetype: 'application/pdf',
          url_private: 'https://files.slack.com/files-pri/T_TEST/report.pdf',
          size: 5000,
        },
      };
    }
    return { ok: true, user: { id: 'U_TEST', name: 'testuser', real_name: 'Test User' } };
  });

  const fileHandler = (adapter as any).fileHandler;
  fileHandler.downloadFile = vi.fn(async (_url: string, destPath: string) => {
    const resolved = path.resolve(fileHandler.downloadDir, destPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, 'fake-pdf-content');
    return resolved;
  });
}

describe('SlackAdapter onMessageLogged dispatch is contained', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-logged-dispatch-'));
    DegradationReporter.resetForTesting();
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    DegradationReporter.resetForTesting();
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true, force: true,
      operation: 'tests/unit/slack-message-logged-dispatch-contained.test.ts:afterEach',
    });
  });

  it('_handleMessage: a throwing subscriber does not stop the message reaching its handler', async () => {
    // POSITIVE CONTROL first: the same path with a subscriber that returns normally.
    const control = createTestAdapter();
    const seen: string[] = [];
    control.adapter.onMessageLogged = (entry) => { seen.push(String(entry.text)); };
    await (control.adapter as any)._handleMessage.bind(control.adapter)({
      user: 'U_TEST', text: 'control message', channel: 'C_TEST', ts: '1774829441.000011',
    });
    expect(seen).toEqual(['control message']);     // the dispatch really happens on this path
    expect(control.messages.length).toBe(1);

    // The containment itself.
    const { adapter, messages } = createTestAdapter();
    adapter.onMessageLogged = () => { throw new Error(BOOM); };

    await expect(
      (adapter as any)._handleMessage.bind(adapter)({
        user: 'U_TEST', text: 'please still route me', channel: 'C_TEST', ts: '1774829441.000012',
      }),
    ).resolves.toBeUndefined();

    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('please still route me');

    const reported = DegradationReporter.getInstance().getEvents()
      .filter((e) => e.feature === 'TopicMemory.dualWrite');
    expect(reported.length).toBe(1);
    expect(reported[0].reason).toContain(BOOM);
  });

  it('_handleFileShared: a throwing subscriber does not stop the file reaching its handler', async () => {
    const control = createTestAdapter();
    mockFileShare(control.adapter);
    const seen: string[] = [];
    control.adapter.onMessageLogged = (entry) => { seen.push(String(entry.text)); };
    await (control.adapter as any)._handleFileShared.bind(control.adapter)({
      file_id: 'F_TEST_PDF', user_id: 'U_TEST', channel_id: 'C_TEST_CHAN',
    });
    expect(seen.length).toBe(1);                   // the dispatch really happens on this path
    expect(control.messages.length).toBe(1);

    const { adapter, messages } = createTestAdapter();
    mockFileShare(adapter);
    adapter.onMessageLogged = () => { throw new Error(BOOM); };

    await expect(
      (adapter as any)._handleFileShared.bind(adapter)({
        file_id: 'F_TEST_PDF', user_id: 'U_TEST', channel_id: 'C_TEST_CHAN',
      }),
    ).resolves.toBeUndefined();

    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain('[document:');

    const reported = DegradationReporter.getInstance().getEvents()
      .filter((e) => e.feature === 'TopicMemory.dualWrite');
    expect(reported.length).toBe(1);
  });

  it('logMessage: the already-guarded site keeps its containment and now reports it', () => {
    const { adapter } = createTestAdapter();
    const seen: string[] = [];
    adapter.onMessageLogged = (entry) => { seen.push(String(entry.text)); };
    adapter.logMessage({
      messageId: '1774829441.000021', channelId: 'C_TEST', text: 'control row', fromUser: false,
    });
    expect(seen).toEqual(['control row']);         // notify defaults on, so the dispatch happens

    adapter.onMessageLogged = () => { throw new Error(BOOM); };
    expect(() => adapter.logMessage({
      messageId: '1774829441.000022', channelId: 'C_TEST', text: 'row that throws', fromUser: false,
    })).not.toThrow();

    const reported = DegradationReporter.getInstance().getEvents()
      .filter((e) => e.feature === 'TopicMemory.dualWrite');
    expect(reported.length).toBe(1);
  });

  it('logMessage with notify:false still does not dispatch (the agent-reply route contract)', () => {
    const { adapter } = createTestAdapter();
    let called = 0;
    adapter.onMessageLogged = () => { called += 1; };
    adapter.logMessage({
      messageId: '1774829441.000031', channelId: 'C_TEST', text: 'no notify', fromUser: false,
    }, { notify: false });
    expect(called).toBe(0);
  });
});
