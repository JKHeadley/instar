// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 tests for StreamTicketStore (Pool Dashboard Streaming phase 2,
 * POOL-DASHBOARD-STREAM-SPEC §2.3 — the auth boundary). Security-critical:
 * single-use, TTL-bounded, machine-bound, and replay-proof ACROSS a restart
 * (the persisted consumed-set). Deterministic clock + counter-based mintId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StreamTicketStore } from '../../src/server/StreamTicketStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
let nowMs: number;
let seq: number;

function makeStore(over: { ttlMs?: number; retentionMs?: number } = {}) {
  return new StreamTicketStore({
    filePath: path.join(dir, 'stream-tickets.json'),
    now: () => nowMs,
    mintId: () => `tkt-${++seq}`,
    ttlMs: over.ttlMs ?? 60_000,
    retentionMs: over.retentionMs,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-ticket-'));
  nowMs = 1_000_000;
  seq = 0;
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/StreamTicketStore.test.ts:cleanup' });
});

describe('StreamTicketStore — mint + consume happy path', () => {
  it('mints a ticket for a machine and consumes it exactly once', () => {
    const s = makeStore();
    const t = s.mint('m_peer');
    expect(t.ticket).toBe('tkt-1');
    expect(t.forMachineId).toBe('m_peer');
    const r1 = s.consume('tkt-1', 'm_peer');
    expect(r1).toEqual({ ok: true, forMachineId: 'm_peer' });
  });

  it('liveCount reflects unconsumed, unexpired tickets', () => {
    const s = makeStore();
    s.mint('m_peer'); s.mint('m_peer');
    expect(s.liveCount()).toBe(2);
    s.consume('tkt-1', 'm_peer');
    expect(s.liveCount()).toBe(1);
  });
});

describe('StreamTicketStore — every rejection mode', () => {
  it('rejects an unknown ticket', () => {
    expect(makeStore().consume('nope', 'm_peer')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a SECOND consume of the same ticket (single-use)', () => {
    const s = makeStore();
    s.mint('m_peer');
    expect(s.consume('tkt-1', 'm_peer').ok).toBe(true);
    expect(s.consume('tkt-1', 'm_peer')).toEqual({ ok: false, reason: 'already-consumed' });
  });

  it('rejects an expired ticket (past TTL)', () => {
    const s = makeStore({ ttlMs: 30_000 });
    s.mint('m_peer');
    nowMs += 30_001;
    expect(s.consume('tkt-1', 'm_peer')).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a ticket presented by a DIFFERENT machine than it was minted for (when identity is proven)', () => {
    const s = makeStore();
    s.mint('m_peerA');
    expect(s.consume('tkt-1', 'm_peerB')).toEqual({ ok: false, reason: 'wrong-machine' });
    // and the legit machine can still use it (the failed attempt did not consume it)
    expect(s.consume('tkt-1', 'm_peerA').ok).toBe(true);
  });

  it('bearer mode: consume with no presentedBy validates the ticket and returns the bound machine', () => {
    const s = makeStore();
    s.mint('m_peerA');
    // The WS upgrade carries only the single-use ticket; identity comes from the
    // mint record, not the upgrade.
    expect(s.consume('tkt-1')).toEqual({ ok: true, forMachineId: 'm_peerA' });
    expect(s.consume('tkt-1')).toEqual({ ok: false, reason: 'already-consumed' });
  });
});

describe('StreamTicketStore — replay-proof across restart (sec#4)', () => {
  it('a consumed ticket stays consumed after a fresh store loads the persisted file', () => {
    const file = path.join(dir, 'stream-tickets.json');
    const s1 = new StreamTicketStore({ filePath: file, now: () => nowMs, mintId: () => 'tkt-X', ttlMs: 60_000 });
    s1.mint('m_peer');
    expect(s1.consume('tkt-X', 'm_peer').ok).toBe(true);
    // "restart": brand-new instance over the SAME file.
    const s2 = new StreamTicketStore({ filePath: file, now: () => nowMs, mintId: () => 'tkt-Y', ttlMs: 60_000 });
    expect(s2.consume('tkt-X', 'm_peer')).toEqual({ ok: false, reason: 'already-consumed' });
  });

  it('an UNconsumed ticket survives a restart and is still usable until its TTL', () => {
    const file = path.join(dir, 'stream-tickets.json');
    const s1 = new StreamTicketStore({ filePath: file, now: () => nowMs, mintId: () => 'tkt-Z', ttlMs: 60_000 });
    s1.mint('m_peer');
    const s2 = new StreamTicketStore({ filePath: file, now: () => nowMs, mintId: () => 'q', ttlMs: 60_000 });
    expect(s2.consume('tkt-Z', 'm_peer').ok).toBe(true);
  });

  it('a corrupt store file fails closed (empty) without throwing', () => {
    const file = path.join(dir, 'stream-tickets.json');
    fs.writeFileSync(file, '{ this is not json');
    const s = new StreamTicketStore({ filePath: file, now: () => nowMs, mintId: () => 'tkt-1', ttlMs: 60_000 });
    expect(() => s.consume('anything', 'm_peer')).not.toThrow();
    expect(s.consume('anything', 'm_peer')).toEqual({ ok: false, reason: 'unknown' });
    // still usable afterward
    s.mint('m_peer');
    expect(s.consume('tkt-1', 'm_peer').ok).toBe(true);
  });
});

describe('StreamTicketStore — GC bounds the map', () => {
  it('drops records past retention', () => {
    const file = path.join(dir, 'stream-tickets.json');
    const s = new StreamTicketStore({ filePath: file, now: () => nowMs, mintId: () => `g-${++seq}`, ttlMs: 1_000, retentionMs: 5_000 });
    s.mint('m_peer'); // g-1, expires nowMs+1000
    nowMs += 10_000;  // past expiry + retention
    s.mint('m_peer'); // g-2 triggers gc()
    // g-1 should be GC'd; presenting it reads as unknown (forgotten), not consumed.
    expect(s.consume('g-1', 'm_peer')).toEqual({ ok: false, reason: 'unknown' });
  });
});
