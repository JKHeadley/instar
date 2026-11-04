import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';

describe('Slack dead-session stall handling', () => {
  afterEach(() => vi.useRealTimers());

  it('leaves expired messages and promises to SessionMonitor before triage or notices', async () => {
    vi.useFakeTimers();
    const adapter = new SlackAdapter({
      botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U_TEST'],
      workspaceMode: 'dedicated',
    } as any, '/tmp/slack-dead-stall-test');
    const triage = vi.fn();
    const send = vi.fn(async () => undefined);
    adapter.onIsSessionAlive = () => false;
    adapter.onStallDetected = triage;
    adapter.sendToChannel = send;
    adapter.trackMessageInjection('C_TEST', 'dead-session', 'Please help');
    for (const entry of adapter['pendingStalls'].values()) entry.injectedAt -= 6 * 60_000;
    adapter['pendingPromises'].set('C_TEST', {
      sessionName: 'dead-session', promiseText: 'I will follow up',
      promisedAt: Date.now() - 11 * 60_000, alerted: false,
    });

    adapter.startStallDetection();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(triage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    clearInterval(adapter['stallCheckTimer']!);
  });
});
