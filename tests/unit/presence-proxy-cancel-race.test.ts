/**
 * PresenceProxy tier cancellation race — verifies that when an agent
 * responds while the proxy is in the middle of sending a tier message,
 * subsequent tiers are NOT scheduled.
 *
 * Root cause: fireTier1 checks state.cancelled BEFORE the async
 * sendProxyMessage call. If the agent responds during that async gap,
 * the cancelled flag is set but fireTier1 still schedules tier 2.
 *
 * Fix: re-check state.cancelled after sendProxyMessage, before scheduleTier.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function createTestProxy(overrides: Record<string, unknown> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-'));
  const sentMessages: Array<{ topicId: number; text: string }> = [];

  const config = {
    stateDir,
    intelligence: null, // No LLM — forces fallback message (fast, no async LLM)
    agentName: 'test-agent',
    captureSessionOutput: () => 'Some terminal output here\nWorking on things...',
    getSessionForTopic: () => 'test-session',
    isSessionAlive: () => true,
    sendMessage: async (topicId: number, text: string) => {
      sentMessages.push({ topicId, text });
    },
    getAuthorizedUserIds: () => [],
    getProcessTree: () => [],
    hasAgentRespondedSince: () => false,
    // Use very short delays for testing
    tier1DelayMs: 50,
    tier2DelayMs: 200,
    tier3DelayMs: 500,
    ...overrides,
  };

  const proxy = new PresenceProxy(config as any);
  proxy.start();

  return { proxy, sentMessages, stateDir };
}

describe('PresenceProxy tier cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels tier 2 when agent responds after tier 1 sends', async () => {
    const { proxy, sentMessages } = createTestProxy();

    // User sends a message — starts the proxy cycle
    proxy.onMessageLogged({
      messageId: 1,
      channelId: '100',
      text: 'Hello',
      fromUser: true,
      timestamp: new Date().toISOString(),
    });

    // Advance past tier 1 delay
    await vi.advanceTimersByTimeAsync(60);

    // Tier 1 should have fired (fallback message since no LLM)
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain('test-agent');

    // Now simulate agent responding (non-system, non-proxy message)
    proxy.onMessageLogged({
      messageId: 2,
      channelId: '100',
      text: 'Done! Here is the result.',
      fromUser: false,
      timestamp: new Date().toISOString(),
    });

    // Advance past tier 2 delay
    await vi.advanceTimersByTimeAsync(300);

    // Tier 2 should NOT have fired — agent already responded
    expect(sentMessages.length).toBe(1);
  });

  it('allows tier 2 when agent has not responded', async () => {
    const { proxy, sentMessages } = createTestProxy();

    // User sends a message
    proxy.onMessageLogged({
      messageId: 1,
      channelId: '200',
      text: 'Do something',
      fromUser: true,
      timestamp: new Date().toISOString(),
    });

    // Advance past tier 1
    await vi.advanceTimersByTimeAsync(60);
    expect(sentMessages.length).toBe(1);

    // No agent response — advance past tier 2
    await vi.advanceTimersByTimeAsync(250);

    // Tier 2 should fire
    expect(sentMessages.length).toBe(2);
    expect(sentMessages[1].text).toContain('2-minute update');
  });

  it('does not schedule tier if state was cancelled before scheduleTier', async () => {
    const { proxy, sentMessages } = createTestProxy();

    // User message
    proxy.onMessageLogged({
      messageId: 1,
      channelId: '300',
      text: 'Quick question',
      fromUser: true,
      timestamp: new Date().toISOString(),
    });

    // Agent responds immediately (before tier 1 even fires)
    proxy.onMessageLogged({
      messageId: 2,
      channelId: '300',
      text: 'Quick answer!',
      fromUser: false,
      timestamp: new Date().toISOString(),
    });

    // Advance past all tier delays
    await vi.advanceTimersByTimeAsync(600);

    // No tier messages should have been sent
    expect(sentMessages.length).toBe(0);
  });

  it('system messages (delivery confirmations) do not cancel tiers', async () => {
    const { proxy, sentMessages } = createTestProxy();

    // User message
    proxy.onMessageLogged({
      messageId: 1,
      channelId: '400',
      text: 'Build the feature',
      fromUser: true,
      timestamp: new Date().toISOString(),
    });

    // Delivery confirmation (system message — should NOT cancel)
    proxy.onMessageLogged({
      messageId: 2,
      channelId: '400',
      text: '✓ Delivered',
      fromUser: false,
      timestamp: new Date().toISOString(),
    });

    // Advance past tier 1
    await vi.advanceTimersByTimeAsync(60);

    // Tier 1 should still fire (delivery confirmation doesn't count as agent response)
    expect(sentMessages.length).toBe(1);
  });

  it('proxy messages (standby updates) do not cancel tiers', async () => {
    const { proxy, sentMessages } = createTestProxy();

    // User message
    proxy.onMessageLogged({
      messageId: 1,
      channelId: '500',
      text: 'Deploy the app',
      fromUser: true,
      timestamp: new Date().toISOString(),
    });

    // Advance past tier 1
    await vi.advanceTimersByTimeAsync(60);
    expect(sentMessages.length).toBe(1);

    // Proxy message (starts with 🔭 — should NOT cancel tier 2)
    proxy.onMessageLogged({
      messageId: 3,
      channelId: '500',
      text: '🔭 test-agent is working on deployment...',
      fromUser: false,
      timestamp: new Date().toISOString(),
    });

    // Advance past tier 2
    await vi.advanceTimersByTimeAsync(250);

    // Tier 2 should fire (proxy message doesn't count as agent response)
    expect(sentMessages.length).toBe(2);
  });
});
