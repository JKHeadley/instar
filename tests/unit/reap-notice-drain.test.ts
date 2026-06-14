// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * ReapNoticeDrain (reap-notify spec R1.3) — against a REAL PendingRelayStore:
 * hold release, retries/backoff to the maxAttempts bound, per-pass send cap,
 * terminal escalation into ONE aggregated item, idempotent re-claim, and the
 * origin-scoped single-owner contract with the DFS selector.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';
import { buildReapNotifyDeliveryId } from '../../src/messaging/reap-notice-delivery-id.js';
import { ReapNoticeDrain } from '../../src/monitoring/ReapNoticeDrain.js';

let tmpDir: string;
let store: PendingRelayStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-drain-test-'));
  store = PendingRelayStore.open('echo', tmpDir);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function enqueueNotice(id: string, topicId: number, releaseAtIso?: string | null, text = `notice ${id}`) {
  store.enqueue({
    delivery_id: buildReapNotifyDeliveryId(id),
    topic_id: topicId,
    text_hash: 'h'.repeat(64),
    text,
    next_attempt_at: releaseAtIso ?? null,
  });
}

function makeDrain(over?: {
  sendFails?: (topicId: number) => boolean;
  maxAttempts?: number;
  perPassSendCap?: number;
  backoffBaseMs?: number;
  now?: () => number;
}) {
  const sent: Array<{ topicId: number; text: string }> = [];
  const records: Array<{ noticeId: string; topicId: number | null; outcome: string; detail?: string }> = [];
  const attention: Array<{ id: string; title: string }> = [];
  let nowMs = 2_000_000_000_000;
  const drain = new ReapNoticeDrain(
    {
      store,
      sendToTopic: async (topicId, text) => {
        if (over?.sendFails?.(topicId)) throw new Error('telegram 502');
        sent.push({ topicId, text });
      },
      recordNotify: (e) => { records.push(e); },
      emitAttention: async (item) => { attention.push({ id: item.id, title: item.title }); },
      bootId: 'boot-test',
      now: over?.now ?? (() => nowMs),
    },
    {
      maxAttempts: over?.maxAttempts ?? 8,
      perPassSendCap: over?.perPassSendCap ?? 15,
      backoffBaseMs: over?.backoffBaseMs ?? 30_000,
    },
  );
  return { drain, sent, records, attention, advance: (ms: number) => { nowMs += ms; }, nowAt: () => nowMs };
}

describe('ReapNoticeDrain — delivery + hold release', () => {
  it('delivers a due notice via the direct adapter send and records sent', async () => {
    enqueueNotice('n1', 42);
    const { drain, sent, records } = makeDrain();
    const result = await drain.tick();
    expect(result.sent).toBe(1);
    expect(sent).toEqual([{ topicId: 42, text: 'notice n1' }]);
    expect(records).toEqual([{ noticeId: 'n1', topicId: 42, outcome: 'sent' }]);
    // Terminal state — re-tick is a no-op (idempotent).
    const again = await drain.tick();
    expect(again.sent).toBe(0);
  });

  it('honors the release hold: a held notice is not sent until next_attempt_at passes', async () => {
    const { drain, sent, advance, nowAt } = makeDrain();
    enqueueNotice('held', 7, new Date(nowAt() + 3600_000).toISOString());
    expect((await drain.tick()).sent).toBe(0);
    expect(sent).toHaveLength(0);
    advance(3600_001);
    expect((await drain.tick()).sent).toBe(1);
    expect(sent[0].topicId).toBe(7);
  });

  it('caps sends per pass (the global release throttle, R1.5) and picks up the rest next tick', async () => {
    for (let i = 1; i <= 7; i++) enqueueNotice(`s${i}`, i);
    const { drain, sent } = makeDrain({ perPassSendCap: 3 });
    expect((await drain.tick()).sent).toBe(3);
    expect((await drain.tick()).sent).toBe(3);
    expect((await drain.tick()).sent).toBe(1);
    expect(sent).toHaveLength(7);
  });
});

