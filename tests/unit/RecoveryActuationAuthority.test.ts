import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RecoveryActuationAuthority, type RecoveryAuthoritySnapshot } from '../../src/core/RecoveryActuationAuthority.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const safe: RecoveryAuthoritySnapshot = {
  operatorStopEpoch: 1, observedOperatorStopEpoch: 1,
  ownerEpoch: 7, observedOwnerEpoch: 7,
  latestOrdinal: 3, deliveryOrdinal: 3,
  sessionActive: false, incarnation: 'i1', observedIncarnation: 'i1',
  deliveryExhausted: true, breakerOpen: false,
};

describe('RecoveryActuationAuthority', () => {
  it.each([
    [{ operatorStopEpoch: 2 }, 'operator-stopped'],
    [{ ownerEpoch: 8 }, 'owner-changed'],
    [{ latestOrdinal: 4 }, 'newer-delivery'],
    [{ sessionActive: true }, 'session-active'],
    [{ incarnation: 'i2' }, 'incarnation-changed'],
    [{ deliveryExhausted: false }, 'delivery-not-exhausted'],
    [{ breakerOpen: true }, 'breaker-open'],
  ] as const)('refuses unsafe snapshot %j', (delta, reason) => {
    const result = new RecoveryActuationAuthority().authorize({ ...safe, ...delta, conversationId: 'c', deliveryId: 'd' });
    expect(result).toEqual({ ok: false, reason });
  });

  it('mints a bounded single-use capability only for the complete safe snapshot', () => {
    const authority = new RecoveryActuationAuthority();
    const result = authority.authorize({ ...safe, conversationId: 'c', deliveryId: 'd', now: 100, ttlMs: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(authority.consume(result.capability.id, 149).ok).toBe(true);
    expect(authority.consume(result.capability.id, 149)).toEqual({ ok: false, reason: 'capability-consumed' });
  });

  it('refuses an expired capability', () => {
    const authority = new RecoveryActuationAuthority();
    const result = authority.authorize({ ...safe, conversationId: 'c', deliveryId: 'd', now: 100, ttlMs: 50 });
    if (!result.ok) throw new Error('unexpected denial');
    expect(authority.consume(result.capability.id, 150)).toEqual({ ok: false, reason: 'capability-expired' });
  });

  it('persists single-use consumption across authority restarts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-recovery-authority-'));
    let first: RecoveryActuationAuthority | null = null;
    let second: RecoveryActuationAuthority | null = null;
    try {
      first = RecoveryActuationAuthority.open(dir);
      const minted = first.authorize({ ...safe, conversationId: 'c', deliveryId: 'd', now: 100, ttlMs: 100 });
      if (!minted.ok) throw new Error('unexpected denial');
      first.close(); first = null;
      second = RecoveryActuationAuthority.open(dir);
      expect(second.consume(minted.capability.id, 150).ok).toBe(true);
      second.close(); second = null;
      const third = RecoveryActuationAuthority.open(dir);
      expect(third.consume(minted.capability.id, 151)).toEqual({ ok: false, reason: 'capability-consumed' });
      expect(third.status(151)).toMatchObject({ consumed: 1, durable: true });
      third.close();
    } finally {
      first?.close(); second?.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'unit-test-cleanup' });
    }
  });

  it('journals the external request effectively once across restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-recovery-effect-'));
    try {
      const first = RecoveryActuationAuthority.open(dir);
      const minted = first.authorize({ ...safe, conversationId: 'c', deliveryId: 'd', now: 100, ttlMs: 100 });
      if (!minted.ok) throw new Error('unexpected denial');
      let calls = 0;
      expect(first.publish(minted.capability.id, () => { calls++; return true; }, 110)).toEqual({ ok: true, requested: true });
      first.close();
      const second = RecoveryActuationAuthority.open(dir);
      expect(second.authorize({ ...safe, conversationId: 'c', deliveryId: 'd', now: 120, ttlMs: 100 }))
        .toEqual({ ok: false, reason: 'recovery-already-recorded' });
      expect(calls).toBe(1);
      expect(second.status(120).recoveryEffects).toEqual({ requested: 1 });
      second.close();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'unit-test-cleanup' });
    }
  });

  it('turns an ambiguous publication crash into durable effect-unknown and never reauthorizes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-recovery-unknown-'));
    try {
      const first = RecoveryActuationAuthority.open(dir);
      const minted = first.authorize({ ...safe, conversationId: 'c', deliveryId: 'd', now: 100, ttlMs: 100 });
      if (!minted.ok) throw new Error('unexpected denial');
      expect(first.publish(minted.capability.id, () => { throw new Error('crash after write may have landed'); }, 110))
        .toEqual({ ok: false, reason: 'effect-unknown' });
      first.close();
      const second = RecoveryActuationAuthority.open(dir);
      expect(second.authorize({ ...safe, conversationId: 'c', deliveryId: 'd', now: 120, ttlMs: 100 }))
        .toEqual({ ok: false, reason: 'recovery-already-recorded' });
      expect(second.status(120).recoveryEffects).toEqual({ 'effect-unknown': 1 });
      second.close();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'unit-test-cleanup' });
    }
  });

  it('boot-reconciles a real-crash publish-started row to effect-unknown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-recovery-crash-'));
    try {
      const first = RecoveryActuationAuthority.open(dir);
      const minted = first.authorize({ ...safe, conversationId: 'c', deliveryId: 'd', now: 100, ttlMs: 100 });
      if (!minted.ok) throw new Error('unexpected denial');
      first.close();
      const db = new Database(path.join(dir, 'state', 'recovery-actuation.sqlite'));
      db.prepare(`INSERT INTO recovery_effect
        (conversation_id, delivery_id, effect_type, capability_id, phase, created_at, updated_at)
        VALUES ('c','d','session-recovery',?,'publish-started',110,110)`).run(minted.capability.id);
      db.prepare('UPDATE recovery_capability SET consumed = 1 WHERE id = ?').run(minted.capability.id);
      db.close();
      const recovered = RecoveryActuationAuthority.open(dir);
      expect(recovered.status(120).recoveryEffects).toEqual({ 'effect-unknown': 1 });
      expect(recovered.authorize({ ...safe, conversationId: 'c', deliveryId: 'd', now: 120, ttlMs: 100 }))
        .toEqual({ ok: false, reason: 'recovery-already-recorded' });
      recovered.close();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'unit-test-cleanup' });
    }
  });
});
