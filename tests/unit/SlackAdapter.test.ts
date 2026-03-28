import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';

describe('SlackAdapter compatibility surface', () => {
  let tmpDir: string;
  let adapter: SlackAdapter;
  const config = {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    authorizedUserIds: ['U123'],
    stallTimeoutMinutes: 0.001,
    promiseTimeoutMinutes: 0,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-slack-test-'));
    adapter = new SlackAdapter(config, tmpDir);
    vi.spyOn(adapter, 'getUserInfo').mockResolvedValue({ id: 'U123', name: 'Test User' });
    vi.spyOn(adapter.api, 'call').mockResolvedValue({ ts: '123.456' } as never);
  });

  afterEach(async () => {
    (adapter as { stallDetector?: { stop: () => void } }).stallDetector?.stop();
    await adapter.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers and reloads channel-session mappings', async () => {
    adapter.registerChannelSession('C123', 'sess-1', 'customer-thread');

    expect(adapter.getSessionForChannel('C123')).toBe('sess-1');
    expect(adapter.getChannelForSession('sess-1')).toBe('C123');

    const reloaded = new SlackAdapter(config, tmpDir);
    expect(reloaded.getSessionForChannel('C123')).toBe('sess-1');
    expect(reloaded.getChannelForSession('sess-1')).toBe('C123');
    await reloaded.stop();
  });

  it('persists channel resume entries', async () => {
    adapter.saveChannelResume('C123', 'uuid-1', 'sess-1');

    expect(adapter.getChannelResume('C123')).toMatchObject({
      uuid: 'uuid-1',
      sessionName: 'sess-1',
    });

    const reloaded = new SlackAdapter(config, tmpDir);
    expect(reloaded.getChannelResume('C123')).toMatchObject({
      uuid: 'uuid-1',
      sessionName: 'sess-1',
    });

    reloaded.removeChannelResume('C123');
    expect(reloaded.getChannelResume('C123')).toBeNull();
    await reloaded.stop();
  });

  it('tracks injected messages for registered sessions after routing', async () => {
    const trackSpy = vi.spyOn((adapter as { stallDetector: { trackMessageInjection: (...args: string[]) => void } }).stallDetector, 'trackMessageInjection');
    const handler = vi.fn().mockResolvedValue(undefined);

    adapter.registerChannelSession('C123', 'sess-1');
    adapter.onMessage(handler);

    await adapter._testInjectMessage({
      user: 'U123',
      text: 'hello from slack',
      channel: 'C123',
      ts: '123.456',
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(trackSpy).toHaveBeenCalledWith('C123', 'sess-1', 'hello from slack');
  });

  it('tracks outbound replies and clears stalls for mapped channels', async () => {
    const detector = adapter as {
      stallDetector: {
        clearStallForChannel: (channelId: string) => void;
        trackOutboundMessage: (channelId: string, sessionName: string, text: string) => void;
      };
    };
    const clearSpy = vi.spyOn(detector.stallDetector, 'clearStallForChannel');
    const outboundSpy = vi.spyOn(detector.stallDetector, 'trackOutboundMessage');

    adapter.registerChannelSession('C123', 'sess-1');
    await adapter.sendToChannel('C123', 'Working on it');

    expect(clearSpy).toHaveBeenCalledWith('C123');
    expect(outboundSpy).toHaveBeenCalledWith('C123', 'sess-1', 'Working on it');
  });

  it('forwards shared stall events through onStallDetected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-28T00:00:00.000Z'));

    const stallSpy = vi.fn().mockResolvedValue(undefined);
    adapter.onStallDetected = stallSpy;
    adapter.registerChannelSession('C123', 'sess-1');
    adapter.onMessage(async () => {});

    await adapter._testInjectMessage({
      user: 'U123',
      text: 'stalled message',
      channel: 'C123',
      ts: '123.456',
    });

    vi.setSystemTime(new Date('2026-03-28T00:00:00.120Z'));
    await (adapter as { stallDetector: { check: () => Promise<void> } }).stallDetector.check();

    expect(stallSpy).toHaveBeenCalledWith('C123', 'sess-1', 'stalled message', expect.any(Number));
  });
});