describe('ReapNoticeDrain — retries, backoff, terminal escalation', () => {
  it('a failed send retries with growing backoff and escalates at maxAttempts with ONE aggregated item', async () => {
    enqueueNotice('flaky', 13);
    const { drain, records, attention, advance } = makeDrain({
      sendFails: () => true,
      maxAttempts: 3,
      backoffBaseMs: 1000,
    });

    // Attempt 2 (row starts at attempts=1): retried with a backoff hold.
    let r = await drain.tick();
    expect(r.retried).toBe(1);
    const row1 = store.findByDeliveryId(buildReapNotifyDeliveryId('flaky'))!;
    expect(row1.state).toBe('queued');
    expect(row1.attempts).toBe(2);
    expect(row1.next_attempt_at).not.toBeNull();

    // Not due yet — nothing happens.
    expect((await drain.tick()).retried).toBe(0);

    // Attempt 3 = maxAttempts → terminal escalation.
    advance(10_000);
    r = await drain.tick();
    expect(r.escalated).toBe(1);
    const row2 = store.findByDeliveryId(buildReapNotifyDeliveryId('flaky'))!;
    expect(row2.state).toBe('escalated');
    expect(records.map((x) => x.outcome)).toEqual(['send-failed-escalated']);
    expect(records[0].detail).toContain('telegram 502');
    expect(attention).toHaveLength(1);
    expect(attention[0].id).toBe('reap-notice-drain:escalations'); // ONE stable id (P17)

    // Escalated is terminal — no further attempts.
    advance(100_000);
    expect((await drain.tick()).retried + (await drain.tick()).escalated).toBe(0);
  });

  it('multiple escalations UPDATE the same aggregated item, never per-row items', async () => {
    enqueueNotice('e1', 1);
    enqueueNotice('e2', 2);
    const { drain, attention, advance } = makeDrain({ sendFails: () => true, maxAttempts: 2, backoffBaseMs: 1 });
    await drain.tick();
    advance(50);
    await drain.tick();
    advance(50);
    await drain.tick();
    const ids = new Set(attention.map((a) => a.id));
    expect(ids.size).toBe(1); // same stable id every time
    expect(attention[attention.length - 1].title).toContain('2'); // rolling count
  });

  it('a mixed pass: one topic failing does not block the other topic from delivering', async () => {
    enqueueNotice('ok', 1);
    enqueueNotice('bad', 2);
    const { drain, sent } = makeDrain({ sendFails: (topicId) => topicId === 2 });
    const r = await drain.tick();
    expect(r.sent).toBe(1);
    expect(r.retried).toBe(1);
    expect(sent[0].topicId).toBe(1);
  });
});

describe('ReapNoticeDrain — single-owner contract with DFS (R1.3)', () => {
  it('the drain never touches non-reap-notify rows; selectClaimable never returns reap-notify rows', async () => {
    enqueueNotice('mine', 1);
    store.enqueue({
      delivery_id: '12121212-1212-4121-8121-121212121212',
      topic_id: 2,
      text_hash: 'x'.repeat(64),
      text: 'a relay row the DFS owns',
      http_code: 503,
      attempted_port: 4042,
    });
    const { drain, sent } = makeDrain();
    await drain.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].topicId).toBe(1); // only the reap-notify row
    const dfsRow = store.findByDeliveryId('12121212-1212-4121-8121-121212121212')!;
    expect(dfsRow.state).toBe('queued'); // untouched by the drain
    // And the DFS-side selector cannot even see the drain's lane.
    const dfsView = store.selectClaimable(new Date().toISOString());
    expect(dfsView.map((r) => r.delivery_id)).toEqual(['12121212-1212-4121-8121-121212121212']);
  });

  it('a stale lease from a PRIOR boot is reclaimed; a fresh lease from THIS boot is not double-claimed', async () => {
    enqueueNotice('n1', 1);
    const id = buildReapNotifyDeliveryId('n1');
    // Simulate a prior boot's claim.
    store.claimCas(id, 'old-boot:99:2020-01-01T00:00:00.000Z', { state: 'queued', claimed_by: null });
    const { drain, sent } = makeDrain();
    expect((await drain.tick()).sent).toBe(1); // reclaimed (bootId mismatch ⇒ stale)
    expect(sent).toHaveLength(1);
  });

  it('a fresh lease held by THIS boot is left alone until it expires', async () => {
    enqueueNotice('n2', 1);
    const id = buildReapNotifyDeliveryId('n2');
    const { drain, sent, nowAt, advance } = makeDrain();
    const leaseUntil = new Date(nowAt() + 60_000).toISOString();
    store.claimCas(id, `boot-test:${process.pid}:${leaseUntil}`, { state: 'queued', claimed_by: null });
    expect((await drain.tick()).sent).toBe(0); // live lease — not stolen
    advance(61_000);
    expect((await drain.tick()).sent).toBe(1); // lease expired — reclaimed
    expect(sent).toHaveLength(1);
  });
});

describe('ReapNoticeDrain — bounded terminal cleanup (P19)', () => {
  it('removes old terminal rows from the reap-notify lane only', async () => {
    enqueueNotice('done', 1);
    // Real clock so the tick's own hourly cleanup doesn't see fresh rows as old.
    const { drain } = makeDrain({ now: () => Date.now() });
    await drain.tick(); // delivers → terminal
    // Age the row far past retention.
    store.rawDb()
      .prepare("UPDATE entries SET attempted_at = '2020-01-01T00:00:00.000Z' WHERE delivery_id = ?")
      .run(buildReapNotifyDeliveryId('done'));
    const purged = store.purgeTerminalReapNotices(new Date().toISOString());
    expect(purged).toBe(1);
    expect(store.count()).toBe(0);
  });

  it('never purges queued/claimed reap-notify rows', async () => {
    enqueueNotice('pending', 1, new Date(Date.now() + 3600_000).toISOString());
    store.rawDb()
      .prepare("UPDATE entries SET attempted_at = '2020-01-01T00:00:00.000Z'")
      .run();
    expect(store.purgeTerminalReapNotices(new Date().toISOString())).toBe(0);
    expect(store.count()).toBe(1);
  });
});
