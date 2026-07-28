// safe-fs-allow: test file — tmpdir stateDir only.

/**
 * PresenceProxy honest turn-receipts (item 4, 2026-06-05).
 *
 * Behavioral proof that a live-but-failing session no longer gets the
 * "🔭 actively working" lie: fireTier3 is driven directly with a snapshot
 * that has a LIVE child process (the exact condition that previously forced
 * the "working" assessment) but whose tail shows a known stuck signature.
 * The proxy must surface the honest reason instead.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUP_ERROR =
  '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).';
const AUP_WEDGE = [
  '❯ msg one', AUP_ERROR, '✻ Churned for 8s',
  '❯ msg two', AUP_ERROR, '✻ Cogitated for 8s',
].join('\n');

const RATE_LIMIT = [
  '❯ did you get my messages?',
  "You've hit your session limit · resets 10:30pm (America/Los_Angeles)",
  '✻ Cooked for 0s',
].join('\n');

// "conversation too long" only in scrollback, then real work — must NOT fire.
const STALE_TOO_LONG = [
  'This conversation is too long. Press esc twice.',
  ...Array.from({ length: 18 }, (_, i) => `⏺ working line ${i}: real progress`),
  '✻ Crunching (12s)',
].join('\n');

interface Sent { topicId: number; text: string; opts?: any; }

function mkProxy(overrides: Record<string, unknown> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-honest-'));
  const sent: Sent[] = [];
  const config: any = {
    stateDir,
    intelligence: null,
    agentName: 'echo',
    // A LIVE child process — the condition that previously forced "working".
    getProcessTree: () => [{ command: 'claude', pid: 4242, cpu: 0, mem: 0 }],
    isSessionAlive: () => true,
    getSessionForTopic: () => 'sess-1',
    captureSessionOutput: () => AUP_WEDGE,
    sendMessage: async (topicId: number, text: string, opts: any) => { sent.push({ topicId, text, opts }); },
    getAuthorizedUserIds: () => [],
    ...overrides,
  };
  const proxy = new PresenceProxy(config);
  proxy.start();
  return { proxy, sent, stateDir, config };
}

function seedState(proxy: any, topicId: number, sessionName = 'sess-1') {
  const state = {
    topicId, sessionName,
    userMessageAt: Date.now() - 300_000,
    userMessageText: 'did you get my messages?',
    userMessageBaselineSnapshot: null,
    tier1FiredAt: Date.now() - 280_000, tier1Snapshot: null, tier1SnapshotHash: null,
    tier2FiredAt: null, tier2Snapshot: null, tier2SnapshotHash: null,
    tier3FiredAt: null, tier3Assessment: null, tier3Summary: null, tier3RecheckCount: 0,
    silencedUntil: null, cancelled: false, llmCallCount: 0, lastLlmCallAt: 0,
    conversationHistory: [], lastAckText: null, lastAckAt: null,
  };
  proxy.states.set(topicId, state);
  return state;
}

describe('PresenceProxy honest turn-receipts — fireTier3', () => {
  let cleanup: string[] = [];
  beforeEach(() => { cleanup = []; });
  afterEach(() => {
    for (const d of cleanup) {
      try {
        SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/presence-proxy-honest-receipts.test.ts:cleanup' });
      } catch { /* ignore */ }
    }
  });

  it('policy-wedge: surfaces the honest reason, NOT "working" (the core bug)', async () => {
    const { proxy, sent, stateDir } = mkProxy({ captureSessionOutput: () => AUP_WEDGE });
    cleanup.push(stateDir);
    const state = seedState(proxy, 100);
    await (proxy as any).fireTier3(100, state);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/content-policy/i);
    expect(sent[0].text).not.toMatch(/actively working|active child/i);
    expect(state.tier3Assessment).toBe('dead');
  });

  it('rate-limited: honest reason + reset hint, assessed self-clearing (waiting)', async () => {
    const { proxy, sent, stateDir } = mkProxy({ captureSessionOutput: () => RATE_LIMIT });
    cleanup.push(stateDir);
    const state = seedState(proxy, 101);
    await (proxy as any).fireTier3(101, state);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/usage limit/i);
    expect(sent[0].text).toMatch(/10:30pm/);
    expect(state.tier3Assessment).toBe('waiting');
  });

  it('defers to an owning recovery sentinel — stays silent (one voice)', async () => {
    const { proxy, sent, stateDir } = mkProxy({
      captureSessionOutput: () => AUP_WEDGE,
      isStuckRecoveryActive: () => true,
    });
    cleanup.push(stateDir);
    const state = seedState(proxy, 102);
    await (proxy as any).fireTier3(102, state);

    expect(sent).toHaveLength(0);
  });

  it('context-too-long: tries recovery first, announces the fresh session', async () => {
    let recoverCalled = false;
    const { proxy, sent, stateDir } = mkProxy({
      captureSessionOutput: () => 'This conversation is too long. Press esc twice to go up.\n❯',
      recoverContextExhaustion: async () => { recoverCalled = true; return { recovered: true }; },
    });
    cleanup.push(stateDir);
    const state = seedState(proxy, 103);
    await (proxy as any).fireTier3(103, state);

    expect(recoverCalled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/too long/i);
  });

  it('NOISE FIX: stale "conversation too long" in scrollback does NOT fire the honest message', async () => {
    let recoverCalled = false;
    const { proxy, sent, stateDir } = mkProxy({
      captureSessionOutput: () => STALE_TOO_LONG,
      recoverContextExhaustion: async () => { recoverCalled = true; return { recovered: true }; },
      // No LLM — force the deterministic path; active processes → "working".
      intelligence: null,
    });
    cleanup.push(stateDir);
    const state = seedState(proxy, 104);
    await (proxy as any).fireTier3(104, state);

    // The stale mention must NOT trigger context recovery or a "too long" notice.
    expect(recoverCalled).toBe(false);
    const tooLongMsg = sent.find(s => /conversation.*too long|got too long/i.test(s.text));
    expect(tooLongMsg).toBeUndefined();
  });

  it('durable context latch overrides misleading live-process evidence', async () => {
    const { proxy, sent, stateDir } = mkProxy({
      captureSessionOutput: () => '⏺ ordinary stale tail\n✻ Crunching (12s)',
      hasContextExhaustionLatch: () => true,
      recoverContextExhaustion: async () => ({ recovered: false }),
    });
    cleanup.push(stateDir);
    const state = seedState(proxy, 105);
    await (proxy as any).fireTier3(105, state);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/context limit|too long/i);
    expect(sent[0].text).not.toMatch(/actively working|active child/i);
    expect(state.tier3Assessment).toBe('dead');
  });
});

describe('PresenceProxy honest turn-receipts — server.ts wiring (dead-code guard)', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const serverSrc = fs2.readFileSync(
    path2.join(process.cwd(), 'src/commands/server.ts'),
    'utf-8',
  );

  it('server.ts wires isStuckRecoveryActive into the PresenceProxy config', () => {
    expect(serverSrc).toContain('isStuckRecoveryActive:');
  });

  it('the deference callback reuses the composed wedge recovery checker', () => {
    // It must reference wedgeRecoveryActive — the same checker the SessionReaper
    // veto uses — so PresenceProxy stays silent while a sentinel is recovering.
    const block = serverSrc.slice(serverSrc.indexOf('isStuckRecoveryActive:'));
    expect(block.slice(0, 200)).toContain('wedgeRecoveryActive');
  });

  it('server.ts wires the durable context latch into PresenceProxy', () => {
    expect(serverSrc).toContain('hasContextExhaustionLatch:');
    expect(serverSrc).toContain('_contextExhaustionFreshRequired');
  });
});
