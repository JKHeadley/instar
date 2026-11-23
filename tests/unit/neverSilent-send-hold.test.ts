// lease-freshness-lapse-retry — send holds are a count beside the never-silent incidents, never an incident.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NeverSilentStore } from '../../src/monitoring/neverSilent/NeverSilentStore.js';

function harness() {
  let t = 1_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-send-hold-'));
  const store = new NeverSilentStore(dir, () => t);
  return { store, dir, advance: (ms: number) => { t += ms; }, now: () => t };
}

describe('never-silent send holds', () => {
  it('opens a row that is not an incident, idempotent on the operation id', () => {
    const h = harness();
    const row = h.store.recordSendHold('telegram', '42', { operationId: 'op-1', reason: 'lease-freshness-lapsed', heldAt: h.now(), deadlineAt: h.now() + 60_000 });
    expect(row).toMatchObject({ platform: 'telegram', conversationKey: '42', operationId: 'op-1', reason: 'lease-freshness-lapsed' });
    expect(h.store.recordSendHold('telegram', '42', { operationId: 'op-1', reason: 'lease-freshness-lapsed', heldAt: h.now() + 5, deadlineAt: h.now() + 60_000 })).toBe(row);
    expect(h.store.openIncident('telegram', '42')).toBeNull();
    const snap = h.store.snapshot();
    expect(snap.incidents).toHaveLength(0);
    expect(snap.sendHolds).toHaveLength(1);
    expect(h.store.openSendHolds()).toHaveLength(1);
  });
  it('closes with the delivery time by durable operation id and ignores unknown ids without a write', () => {
    const h = harness();
    h.store.recordSendHold('telegram', '42', { operationId: 'op-1', reason: 'lease-not-held-at-send', heldAt: h.now(), deadlineAt: h.now() + 60_000 });
    const file = path.join(h.dir, 'state', 'never-silent.json');
    const before = fs.statSync(file).mtimeMs;
    expect(h.store.recordSendHoldDelivered('op-unknown', h.now() + 10)).toBeNull();
    expect(fs.statSync(file).mtimeMs).toBe(before);
    h.advance(2_300);
    const closed = h.store.recordSendHoldDelivered('op-1', h.now());
    expect(closed).toMatchObject({ operationId: 'op-1', deliveredAt: h.now(), closedAt: h.now(), closedReason: 'delivered-after-hold' });
    expect(closed!.deliveredAt! - closed!.heldAt).toBe(2_300);
    expect(h.store.openSendHolds()).toHaveLength(0);
    expect(h.store.recordSendHoldDelivered('op-1', h.now() + 1)).toBeNull();
  });
  it('closes an undelivered hold past its deadline as unobserved, at a write and at a read', () => {
    const h = harness();
    h.store.recordSendHold('telegram', '42', { operationId: 'op-1', reason: 'lease-freshness-lapsed', heldAt: h.now(), deadlineAt: h.now() + 1_000 });
    h.store.recordSendHold('telegram', '43', { operationId: 'op-2', reason: 'lease-freshness-lapsed', heldAt: h.now(), deadlineAt: h.now() + 50_000 });
    h.advance(1_001);
    // A read settles it (and persists the close) on a quiet agent.
    const snap = h.store.snapshot();
    expect(snap.sendHolds.find((x) => x.operationId === 'op-1')).toMatchObject({ closedReason: 'hold-unobserved-past-deadline', closedAt: h.now() });
    expect(snap.sendHolds.find((x) => x.operationId === 'op-2')!.closedAt).toBeUndefined();
    const reloaded = new NeverSilentStore(h.dir, h.now);
    expect(reloaded.openSendHolds().map((x) => x.operationId)).toEqual(['op-2']);
    // A write settles it too.
    h.advance(50_000);
    reloaded.recordSendHold('telegram', '44', { operationId: 'op-3', reason: 'lease-freshness-lapsed', heldAt: h.now(), deadlineAt: h.now() + 60_000 });
    expect(reloaded.snapshot().sendHolds.find((x) => x.operationId === 'op-2')).toMatchObject({ closedReason: 'hold-unobserved-past-deadline' });
  });
  it('loads a file written before send holds existed and keeps its own retention cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-send-hold-old-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'never-silent.json'), JSON.stringify({ schema: 'never-silent/1', obligations: [], incidents: [] }));
    let t = 5_000_000;
    const store = new NeverSilentStore(dir, () => t);
    expect(store.snapshot().sendHolds).toEqual([]);
    for (let i = 0; i < 230; i++) {
      store.recordSendHold('telegram', '1', { operationId: `op-${i}`, reason: 'lease-freshness-lapsed', heldAt: t, deadlineAt: t + 60_000 });
      store.recordSendHoldDelivered(`op-${i}`, t + 1); t += 10;
    }
    store.recordSendHold('telegram', '1', { operationId: 'op-open', reason: 'lease-freshness-lapsed', heldAt: t, deadlineAt: t + 60_000 });
    const snap = store.snapshot();
    expect(snap.sendHolds.filter((x) => x.closedAt)).toHaveLength(200);
    expect(snap.sendHolds.filter((x) => !x.closedAt).map((x) => x.operationId)).toEqual(['op-open']);
    expect(snap.incidents).toHaveLength(0);
  });
});
