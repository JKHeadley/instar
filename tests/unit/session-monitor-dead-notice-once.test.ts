/**
 * "The session has stopped" — one notice per death, and never for the agent's
 * own messages.
 *
 * REGRESSION (2026-11-02, a Slack-only agent): the notice was posted a dozen
 * times in one morning in one channel. Two defects combined:
 *   1. The Slack history fed to the monitor marked EVERY message as from the
 *      user — the agent's own notice included — so "a user is waiting" stayed
 *      true forever and no reply could ever satisfy it.
 *   2. The repeat guards lived only in memory, so each server restart forgot
 *      the death had already been announced and announced it again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionMonitor, type SessionMonitorDeps } from '../../src/monitoring/SessionMonitor.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TOPIC = -12345;

function deadDeps(
  sessionName: string,
  history: () => Array<{ text: string; fromUser: boolean; timestamp: string }>,
  ledger?: string,
): SessionMonitorDeps {
  return {
    getActiveTopicSessions: vi.fn(() => new Map([[TOPIC, sessionName]])),
    captureSessionOutput: vi.fn(() => ''),
    isSessionAlive: vi.fn(() => false),
    getTopicHistory: vi.fn(history),
    sendToTopic: vi.fn(async () => undefined),
    triggerTriage: vi.fn(async () => ({ resolved: false })),
    deadNoticeStatePath: ledger,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('SessionMonitor: dead-session notice is once per death across restarts', () => {
  let tmpDir: string;
  let ledger: string;
  const userMsgAt = Date.now() - 5 * 60_000;
  const userWaiting = () => [{ text: 'hi', fromUser: true, timestamp: iso(userMsgAt) }];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-dead-ledger-'));
    ledger = path.join(tmpDir, 'state', 'session-monitor-dead-notified.json');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-monitor-dead-notice-once.test.ts cleanup' });
  });

  it('a restarted monitor does not re-announce the same death', async () => {
    const a = deadDeps('sess-1', userWaiting, ledger);
    await new SessionMonitor(a).poll();
    expect(a.sendToTopic).toHaveBeenCalledTimes(1);
    expect(a.sendToTopic).toHaveBeenCalledWith(TOPIC, "I couldn't restore this conversation. Your message is saved.");

    // Server restart: new instance, same ledger, same dead session, same history.
    const b = deadDeps('sess-1', userWaiting, ledger);
    await new SessionMonitor(b).poll();
    expect(b.sendToTopic).not.toHaveBeenCalled();
    expect(b.triggerTriage).not.toHaveBeenCalled();
  });

  it('a different dead session with no newer user message is not announced', async () => {
    const a = deadDeps('sess-1', userWaiting, ledger);
    await new SessionMonitor(a).poll();
    const b = deadDeps('sess-2', userWaiting, ledger);
    await new SessionMonitor(b).poll();
    expect(b.sendToTopic).not.toHaveBeenCalled();
  });

  it('a newer user message to a new dead session IS announced (real users still hear)', async () => {
    const a = deadDeps('sess-1', userWaiting, ledger);
    await new SessionMonitor(a).poll();
    const later = () => [{ text: 'still there?', fromUser: true, timestamp: iso(userMsgAt + 60_000) }];
    const b = deadDeps('sess-2', later, ledger);
    await new SessionMonitor(b).poll();
    expect(b.sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('a reused session name (Telegram) with a newer user message IS announced — a new death is news', async () => {
    const a = deadDeps('topic-session', userWaiting, ledger);
    await new SessionMonitor(a).poll();
    const later = () => [{ text: 'hello?', fromUser: true, timestamp: iso(userMsgAt + 60_000) }];
    const b = deadDeps('topic-session', later, ledger);
    await new SessionMonitor(b).poll();
    expect(b.sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('many restarts with no new user message post exactly one notice in total', async () => {
    const all: SessionMonitorDeps[] = [];
    for (let i = 0; i < 12; i++) {
      const d = deadDeps('sess-1', userWaiting, ledger);
      all.push(d);
      await new SessionMonitor(d).poll();
    }
    const total = all.reduce((n, d) => n + (d.sendToTopic as any).mock.calls.length, 0);
    expect(total).toBe(1);
  });

  it('a notice that failed to send is not recorded, so a restart retries it', async () => {
    const a = deadDeps('sess-1', userWaiting, ledger);
    a.sendToTopic = vi.fn(async () => { throw new Error('rate_limited'); });
    await new SessionMonitor(a).poll();
    expect(a.sendToTopic).toHaveBeenCalledTimes(1);
    const b = deadDeps('sess-1', userWaiting, ledger);
    await new SessionMonitor(b).poll();
    expect(b.sendToTopic).toHaveBeenCalledTimes(1);
  });

  it('a corrupt ledger starts empty and monitoring still works', async () => {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, '{nope');
    const a = deadDeps('sess-1', userWaiting, ledger);
    await new SessionMonitor(a).poll();
    expect(a.sendToTopic).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(ledger, 'utf-8'))[String(TOPIC)].sessionName).toBe('sess-1');
  });

  it('without a ledger path the behavior is the old in-memory one', async () => {
    const a = deadDeps('sess-1', userWaiting);
    await new SessionMonitor(a).poll();
    const b = deadDeps('sess-1', userWaiting);
    await new SessionMonitor(b).poll();
    expect(b.sendToTopic).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(ledger)).toBe(false);
  });
});

describe('Slack history: the agent\'s own messages never count as a waiting user', () => {
  function adapter(botUserId: string | null) {
    const a = new SlackAdapter({
      botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U_HUMAN'], workspaceMode: 'dedicated',
    } as any, fs.mkdtempSync(path.join(os.tmpdir(), 'slack-own-msg-')));
    (a as any).botUserId = botUserId;
    a.onMessage(async () => {});
    return a;
  }

  it('classifies own posts, other bots, strangers and unknown identity as not-user', () => {
    const a = adapter('U_BOT');
    expect(a.isMessageFromUser({ user: 'U_HUMAN' })).toBe(true);
    expect(a.isMessageFromUser({ user: 'U_BOT' })).toBe(false);
    expect(a.isMessageFromUser({ user: 'U_HUMAN', bot_id: 'B1' })).toBe(false);
    expect(a.isMessageFromUser({ user: 'B_SOMEBOT' })).toBe(false);
    expect(a.isMessageFromUser({ user: 'U_STRANGER' })).toBe(false);
    expect(adapter(null).isMessageFromUser({ user: 'U_HUMAN' })).toBe(false);
    expect(a.isMessageFromUser({ user: 'U_HUMAN', subtype: 'channel_join' })).toBe(false);
    expect(a.isMessageFromUser({ user: 'U_HUMAN', subtype: 'file_share' })).toBe(true);
  });

  it('a mention-only channel\'s unaddressed chatter is not a user waiting', async () => {
    const a = new SlackAdapter({
      botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U_HUMAN'], workspaceMode: 'shared', respondMode: 'mention-only',
    } as any, fs.mkdtempSync(path.join(os.tmpdir(), 'slack-own-msg-')));
    (a as any).botUserId = 'U_BOT';
    a.onMessage(async () => {});
    const handle = (a as any)._handleMessage.bind(a);
    await handle({ user: 'U_HUMAN', text: 'lunch at noon?', channel: 'C2', ts: (Date.now() / 1000).toFixed(6) });
    const msgs = a.getChannelMessages('C2', 5);
    expect(msgs).toHaveLength(1);
    expect(a.isMessageFromUser(msgs[0])).toBe(false);
  });

  it('end to end: the agent\'s own notice, echoed back by Slack, does not re-arm the notice', async () => {
    const a = adapter('U_BOT');
    const handle = (a as any)._handleMessage.bind(a);
    const t0 = Date.now() / 1000 - 600;
    // A real user message, then the session dies.
    await handle({ user: 'U_HUMAN', text: 'hi', channel: 'C1', ts: t0.toFixed(6) });
    // The mapping server.ts uses for the SessionMonitor.
    const history = () => a.getChannelMessages('C1', 5).map(m => ({
      text: m.text, fromUser: a.isMessageFromUser(m), timestamp: new Date(parseFloat(m.ts) * 1000).toISOString(),
    }));
    const first = deadDeps('sess-1', history);
    first.sendToTopic = vi.fn(async (_t: number, text: string) => {
      // Slack echoes the bot's own post back as a message event with bot_id.
      await handle({ user: 'U_BOT', bot_id: 'B_SELF', text, channel: 'C1', ts: (t0 + 60).toFixed(6) });
    });
    await new SessionMonitor(first).poll();
    expect(first.sendToTopic).toHaveBeenCalledTimes(1);

    // Restart with NO ledger: the newest message is now the agent's own notice,
    // so nobody is waiting and nothing is posted.
    const second = deadDeps('sess-1', history);
    await new SessionMonitor(second).poll();
    expect(second.sendToTopic).not.toHaveBeenCalled();
  });

  it('server.ts no longer marks every Slack message as from the user', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf-8');
    expect(src).not.toMatch(/getChannelMessages\(slackChId, limit\);\s*return msgs\.map\(m => \(\{ text: m\.text, fromUser: true/);
    expect(src.match(/fromUser: _slackAdapter!\.isMessageFromUser\(m\)/g)?.length).toBe(3);
    expect(src).toContain("deadNoticeStatePath: path.join(config.stateDir, 'state', 'session-monitor-dead-notified.json')");
  });
});
