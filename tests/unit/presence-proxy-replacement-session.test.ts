/**
 * PresenceProxy must watch the session that is ACTUALLY answering, not the one
 * that was registered when the message arrived.
 *
 * Live incident, 2026-11-03 (indra, Slack): the operator messaged a channel
 * whose session had died. Slack logs the inbound message — which arms the
 * watcher — BEFORE it checks the old session, finds it dead, spawns a
 * replacement and registers the new name. The watcher froze the OLD (dead)
 * name, read it dead at the 20-second Tier 1 timer, jumped straight to the
 * Tier 3 dead branch and posted "5-minute check — The session appears to have
 * stopped" about a minute after the message, while the replacement session was
 * visibly working. Telegram respawns follow the same order.
 *
 * Pinned here, both sides of the boundary:
 *  - a live replacement is picked up and watched normally (no alarm);
 *  - a spawn in progress is not "stopped" (no alarm while it starts);
 *  - a genuinely dead session is left to SessionMonitor for self-recovery;
 *  - "5-minute check" is never printed before ~5 minutes have passed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const T1 = 1_000;
const T2 = 30_000;
const T3 = 100_000;

function createProxy(overrides: Record<string, unknown>) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-replace-'));
  const sent: string[] = [];
  const config = {
    stateDir,
    intelligence: null,
    agentName: 'indra',
    captureSessionOutput: () => '⏺ Reading the Plaud transcript\n✻ Working… (12s)',
    getSessionForTopic: () => 'old-session',
    isSessionAlive: () => true,
    sendMessage: async (_topicId: number, text: string) => { sent.push(text); },
    getAuthorizedUserIds: () => [],
    getProcessTree: () => [],
    hasAgentRespondedSince: () => false,
    tier1DelayMs: T1,
    tier2DelayMs: T2,
    tier3DelayMs: T3,
    ...overrides,
  };
  const proxy = new PresenceProxy(config as any);
  proxy.start();
  return { proxy, sent };
}

function userMessage(proxy: PresenceProxy, topic = -4242) {
  proxy.onMessageLogged({
    messageId: 1,
    channelId: String(topic),
    text: 'review the Plaud transcript and start on its action items',
    fromUser: true,
    timestamp: new Date().toISOString(),
  });
}

const stoppedAlarm = (t: string) => /stopped/i.test(t);

describe('PresenceProxy follows the replacement session', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('replacement alive: the old dead name does not raise a "stopped" alarm', async () => {
    // The registry still names the dead session when the message is logged,
    // then names the replacement once the spawn registers it.
    let current = 'old-session';
    const { proxy, sent } = createProxy({
      getSessionForTopic: () => current,
      isSessionAlive: (name: string) => name === 'new-session',
    });
    userMessage(proxy);
    current = 'new-session'; // spawn finished and registered before Tier 1

    await vi.advanceTimersByTimeAsync(T1 + 12_000);
    expect(sent.some(stoppedAlarm)).toBe(false);
    expect(sent.some(t => t.includes('5-minute check'))).toBe(false);
    // Normal standby still runs against the live replacement.
    expect(sent.length).toBe(1);
    expect(proxy.getState(-4242)?.sessionName).toBe('new-session');
  });

  it('spawn in progress: no alarm while the replacement is starting', async () => {
    let current = 'old-session';
    let starting = true;
    const { proxy, sent } = createProxy({
      getSessionForTopic: () => current,
      isSessionAlive: (name: string) => name === 'new-session',
      isSessionStarting: () => starting,
    });
    userMessage(proxy);

    // Well past Tier 2 with the spawn still running — nothing may say "stopped".
    await vi.advanceTimersByTimeAsync(T2 + 6_000);
    expect(sent.some(stoppedAlarm)).toBe(false);

    // Spawn lands; the watcher picks up the new name and carries on.
    current = 'new-session';
    starting = false;
    await vi.advanceTimersByTimeAsync(T1 + 12_000);
    expect(sent.some(stoppedAlarm)).toBe(false);
    expect(proxy.getState(-4242)?.sessionName).toBe('new-session');
  });

  it('a live session the model calls dead still counts against the recheck limit', async () => {
    const evaluate = vi.fn(async () => 'dead');
    const { proxy, sent } = createProxy({
      intelligence: { evaluate },
      captureSessionOutput: () => 'idle prompt',
    });
    userMessage(proxy);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(evaluate).toHaveBeenCalled();
    expect(sent.some(stoppedAlarm)).toBe(false);
    expect(proxy.getState(-4242)?.tier3RecheckCount).toBeGreaterThan(0);
  });

  it('a logged brief agent reply never leads to a stopped notice', async () => {
    const { proxy, sent } = createProxy({
      getSessionForTopic: () => 'failed-resume',
      isSessionAlive: () => false,
      hasAgentRepliedSince: () => true,
    });
    userMessage(proxy);
    await vi.advanceTimersByTimeAsync(T2 + 20_000);
    expect(sent.some(stoppedAlarm)).toBe(false);
    expect(sent.some(t => /unstick|restart/i.test(t))).toBe(false);
  });

  it('really dead, no replacement: the proxy leaves recovery and notification to SessionMonitor', async () => {
    const { proxy, sent } = createProxy({
      getSessionForTopic: () => 'old-session',
      isSessionAlive: () => false,
    });
    userMessage(proxy);

    // At the Tier 1 timer the watcher waits for a replacement instead of alarming.
    await vi.advanceTimersByTimeAsync(T1 + 12_000);
    expect(sent.some(stoppedAlarm)).toBe(false);

    // By the Tier 2 mark nothing replaced it — the proxy stays quiet.
    await vi.advanceTimersByTimeAsync(T2 + 20_000);
    expect(sent.some(stoppedAlarm)).toBe(false);
  });

  it('really dead at the true 5-minute mark remains quiet', async () => {
    let starting = true;
    const { proxy, sent } = createProxy({
      getSessionForTopic: () => 'old-session',
      isSessionAlive: () => false,
      isSessionStarting: () => starting,
    });
    userMessage(proxy);
    await vi.advanceTimersByTimeAsync(T3 - 1_000);
    expect(sent.some(stoppedAlarm)).toBe(false);
    // A spawn that never lands is handled by the monitor's recovery path.
    await vi.advanceTimersByTimeAsync(T3 + 20_000);
    expect(sent.some(stoppedAlarm)).toBe(false);
    starting = false;
  });
});

describe('the watch continues after a held or skipped first check', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('dead at Tier 1, replacement up by Tier 2: Tier 2 and the 5-minute check still run', async () => {
    let current = 'old-session';
    const { proxy, sent } = createProxy({
      getSessionForTopic: () => current,
      isSessionAlive: (name: string) => name === 'new-session',
    });
    userMessage(proxy);
    await vi.advanceTimersByTimeAsync(T1 + 12_000); // Tier 1 reads dead, defers
    current = 'new-session'; // replacement registered (no start signal wired)
    await vi.advanceTimersByTimeAsync(T3 + 20_000);
    expect(sent.some(stoppedAlarm)).toBe(false);
    // Tier 2 ran and the real 5-minute check fired on the live replacement.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.some(t => t.includes('5-minute check'))).toBe(true);
  });

  it('a spawn hold that ends after the Tier 2 mark still reaches the 5-minute check', async () => {
    let current = 'old-session';
    let starting = true;
    const { proxy, sent } = createProxy({
      getSessionForTopic: () => current,
      isSessionAlive: (name: string) => name === 'new-session',
      isSessionStarting: () => starting,
    });
    userMessage(proxy);
    await vi.advanceTimersByTimeAsync(T2 + 10_000);
    current = 'new-session';
    starting = false;
    await vi.advanceTimersByTimeAsync(T3);
    expect(sent.some(stoppedAlarm)).toBe(false);
    expect(sent.some(t => t.includes('5-minute check'))).toBe(true);
  });
});

describe('server wires the spawn-in-progress signal (both channels)', () => {
  const SRC = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it('PresenceProxy is given isSessionStarting covering Slack and Telegram', () => {
    const start = SRC.indexOf('presenceProxy = new PresenceProxy({');
    expect(start).toBeGreaterThan(-1);
    const block = SRC.slice(start, start + 8_000);
    expect(block).toContain('isSessionStarting: (topicId) => {');
    expect(block).toContain('_slackSpawningChannels.get(channelId)');
    expect(block).toContain('_spawningTopicsRegistryRef?.has(topicId)');
  });

  it('the Slack spawn marks the channel and always clears it', () => {
    const at = SRC.indexOf('_slackSpawningChannels.set(channelId, (_slackSpawningChannels.get(channelId) ?? 0) + 1);');
    expect(at).toBeGreaterThan(-1);
    const after = SRC.slice(at, at + 6_000);
    expect(after).toContain('sessionManager.spawnInteractiveSession(');
    expect(after).toMatch(/finally \{\s*const left = \(_slackSpawningChannels\.get\(channelId\)/);
  });
});
