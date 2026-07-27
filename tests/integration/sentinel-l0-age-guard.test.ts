/**
 * Integration test — L0 zombie-free delivery invariant (dequeue-time age guard).
 *
 * Spec: drive12 UX-first enforcement (L0), Increment 1. Regression class:
 * 2026-07-24 zombie-replay — weeks-old queued replies (including expired
 * secure links) auto-delivered as new the moment the recovery drain was
 * fixed. The invariant: a row older than the class policy can NEVER reach
 * processRow, no matter how it became claimable.
 *
 * Drives the real DeliveryFailureSentinel tick against a real
 * PendingRelayStore (SQLite on disk), postReply stubbed. Covers BOTH sides
 * of the decision boundary and both rollback levers (flag off / maxAge 0).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';
import { DeliveryFailureSentinel } from '../../src/monitoring/delivery-failure-sentinel.js';
import { WhoamiCache } from '../../src/messaging/whoami-cache.js';
import { getOrCreateBootId, _resetCacheForTest } from '../../src/server/boot-id.js';

let stateDir: string;
let configPath: string;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  _resetCacheForTest();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-l0-age-'));
  configPath = path.join(stateDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 4042, projectName: 'echo' }));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, {
    recursive: true,
    force: true,
    operation: 'tests/integration/sentinel-l0-age-guard.test.ts:cleanup',
  });
});

function mkSentinel(
  store: PendingRelayStore,
  postReply: ReturnType<typeof vi.fn>,
  l0AgeGuard?: { enabled?: boolean; maxAgeMs?: number },
) {
  const sentinel = new DeliveryFailureSentinel(
    {
      store,
      configPath,
      readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
      bootId: getOrCreateBootId(stateDir, '0.28.0'),
      toneGate: null,
      postReply: postReply as never,
      whoamiCache: new WhoamiCache({ fetchFn: async () => ({ agentId: 'echo', port: 4042 }) }),
    },
    l0AgeGuard ? { l0AgeGuard } : {},
  );
  // Drive tick() without start(): start()'s one-shot restore-purge would
  // delete the aged fixtures at boot and mask the DRAIN-TIME invariant this
  // suite exists to prove (the guard must hold for rows that become
  // claimable long after startup — the 2026-07-24 zombie class).
  (sentinel as unknown as { running: boolean }).running = true;
  return sentinel;
}

function enqueueAged(store: PendingRelayStore, id: string, topicId: number, ageMs: number, text: string) {
  store.enqueue({
    delivery_id: id,
    topic_id: topicId,
    text_hash: 'a'.repeat(64),
    text: Buffer.from(text),
    http_code: 503,
    attempted_port: 4042,
    attempted_at: new Date(Date.now() - ageMs).toISOString(),
  });
}

describe('DeliveryFailureSentinel — L0 dequeue-time age guard', () => {
  it('a row older than policy retires to dead-letter and is NEVER delivered; a fresh row still delivers', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const staleId = '11111111-1111-4111-8111-111111111111';
    const freshId = '22222222-2222-4222-8222-222222222222';
    enqueueAged(store, staleId, 6, 40 * DAY_MS, 'weeks-old zombie');
    enqueueAged(store, freshId, 7, 60 * 1000, 'fresh reply');

    const postReply = vi.fn(async () => ({ status: 200, body: '{"ok":true}' }));
    const sentinel = mkSentinel(store, postReply, { enabled: true, maxAgeMs: DAY_MS });

    await sentinel.tick();

    // The stale row never reached delivery.
    const deliveredIds = postReply.mock.calls.map((c) => c[5]);
    expect(deliveredIds).not.toContain(staleId);
    // It retired as an audited dead-letter with the expired-stale reason.
    const staleRow = store.findByDeliveryId(staleId)!;
    expect(staleRow.state).toBe('dead-letter');
    expect(staleRow.error_body).toMatch(/expired-stale/);
    expect(staleRow.status_history).toMatch(/dead-letter/);
    // The fresh row was processed normally on the same pass.
    expect(deliveredIds).toContain(freshId);
  });

  it('flag OFF (default) preserves today\'s behavior byte-identical — the old row is still claimable', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const staleId = '33333333-3333-4333-8333-333333333333';
    enqueueAged(store, staleId, 8, 40 * DAY_MS, 'old but guard dark');

    const postReply = vi.fn(async () => ({ status: 200, body: '{"ok":true}' }));
    const sentinel = mkSentinel(store, postReply); // no l0AgeGuard config at all

    await sentinel.tick();

    const row = store.findByDeliveryId(staleId)!;
    expect(row.state).not.toBe('dead-letter');
  });

  it('maxAgeMs 0 ⇒ no expiry even when enabled (the data-edit rollback sentinel)', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const staleId = '44444444-4444-4444-8444-444444444444';
    enqueueAged(store, staleId, 9, 40 * DAY_MS, 'old, zero-policy class');

    const postReply = vi.fn(async () => ({ status: 200, body: '{"ok":true}' }));
    const sentinel = mkSentinel(store, postReply, { enabled: true, maxAgeMs: 0 });

    await sentinel.tick();

    const row = store.findByDeliveryId(staleId)!;
    expect(row.state).not.toBe('dead-letter');
  });

  it('emits ONE aggregated stale-retired event per pass (never per-message)', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    for (let i = 0; i < 4; i++) {
      enqueueAged(store, `55555555-5555-4555-8555-55555555555${i}`, 100 + i, 40 * DAY_MS, `zombie ${i}`);
    }
    const postReply = vi.fn(async () => ({ status: 200, body: '{"ok":true}' }));
    const sentinel = mkSentinel(store, postReply, { enabled: true, maxAgeMs: DAY_MS });
    const events: Array<{ count: number }> = [];
    sentinel.on('sentinel:stale-retired', (e) => events.push(e));

    await sentinel.tick();

    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(4);
    expect(postReply).not.toHaveBeenCalled();
  });
});
