/**
 * standby-durable-forward-without-token §8 — every attention hub post is notice-class.
 *
 * Regression for the independent review of 2026-11-11: ordinary hub posts
 * (createAttentionItem → routeToAttentionHub) carried no notice class, so on a
 * token-less machine with the gate live an expiry report became a durable held
 * reply of its own (expiry → held → expiry). Now the post is notice-class (the
 * server sends it by the direct relay, never as a hold); when the holder is
 * unreachable nothing is prepared, the item stays in the store, and one re-post
 * is queued durably (it survives a restart) and sent when the holder answers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../../src/messaging/TelegramAdapter.js';
import { TelegramOriginHoldError } from '../../../src/messaging/telegram-origin/types.js';
import { isNoticeClass } from '../../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { hubRepostDecision, HUB_REPOST_MAX_ATTEMPTS, HUB_REPOST_BACKOFF_MS } from '../../../src/messaging/telegram-origin/TokenlessNoticeBrakes.js';

const dirs: string[] = [];
const adapters: TelegramAdapter[] = [];
function tokenless(dir: string, relay: TelegramAdapter['outboundRelay']): TelegramAdapter {
  const adapter = new TelegramAdapter({ token: '', chatId: '-100123456', pollIntervalMs: 100, attentionHubFilter: 'all', getAttentionHubTopicId: () => 7848 }, dir);
  adapter.outboundRelay = relay;
  adapters.push(adapter);
  return adapter;
}
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'hub-post-notice-class cleanup' });
});

describe('attention hub posts on a token-less machine (§8)', () => {
  it('an expiry report while the holder is unreachable: sent notice-class, no hold, re-post queued durably, posted once when the holder answers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hub-notice-')); dirs.push(dir);
    let reachable = false;
    const relay = vi.fn(async (_topicId: number, _text: string, opts?: { kindMetadata?: Record<string, unknown> }) => {
      if (!reachable) throw new TelegramOriginHoldError('origin-peer-unreachable'); // nothing prepared anywhere
      return { messageId: 41, topicId: 7848 };
    });
    const adapter = tokenless(dir, relay as never);
    const item = await adapter.createAttentionItem({ id: 'held-expiry:op-1', category: 'telegram-origin', priority: 'HIGH',
      title: 'A reply expired before it could be sent', summary: 'The reply to topic 141014 was never delivered.', sourceContext: 'telegram-origin-held-expiry' },
      { hubOnly: true, noticeClass: 'held-expiry-report' });
    expect(item.id).toBe('held-expiry:op-1');
    expect(relay).toHaveBeenCalledTimes(1);
    const meta = relay.mock.calls[0][2]?.kindMetadata;
    expect(meta).toEqual({ noticeClass: 'held-expiry-report' });
    expect(isNoticeClass(meta)).toBe(true); // the server's relay therefore never takes the durable-hold path
    expect([...adapter.pendingHubReposts]).toEqual(['held-expiry:op-1']);

    // A restart during the outage does not forget the re-post.
    const restarted = tokenless(dir, relay as never);
    restarted.loadPendingHubReposts();
    expect([...restarted.pendingHubReposts]).toEqual(['held-expiry:op-1']);

    reachable = true;
    expect(await restarted.repostPendingHubPosts()).toBe(1);
    expect(isNoticeClass(relay.mock.calls.at(-1)?.[2]?.kindMetadata)).toBe(true);
    expect(restarted.pendingHubReposts.size).toBe(0);
    expect(await restarted.repostPendingHubPosts()).toBe(0);
  });
  it('an ordinary hub post defaults to the attention-hub-post class', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hub-notice-')); dirs.push(dir);
    const relay = vi.fn(async () => ({ messageId: 42, topicId: 7848 }));
    const adapter = tokenless(dir, relay as never);
    await adapter.createAttentionItem({ id: 'raise-held:9', category: 'telegram-origin', priority: 'HIGH', title: 'Reply held', summary: 'held', sourceContext: 'telegram-origin-forward-to-holder' }, { hubOnly: true });
    expect((relay.mock.calls[0] as unknown[])[2]).toMatchObject({ kindMetadata: { noticeClass: 'attention-hub-post' } });
    expect(adapter.pendingHubReposts.size).toBe(0);
  });
  it('a re-post that keeps failing backs off, survives a restart with its count, and is given up after the cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hub-notice-')); dirs.push(dir);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
      const relay = vi.fn(async () => { throw new TelegramOriginHoldError('origin-peer-unreachable'); });
      const adapter = tokenless(dir, relay as never);
      await adapter.createAttentionItem({ id: 'held-expiry:op-2', category: 'telegram-origin', priority: 'HIGH', title: 'Expired', summary: 's', sourceContext: 'x' }, { hubOnly: true, noticeClass: 'held-expiry-report' });
      const before = relay.mock.calls.length;
      await adapter.repostPendingHubPosts(); // first re-post attempt: fails, attempt 1 recorded
      await adapter.repostPendingHubPosts(); // inside the 1 min backoff: not tried
      expect(relay.mock.calls.length - before).toBe(1);
      // A restart keeps the count, so the backoff still holds.
      const restarted = tokenless(dir, relay as never);
      await restarted.repostPendingHubPosts();
      expect(relay.mock.calls.length - before).toBe(1);
      let tries = 1;
      for (let i = 0; i < 40; i++) { vi.setSystemTime(Date.now() + HUB_REPOST_BACKOFF_MS[HUB_REPOST_BACKOFF_MS.length - 1]); await restarted.repostPendingHubPosts(); }
      tries = relay.mock.calls.length - before;
      expect(tries).toBe(HUB_REPOST_MAX_ATTEMPTS);
      expect(restarted.pendingHubReposts.size).toBe(0); // given up; the item itself stays open
      expect(restarted.getAttentionItem('held-expiry:op-2')?.status).toBe('OPEN');
    } finally { vi.useRealTimers(); }
  });
});

describe('hubRepostDecision', () => {
  it('due when never tried, waits along the backoff, gives up at the cap', () => {
    expect(hubRepostDecision(undefined, 0)).toBe('due');
    expect(hubRepostDecision({ attempts: 1, lastAt: 0 }, HUB_REPOST_BACKOFF_MS[0] - 1)).toBe('wait');
    expect(hubRepostDecision({ attempts: 1, lastAt: 0 }, HUB_REPOST_BACKOFF_MS[0])).toBe('due');
    expect(hubRepostDecision({ attempts: 9, lastAt: 0 }, 0)).toBe('give-up');
    expect(hubRepostDecision({ attempts: HUB_REPOST_MAX_ATTEMPTS, lastAt: 0 }, 1e12)).toBe('give-up');
  });
});
