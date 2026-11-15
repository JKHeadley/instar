/**
 * docs/specs/mobile-pairing-outcome-notice.md §3.4: the protected `pairing-outcome` category.
 * Delivered when anchored (even with no inbound rows: the restart case), recorded otherwise,
 * never configurable, never redirected to a push destination. `recentOperatorInbound` reads only
 * operator rows inside the window.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotificationSelectivityGate, type SelectivityConfig } from '../../src/messaging/NotificationSelectivityGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CONVERSATION_CATEGORIES, PROTECTED_DELIVERY_CATEGORIES, categoryForProducer } from '../../src/messaging/notificationCategories.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

function gate(now: () => number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-cat-'));
  const config: SelectivityConfig = { enabled: true, dryRun: false };
  const g = new NotificationSelectivityGate(root, 'machine-a', () => config, now);
  cleanup.push(async () => { await g.close(); SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/notification-pairing-outcome-category.test.ts' }); });
  return g;
}

describe('pairing-outcome category', () => {
  it('is protected but is not a conversation category, and no producer maps to it', () => {
    expect(PROTECTED_DELIVERY_CATEGORIES.has('pairing-outcome')).toBe(true);
    expect(CONVERSATION_CATEGORIES.has('pairing-outcome')).toBe(false);
    for (const c of CONVERSATION_CATEGORIES) expect(PROTECTED_DELIVERY_CATEGORIES.has(c)).toBe(true);
    expect(categoryForProducer('mobile-pairing-outcome')).toBe('uncategorized');
  });

  it('delivers an anchored line even with no inbound rows (after a restart), records an unanchored one', () => {
    const g = gate(() => 1_000_000);
    const anchored = g.decide(42, { origin: 'automated', category: 'pairing-outcome', sourceContext: 'mobile-pairing-outcome', inboundMessageId: '555' } as never);
    expect(anchored.decision).toBe('deliver');
    const bare = g.decide(42, { origin: 'automated', category: 'pairing-outcome', sourceContext: 'mobile-pairing-outcome' } as never);
    expect(bare.decision).toBe('record');
  });

  it('is never redirected to a push destination and is not configurable', () => {
    const g = gate(() => 1_000_000);
    g.pushDestination = () => ({ chatId: 'c', topicId: 1 });
    expect(g.destination({ origin: 'automated', category: 'pairing-outcome', sourceContext: 'x', inboundMessageId: '5' } as never, 42)).toBeNull();
    const status = g.status() as { categories: Array<{ id: string; configurable: boolean }> };
    expect(status.categories.find((c) => c.id === 'pairing-outcome')?.configurable).toBe(false);
  });

  it('recentOperatorInbound returns the latest operator message inside the window only', () => {
    let t = 10_000_000;
    const g = gate(() => t);
    g.observeInbound(42, 100, true, t - 20 * 60_000);
    expect(g.recentOperatorInbound(42, 15 * 60_000)).toBeNull();
    g.observeInbound(42, 101, true, t - 60_000);
    g.observeInbound(42, 102, false, t - 30_000);
    expect(g.recentOperatorInbound(42, 15 * 60_000)).toBe('101');
    expect(g.recentOperatorInbound(7, 15 * 60_000)).toBeNull();
    t += 20 * 60_000;
    expect(g.recentOperatorInbound(42, 15 * 60_000)).toBeNull();
  });
});
