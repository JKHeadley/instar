/**
 * The unanswered-message watcher must exist on an agent that has no Telegram.
 *
 * Live incident, 2026-10-20: an operator message to the indra agent sat
 * unanswered for 28 minutes and nothing was raised anywhere. indra talks on
 * Slack and has no Telegram adapter at all.
 *
 * The cause was a gate, not a missing feature. PresenceProxy — and the Slack
 * arming that feeds it, and the Slack standby commands, and PromiseBeacon —
 * were all constructed inside `if (sharedIntelligence && telegram)`. The Slack
 * support was written and sitting INSIDE the Telegram-gated block, so a
 * Slack-only agent got none of it: indra's entire server log carries no
 * "Presence Proxy wired to Slack" line.
 *
 * Every dep the proxy is given already branches on the Slack synthetic-id map
 * first and falls back to Telegram, so admitting a Slack-only agent is a gate
 * change rather than a redesign — which is exactly what these tests pin, plus
 * the safety of every Telegram dereference that the widened gate now exposes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

/** The presence-proxy construction block, from its gate to the proxy start. */
function proxyBlock(): string {
  const start = SRC.indexOf('let presenceProxy:');
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('presenceProxy.start();', start);
  expect(end).toBeGreaterThan(start);
  // Include the Slack arming, which sits after start() in the same block.
  const slackArm = SRC.indexOf('Presence Proxy wired to Slack', end);
  expect(slackArm).toBeGreaterThan(end);
  return SRC.slice(start, slackArm + 200);
}

describe('PresenceProxy is admitted on a Slack-only agent', () => {
  it('the gate accepts an agent with Slack and no Telegram', () => {
    expect(SRC).toContain('if (sharedIntelligence && (telegram || _slackAdapter)) {');
  });

  it('the old Telegram-only gate is gone', () => {
    // The exact string that kept indra from ever having a watcher.
    expect(SRC).not.toContain('if (sharedIntelligence && telegram) {');
  });

  it('the Slack arming lives inside the block the gate now admits', () => {
    const block = proxyBlock();
    expect(block).toContain('Presence Proxy wired to Slack');
    expect(block).toContain('slackChannelToSyntheticId');
  });

  it('no Telegram dereference in the block can throw when there is no Telegram', () => {
    // A non-null assertion compiles fine and crashes at runtime, so the
    // compiler cannot be the only check here. The block must contain none.
    const block = proxyBlock();
    expect(block).not.toContain('telegram!');
  });

  it('every Telegram message-capture chain is skipped rather than crashing', () => {
    const block = proxyBlock();
    // Each chain reads the previous callback optionally and only assigns when
    // the adapter exists; an unguarded assignment would throw at startup.
    const guarded = block.split('telegram.onMessageLogged = ').length - 1;
    const guardedWithIf = block.split('if (telegram) telegram.onMessageLogged = ').length - 1;
    expect(guarded).toBeGreaterThan(0);
    expect(guardedWithIf).toBe(guarded);
    expect(block).not.toContain('const existingCallback = telegram.onMessageLogged;');
  });

  it('the proxy deps resolve a Slack conversation before falling back to Telegram', () => {
    const block = proxyBlock();
    // The fallback is what made the Telegram-only gate look load-bearing; it
    // must now degrade to null rather than assert.
    expect(block).toContain('telegram?.getSessionForTopic(topicId) ?? null');
    expect(block).toContain('_slackAdapter.getSessionForChannel');
  });
});
