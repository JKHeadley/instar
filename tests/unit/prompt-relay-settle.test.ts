import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { settleBeforeRelay, promptAnchors, DEFAULT_RELAY_SETTLE_MS } from '../../src/monitoring/promptRelaySettle.js';
import type { DetectedPrompt } from '../../src/monitoring/PromptGate.js';

const usageLimit: DetectedPrompt = {
  type: 'selection',
  raw: 'You have hit your weekly limit\n❯ 1. Stop and wait for the limit to reset\n  2. Wait here, then continue automatically\n  3. Switch to usage credits',
  summary: 'Claude Code is asking how to handle the weekly usage limit.',
  options: [
    { key: '1', label: 'Stop and wait for the limit to reset' },
    { key: '2', label: 'Wait here, then continue automatically' },
    { key: '3', label: 'Switch to usage credits' },
  ],
  sessionName: 'echo-instar-app',
  detectedAt: 0,
  id: 'abc',
} as DetectedPrompt;

function deps(over: Partial<Parameters<typeof settleBeforeRelay>[1]> = {}) {
  const slept: number[] = [];
  return {
    slept,
    d: {
      settleMs: 1000,
      sleep: async (ms: number) => { slept.push(ms); },
      isAlive: () => true,
      capture: () => '',
      ...over,
    },
  };
}

describe('settleBeforeRelay', () => {
  it('relays a prompt that is still on screen after the wait', async () => {
    const { d, slept } = deps({ capture: () => 'old output\n' + usageLimit.raw });
    expect(await settleBeforeRelay(usageLimit, d)).toEqual({ relay: true, reason: 'still-pending' });
    expect(slept).toEqual([1000]);
  });

  it('does not relay a prompt that was answered during the wait', async () => {
    const { d } = deps({ capture: () => 'Switched account. Resuming…\n> ' });
    expect(await settleBeforeRelay(usageLimit, d)).toEqual({ relay: false, reason: 'prompt-cleared' });
  });

  it('does not relay when the session is gone (respawned or killed)', async () => {
    const { d } = deps({ isAlive: () => false });
    expect(await settleBeforeRelay(usageLimit, d)).toEqual({ relay: false, reason: 'session-gone' });
  });

  it('only counts the prompt when it is in the pane tail, not scrolled-back history', async () => {
    const scrolled = usageLimit.raw + '\n' + Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const { d } = deps({ capture: () => scrolled });
    expect((await settleBeforeRelay(usageLimit, d)).relay).toBe(false);
  });

  it('fails toward relaying when the pane cannot be read', async () => {
    const { d } = deps({ capture: () => null });
    expect(await settleBeforeRelay(usageLimit, d)).toEqual({ relay: true, reason: 'pane-unreadable' });
    const { d: d2 } = deps({ capture: () => { throw new Error('tmux gone'); } });
    expect((await settleBeforeRelay(usageLimit, d2)).relay).toBe(true);
  });

  it('relays immediately with no wait when the settle window is 0', async () => {
    const { d, slept } = deps({ settleMs: 0, isAlive: () => false });
    expect(await settleBeforeRelay(usageLimit, d)).toEqual({ relay: true, reason: 'settle-disabled' });
    expect(slept).toEqual([]);
  });

  it('uses the raw text tail as the anchor when there are no options', async () => {
    const q = { ...usageLimit, options: undefined, raw: 'Some header\nDo you want to continue with the deploy?' } as DetectedPrompt;
    expect(promptAnchors(q)).toContain('do you want to continue with the deploy?');
    const { d } = deps({ capture: () => 'Do you want to continue   with the deploy?' });
    expect((await settleBeforeRelay(q, d)).relay).toBe(true);
  });

  it('relays when nothing distinctive can be anchored', async () => {
    const q = { ...usageLimit, options: [{ key: 'y', label: 'Yes' }], raw: 'y/n' } as DetectedPrompt;
    const { d } = deps({ capture: () => 'anything' });
    expect(await settleBeforeRelay(q, d)).toEqual({ relay: true, reason: 'no-anchor' });
  });

  it('defaults to a 45 second settle window', () => {
    expect(DEFAULT_RELAY_SETTLE_MS).toBe(45_000);
  });
});

describe('wiring', () => {
  it('server relay path settles before relaying, with the real session manager reads', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
    const i = src.indexOf('settleBeforeRelay(prompt');
    expect(i).toBeGreaterThan(0);
    expect(src.indexOf('telegram.relayPrompt(topicId, prompt)')).toBeGreaterThan(i);
    expect(src.slice(i, i + 600)).toContain('sessionManager.isSessionAlive(name)');
    expect(src.slice(i, i + 600)).toContain('sessionManager.captureOutput(name');
  });

  it('the Telegram adapter no longer sends a separate "Prompt Gate is now active" message', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/messaging/TelegramAdapter.ts'), 'utf8');
    expect(src).not.toContain('Prompt Gate is now active');
  });
});
