/**
 * Thread → session routing (Slack org §5.3, threads-as-first-class-sessions).
 *
 * A Slack thread is the real analog of a Telegram forum topic: a continuous,
 * focused conversation. When a channel is opted into thread routing, a reply
 * inside a thread (a message carrying a `thread_ts`) routes to / resumes a session
 * keyed on `<channelId>:<thread_ts>`, isolated from the channel-root session and
 * from sibling threads. When NOT opted in (the default), routing is byte-for-byte
 * unchanged — every message folds into the single channel-keyed session.
 *
 * These tests exercise the pure routing logic on a real SlackAdapter instance
 * (no Socket Mode / network), plus the registry + resume map keyed on the routing
 * key, and the sendToChannel routing-key tolerance.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';

const CH = 'C_MAIN';
const CH2 = 'C_OTHER';
const THREAD_A = '1700000000.000100';
const THREAD_B = '1700000000.000200';

function makeAdapter(threadSessions?: { enabledChannelIds?: string[]; allChannels?: boolean }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-thread-route-'));
  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    authorizedUserIds: ['U_TEST'],
    workspaceMode: 'dedicated',
    ...(threadSessions ? { threadSessions } : {}),
  } as any, stateDir);
  return { adapter, stateDir };
}

describe('Slack thread→session routing key resolution', () => {
  describe('opt-in gating (isThreadRoutingEnabled)', () => {
    it('default config: thread routing OFF for every channel', () => {
      const { adapter } = makeAdapter();
      expect(adapter.isThreadRoutingEnabled(CH)).toBe(false);
      expect(adapter.isThreadRoutingEnabled(CH2)).toBe(false);
    });

    it('enabledChannelIds opts in ONLY the listed channels', () => {
      const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
      expect(adapter.isThreadRoutingEnabled(CH)).toBe(true);
      expect(adapter.isThreadRoutingEnabled(CH2)).toBe(false);
    });

    it('allChannels:true opts in every channel', () => {
      const { adapter } = makeAdapter({ allChannels: true });
      expect(adapter.isThreadRoutingEnabled(CH)).toBe(true);
      expect(adapter.isThreadRoutingEnabled(CH2)).toBe(true);
    });
  });

  describe('resolveRoutingKey', () => {
    it('thread routing DISABLED: a threaded reply still routes to the CHANNEL key', () => {
      const { adapter } = makeAdapter(); // off
      expect(adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000300')).toBe(CH);
    });

    it('thread routing ENABLED: a reply inside a thread routes to `channel:thread_ts`', () => {
      const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
      const key = adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000300');
      expect(key).toBe(`${CH}:${THREAD_A}`);
    });

    it('a top-level (non-threaded) message routes to the channel key even when enabled', () => {
      const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
      expect(adapter.resolveRoutingKey(CH, undefined, '1700000000.000300')).toBe(CH);
    });

    it('a thread ROOT (thread_ts === own ts) routes to the channel key, not a degenerate thread', () => {
      const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
      // Slack sets thread_ts === ts on the parent of a thread.
      expect(adapter.resolveRoutingKey(CH, THREAD_A, THREAD_A)).toBe(CH);
    });

    it('TWO DIFFERENT threads in the same channel → two DIFFERENT keys', () => {
      const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
      const keyA = adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000300');
      const keyB = adapter.resolveRoutingKey(CH, THREAD_B, '1700000000.000400');
      expect(keyA).not.toBe(keyB);
      expect(keyA).toBe(`${CH}:${THREAD_A}`);
      expect(keyB).toBe(`${CH}:${THREAD_B}`);
    });

    it('the SAME thread resolves to the SAME key (resume → same session)', () => {
      const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
      const first = adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000300');
      const again = adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000900');
      expect(first).toBe(again);
    });

    it('a thread in an UNOPTED channel still folds into that channel (mixed config)', () => {
      const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
      expect(adapter.resolveRoutingKey(CH2, THREAD_A, '1700000000.000300')).toBe(CH2);
    });
  });

  describe('routing-key helpers', () => {
    it('isThreadRoutingKey distinguishes thread keys from channel keys', () => {
      const { adapter } = makeAdapter();
      expect(adapter.isThreadRoutingKey(CH)).toBe(false);
      expect(adapter.isThreadRoutingKey(`${CH}:${THREAD_A}`)).toBe(true);
    });

    it('parseRoutingKey round-trips channel + thread_ts', () => {
      const { adapter } = makeAdapter();
      expect(adapter.parseRoutingKey(CH)).toEqual({ channelId: CH });
      expect(adapter.parseRoutingKey(`${CH}:${THREAD_A}`)).toEqual({ channelId: CH, threadTs: THREAD_A });
    });

    it('parseRoutingKey splits on the FIRST colon only (thread_ts can contain a dot, never a colon)', () => {
      const { adapter } = makeAdapter();
      expect(adapter.parseRoutingKey(`${CH}:${THREAD_A}`).threadTs).toBe(THREAD_A);
    });
  });
});

describe('Slack registry + resume map are routing-key aware', () => {
  it('a channel session and a thread session in the same channel are distinct registry entries', () => {
    const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
    const channelKey = adapter.resolveRoutingKey(CH, undefined);
    const threadKey = adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000300');

    adapter.registerChannelSession(channelKey, 'sess-channel');
    adapter.registerChannelSession(threadKey, 'sess-thread', `${CH} (thread ${THREAD_A})`);

    expect(adapter.getSessionForChannel(channelKey)).toBe('sess-channel');
    expect(adapter.getSessionForChannel(threadKey)).toBe('sess-thread');
    // Distinct sessions — the thread did not clobber the channel session.
    expect(adapter.getSessionForChannel(channelKey)).not.toBe(adapter.getSessionForChannel(threadKey));
  });

  it('two threads in the same channel get two distinct sessions', () => {
    const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
    const keyA = adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000300');
    const keyB = adapter.resolveRoutingKey(CH, THREAD_B, '1700000000.000400');
    adapter.registerChannelSession(keyA, 'sess-A');
    adapter.registerChannelSession(keyB, 'sess-B');
    expect(adapter.getSessionForChannel(keyA)).toBe('sess-A');
    expect(adapter.getSessionForChannel(keyB)).toBe('sess-B');
  });

  it('getChannelForSession reverse-resolves a thread session to its routing key', () => {
    const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
    const threadKey = adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000300');
    adapter.registerChannelSession(threadKey, 'sess-thread');
    expect(adapter.getChannelForSession('sess-thread')).toBe(threadKey);
  });

  it('resume map keyed on the routing key: a thread resumes its OWN uuid, not the channel root', () => {
    const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
    const channelKey = adapter.resolveRoutingKey(CH, undefined);
    const threadKey = adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000300');

    adapter.saveChannelResume(channelKey, 'uuid-channel', 'sess-channel');
    adapter.saveChannelResume(threadKey, 'uuid-thread', 'sess-thread');

    expect(adapter.getChannelResume(channelKey)?.uuid).toBe('uuid-channel');
    expect(adapter.getChannelResume(threadKey)?.uuid).toBe('uuid-thread');
  });
});

describe('DEFAULT behavior is unchanged when thread routing is OFF (no regression)', () => {
  it('every message in a channel routes to the single channel key (threaded or not)', () => {
    const { adapter } = makeAdapter(); // default: off
    expect(adapter.resolveRoutingKey(CH, undefined)).toBe(CH);
    expect(adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000300')).toBe(CH);
    expect(adapter.resolveRoutingKey(CH, THREAD_B, '1700000000.000400')).toBe(CH);
  });

  it('registry behaves exactly as the channel→session model when off', () => {
    const { adapter } = makeAdapter();
    const k1 = adapter.resolveRoutingKey(CH, THREAD_A, '1700000000.000300');
    const k2 = adapter.resolveRoutingKey(CH, THREAD_B, '1700000000.000400');
    adapter.registerChannelSession(k1, 'one-session');
    // Both threads resolve to the same channel key → same session.
    expect(adapter.getSessionForChannel(k2)).toBe('one-session');
  });
});

describe('sendToChannel tolerates a routing key (PresenceProxy/standby relay safety)', () => {
  let posted: Array<{ method: string; params: Record<string, unknown> }>;

  function adapterWithCapturedApi() {
    const { adapter } = makeAdapter({ enabledChannelIds: [CH] });
    posted = [];
    // Stub the API client so no network call happens.
    (adapter as any).apiClient = {
      call: async (method: string, params: Record<string, unknown>) => {
        posted.push({ method, params });
        return { ts: '1700000001.000001' };
      },
    };
    return adapter;
  }

  beforeEach(() => { posted = []; });

  it('a raw channel id posts with NO thread_ts (channel-level reply)', async () => {
    const adapter = adapterWithCapturedApi();
    await adapter.sendToChannel(CH, 'hello');
    expect(posted[0].params.channel).toBe(CH);
    expect(posted[0].params.thread_ts).toBeUndefined();
  });

  it('a thread routing key is split: posts to the raw channel, threaded under thread_ts', async () => {
    const adapter = adapterWithCapturedApi();
    await adapter.sendToChannel(`${CH}:${THREAD_A}`, 'in thread');
    expect(posted[0].params.channel).toBe(CH);
    expect(posted[0].params.thread_ts).toBe(THREAD_A);
  });

  it('an explicit options.thread_ts always wins over an embedded one', async () => {
    const adapter = adapterWithCapturedApi();
    await adapter.sendToChannel(`${CH}:${THREAD_A}`, 'x', { thread_ts: THREAD_B });
    expect(posted[0].params.channel).toBe(CH);
    expect(posted[0].params.thread_ts).toBe(THREAD_B);
  });
});

describe('isSystemChannel tolerates a routing key', () => {
  it('a thread in a system (lifeline) channel is still a system channel', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-thread-sys-'));
    const adapter = new SlackAdapter({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      authorizedUserIds: ['U_TEST'],
      lifelineChannelId: 'C_LIFELINE',
      threadSessions: { allChannels: true },
    } as any, stateDir);
    expect(adapter.isSystemChannel('C_LIFELINE')).toBe(true);
    expect(adapter.isSystemChannel(`C_LIFELINE:${THREAD_A}`)).toBe(true);
    expect(adapter.isSystemChannel(CH)).toBe(false);
  });
});

describe('inbound _handleMessage carries thread_ts metadata used by routing', () => {
  it('a threaded inbound message exposes threadTs + ts in metadata', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-thread-inbound-'));
    const adapter = new SlackAdapter({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      authorizedUserIds: ['U_TEST'],
      workspaceMode: 'dedicated',
      threadSessions: { enabledChannelIds: [CH] },
    } as any, stateDir);

    const received: any[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    await (adapter as any)._handleMessage({
      user: 'U_TEST',
      text: 'reply inside a thread',
      channel: CH,
      ts: '1700000000.000900',
      thread_ts: THREAD_A,
    });

    expect(received.length).toBe(1);
    expect(received[0].metadata.threadTs).toBe(THREAD_A);
    expect(received[0].metadata.ts).toBe('1700000000.000900');
    // The routing layer would resolve this to the thread key:
    const key = adapter.resolveRoutingKey(CH, received[0].metadata.threadTs, received[0].metadata.ts);
    expect(key).toBe(`${CH}:${THREAD_A}`);
  });
});
