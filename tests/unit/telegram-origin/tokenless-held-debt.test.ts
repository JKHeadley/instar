/** standby-durable-forward-without-token §9 — peers record "a reply is pending on X" until X reports or is recorded gone. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { PeerHeldDebtStore, StandbyHeldDebtLedger, chainRoot, sanitizeHoldNotice, sanitizeOutcomes } from '../../../src/messaging/telegram-origin/TokenlessHeldDebt.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tokenless-held-debt:test-cleanup' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-debt-')); dirs.push(d); return d; };
const SIX_H = 6 * 60 * 60_000;

describe('PeerHeldDebtStore', () => {
  it('lists an entry only after the deadline, collapsed per origin machine, and never ages it out', () => {
    let now = 10 * SIX_H;
    const store = new PeerHeldDebtStore(tmp(), () => now);
    store.add('m5', { rootOperationId: 'op-a', topicId: '141014', authoredAt: now });
    store.add('m5', { rootOperationId: 'op-b', topicId: '141014', authoredAt: now - 1000 });
    expect(store.overdue(SIX_H)).toEqual([]);
    now += SIX_H + 1;
    expect(store.overdue(SIX_H)).toEqual([expect.objectContaining({ originMachineId: 'm5', count: 2, label: 'pending on m5, outcome unknown' })]);
    now += 100 * SIX_H;
    expect(store.overdue(SIX_H)[0].count).toBe(2);
  });
  it('only the origin machine can close its own entries', () => {
    const store = new PeerHeldDebtStore(tmp(), () => 0);
    store.add('m5', { rootOperationId: 'op-a', topicId: null, authoredAt: -SIX_H * 2 });
    expect(store.close('mini', [{ rootOperationId: 'op-a', outcome: 'delivered' }])).toEqual([]);
    expect(store.overdue(SIX_H)).toHaveLength(1);
    expect(store.close('m5', [{ rootOperationId: 'op-a', outcome: 'delivered' }])).toEqual(['op-a']);
    expect(store.overdue(SIX_H)).toHaveLength(0);
  });
  it('a machine the owner recorded gone closes its entries as real losses', () => {
    const store = new PeerHeldDebtStore(tmp(), () => 0);
    store.add('m5', { rootOperationId: 'op-a', topicId: '1', authoredAt: -SIX_H * 2 });
    store.add('mini', { rootOperationId: 'op-b', topicId: '1', authoredAt: -SIX_H * 2 });
    const loss = vi.fn();
    expect(store.closeGone(id => id === 'm5', loss)).toBe(1);
    expect(loss).toHaveBeenCalledWith(expect.objectContaining({ originMachineId: 'm5', rootOperationId: 'op-a' }));
    expect(store.overdue(SIX_H).map(g => g.originMachineId)).toEqual(['mini']);
  });
});

describe('StandbyHeldDebtLedger', () => {
  it('owes an outcome only to peers that were told, and forgets it per peer on ack', () => {
    const ledger = new StandbyHeldDebtLedger(tmp());
    ledger.notified('op-a', ['studio', 'mini']);
    ledger.resolved('op-a', 'delivered');
    ledger.resolved('op-unknown', 'expired');
    expect(ledger.owed('studio')).toEqual([{ rootOperationId: 'op-a', outcome: 'delivered' }]);
    expect(ledger.peersOwed().sort()).toEqual(['mini', 'studio']);
    ledger.acked('studio', ['op-a']);
    expect(ledger.owed('studio')).toEqual([]);
    expect(ledger.peersOwed()).toEqual(['mini']);
    ledger.acked('mini', ['op-a']);
    expect(ledger.peersOwed()).toEqual([]);
  });
});

describe('ids and sanitizers', () => {
  it('chainRoot strips the supersede suffix', () => {
    expect(chainRoot('op-a~r2-0123abcd')).toBe('op-a');
    expect(chainRoot('op-a')).toBe('op-a');
  });
  it('sanitizers drop malformed input', () => {
    expect(sanitizeHoldNotice({ rootOperationId: 'bad id!', authoredAt: 1 })).toBeNull();
    expect(sanitizeHoldNotice({ rootOperationId: 'op-a', authoredAt: 1, topicId: '9' })).toEqual({ rootOperationId: 'op-a', authoredAt: 1, topicId: '9' });
    expect(sanitizeOutcomes([{ rootOperationId: 'op-a', outcome: 'delivered' }, { rootOperationId: 'op-b', outcome: 'lost?' }])).toHaveLength(1);
  });
});

describe('handleOriginMesh capabilities carries outcome reports and evidence acks (§9, §10)', () => {
  it('closes the sender\'s entries, acks them, and records evidence, without changing the answer', async () => {
    const { handleOriginMesh, ORIGIN_MESH_PROTOCOL } = await import('../../../src/messaging/telegram-origin/OriginMesh.js');
    const { HolderEvidenceRecorder } = await import('../../../src/messaging/telegram-origin/TokenlessForwardEvidence.js');
    const dir = tmp();
    const heldDebt = new PeerHeldDebtStore(dir, () => 0);
    heldDebt.add('m5', { rootOperationId: 'op-a', topicId: '1', authoredAt: -SIX_H * 2 });
    const record = vi.fn();
    const runtime = { options: { identity: { originMachineId: 'studio' }, bot: { token: '1:x', accountId: '1' } } } as never;
    const out = await handleOriginMesh({ runtime, authenticatedSender: 'm5', resolveKey: () => ({}) as never, heldDebt,
      evidence: new HolderEvidenceRecorder(dir, record),
      command: { type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL, action: 'capabilities',
        forwardContext: { tokenless: true, outcomes: [{ rootOperationId: 'op-a', outcome: 'delivered' }], events: [{ id: 'e1', kind: 'not-sent-while-live', at: 1 }] } } }) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, credentialOwner: true, accountId: '1', outcomesAck: ['op-a'], evidenceAck: ['e1'] });
    expect(heldDebt.overdue(SIX_H)).toEqual([]);
    expect(record).toHaveBeenCalledWith('telegram.tokenlessDurableForward', expect.objectContaining({ kind: 'error', reason: 'not-sent-while-live' }));
  });
});
