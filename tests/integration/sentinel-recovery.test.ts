/**
 * Integration test — sentinel recovery happy path.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3d, § 3e.
 *
 * Drives the full DeliveryFailureSentinel state machine against a real
 * PendingRelayStore (SQLite on disk). The HTTP transport (postReply,
 * /whoami fetcher) is stubbed because spinning two real Telegram-
 * connected AgentServers in CI exceeds reasonable test runtime — the
 * stubs are intentionally narrow and capture the same wire shape the
 * real path would exercise.
 *
 * What this test verifies (the bug-fix evidence bar from spec §6):
 *   1. A 503 enqueue → /whoami → POST /telegram/reply with delivery-id → 200.
 *   2. Row finalizes as `delivered-recovered`.
 *   3. Recovered marker fires ~2s later as a follow-up.
 *   4. `X-Instar-DeliveryId` is propagated on the recovery POST.
 *   5. `X-Instar-System: true` is set on the recovered marker (system template).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';
import { DeliveryFailureSentinel } from '../../src/monitoring/delivery-failure-sentinel.js';
import { WhoamiCache } from '../../src/messaging/whoami-cache.js';
import { getOrCreateBootId, _resetCacheForTest } from '../../src/server/boot-id.js';

let stateDir: string;
let configPath: string;

beforeEach(() => {
  _resetCacheForTest();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-recovery-'));
  configPath = path.join(stateDir, 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ port: 4042, projectName: 'echo' }));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/sentinel-recovery.test.ts:cleanup' });
});

describe('DeliveryFailureSentinel — recovery happy path', () => {
  it('two stale drain reads of one delivery_id produce exactly one recovery POST', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const id = '01010101-0101-4101-8101-010101010101';
    store.enqueue({ delivery_id: id, topic_id: 6, text_hash: 'f'.repeat(64), text: Buffer.from('once'), http_code: 503, attempted_port: 4042 });
    const stale = store.findByDeliveryId(id)!;
    const postReply = vi.fn(async () => ({ status: 200, body: '{"ok":true}' }));
    const sentinel = new DeliveryFailureSentinel({
      store, configPath, readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
      bootId: getOrCreateBootId(stateDir, '0.28.0'), toneGate: null, postReply,
      whoamiCache: new WhoamiCache({ fetchFn: async () => ({ agentId: 'echo', port: 4042 }) }),
    });
    const process = (sentinel as unknown as { processRow: (row: typeof stale) => Promise<string> }).processRow.bind(sentinel);
    const outcomes = await Promise.all([process(stale), process(stale)]);
    expect(outcomes.sort()).toEqual(['recovered', 'retry']);
    expect(postReply).toHaveBeenCalledTimes(1);
    store.close();
  });

  it('renews the lease during a blocked send so a second boot cannot double-POST', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const id = '02020202-0202-4202-8202-020202020202';
    store.enqueue({ delivery_id: id, topic_id: 16, text_hash: '1'.repeat(64), text: 'blocked', http_code: 503, attempted_port: 4042 });
    let now = 1_000;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const postReply = vi.fn(async () => { await blocked; return { status: 200, body: '{}' }; });
    const deps = {
      store, configPath, readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
      toneGate: null, postReply, now: () => now,
      whoamiCache: new WhoamiCache({ fetchFn: async () => ({ agentId: 'echo', port: 4042 }) }),
    };
    const first = new DeliveryFailureSentinel({ ...deps, bootId: 'boot-one' }, { leaseDurationMs: 60 });
    const second = new DeliveryFailureSentinel({ ...deps, bootId: 'boot-two' }, { leaseDurationMs: 60 });
    const original = store.findByDeliveryId(id)!;
    const firstRun = (first as any).processRow(original) as Promise<string>;
    await vi.waitFor(() => expect(postReply).toHaveBeenCalledTimes(1));
    now = 10_000;
    await new Promise((resolve) => setTimeout(resolve, 35));
    const claimable = (second as any).selectClaimable() as unknown[];
    expect(claimable).toHaveLength(0);
    expect(postReply).toHaveBeenCalledTimes(1);
    release();
    expect(await firstRun).toBe('recovered');
    store.close();
  });

  it('a stale owner cannot finalize after its exact claim token is replaced', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const id = '03030303-0303-4303-8303-030303030303';
    store.enqueue({ delivery_id: id, topic_id: 17, text_hash: '2'.repeat(64), text: 'fenced', http_code: 503, attempted_port: 4042 });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const postReply = vi.fn(async () => { await blocked; return { status: 200, body: '{}' }; });
    const sentinel = new DeliveryFailureSentinel({
      store, configPath, readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
      bootId: 'old-owner', toneGate: null, postReply,
      whoamiCache: new WhoamiCache({ fetchFn: async () => ({ agentId: 'echo', port: 4042 }) }),
    }, { leaseDurationMs: 10_000 });
    const run = (sentinel as any).processRow(store.findByDeliveryId(id)!) as Promise<string>;
    await vi.waitFor(() => expect(postReply).toHaveBeenCalledTimes(1));
    const owned = store.findByDeliveryId(id)!;
    expect(store.claimCas(id, 'new-owner:999:2099-01-01T00:00:00.000Z', {
      state: 'claimed', claimed_by: owned.claimed_by,
    })).toBe(true);
    release();
    expect(await run).toBe('retry');
    const final = store.findByDeliveryId(id)!;
    expect(final.state).toBe('claimed');
    expect(final.claimed_by).toContain('new-owner');
    store.close();
  });

  it('queued 503 → recovery → delivered-recovered + recovered marker follow-up', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const id = '11111111-1111-4111-8111-111111111111';
    store.enqueue({
      delivery_id: id,
      topic_id: 7,
      text_hash: 'a'.repeat(64),
      text: Buffer.from('hello user', 'utf-8'),
      http_code: 503,
      attempted_port: 4042,
    });

    const calls: Array<{ topicId: number; deliveryId: string; isSystem: boolean; text: string }> = [];
    const postReply = vi.fn(async (
      _port: number,
      _token: string,
      _agentId: string,
      topicId: number,
      text: string,
      deliveryId: string,
      isSystem = false,
    ) => {
      calls.push({ topicId, deliveryId, isSystem, text });
      return { status: 200, body: '{"ok":true}' };
    });

    const whoamiCache = new WhoamiCache({
      fetchFn: async () => ({ agentId: 'echo', port: 4042 }),
    });

    const bootId = getOrCreateBootId(stateDir, '0.28.0');
    const sentinel = new DeliveryFailureSentinel({
      store,
      configPath,
      readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
      bootId,
      toneGate: null,
      postReply,
      whoamiCache,
    });

    // start() now performs the FIRST drain itself (startup tick — the
    // restart-cascade fix: short up-windows must not wait out the 5-min
    // watchdog interval). The pre-existing queued row is recovered by
    // start(); a subsequent explicit tick finds nothing left.
    await sentinel.start();
    const row = store.findByDeliveryId(id);
    expect(row?.state).toBe('delivered-recovered');

    const counters = await sentinel.tick();
    expect(counters.recovered).toBe(0); // backlog already drained by start()

    // First call is the recovery POST.
    const first = calls[0];
    expect(first.topicId).toBe(7);
    expect(first.deliveryId).toBe(id);
    expect(first.isSystem).toBe(false);
    expect(first.text).toBe('hello user');

    // The recovered-marker fires ~2s later. We don't want to wait that
    // long in a test, so we verify the call was scheduled by waiting
    // briefly past 2s.
    await new Promise((r) => setTimeout(r, 2200));
    const marker = calls.find((c) => c.isSystem);
    expect(marker).toBeDefined();
    expect(marker!.text).toContain(id.slice(0, 8));

    await sentinel.stop();
    store.close();
  }, 10_000);

  it('agent_id mismatch → retry, queued state preserved', async () => {
    const store = PendingRelayStore.open('echo', stateDir);
    const id = '22222222-2222-4222-8222-222222222222';
    store.enqueue({
      delivery_id: id,
      topic_id: 8,
      text_hash: 'b'.repeat(64),
      text: Buffer.from('hello again', 'utf-8'),
      http_code: 503,
      attempted_port: 4042,
    });

    // /whoami returns a different agentId than config.
    const whoamiCache = new WhoamiCache({
      fetchFn: async () => ({ agentId: 'wrong-agent', port: 4042 }),
    });
    const postReply = vi.fn();

    const bootId = getOrCreateBootId(stateDir, '0.28.0');
    const sentinel = new DeliveryFailureSentinel({
      store,
      configPath,
      readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
      bootId,
      toneGate: null,
      postReply,
      whoamiCache,
    });

    await sentinel.start();
    await sentinel.tick();
    expect(postReply).not.toHaveBeenCalled();
    const row = store.findByDeliveryId(id);
    expect(row?.state).toBe('queued');
    expect(row?.next_attempt_at).toBeTruthy();
    expect(row?.attempts).toBe(2); // attempts incremented on retry decision

    await sentinel.stop();
    store.close();
  });

  it('start() drains a pre-existing backlog immediately (restart-cascade survival — no 5-min wait)', async () => {
    // Live failure shape (2026-06-05 ~15:40-16:50Z): a restart cascade gave
    // up-windows shorter than boot-time + the 5-min watchdog interval, so
    // five queued user messages survived FOUR up-windows undelivered while
    // fresh sends in the same windows succeeded. The contract pinned here:
    // start() itself performs the first drain — a booted sentinel means a
    // drained backlog, with no dependency on the watchdog timer firing.
    const store = PendingRelayStore.open('echo', stateDir);
    const ids = [
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    // Distinct topics — the sentinel's per-topic rate limit (30s) is its own
    // tested behavior; this test pins the START-TIME drain, not pacing.
    ids.forEach((id, i) => {
      store.enqueue({
        delivery_id: id,
        topic_id: 9 + i,
        text_hash: id[0].repeat(64),
        text: Buffer.from(`backlog ${id.slice(0, 8)}`, 'utf-8'),
        http_code: 0, // connection-refused class — the cascade signature
        attempted_port: 4042,
      });
    });

    const postReply = vi.fn(async () => ({ status: 200, body: '{"ok":true}' }));
    const whoamiCache = new WhoamiCache({
      fetchFn: async () => ({ agentId: 'echo', port: 4042 }),
    });
    const bootId = getOrCreateBootId(stateDir, '0.28.0');
    const sentinel = new DeliveryFailureSentinel({
      store,
      configPath,
      readConfig: () => ({ port: 4042, authToken: 'tok', agentId: 'echo' }),
      bootId,
      toneGate: null,
      postReply,
      whoamiCache,
    });

    // No explicit tick. start() alone must deliver the backlog.
    await sentinel.start();
    for (const id of ids) {
      expect(store.findByDeliveryId(id)?.state).toBe('delivered-recovered');
    }
    expect(postReply.mock.calls.length).toBeGreaterThanOrEqual(2);

    await sentinel.stop();
    store.close();
  }, 10_000);
});
