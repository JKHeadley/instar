// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup (mkdtempSync under os.tmpdir), not production destructive fs.
/**
 * RemoteAckStore — durable queue for operator-bound attention acks targeting an
 * item owned by another machine (WS4.1 follow-up, CMT-1416). Tests the durable
 * lifecycle in isolation with a real filesystem:
 *   - enqueue persists intent and is idempotent on (itemId, targetMachineId);
 *   - recordAttempt increments + persists;
 *   - resolve removes and survives a reload (tombstone);
 *   - a reload reconstructs exactly the live set (the boot-sweep guarantee);
 *   - a torn last line is skipped, the rest still loads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteAckStore } from '../../src/core/RemoteAckStore.js';

describe('RemoteAckStore (WS4.1 durable remote-ack)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-remote-ack-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const intent = (over: Partial<Parameters<RemoteAckStore['enqueue']>[0]> = {}) => ({
    itemId: 'att-1',
    targetMachineId: 'm_owner',
    status: 'DONE',
    operatorUid: 'tg:42',
    operatorDisplayName: 'Justin',
    ...over,
  });

  it('enqueue persists the intent with the operator principal', () => {
    const store = new RemoteAckStore(stateDir);
    const e = store.enqueue(intent());
    expect(e.itemId).toBe('att-1');
    expect(e.operatorUid).toBe('tg:42');
    expect(e.attempts).toBe(0);
    expect(e.lastOutcome).toBe('pending');
    expect(store.size).toBe(1);
  });

  it('enqueue is idempotent on (itemId, targetMachineId) — re-ack refreshes, never stacks', () => {
    const store = new RemoteAckStore(stateDir);
    store.enqueue(intent({ status: 'ACKNOWLEDGED' }));
    store.recordAttempt('att-1', 'm_owner', 'unreachable');
    store.enqueue(intent({ status: 'DONE' })); // operator changed their mind
    expect(store.size).toBe(1);
    const live = store.list()[0];
    expect(live.status).toBe('DONE');
    expect(live.attempts).toBe(0); // reset on re-enqueue
  });

  it('the SAME item targeting DIFFERENT machines are distinct rows', () => {
    const store = new RemoteAckStore(stateDir);
    store.enqueue(intent({ targetMachineId: 'm_a' }));
    store.enqueue(intent({ targetMachineId: 'm_b' }));
    expect(store.size).toBe(2);
  });

  it('recordAttempt increments attempts and persists across reload', () => {
    const store = new RemoteAckStore(stateDir);
    store.enqueue(intent());
    store.recordAttempt('att-1', 'm_owner', 'unreachable');
    store.recordAttempt('att-1', 'm_owner', 'unreachable');
    const reloaded = new RemoteAckStore(stateDir);
    expect(reloaded.list()[0].attempts).toBe(2);
    expect(reloaded.list()[0].lastOutcome).toBe('unreachable');
  });

  it('resolve removes the intent and the removal survives a reload (boot-sweep guarantee)', () => {
    const store = new RemoteAckStore(stateDir);
    store.enqueue(intent());
    store.resolve('att-1', 'm_owner');
    expect(store.size).toBe(0);
    const reloaded = new RemoteAckStore(stateDir);
    expect(reloaded.size).toBe(0); // tombstone honored on reload
  });

  it('a reload reconstructs exactly the live pending set', () => {
    const a = new RemoteAckStore(stateDir);
    a.enqueue(intent({ itemId: 'i1' }));
    a.enqueue(intent({ itemId: 'i2' }));
    a.enqueue(intent({ itemId: 'i3' }));
    a.resolve('i2', 'm_owner');
    const b = new RemoteAckStore(stateDir);
    expect(b.list().map((e) => e.itemId).sort()).toEqual(['i1', 'i3']);
  });

  it('listForMachine filters to one target', () => {
    const store = new RemoteAckStore(stateDir);
    store.enqueue(intent({ itemId: 'i1', targetMachineId: 'm_a' }));
    store.enqueue(intent({ itemId: 'i2', targetMachineId: 'm_b' }));
    expect(store.listForMachine('m_a').map((e) => e.itemId)).toEqual(['i1']);
  });

  it('a torn final line (crash mid-append) is skipped; the rest loads', () => {
    const store = new RemoteAckStore(stateDir);
    store.enqueue(intent({ itemId: 'good' }));
    const file = path.join(stateDir, '..', 'logs', 'remote-ack-queue.jsonl');
    fs.appendFileSync(file, '{"itemId":"torn","targetMachineId":'); // truncated JSON
    const reloaded = new RemoteAckStore(stateDir);
    expect(reloaded.list().map((e) => e.itemId)).toEqual(['good']);
  });
});
